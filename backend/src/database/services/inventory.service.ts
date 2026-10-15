import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { AnyBulkWriteOperation, ClientSession } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { MAX_STAY_NIGHTS } from '../constants';
import { DateInput, addDays, eachNight, formatDateOnly, todayIn, toDateOnly } from '../common/dates';
import { isDuplicateKeyError } from '../common/schema-helpers';
import { runInTransaction } from '../common/transaction';
import {
  ACTIVE_RESERVATION_STATUSES,
  InventoryBlockReason,
  InventoryBlockStatus,
  SyncEntityType,
  SyncJobType,
} from '../enums';
import {
  DomainValidationError,
  InsufficientInventoryError,
  InventoryInvariantError,
  InventoryNotInitializedError,
  NotFoundError,
  RoomAssignmentConflictError,
} from '../errors';
import { Models, getModels } from '../models';
import type { Inventory, InventoryBlock, Restriction } from '../schemas/inventory.schema';
import { AuditService } from './audit.service';
import { SyncJobService } from './sync-job.service';

type Id = Types.ObjectId;

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
 * Owns every write to `inventory`. Counter invariant (also enforced by the
 * collection validator):
 *
 *     available + sold + blocked == total + overbooked      all >= 0
 *
 * Every mutation is a conditional multi-document update inside the caller's
 * transaction. It checks that the number of modified rows equals the number
 * of nights, so a multi-night change is all-or-nothing.
 */
@Injectable()
export class InventoryService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly syncJobs: SyncJobService,
    private readonly audit: AuditService,
  ) {
    this.m = getModels(connection);
  }

  // ================================================================ materialisation

  /**
   * Idempotently create inventory rows for [from, to) from roomType.totalRooms.
   * Existing rows are left untouched (pure $setOnInsert, no timestamp bump), so
   * this is safe to run concurrently with bookings. Run it outside
   * transactions: from the nightly horizon job, before blocks, and before
   * importing OTA bookings.
   */
  async ensureInventory(propertyId: Id, roomTypeId: Id, from: Date, to: Date): Promise<number> {
    const roomType = await this.m.RoomType.findOne({ _id: roomTypeId, propertyId }, { totalRooms: 1 }).lean();
    if (!roomType) throw new NotFoundError('RoomType', roomTypeId);
    const now = new Date();
    const ops: AnyBulkWriteOperation<Inventory>[] = eachNight(from, to).map((date) => ({
      updateOne: {
        filter: { propertyId, roomTypeId, date },
        update: {
          $setOnInsert: {
            total: roomType.totalRooms,
            sold: 0,
            blocked: 0,
            available: roomType.totalRooms,
            overbooked: 0,
            stopSell: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));
    if (!ops.length) return 0;
    try {
      const res = await this.m.Inventory.bulkWrite(ops as never, { ordered: false, timestamps: false });
      return res.upsertedCount;
    } catch (err) {
      // A concurrent ensureInventory inserted the same (property, type, date) first. Its row is just as good.
      if (isDuplicateKeyError(err)) return 0;
      throw err;
    }
  }

  /** Nightly job: keep `bookingHorizonDays` of inventory materialised for every room type. */
  async extendHorizon(propertyId: Id): Promise<number> {
    const property = await this.m.Property.findById(propertyId).lean();
    if (!property) throw new NotFoundError('Property', propertyId);
    const from = todayIn(property.timezone);
    const to = addDays(from, property.bookingHorizonDays);
    const roomTypes = await this.m.RoomType.find({ propertyId }, { _id: 1 }).lean();
    let created = 0;
    for (const rt of roomTypes) created += await this.ensureInventory(propertyId, rt._id, from, to);
    return created;
  }

  // ================================================================ booking / cancellation primitives

  /**
   * Take `quantity` rooms for every night of the stay. MUST run inside a transaction.
   *
   * Direct/PMS path (allowOverbooking = false):
   *   updateMany({ ...range, stopSell: false, available: { $gte: q } },
   *              { $inc: { available: -q, sold: q } })
   *   The filter and the decrement are one atomic operation per document, so
   *   `available` can never go below 0. If any night fails the filter,
   *   modifiedCount < nights and we throw, which aborts the transaction and
   *   rolls back the nights that did succeed. Two concurrent transactions on
   *   the same night hit a WriteConflict; the driver retries the loser, which
   *   then sees the winner's decrement.
   *
   * OTA path (allowOverbooking = true): the booking already exists on the
   * OTA, so refusing it would only hide it. We take what is available and
   * count the rest in `overbooked`, keeping every counter >= 0, and the
   * caller raises an overbooking alert.
   */
  async reserve(
    session: ClientSession,
    s: StayRange & { allowOverbooking?: boolean },
  ): Promise<{ overbookedUnits: number }> {
    const nights = this.nightsOf(s);
    const range = { propertyId: s.propertyId, roomTypeId: s.roomTypeId, date: { $gte: s.checkIn, $lt: s.checkOut } };
    const q = s.quantity;

    // Snapshot read for precise error messages. Correctness does not depend on it:
    // the conditional update below is the guard.
    const rows = await this.m.Inventory.find(range, { date: 1, available: 1, stopSell: 1 }).session(session).lean();
    const have = new Set(rows.map((r) => r.date.getTime()));
    const missing = nights.filter((d) => !have.has(d.getTime()));
    if (missing.length) {
      throw new InventoryNotInitializedError({ roomTypeId: String(s.roomTypeId), missingNights: missing.map(formatDateOnly) });
    }

    if (!s.allowOverbooking) {
      const failing = rows.filter((r) => r.stopSell || r.available < q).map((r) => formatDateOnly(r.date));
      if (failing.length) throw new InsufficientInventoryError({ roomTypeId: String(s.roomTypeId), requested: q, failingNights: failing });

      const res = await this.m.Inventory.updateMany(
        { ...range, stopSell: false, available: { $gte: q } },
        { $inc: { available: -q, sold: q } },
        { session },
      );
      if (res.modifiedCount !== nights.length) {
        throw new InsufficientInventoryError({ roomTypeId: String(s.roomTypeId), requested: q, failingNights: [] });
      }
      return { overbookedUnits: 0 };
    }

    const overbookedUnits = rows.reduce((acc, r) => acc + Math.max(0, q - Math.max(0, r.available)), 0);
    const res = await this.m.Inventory.updateMany(
      range,
      [
        { $set: { _take: { $min: [{ $max: ['$available', 0] }, q] } } },
        {
          $set: {
            sold: { $add: ['$sold', q] },
            available: { $subtract: ['$available', '$_take'] },
            overbooked: { $add: ['$overbooked', { $subtract: [q, '$_take'] }] },
            updatedAt: '$$NOW',
          },
        },
        { $unset: '_take' },
      ],
      { session, timestamps: false },
    );
    if (res.modifiedCount !== nights.length) {
      throw new InventoryInvariantError({ op: 'reserve', roomTypeId: String(s.roomTypeId), expected: nights.length, modified: res.modifiedCount });
    }
    return { overbookedUnits };
  }

  /**
   * Give back `quantity` rooms for every night (cancellation, no-show, expired
   * hold). Overbooked units are cleared first, then `available` grows.
   * MUST run inside a transaction.
   */
  async release(session: ClientSession, s: StayRange): Promise<void> {
    const nights = this.nightsOf(s);
    const q = s.quantity;
    const res = await this.m.Inventory.updateMany(
      { propertyId: s.propertyId, roomTypeId: s.roomTypeId, date: { $gte: s.checkIn, $lt: s.checkOut }, sold: { $gte: q } },
      [
        { $set: { _fromOver: { $min: ['$overbooked', q] } } },
        {
          $set: {
            sold: { $subtract: ['$sold', q] },
            overbooked: { $subtract: ['$overbooked', '$_fromOver'] },
            available: { $add: ['$available', { $subtract: [q, '$_fromOver'] }] },
            updatedAt: '$$NOW',
          },
        },
        { $unset: '_fromOver' },
      ],
      { session, timestamps: false },
    );
    if (res.modifiedCount !== nights.length) {
      throw new InventoryInvariantError({ op: 'release', roomTypeId: String(s.roomTypeId), expected: nights.length, modified: res.modifiedCount });
    }
  }

  // ================================================================ physical-room conflicts

  /**
   * Throws if `roomId` is assigned to another active reservation or covered by
   * an active room-level block in [from, to). The caller must already have
   * bumped rooms.assignmentVersion in the same transaction, which serialises
   * concurrent assigners of this room.
   */
  async assertRoomFree(
    session: ClientSession,
    q: { roomId: Id; from: Date; to: Date; excludeReservationId?: Id },
  ): Promise<void> {
    const clash = await this.m.Reservation.findOne(
      {
        'reservationRooms.roomId': q.roomId,
        // Stays are at most MAX_STAY_NIGHTS long, so this lower bound keeps the index scan short.
        checkIn: { $lt: q.to, $gte: addDays(q.from, -MAX_STAY_NIGHTS) },
        checkOut: { $gt: q.from },
        status: { $in: [...ACTIVE_RESERVATION_STATUSES] },
        ...(q.excludeReservationId ? { _id: { $ne: q.excludeReservationId } } : {}),
      },
      { reservationCode: 1, checkIn: 1, checkOut: 1 },
    )
      .session(session)
      .lean();
    if (clash) throw new RoomAssignmentConflictError({ roomId: String(q.roomId), reservationCode: clash.reservationCode });

    const block = await this.m.InventoryBlock.findOne(
      { roomId: q.roomId, status: InventoryBlockStatus.ACTIVE, startDate: { $lt: q.to }, endDate: { $gt: q.from } },
      { reason: 1, startDate: 1, endDate: 1 },
    )
      .session(session)
      .lean();
    if (block) throw new RoomAssignmentConflictError({ roomId: String(q.roomId), blockId: String(block._id), reason: block.reason });
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
      const room = await this.m.Room.findOne({ _id: input.roomId, propertyId: input.propertyId }).lean();
      if (!room) throw new NotFoundError('Room', input.roomId);
      if (!room.roomTypeId.equals(input.roomTypeId)) throw new DomainValidationError('Room does not belong to roomTypeId');
    }
    await this.ensureInventory(input.propertyId, input.roomTypeId, startDate, endDate);
    const nights = eachNight(startDate, endDate);

    return runInTransaction(this.connection, async (session) => {
      if (input.roomId) {
        await this.m.Room.updateOne({ _id: input.roomId }, { $inc: { assignmentVersion: 1 } }, { session });
        await this.assertRoomFree(session, { roomId: input.roomId, from: startDate, to: endDate });
      }
      const [block] = await this.m.InventoryBlock.create(
        [
          {
            propertyId: input.propertyId,
            roomTypeId: input.roomTypeId,
            roomId: input.roomId ?? null,
            startDate,
            endDate,
            quantity,
            reason: input.reason,
            notes: input.notes,
            createdBy: input.createdBy ?? null,
          },
        ],
        { session },
      );
      const res = await this.m.Inventory.updateMany(
        { propertyId: input.propertyId, roomTypeId: input.roomTypeId, date: { $gte: startDate, $lt: endDate }, available: { $gte: quantity } },
        { $inc: { available: -quantity, blocked: quantity } },
        { session },
      );
      if (res.modifiedCount !== nights.length) {
        const short = await this.m.Inventory.find(
          { propertyId: input.propertyId, roomTypeId: input.roomTypeId, date: { $gte: startDate, $lt: endDate } },
          { date: 1, available: 1 },
        )
          .session(session)
          .lean();
        throw new InsufficientInventoryError({
          roomTypeId: String(input.roomTypeId),
          requested: quantity,
          // Rows already decremented by this transaction show available+quantity; this is only a hint.
          failingNights: short.filter((r) => r.available < quantity).map((r) => formatDateOnly(r.date)),
        });
      }
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: startDate,
        dateTo: endDate,
      });
      await this.audit.record(session, {
        propertyId: input.propertyId,
        userId: input.createdBy ?? null,
        action: 'inventory_block.create',
        entityType: 'InventoryBlock',
        entityId: block._id,
        after: { roomTypeId: input.roomTypeId, roomId: input.roomId ?? null, startDate, endDate, quantity, reason: input.reason },
      });
      return block.toObject();
    });
  }

  async releaseBlock(propertyId: Id, blockId: Id, releasedBy: Id | null = null): Promise<InventoryBlock> {
    return runInTransaction(this.connection, async (session) => {
      const block = await this.m.InventoryBlock.findOneAndUpdate(
        { _id: blockId, propertyId, status: InventoryBlockStatus.ACTIVE },
        { $set: { status: InventoryBlockStatus.RELEASED, releasedAt: new Date(), releasedBy } },
        { session, new: true },
      ).lean();
      if (!block) throw new NotFoundError('Active InventoryBlock', blockId);
      const nights = eachNight(block.startDate, block.endDate);
      const res = await this.m.Inventory.updateMany(
        { propertyId, roomTypeId: block.roomTypeId, date: { $gte: block.startDate, $lt: block.endDate }, blocked: { $gte: block.quantity } },
        { $inc: { blocked: -block.quantity, available: block.quantity } },
        { session },
      );
      if (res.modifiedCount !== nights.length) {
        throw new InventoryInvariantError({ op: 'releaseBlock', blockId: String(blockId), expected: nights.length, modified: res.modifiedCount });
      }
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId,
        roomTypeId: block.roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: block.startDate,
        dateTo: block.endDate,
      });
      await this.audit.record(session, {
        propertyId,
        userId: releasedBy,
        action: 'inventory_block.release',
        entityType: 'InventoryBlock',
        entityId: block._id,
      });
      return block;
    });
  }

  // ================================================================ restrictions & stop-sell

  /**
   * Upsert restrictions for every night in [from, to) and mirror
   * `closed || stopSell` onto inventory.stopSell, so the booking filter stays a
   * single-document condition.
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
    const { propertyId, roomTypeId, patch } = input;
    const touchesSell = 'closed' in patch || 'stopSell' in patch;
    await this.ensureInventory(propertyId, roomTypeId, from, to);

    await runInTransaction(this.connection, async (session) => {
      const now = new Date();
      await this.m.Restriction.bulkWrite(
        nights.map((date) => ({
          updateOne: {
            filter: { propertyId, roomTypeId, date },
            update: { $set: { ...patch, updatedAt: now }, $setOnInsert: { createdAt: now } },
            upsert: true,
          },
        })) as never,
        { session, ordered: true, timestamps: false },
      );
      const rows = await this.m.Restriction.find({ propertyId, roomTypeId, date: { $gte: from, $lt: to } }).session(session).lean();
      const bad = rows.find((r) => r.minimumStay != null && r.maximumStay != null && r.maximumStay < r.minimumStay);
      if (bad) throw new DomainValidationError(`maximumStay < minimumStay on ${formatDateOnly(bad.date)}`);

      if (touchesSell) {
        await this.m.Inventory.bulkWrite(
          rows.map((r) => ({
            updateOne: {
              filter: { propertyId, roomTypeId, date: r.date },
              update: { $set: { stopSell: !!(r.closed || r.stopSell) } },
            },
          })) as never,
          { session, ordered: true },
        );
      }
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId,
        roomTypeId,
        types: touchesSell ? [SyncJobType.RESTRICTIONS, SyncJobType.INVENTORY] : [SyncJobType.RESTRICTIONS],
        dateFrom: from,
        dateTo: to,
      });
      await this.audit.record(session, {
        propertyId,
        userId: input.userId ?? null,
        action: 'restrictions.set',
        entityType: 'RoomType',
        entityId: roomTypeId,
        after: { from, to, ...patch },
      });
    });
  }

  // ================================================================ capacity changes

  /**
   * A physical room was added (+1) or removed (-1). Adjusts roomType.totalRooms
   * and every materialised night from today on. Removal fails if any future
   * night has no spare room to remove.
   */
  async adjustTotal(propertyId: Id, roomTypeId: Id, delta: number, userId: Id | null = null, outerSession?: ClientSession): Promise<void> {
    if (!Number.isInteger(delta) || delta === 0) throw new DomainValidationError('delta must be a non-zero integer');
    const property = await this.m.Property.findById(propertyId, { timezone: 1 }).lean();
    if (!property) throw new NotFoundError('Property', propertyId);
    const today = todayIn(property.timezone);

    const body = async (session: ClientSession) => {
      const rt = await this.m.RoomType.findOneAndUpdate(
        { _id: roomTypeId, propertyId, totalRooms: { $gte: Math.max(0, -delta) } },
        { $inc: { totalRooms: delta } },
        { session, new: true },
      ).lean();
      if (!rt) throw new DomainValidationError('Room type not found or totalRooms would go negative');

      const range = { propertyId, roomTypeId, date: { $gte: today } };
      const rows = await this.m.Inventory.countDocuments(range).session(session);
      const res = await this.m.Inventory.updateMany(
        { ...range, ...(delta < 0 ? { available: { $gte: -delta }, total: { $gte: -delta } } : {}) },
        { $inc: { total: delta, available: delta } },
        { session },
      );
      if (res.modifiedCount !== rows) {
        throw new DomainValidationError('Cannot remove capacity: some future nights have no unsold room to remove', {
          nightsAffected: rows - res.modifiedCount,
        });
      }
      await this.syncJobs.enqueueForRoomType(session, {
        propertyId,
        roomTypeId,
        types: [SyncJobType.INVENTORY],
        dateFrom: today,
        dateTo: addDays(today, 730),
        entityType: SyncEntityType.ROOM_TYPE,
      });
      await this.audit.record(session, {
        propertyId,
        userId,
        action: 'inventory.adjust_total',
        entityType: 'RoomType',
        entityId: roomTypeId,
        after: { delta, totalRooms: rt.totalRooms },
      });
    };
    // Inside a caller's transaction (room create/move) or in its own.
    if (outerSession) await body(outerSession);
    else await runInTransaction(this.connection, body);
  }

  // ================================================================ helpers

  private nightsOf(s: StayRange): Date[] {
    const nights = eachNight(s.checkIn, s.checkOut);
    if (!nights.length) throw new DomainValidationError('checkOut must be after checkIn');
    if (!Number.isInteger(s.quantity) || s.quantity < 1) throw new DomainValidationError('quantity must be a positive integer');
    return nights;
  }
}
