import { Injectable } from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toUuid } from '../../common/utils';
import { addDays, formatDateOnly, todayIn, toDateOnly } from '../../database/common/dates';
import type { CancellationPolicy, Promotion, RatePlan } from '../../database/db-types';
import { CancellationPenaltyType, PromotionType, RatePlanStatus, RatePlanType, RedemptionStatus, SyncEntityType, SyncJobType } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, j, runInTransaction } from '../../database/kysely';
import { SyncJobService } from '../../database/services/sync-job.service';
import { setFrom } from '../../database/sql';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { CreatePromotionDto, CreateRatePlanDto, UpdatePromotionDto, UpdateRatePlanDto } from './rates.dto';

type PolicyInput = Partial<CancellationPolicy> & { refundable: boolean };

/** Fills the policy defaults the old schema applied (no free window, no penalty). */
const normalizePolicy = (p: PolicyInput): CancellationPolicy => ({
  refundable: p.refundable,
  freeCancellationHours: p.freeCancellationHours ?? 0,
  penaltyType: p.penaltyType ?? CancellationPenaltyType.NONE,
  penaltyValue: p.penaltyValue ?? 0,
  ...(p.description ? { description: p.description } : {}),
});

function assertPolicyMatchesType(type: string, policy: CancellationPolicy) {
  if (type === RatePlanType.NON_REFUNDABLE && policy.refundable) {
    throw new DomainValidationError('NON_REFUNDABLE rate plans cannot have a refundable policy', { fields: { 'cancellationPolicy.refundable': ['must be false for NON_REFUNDABLE plans'] } });
  }
}

function assertPromotion(type: string, value: number, validFrom: Date, validTo: Date) {
  if (validTo <= validFrom) throw new DomainValidationError('validTo must be after validFrom');
  if (type === PromotionType.PERCENTAGE && value > 100) throw new DomainValidationError('Percentage cannot exceed 100');
  if (type === PromotionType.FIXED && !Number.isInteger(value)) throw new DomainValidationError('Fixed discount must be in minor units');
}

@Injectable()
export class RatesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {}

  // ------------------------------------------------------------ rate plans

  listRatePlans(propertyId: string, roomTypeId?: string): Promise<RatePlan[]> {
    let q = this.db.selectFrom('ratePlans').selectAll().where('propertyId', '=', propertyId).where('status', '<>', RatePlanStatus.ARCHIVED);
    if (roomTypeId) q = q.where('roomTypeId', '=', toUuid(roomTypeId, 'roomTypeId'));
    return q.orderBy('roomTypeId').orderBy('basePrice').execute();
  }

  async createRatePlan(user: AuthUser, meta: RequestMeta, propertyId: string, dto: CreateRatePlanDto): Promise<RatePlan> {
    const rtId = toUuid(dto.roomTypeId, 'roomTypeId');
    const [property, rt] = await Promise.all([
      this.db.selectFrom('properties').select('currency').where('id', '=', propertyId).executeTakeFirst(),
      this.db.selectFrom('roomTypes').select('id').where('id', '=', rtId).where('propertyId', '=', propertyId).executeTakeFirst(),
    ]);
    if (!property) throw new NotFoundError('Property', propertyId);
    if (!rt) throw new DomainValidationError('roomTypeId must belong to this property');
    const policy = normalizePolicy(dto.cancellationPolicy);
    assertPolicyMatchesType(dto.type, policy);
    try {
      const rp = await this.db
        .insertInto('ratePlans')
        .values({
          propertyId,
          roomTypeId: rtId,
          name: dto.name.trim(),
          code: dto.code.trim().toUpperCase(),
          type: dto.type,
          basePrice: dto.basePrice,
          currency: property.currency,
          ...(dto.mealPlan ? { mealPlan: dto.mealPlan } : {}),
          cancellationPolicy: j(policy),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.log({ user, meta }, { action: 'rate_plan.create', entityType: 'RatePlan', entityId: rp.id, propertyId, after: { code: rp.code, basePrice: rp.basePrice } });
      return rp;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', `Rate plan code ${dto.code} already exists for this room type`);
      throw err;
    }
  }

  /** A price or policy change queues a RATES push for the whole horizon to every mapped channel. */
  async updateRatePlan(user: AuthUser, meta: RequestMeta, id: string, dto: UpdateRatePlanDto): Promise<RatePlan> {
    const rp = await this.db.selectFrom('ratePlans').selectAll().where('id', '=', id).executeTakeFirst();
    if (!rp) throw new NotFoundError('RatePlan', id);
    if (rp.status === RatePlanStatus.ARCHIVED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Archived rate plans cannot be edited');
    const before = { basePrice: rp.basePrice, status: rp.status, name: rp.name };
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', rp.propertyId).executeTakeFirstOrThrow();
    const policy = dto.cancellationPolicy ? normalizePolicy(dto.cancellationPolicy) : rp.cancellationPolicy;
    assertPolicyMatchesType(dto.type ?? rp.type, policy);
    const set = setFrom({ ...dto, cancellationPolicy: dto.cancellationPolicy ? policy : undefined }, { json: ['cancellationPolicy'] });
    const result = await runInTransaction(this.db, async (tx) => {
      const doc = Object.keys(set).length
        ? await tx.updateTable('ratePlans').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
        : rp;
      if (dto.basePrice !== undefined || dto.status !== undefined) {
        const today = todayIn(property.timezone);
        await this.syncJobs.enqueueForRoomType(tx, {
          propertyId: rp.propertyId,
          roomTypeId: rp.roomTypeId,
          types: [SyncJobType.RATES],
          dateFrom: today,
          dateTo: addDays(today, property.bookingHorizonDays),
          entityType: SyncEntityType.RATE_PLAN,
          entityId: rp.id,
        });
      }
      await this.audit.log({ user, meta }, { action: 'rate_plan.update', entityType: 'RatePlan', entityId: id, propertyId: rp.propertyId, before, after: dto as Record<string, unknown> }, tx);
      return doc;
    });
    void this.outbox.flush();
    return result;
  }

  async archiveRatePlan(user: AuthUser, meta: RequestMeta, id: string): Promise<RatePlan> {
    const rp = await this.db.updateTable('ratePlans').set({ status: RatePlanStatus.ARCHIVED }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!rp) throw new NotFoundError('RatePlan', id);
    await this.audit.log({ user, meta }, { action: 'rate_plan.archive', entityType: 'RatePlan', entityId: id, propertyId: rp.propertyId });
    return rp;
  }

  // ------------------------------------------------------------ promotions

  async listPromotions(propertyId: string): Promise<(Promotion & { redeemed: number })[]> {
    const rows = await this.db.selectFrom('promotions').selectAll().where('propertyId', '=', propertyId).orderBy('validFrom', 'desc').execute();
    if (!rows.length) return [];
    const counts = await this.db
      .selectFrom('promotionRedemptions')
      .select(['promotionId', (eb) => eb.fn.countAll<string>().as('n')])
      .where('promotionId', 'in', rows.map((r) => r.id))
      .where('status', '=', RedemptionStatus.ACTIVE)
      .groupBy('promotionId')
      .execute();
    const byId = new Map(counts.map((c) => [c.promotionId, Number(c.n)]));
    return rows.map((r) => ({ ...r, redeemed: byId.get(r.id) ?? 0 }));
  }

  async createPromotion(user: AuthUser, meta: RequestMeta, propertyId: string, dto: CreatePromotionDto): Promise<Promotion> {
    const validFrom = toDateOnly(dto.validFrom);
    const validTo = toDateOnly(dto.validTo);
    assertPromotion(dto.type, dto.value, validFrom, validTo);
    try {
      const p = await this.db
        .insertInto('promotions')
        .values({
          propertyId,
          code: dto.code.trim().toUpperCase(),
          name: dto.name.trim(),
          type: dto.type,
          value: dto.value,
          validFrom: formatDateOnly(validFrom),
          validTo: formatDateOnly(validTo),
          ...(dto.minNights !== undefined ? { minNights: dto.minNights } : {}),
          roomTypeIds: (dto.roomTypeIds ?? []).map((x) => toUuid(x, 'roomTypeIds')),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          maxRedemptions: dto.maxRedemptions ?? null,
          maxPerGuest: dto.maxPerGuest ?? null,
          ...(dto.minBookingValue !== undefined ? { minBookingValue: dto.minBookingValue } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.log({ user, meta }, { action: 'promotion.create', entityType: 'Promotion', entityId: p.id, propertyId, after: { code: p.code, type: p.type, value: p.value } });
      return p;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', `Promo code ${dto.code} already exists`);
      throw err;
    }
  }

  async updatePromotion(user: AuthUser, meta: RequestMeta, id: string, dto: UpdatePromotionDto): Promise<Promotion> {
    const doc = await this.db.selectFrom('promotions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!doc) throw new NotFoundError('Promotion', id);
    const validFrom = dto.validFrom ? toDateOnly(dto.validFrom) : doc.validFrom;
    const validTo = dto.validTo ? toDateOnly(dto.validTo) : doc.validTo;
    assertPromotion(dto.type ?? doc.type, dto.value ?? doc.value, validFrom, validTo);
    const { validFrom: _f, validTo: _t, roomTypeIds, ...rest } = dto;
    const set = {
      ...setFrom(rest),
      ...(dto.validFrom ? { validFrom: formatDateOnly(validFrom) } : {}),
      ...(dto.validTo ? { validTo: formatDateOnly(validTo) } : {}),
      ...(roomTypeIds ? { roomTypeIds: roomTypeIds.map((x) => toUuid(x, 'roomTypeIds')) } : {}),
    };
    const updated = Object.keys(set).length ? await this.db.updateTable('promotions').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow() : doc;
    await this.audit.log({ user, meta }, { action: 'promotion.update', entityType: 'Promotion', entityId: id, propertyId: doc.propertyId, after: dto as Record<string, unknown> });
    return updated;
  }

  async deletePromotion(user: AuthUser, meta: RequestMeta, id: string) {
    const doc = await this.db.updateTable('promotions').set({ active: false }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!doc) throw new NotFoundError('Promotion', id);
    await this.audit.log({ user, meta }, { action: 'promotion.deactivate', entityType: 'Promotion', entityId: id, propertyId: doc.propertyId });
    return doc;
  }
}
