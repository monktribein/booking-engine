import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toObjectId } from '../../common/utils';
import { addDays, todayIn, toDateOnly } from '../../database/common/dates';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { runInTransaction } from '../../database/common/transaction';
import { RatePlanStatus, SyncEntityType, SyncJobType } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { RatePlan } from '../../database/schemas/property.schema';
import type { Promotion } from '../../database/schemas/promotion.schema';
import { SyncJobService } from '../../database/services/sync-job.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { CreatePromotionDto, CreateRatePlanDto, UpdatePromotionDto, UpdateRatePlanDto } from './rates.dto';

@Injectable()
export class RatesService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  // ------------------------------------------------------------ rate plans

  listRatePlans(propertyId: Types.ObjectId, roomTypeId?: string): Promise<RatePlan[]> {
    return this.m.RatePlan.find({
      propertyId,
      status: { $ne: RatePlanStatus.ARCHIVED },
      ...(roomTypeId ? { roomTypeId: toObjectId(roomTypeId, 'roomTypeId') } : {}),
    })
      .sort({ roomTypeId: 1, basePrice: 1 })
      .lean();
  }

  async createRatePlan(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: CreateRatePlanDto): Promise<RatePlan> {
    const rtId = toObjectId(dto.roomTypeId, 'roomTypeId');
    const [property, rt] = await Promise.all([
      this.m.Property.findById(propertyId, { currency: 1 }).lean(),
      this.m.RoomType.findOne({ _id: rtId, propertyId }, { _id: 1 }).lean(),
    ]);
    if (!property) throw new NotFoundError('Property', propertyId);
    if (!rt) throw new DomainValidationError('roomTypeId must belong to this property');
    try {
      const [rp] = await this.m.RatePlan.create([{ ...dto, roomTypeId: rtId, propertyId, currency: property.currency }]);
      await this.audit.log({ user, meta }, { action: 'rate_plan.create', entityType: 'RatePlan', entityId: rp._id, propertyId, after: { code: rp.code, basePrice: rp.basePrice } });
      return rp.toObject();
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', `Rate plan code ${dto.code} already exists for this room type`);
      throw err;
    }
  }

  /** A price or policy change queues a RATES push for the whole horizon to every mapped channel. */
  async updateRatePlan(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: UpdateRatePlanDto): Promise<RatePlan> {
    const rp = await this.m.RatePlan.findById(id);
    if (!rp) throw new NotFoundError('RatePlan', id);
    if (rp.status === RatePlanStatus.ARCHIVED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Archived rate plans cannot be edited');
    const before = { basePrice: rp.basePrice, status: rp.status, name: rp.name };
    const property = await this.m.Property.findById(rp.propertyId, { timezone: 1, bookingHorizonDays: 1 }).lean();
    const result = await runInTransaction(this.connection, async (session) => {
      const doc = await this.m.RatePlan.findById(id).session(session);
      doc!.set(dto);
      await doc!.save({ session });
      if (dto.basePrice !== undefined || dto.status !== undefined) {
        const today = todayIn(property!.timezone);
        await this.syncJobs.enqueueForRoomType(session, {
          propertyId: rp.propertyId,
          roomTypeId: rp.roomTypeId,
          types: [SyncJobType.RATES],
          dateFrom: today,
          dateTo: addDays(today, property!.bookingHorizonDays),
          entityType: SyncEntityType.RATE_PLAN,
          entityId: rp._id,
        });
      }
      await this.audit.log({ user, meta }, { action: 'rate_plan.update', entityType: 'RatePlan', entityId: id, propertyId: rp.propertyId, before, after: dto as Record<string, unknown> }, session);
      return doc!.toObject();
    });
    void this.outbox.flush();
    return result;
  }

  async archiveRatePlan(user: AuthUser, meta: RequestMeta, id: Types.ObjectId): Promise<RatePlan> {
    const rp = await this.m.RatePlan.findByIdAndUpdate(id, { $set: { status: RatePlanStatus.ARCHIVED } }, { new: true }).lean();
    if (!rp) throw new NotFoundError('RatePlan', id);
    await this.audit.log({ user, meta }, { action: 'rate_plan.archive', entityType: 'RatePlan', entityId: id, propertyId: rp.propertyId });
    return rp;
  }

  // ------------------------------------------------------------ promotions

  listPromotions(propertyId: Types.ObjectId): Promise<Promotion[]> {
    return this.m.Promotion.find({ propertyId }).sort({ validFrom: -1 }).lean();
  }

  async createPromotion(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: CreatePromotionDto): Promise<Promotion> {
    try {
      const [p] = await this.m.Promotion.create([
        {
          ...dto,
          propertyId,
          validFrom: toDateOnly(dto.validFrom),
          validTo: toDateOnly(dto.validTo),
          roomTypeIds: (dto.roomTypeIds ?? []).map((x) => toObjectId(x, 'roomTypeIds')),
        },
      ]);
      await this.audit.log({ user, meta }, { action: 'promotion.create', entityType: 'Promotion', entityId: p._id, propertyId, after: { code: p.code, type: p.type, value: p.value } });
      return p.toObject();
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', `Promo code ${dto.code} already exists`);
      throw err;
    }
  }

  async updatePromotion(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: UpdatePromotionDto): Promise<Promotion> {
    const doc = await this.m.Promotion.findById(id);
    if (!doc) throw new NotFoundError('Promotion', id);
    doc.set({
      ...dto,
      ...(dto.validFrom ? { validFrom: toDateOnly(dto.validFrom) } : {}),
      ...(dto.validTo ? { validTo: toDateOnly(dto.validTo) } : {}),
      ...(dto.roomTypeIds ? { roomTypeIds: dto.roomTypeIds.map((x) => toObjectId(x, 'roomTypeIds')) } : {}),
    });
    await doc.save();
    await this.audit.log({ user, meta }, { action: 'promotion.update', entityType: 'Promotion', entityId: id, propertyId: doc.propertyId, after: dto as Record<string, unknown> });
    return doc.toObject();
  }

  async deletePromotion(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const doc = await this.m.Promotion.findByIdAndUpdate(id, { $set: { active: false } }, { new: true }).lean();
    if (!doc) throw new NotFoundError('Promotion', id);
    await this.audit.log({ user, meta }, { action: 'promotion.deactivate', entityType: 'Promotion', entityId: id, propertyId: doc.propertyId });
    return doc;
  }
}
