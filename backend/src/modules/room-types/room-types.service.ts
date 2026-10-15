import { Injectable } from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { slugify } from '../../common/utils';
import { addDays, todayIn } from '../../database/common/dates';
import type { RoomType } from '../../database/db-types';
import { ACTIVE_RESERVATION_STATUSES, CancellationPenaltyType, MealPlan, RatePlanType, RoomTypeStatus, SyncJobType } from '../../database/enums';
import { ConflictError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, j, runInTransaction } from '../../database/kysely';
import { d, setFrom } from '../../database/sql';
import { InventoryService } from '../../database/services/inventory.service';
import { SyncJobService } from '../../database/services/sync-job.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import { normalizeImages } from '../properties/properties.service';
import type { CreateRoomTypeDto, UpdateRoomTypeDto } from './room-types.dto';

@Injectable()
export class RoomTypesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly inventory: InventoryService,
    private readonly syncJobs: SyncJobService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {}

  list(propertyId: string): Promise<RoomType[]> {
    return this.db.selectFrom('roomTypes').selectAll().where('propertyId', '=', propertyId).where('status', '<>', RoomTypeStatus.ARCHIVED).orderBy('sortOrder').orderBy('name').execute();
  }

  async get(id: string): Promise<RoomType> {
    const rt = await this.db.selectFrom('roomTypes').selectAll().where('id', '=', id).executeTakeFirst();
    if (!rt) throw new NotFoundError('RoomType', id);
    return rt;
  }

  /**
   * Creates the room type with 0 rooms, materialises its inventory horizon (rooms are added through
   * /room-types/:id/rooms, which raises the counts), and by default a flexible STD rate plan.
   */
  async create(user: AuthUser, meta: RequestMeta, propertyId: string, dto: CreateRoomTypeDto): Promise<RoomType> {
    const property = await this.db.selectFrom('properties').select(['currency', 'timezone', 'bookingHorizonDays']).where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const { createDefaultRatePlan = true } = dto;
    let rt: RoomType;
    try {
      rt = await runInTransaction(this.db, async (tx) => {
        const doc = await tx
          .insertInto('roomTypes')
          .values({
            propertyId,
            name: dto.name.trim(),
            slug: dto.slug ?? (slugify(dto.name) || 'room'),
            description: dto.description ?? null,
            maxOccupancy: dto.maxOccupancy,
            basePrice: dto.basePrice,
            currency: property.currency,
            totalRooms: 0,
            amenities: dto.amenities?.map((a) => a.trim()).filter(Boolean) ?? [],
            images: j(normalizeImages(dto.images) ?? []),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (createDefaultRatePlan) {
          await tx
            .insertInto('ratePlans')
            .values({
              propertyId,
              roomTypeId: doc.id,
              name: 'Standard Flexible',
              code: 'STD',
              type: RatePlanType.STANDARD,
              basePrice: dto.basePrice,
              currency: property.currency,
              mealPlan: MealPlan.ROOM_ONLY,
              cancellationPolicy: j({ refundable: true, freeCancellationHours: 48, penaltyType: CancellationPenaltyType.FIRST_NIGHT, penaltyValue: 0 }),
            })
            .execute();
        }
        await this.audit.log({ user, meta }, { action: 'room_type.create', entityType: 'RoomType', entityId: doc.id, propertyId, after: { name: doc.name } }, tx);
        return doc;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', 'A room type with this slug already exists in the property');
      throw err;
    }
    const today = todayIn(property.timezone);
    await this.inventory.ensureInventory(propertyId, rt.id, today, addDays(today, property.bookingHorizonDays));
    return rt;
  }

  async update(user: AuthUser, meta: RequestMeta, id: string, dto: UpdateRoomTypeDto): Promise<RoomType> {
    const before = await this.get(id);
    if (before.status === RoomTypeStatus.ARCHIVED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Archived room types cannot be edited');
    const set = setFrom({ ...dto, images: normalizeImages(dto.images) }, { json: ['images'] });
    let after = before;
    try {
      if (Object.keys(set).length) after = await this.db.updateTable('roomTypes').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', 'A room type with this slug already exists in the property');
      throw err;
    }
    await this.audit.log({ user, meta }, {
      action: 'room_type.update',
      entityType: 'RoomType',
      entityId: id,
      propertyId: before.propertyId,
      before: Object.fromEntries(Object.keys(dto).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
      after: dto as Record<string, unknown>,
    });
    return after;
  }

  /**
   * Soft delete. Refused while reservations hold future nights. Future inventory is set to stop-sell and pushed, so
   * channels show 0 before the type disappears from the PMS.
   */
  async archive(user: AuthUser, meta: RequestMeta, id: string): Promise<RoomType> {
    const rt = await this.get(id);
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', rt.propertyId).executeTakeFirstOrThrow();
    const today = todayIn(property.timezone);
    const booked = Number(
      (
        await this.db
          .selectFrom('reservations as r')
          .select((eb) => eb.fn.count<number>('r.id').distinct().as('n'))
          .innerJoin('reservationRooms as rr', 'rr.reservationId', 'r.id')
          .where('r.propertyId', '=', rt.propertyId)
          .where('rr.roomTypeId', '=', rt.id)
          .where('r.status', 'in', [...ACTIVE_RESERVATION_STATUSES])
          .where('r.checkOut', '>', d(today))
          .executeTakeFirstOrThrow()
      ).n,
    );
    if (booked) throw new ConflictError('INVALID_STATE_TRANSITION', `${booked} active or upcoming reservation(s) use this room type`);

    const archived = await runInTransaction(this.db, async (tx) => {
      const doc = await tx.updateTable('roomTypes').set({ status: RoomTypeStatus.ARCHIVED }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await tx.updateTable('inventory').set({ stopSell: true }).where('propertyId', '=', rt.propertyId).where('roomTypeId', '=', id).where('date', '>=', d(today)).execute();
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId: rt.propertyId,
        roomTypeId: id,
        types: [SyncJobType.INVENTORY],
        dateFrom: today,
        dateTo: addDays(today, property.bookingHorizonDays),
      });
      await this.audit.log({ user, meta }, { action: 'room_type.archive', entityType: 'RoomType', entityId: id, propertyId: rt.propertyId }, tx);
      return doc;
    });
    void this.outbox.flush();
    return archived;
  }
}
