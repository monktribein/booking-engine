import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { slugify } from '../../common/utils';
import { addDays, todayIn } from '../../database/common/dates';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { runInTransaction } from '../../database/common/transaction';
import { ACTIVE_RESERVATION_STATUSES, CancellationPenaltyType, MealPlan, RatePlanType, RoomTypeStatus, SyncJobType } from '../../database/enums';
import { ConflictError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { RoomType } from '../../database/schemas/property.schema';
import { InventoryService } from '../../database/services/inventory.service';
import { SyncJobService } from '../../database/services/sync-job.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { CreateRoomTypeDto, UpdateRoomTypeDto } from './room-types.dto';

@Injectable()
export class RoomTypesService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly inventory: InventoryService,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  list(propertyId: Types.ObjectId): Promise<RoomType[]> {
    return this.m.RoomType.find({ propertyId, status: { $ne: RoomTypeStatus.ARCHIVED } }).sort({ sortOrder: 1, name: 1 }).lean();
  }

  async get(id: Types.ObjectId): Promise<RoomType> {
    const rt = await this.m.RoomType.findById(id).lean();
    if (!rt) throw new NotFoundError('RoomType', id);
    return rt;
  }

  /**
   * Creates the room type with 0 rooms, materialises its inventory horizon
   * (rooms are added through /room-types/:id/rooms, which raises the counts),
   * and by default a flexible STD rate plan.
   */
  async create(user: AuthUser, meta: RequestMeta, propertyId: Types.ObjectId, dto: CreateRoomTypeDto): Promise<RoomType> {
    const property = await this.m.Property.findById(propertyId).lean();
    if (!property) throw new NotFoundError('Property', propertyId);
    const { createDefaultRatePlan = true, ...fields } = dto;
    let rt: RoomType;
    try {
      rt = await runInTransaction(this.connection, async (session) => {
        const [doc] = await this.m.RoomType.create(
          [{ ...fields, slug: dto.slug ?? (slugify(dto.name) || 'room'), propertyId, currency: property.currency, totalRooms: 0 }],
          { session },
        );
        if (createDefaultRatePlan) {
          await this.m.RatePlan.create(
            [
              {
                propertyId,
                roomTypeId: doc._id,
                name: 'Standard Flexible',
                code: 'STD',
                type: RatePlanType.STANDARD,
                basePrice: dto.basePrice,
                currency: property.currency,
                mealPlan: MealPlan.ROOM_ONLY,
                cancellationPolicy: { refundable: true, freeCancellationHours: 48, penaltyType: CancellationPenaltyType.FIRST_NIGHT },
              },
            ],
            { session },
          );
        }
        await this.audit.log({ user, meta }, { action: 'room_type.create', entityType: 'RoomType', entityId: doc._id, propertyId, after: { name: doc.name } }, session);
        return doc.toObject();
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', 'A room type with this slug already exists in the property');
      throw err;
    }
    const today = todayIn(property.timezone);
    await this.inventory.ensureInventory(propertyId, rt._id, today, addDays(today, property.bookingHorizonDays));
    return rt;
  }

  async update(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: UpdateRoomTypeDto): Promise<RoomType> {
    const doc = await this.m.RoomType.findById(id);
    if (!doc) throw new NotFoundError('RoomType', id);
    if (doc.status === RoomTypeStatus.ARCHIVED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Archived room types cannot be edited');
    const before = doc.toObject();
    doc.set(dto);
    try {
      await doc.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', 'A room type with this slug already exists in the property');
      throw err;
    }
    await this.audit.log({ user, meta }, {
      action: 'room_type.update',
      entityType: 'RoomType',
      entityId: id,
      propertyId: doc.propertyId,
      before: Object.fromEntries(Object.keys(dto).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
      after: dto as Record<string, unknown>,
    });
    return doc.toObject();
  }

  /**
   * Soft delete. Refused while reservations hold future nights. Future
   * inventory is set to stop-sell and pushed, so channels show 0 before
   * the type disappears from the PMS.
   */
  async archive(user: AuthUser, meta: RequestMeta, id: Types.ObjectId): Promise<RoomType> {
    const rt = await this.get(id);
    const property = await this.m.Property.findById(rt.propertyId, { timezone: 1, bookingHorizonDays: 1 }).lean();
    const today = todayIn(property!.timezone);
    const booked = await this.m.Reservation.countDocuments({
      propertyId: rt.propertyId,
      'reservationRooms.roomTypeId': rt._id,
      status: { $in: [...ACTIVE_RESERVATION_STATUSES] },
      checkOut: { $gt: today },
    });
    if (booked) throw new ConflictError('INVALID_STATE_TRANSITION', `${booked} active or upcoming reservation(s) use this room type`);

    const archived = await runInTransaction(this.connection, async (session) => {
      const doc = await this.m.RoomType.findByIdAndUpdate(id, { $set: { status: RoomTypeStatus.ARCHIVED } }, { new: true, session }).lean();
      await this.m.Inventory.updateMany({ propertyId: rt.propertyId, roomTypeId: id, date: { $gte: today } }, { $set: { stopSell: true } }, { session });
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId: rt.propertyId,
        roomTypeId: id,
        types: [SyncJobType.INVENTORY],
        dateFrom: today,
        dateTo: addDays(today, property!.bookingHorizonDays),
      });
      await this.audit.log({ user, meta }, { action: 'room_type.archive', entityType: 'RoomType', entityId: id, propertyId: rt.propertyId }, session);
      return doc!;
    });
    void this.outbox.flush();
    return archived;
  }
}
