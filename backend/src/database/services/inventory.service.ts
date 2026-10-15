import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { MAX_STAY_NIGHTS } from '../constants';
import { DateInput, addDays, eachNight, formatDateOnly, todayIn, toDateOnly } from '../common/dates';
import { ACTIVE_RESERVATION_STATUSES, InventoryBlockReason, InventoryBlockStatus, SyncEntityType, SyncJobType } from '../enums';
import {
  DomainValidationError,
  InsufficientInventoryError,
  InventoryInvariantError,
  InventoryNotInitializedError,
  NotFoundError,
  RoomAssignmentConflictError,
} from '../errors';
import type { InventoryBlock, Restriction } from '../db-types';
import { Db, InjectDb, pgErrorCode, runInTransaction } from '../kysely';
import { d } from '../sql';
import { AuditService } from './audit.service';
import { SyncJobService } from './sync-job.service';

type Id = string;

export interface StayRange {
  propertyId: Id;
  roomTypeId: Id;
  checkIn: Date;
  /** Exclusive. */
  checkOut: Date;
  quantity: number;
}

export type RestrictionPatch = Partial<
  Pick<Restriction, 'minimumStay' | 'maximumStay' | 'closed' | 'closedToArrival' | 'closedToDeparture' | 'stopSell'>
>;

/**
 * Owns every write to `inventory`. Counter invariant (also a CHECK constraint on the table):
 *
 *     available + sold + blocked == total + overbooked      all >= 0
 *
 * Every mutation locks the affected nights (SELECT ... FOR UPDATE, always in date order so two bookings can never
 * deadlock), then applies a conditional UPDATE and checks that the number of updated rows equals the number of
 * nights, so a multi-night change is all-or-nothing inside the caller's transaction.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly syncJobs: SyncJobService,
    private readonly audit: AuditService,
  ) {}

  // ================================================================ materialisation

  /**
   * Idempotently create inventory rows for [from, to) from roomType.totalRooms. Existing rows are left untouched
   * (ON CONFLICT DO NOTHING), so this is safe to run concurrently with bookings and with itself. Returns the number of
   * rows created.
   */
  async ensureInventory(propertyId: Id, roomTypeId: Id, from: Date, to: Date, q: Db = this.db): Promise<number> {
    const roomType = await q.selectFrom('roomTypes').select('totalRooms').where('id', '=', roomTypeId).where('propertyId', '=', propertyId).executeTakeFirst();
    if (!roomType) throw new NotFoundError('RoomType', roomTypeId);
    if (!eachNight(from, to).length) return 0;
    const res = await sql`
      insert into inventory (property_id, room_type_id, date, total, sold, blocked, available, overbooked, stop_sell)
      select ${propertyId}::uuid, ${roomTypeId}::uuid, g::date, ${roomType.totalRooms}::int, 0, 0, ${roomType.totalRooms}::int, 0, false
      from generate_series(${formatDateOnly(from)}::date, ${formatDateOnly(to)}::date - 1, interval '1 day') as g
      on conflict (property_id, room_type_id, date) do nothing`.execute(q);
    return Number(res.numAffectedRows ?? 0);
  }

  /** Nightly job: keep `bookingHorizonDays` of inventory materialised for every room type. */
  async extendHorizon(propertyId: Id): Promise<number> {
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const from = todayIn(property.timezone);
    const to = addDays(from, property.bookingHorizonDays);
    const roomTypes = await this.db.selectFrom('roomTypes').select('id').where('propertyId', '=', propertyId).execute();
    let created = 0;
    for (const rt of roomTypes) created += await this.ensureInventory(propertyId, rt.id, from, to);
    return created;
  }

  // ================================================================ booking / cancellation primitives

  /**
   * Take `quantity` rooms for every night of the stay. MUST run inside a transaction.
   *
   * Direct/PMS path (allowOverbooking = false): the nights are locked in date order, checked, and decremented with
   * `available >= q AND NOT stop_sell` still in the UPDATE's WHERE. `available` can therefore never go below 0, even if
   * application logic is wrong; if any night fails the whole transaction aborts. Two concurrent bookings of the same
   * nights queue on the row locks; the second then sees the first's decrement and is refused.
   *
   * OTA path (allowOverbooking = true): the booking already exists on the OTA, so refusing it would only hide it. We
   * take what is available and count the rest in `overbooked`, keeping every counter >= 0, and the caller raises an
   * overbooking alert.
   */
  async reserve(tx: Db, s: StayRange & { allowOverbooking?: boolean }): Promise<{ overbookedUnits: number }> {
    const nights = this.nightsOf(s);
    const q = s.quantity;

    const rows = await tx
      .selectFrom('inventory')
      .select(['date', 'available', 'stopSell'])
      .where('propertyId', '=', s.propertyId)
      .where('roomTypeId', '=', s.roomTypeId)
      .where('date', '>=', d(s.checkIn))
      .where('date', '<', d(s.checkOut))
      .orderBy('date')
      .forUpdate()
      .execute();
    const have = new Set(rows.map((r) => r.date.getTime()));
    const missing = nights.filter((n) => !have.has(n.getTime()));
    if (missing.length) {
      throw new InventoryNotInitializedError({ roomTypeId: s.roomTypeId, missingNights: missing.map(formatDateOnly) });
    }

    if (!s.allowOverbooking) {
      const failing = rows.filter((r) => r.stopSell || r.available < q).map((r) => formatDateOnly(r.date));
      if (failing.length) throw new InsufficientInventoryError({ roomTypeId: s.roomTypeId, requested: q, failingNights: failing });

      const res = await tx
        .updateTable('inventory')
        .set({ available: sql`available - ${q}`, sold: sql`sold + ${q}` })
        .where('propertyId', '=', s.propertyId)
        .where('roomTypeId', '=', s.roomTypeId)
        .where('date', '>=', d(s.checkIn))
        .where('date', '<', d(s.checkOut))
        .where('stopSell', '=', false)
        .where('available', '>=', q)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== nights.length) {
        throw new InsufficientInventoryError({ roomTypeId: s.roomTypeId, requested: q, failingNights: [] });
      }
      return { overbookedUnits: 0 };
    }

    const overbookedUnits = rows.reduce((acc, r) => acc + Math.max(0, q - Math.max(0, r.available)), 0);
    // take = min(max(available, 0), q); the rest is counted as overbooked.
    const res = await tx
      .updateTable('inventory')
      .set({
        sold: sql`sold + ${q}`,
        overbooked: sql`overbooked + (${q} - least(greatest(available, 0), ${q}))`,
        available: sql`available - least(greatest(available, 0), ${q})`,
      })
      .where('propertyId', '=', s.propertyId)
      .where('roomTypeId', '=', s.roomTypeId)
      .where('date', '>=', d(s.checkIn))
      .where('date', '<', d(s.checkOut))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== nights.length) {
      throw new InventoryInvariantError({ op: 'reserve', roomTypeId: s.roomTypeId, expected: nights.length, modified: Number(res.numUpdatedRows) });
    }
    return { overbookedUnits };
  }

  /**
   * Give back `quantity` rooms for every night (cancellation, no-show, expired hold). Overbooked units are cleared
   * first, then `available` grows. MUST run inside a transaction.
   */
  async release(tx: Db, s: StayRange): Promise<void> {
    const nights = this.nightsOf(s);
    const q = s.quantity;
    // Lock in date order first (same order as reserve), then update.
    await tx
      .selectFrom('inventory')
      .select('id')
      .where('propertyId', '=', s.propertyId)
      .where('roomTypeId', '=', s.roomTypeId)
      .where('date', '>=', d(s.checkIn))
      .where('date', '<', d(s.checkOut))
      .orderBy('date')
      .forUpdate()
      .execute();
    const res = await tx
      .updateTable('inventory')
      .set({
        sold: sql`sold - ${q}`,
        overbooked: sql`overbooked - least(overbooked, ${q})`,
        available: sql`available + (${q} - least(overbooked, ${q}))`,
      })
      .where('propertyId', '=', s.propertyId)
      .where('roomTypeId', '=', s.roomTypeId)
      .where('date', '>=', d(s.checkIn))
      .where('date', '<', d(s.checkOut))
      .where('sold', '>=', q)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== nights.length) {
      throw new InventoryInvariantError({ op: 'release', roomTypeId: s.roomTypeId, expected: nights.length, modified: Number(res.numUpdatedRows) });
    }
  }

  // ================================================================ physical-room conflicts

  /**
   * Throws if `roomId` is assigned to another active reservation or covered by an active room-level block in
   * [from, to). The caller must already have bumped rooms.assignment_version in the same transaction (which takes a row
   * lock on the room), serialising concurrent assigners of this room.
   */
  async assertRoomFree(tx: Db, q: { roomId: Id; from: Date; to: Date; excludeReservationId?: Id }): Promise<void> {
    let clashQuery = tx
      .selectFrom('reservationRooms as rr')
      .innerJoin('reservations as r', 'r.id', 'rr.reservationId')
      .select(['r.reservationCode'])
      .where('rr.roomId', '=', q.roomId)
      // Stays are at most MAX_STAY_NIGHTS long, so this lower bound keeps the index scan short.
      .where('r.checkIn', '<', d(q.to))
      .where('r.checkIn', '>=', d(addDays(q.from, -MAX_STAY_NIGHTS)))
      .where('r.checkOut', '>', d(q.from))
      .where('r.status', 'in', [...ACTIVE_RESERVATION_STATUSES]);
    if (q.excludeReservationId) clashQuery = clashQuery.where('r.id', '<>', q.excludeReservationId);
    const clash = await clashQuery.limit(1).executeTakeFirst();
    if (clash) throw new RoomAssignmentConflictError({ roomId: q.roomId, reservationCode: clash.reservationCode });

    const block = await tx
      .selectFrom('inventoryBlocks')
      .select(['id', 'reason'])
      .where('roomId', '=', q.roomId)
      .where('status', '=', InventoryBlockStatus.ACTIVE)
      .where('startDate', '<', d(q.to))
      .where('endDate', '>', d(q.from))
      .limit(1)
      .executeTakeFirst();
    if (block) throw new RoomAssignmentConflictError({ roomId: q.roomId, blockId: block.id, reason: block.reason });
  }

  // ================================================================ blocks

  async createBlock(input: {
    propertyId: Id;
    roomTypeId: Id;
    roomId?: Id | null;
    startDate: DateInput;
    endDate: DateInput;
    quantity?: number;
    reason: InventoryBlockReason;
    notes?: string;
    createdBy?: Id | null;
  }): Promise<InventoryBlock> {
    const startDate = toDateOnly(input.startDate);
    const endDate = toDateOnly(input.endDate);
    const quantity = input.roomId ? 1 : input.quantity ?? 1;
    if (endDate <= startDate) throw new DomainValidationError('endDate must be after startDate');

    if (input.roomId) {
      const room = await this.db.selectFrom('rooms').select(['id', 'roomTypeId']).where('id', '=', input.roomId).where('propertyId', '=', input.propertyId).executeTakeFirst();
      if (!room) throw new NotFoundError('Room', input.roomId);
      if (room.roomTypeId !== input.roomTypeId) throw new DomainValidationError('Room does not belong to roomTypeId');
    }
    await this.ensureInventory(input.propertyId, input.roomTypeId, startDate, endDate);
    const nights = eachNight(startDate, endDate);

    return runInTransaction(this.db, async (tx) => {
      if (input.roomId) {
        await tx.updateTable('rooms').set({ assignmentVersion: sql`assignment_version + 1` }).where('id', '=', input.roomId).execute();
        await this.assertRoomFree(tx, { roomId: input.roomId, from: startDate, to: endDate });
      }
      const block = await tx
        .insertInto('inventoryBlocks')
        .values({
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          roomId: input.roomId ?? null,
          startDate: formatDateOnly(startDate),
          endDate: formatDateOnly(endDate),
          quantity,
          reason: input.reason,
          notes: input.notes ?? null,
          createdBy: input.createdBy ?? null,
          releasedAt: null,
          releasedBy: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .selectFrom('inventory')
        .select('id')
        .where('propertyId', '=', input.propertyId)
        .where('roomTypeId', '=', input.roomTypeId)
        .where('date', '>=', d(startDate))
        .where('date', '<', d(endDate))
        .orderBy('date')
        .forUpdate()
        .execute();
      const res = await tx
        .updateTable('inventory')
        .set({ available: sql`available - ${quantity}`, blocked: sql`blocked + ${quantity}` })
        .where('propertyId', '=', input.propertyId)
        .where('roomTypeId', '=', input.roomTypeId)
        .where('date', '>=', d(startDate))
        .where('date', '<', d(endDate))
        .where('available', '>=', quantity)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== nights.length) {
        const short = await tx
          .selectFrom('inventory')
          .select(['date', 'available'])
          .where('propertyId', '=', input.propertyId)
          .where('roomTypeId', '=', input.roomTypeId)
          .where('date', '>=', d(startDate))
          .where('date', '<', d(endDate))
          .execute();
        throw new InsufficientInventoryError({
          roomTypeId: input.roomTypeId,
          requested: quantity,
          failingNights: short.filter((r) => r.available < quantity).map((r) => formatDateOnly(r.date)),
        });
      }
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: startDate,
        dateTo: endDate,
      });
      await this.audit.record(tx, {
        propertyId: input.propertyId,
        userId: input.createdBy ?? null,
        action: 'inventory_block.create',
        entityType: 'InventoryBlock',
        entityId: block.id,
        after: { roomTypeId: input.roomTypeId, roomId: input.roomId ?? null, startDate, endDate, quantity, reason: input.reason },
      });
      return block;
    });
  }

  async releaseBlock(propertyId: Id, blockId: Id, releasedBy: Id | null = null): Promise<InventoryBlock> {
    return runInTransaction(this.db, async (tx) => {
      const block = await tx
        .updateTable('inventoryBlocks')
        .set({ status: InventoryBlockStatus.RELEASED, releasedAt: new Date(), releasedBy })
        .where('id', '=', blockId)
        .where('propertyId', '=', propertyId)
        .where('status', '=', InventoryBlockStatus.ACTIVE)
        .returningAll()
        .executeTakeFirst();
      if (!block) throw new NotFoundError('Active InventoryBlock', blockId);
      const nights = eachNight(block.startDate, block.endDate);
      await tx
        .selectFrom('inventory')
        .select('id')
        .where('propertyId', '=', propertyId)
        .where('roomTypeId', '=', block.roomTypeId)
        .where('date', '>=', d(block.startDate))
        .where('date', '<', d(block.endDate))
        .orderBy('date')
        .forUpdate()
        .execute();
      const res = await tx
        .updateTable('inventory')
        .set({ blocked: sql`blocked - ${block.quantity}`, available: sql`available + ${block.quantity}` })
        .where('propertyId', '=', propertyId)
        .where('roomTypeId', '=', block.roomTypeId)
        .where('date', '>=', d(block.startDate))
        .where('date', '<', d(block.endDate))
        .where('blocked', '>=', block.quantity)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== nights.length) {
        throw new InventoryInvariantError({ op: 'releaseBlock', blockId, expected: nights.length, modified: Number(res.numUpdatedRows) });
      }
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId,
        roomTypeId: block.roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: block.startDate,
        dateTo: block.endDate,
      });
      await this.audit.record(tx, { propertyId, userId: releasedBy, action: 'inventory_block.release', entityType: 'InventoryBlock', entityId: block.id });
      return block;
    });
  }

  // ================================================================ restrictions & stop-sell

  /**
   * Upsert restrictions for every night in [from, to) (only the fields present in `patch` change) and mirror
   * `closed || stop_sell` onto inventory.stop_sell, so the booking filter stays a single-table condition.
   */
  async setRestrictions(input: {
    propertyId: Id;
    roomTypeId: Id;
    from: DateInput;
    to: DateInput;
    patch: RestrictionPatch;
    userId?: Id | null;
  }): Promise<void> {
    const from = toDateOnly(input.from);
    const to = toDateOnly(input.to);
    const nights = eachNight(from, to);
    if (!nights.length || nights.length > 730) throw new DomainValidationError('Range must be 1..730 nights');
    const { propertyId, roomTypeId } = input;
    const patch = Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== undefined)) as RestrictionPatch;
    const touchesSell = 'closed' in patch || 'stopSell' in patch;
    await this.ensureInventory(propertyId, roomTypeId, from, to);

    try {
      await runInTransaction(this.db, async (tx) => {
        const rows = nights.map((n) => ({ propertyId, roomTypeId, date: formatDateOnly(n), ...patch }));
        let insert = tx.insertInto('restrictions').values(rows);
        insert = Object.keys(patch).length
          ? insert.onConflict((oc) => oc.columns(['propertyId', 'roomTypeId', 'date']).doUpdateSet(patch))
          : insert.onConflict((oc) => oc.columns(['propertyId', 'roomTypeId', 'date']).doNothing());
        await insert.execute();

        if (touchesSell) {
          await sql`
            update inventory i set stop_sell = (r.closed or r.stop_sell)
            from restrictions r
            where r.property_id = i.property_id and r.room_type_id = i.room_type_id and r.date = i.date
              and i.property_id = ${propertyId}::uuid and i.room_type_id = ${roomTypeId}::uuid
              and i.date >= ${formatDateOnly(from)}::date and i.date < ${formatDateOnly(to)}::date`.execute(tx);
        }
        await this.syncJobs.enqueueForRoomType(tx, {
          propertyId,
          roomTypeId,
          types: touchesSell ? [SyncJobType.RESTRICTIONS, SyncJobType.INVENTORY] : [SyncJobType.RESTRICTIONS],
          dateFrom: from,
          dateTo: to,
        });
        await this.audit.record(tx, { propertyId, userId: input.userId ?? null, action: 'restrictions.set', entityType: 'RoomType', entityId: roomTypeId, after: { from, to, ...patch } });
      });
    } catch (err) {
      // 23514 = check_violation: the table refuses maximum_stay < minimum_stay.
      if (pgErrorCode(err) === '23514') throw new DomainValidationError('maximumStay must be >= minimumStay');
      throw err;
    }
  }

  // ================================================================ capacity changes

  /**
   * A physical room was added (+1) or removed (-1). Adjusts roomType.totalRooms and every materialised night from today
   * on. Removal fails if any future night has no spare room to remove.
   */
  async adjustTotal(propertyId: Id, roomTypeId: Id, delta: number, userId: Id | null = null, outerTx?: Db): Promise<void> {
    if (!Number.isInteger(delta) || delta === 0) throw new DomainValidationError('delta must be a non-zero integer');
    const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const today = todayIn(property.timezone);

    const body = async (tx: Db) => {
      const rt = await tx
        .updateTable('roomTypes')
        .set({ totalRooms: sql`total_rooms + ${delta}` })
        .where('id', '=', roomTypeId)
        .where('propertyId', '=', propertyId)
        .where('totalRooms', '>=', Math.max(0, -delta))
        .returning('totalRooms')
        .executeTakeFirst();
      if (!rt) throw new DomainValidationError('Room type not found or totalRooms would go negative');

      await tx
        .selectFrom('inventory')
        .select('id')
        .where('propertyId', '=', propertyId)
        .where('roomTypeId', '=', roomTypeId)
        .where('date', '>=', d(today))
        .orderBy('date')
        .forUpdate()
        .execute();
      const total = (await tx
        .selectFrom('inventory')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('propertyId', '=', propertyId)
        .where('roomTypeId', '=', roomTypeId)
        .where('date', '>=', d(today))
        .executeTakeFirstOrThrow()).n;
      let upd = tx
        .updateTable('inventory')
        .set({ total: sql`total + ${delta}`, available: sql`available + ${delta}` })
        .where('propertyId', '=', propertyId)
        .where('roomTypeId', '=', roomTypeId)
        .where('date', '>=', d(today));
      if (delta < 0) upd = upd.where('available', '>=', -delta).where('total', '>=', -delta);
      const res = await upd.executeTakeFirst();
      if (Number(res.numUpdatedRows) !== Number(total)) {
        throw new DomainValidationError('Cannot remove capacity: some future nights have no unsold room to remove', {
          nightsAffected: Number(total) - Number(res.numUpdatedRows),
        });
      }
      await this.syncJobs.enqueueForRoomType(tx, {
        propertyId,
        roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: today,
        dateTo: addDays(today, 730),
        entityType: SyncEntityType.ROOM_TYPE,
      });
      await this.audit.record(tx, { propertyId, userId, action: 'inventory.adjust_total', entityType: 'RoomType', entityId: roomTypeId, after: { delta, totalRooms: rt.totalRooms } });
    };
    // Inside a caller's transaction (room create/move) or in its own.
    if (outerTx) await body(outerTx);
    else await runInTransaction(this.db, body);
  }

  // ================================================================ helpers

  private nightsOf(s: StayRange): Date[] {
    const nights = eachNight(s.checkIn, s.checkOut);
    if (!nights.length) throw new DomainValidationError('checkOut must be after checkIn');
    if (!Number.isInteger(s.quantity) || s.quantity < 1) throw new DomainValidationError('quantity must be a positive integer');
    return nights;
  }
}
