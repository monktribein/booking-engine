import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toUuid } from '../../common/utils';
import { todayIn, toDateOnly } from '../../database/common/dates';
import type { Room } from '../../database/db-types';
import { ACTIVE_RESERVATION_STATUSES, InventoryBlockReason, InventoryBlockStatus, RoomStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation, runInTransaction } from '../../database/kysely';
import { d, setFrom } from '../../database/sql';
import { InventoryService } from '../../database/services/inventory.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { ChangeRoomStatusDto, CreateRoomDto, RetireRoomDto, UpdateRoomDto } from './rooms.dto';

/** Room columns the API returns (the internal assignment counter stays inside). */
const ROOM_COLUMNS = ['id', 'propertyId', 'roomTypeId', 'roomNumber', 'floor', 'status', 'notes', 'retiredAt', 'retiredReason', 'createdAt', 'updatedAt'] as const;
type PublicRoom = Omit<Room, 'assignmentVersion' | 'retiredBy'>;

@Injectable()
export class RoomsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {}

  /** Retired rooms are listed only on request, so no picker (assignment, check-in) can offer one by accident. */
  list(roomTypeId: string, includeRetired = false): Promise<PublicRoom[]> {
    let q = this.db.selectFrom('rooms').select(ROOM_COLUMNS).where('roomTypeId', '=', roomTypeId);
    if (!includeRetired) q = q.where('status', '<>', RoomStatus.RETIRED);
    return q.orderBy('roomNumber').execute();
  }

  async get(id: string): Promise<PublicRoom> {
    const r = await this.db.selectFrom('rooms').select(ROOM_COLUMNS).where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundError('Room', id);
    return r;
  }

  /** A new physical room adds one unit of sellable inventory on every future night, in the same transaction. */
  async create(user: AuthUser, meta: RequestMeta, roomTypeId: string, dto: CreateRoomDto): Promise<PublicRoom> {
    const rt = await this.db.selectFrom('roomTypes').select('propertyId').where('id', '=', roomTypeId).executeTakeFirst();
    if (!rt) throw new NotFoundError('RoomType', roomTypeId);
    try {
      const room = await runInTransaction(this.db, async (tx) => {
        const doc = await tx
          .insertInto('rooms')
          .values({ propertyId: rt.propertyId, roomTypeId, roomNumber: dto.roomNumber.trim(), floor: dto.floor?.trim() ?? null, notes: dto.notes ?? null })
          .returning(ROOM_COLUMNS)
          .executeTakeFirstOrThrow();
        await this.inventory.adjustTotal(rt.propertyId, roomTypeId, +1, user.userId, tx);
        await this.audit.log({ user, meta }, { action: 'room.create', entityType: 'Room', entityId: doc.id, propertyId: rt.propertyId, after: { roomNumber: doc.roomNumber } }, tx);
        return doc;
      });
      void this.outbox.flush();
      return room;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', `Room number ${dto.roomNumber} already exists in this property`);
      throw err;
    }
  }

  async update(user: AuthUser, meta: RequestMeta, id: string, dto: UpdateRoomDto): Promise<PublicRoom> {
    const room = await this.get(id);
    if (room.status === RoomStatus.RETIRED) throw new ConflictError('INVALID_STATE_TRANSITION', 'A retired room cannot be edited; reinstate it first');
    const newTypeId = dto.roomTypeId ? toUuid(dto.roomTypeId, 'roomTypeId') : null;
    const moving = !!newTypeId && newTypeId !== room.roomTypeId;
    if (moving) {
      const target = await this.db.selectFrom('roomTypes').select('id').where('id', '=', newTypeId).where('propertyId', '=', room.propertyId).executeTakeFirst();
      if (!target) throw new DomainValidationError('roomTypeId must be a room type of the same property');
      if (room.status === RoomStatus.OCCUPIED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Check the guest out before changing the room type');
      const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', room.propertyId).executeTakeFirstOrThrow();
      const upcoming = Number(
        (
          await this.db
            .selectFrom('reservations as r')
            .innerJoin('reservationRooms as rr', 'rr.reservationId', 'r.id')
            .select((eb) => eb.fn.count<number>('r.id').distinct().as('n'))
            .where('rr.roomId', '=', room.id)
            .where('r.status', 'in', [...ACTIVE_RESERVATION_STATUSES])
            .where('r.checkOut', '>', d(todayIn(property.timezone)))
            .executeTakeFirstOrThrow()
        ).n,
      );
      if (upcoming) throw new ConflictError('ROOM_ASSIGNMENT_CONFLICT', `Room is assigned to ${upcoming} upcoming reservation(s); reassign them first`);
    }
    try {
      const updated = await runInTransaction(this.db, async (tx) => {
        const { roomTypeId: _t, ...fields } = dto;
        const doc = await tx
          .updateTable('rooms')
          .set({ ...setFrom(fields), ...(moving ? { roomTypeId: newTypeId! } : {}), assignmentVersion: sql`assignment_version + 1` })
          .where('id', '=', id)
          .returning(ROOM_COLUMNS)
          .executeTakeFirstOrThrow();
        if (moving) {
          // Capacity moves between types atomically with the room itself.
          await this.inventory.adjustTotal(room.propertyId, room.roomTypeId, -1, user.userId, tx);
          await this.inventory.adjustTotal(room.propertyId, newTypeId!, +1, user.userId, tx);
        }
        await this.audit.log({ user, meta }, {
          action: moving ? 'room.change_type' : 'room.update',
          entityType: 'Room',
          entityId: id,
          propertyId: room.propertyId,
          before: { roomNumber: room.roomNumber, roomTypeId: room.roomTypeId },
          after: { ...fields, roomTypeId: newTypeId ?? room.roomTypeId },
        }, tx);
        return doc;
      });
      if (moving) void this.outbox.flush();
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', 'Room number already exists in this property');
      throw err;
    }
  }

  /**
   * Housekeeping/maintenance status for today. MAINTENANCE/BLOCKED with `blockUntil` also removes the room from sellable
   * inventory through a room-level inventory block, which channels receive as reduced availability.
   */
  async changeStatus(user: AuthUser, meta: RequestMeta, id: string, dto: ChangeRoomStatusDto) {
    const room = await this.get(id);
    if (room.status === RoomStatus.RETIRED) throw new ConflictError('INVALID_STATE_TRANSITION', 'A retired room has no housekeeping status; reinstate it first');
    if (room.status === RoomStatus.OCCUPIED) {
      throw new ConflictError('INVALID_STATE_TRANSITION', 'An occupied room changes status through check-out');
    }
    let blockId: string | null = null;
    if (dto.blockUntil) {
      if (![RoomStatus.MAINTENANCE, RoomStatus.BLOCKED].includes(dto.status)) {
        throw new DomainValidationError('blockUntil is only valid with MAINTENANCE or BLOCKED');
      }
      const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', room.propertyId).executeTakeFirstOrThrow();
      const block = await this.inventory.createBlock({
        propertyId: room.propertyId,
        roomTypeId: room.roomTypeId,
        roomId: room.id,
        startDate: todayIn(property.timezone),
        endDate: toDateOnly(dto.blockUntil),
        reason: dto.status === RoomStatus.MAINTENANCE ? InventoryBlockReason.MAINTENANCE : InventoryBlockReason.MANUAL_BLOCK,
        notes: dto.notes,
        createdBy: user.userId,
      });
      blockId = block.id;
      void this.outbox.flush();
    }
    const updated = await this.db
      .updateTable('rooms')
      .set({ status: dto.status, ...(dto.notes !== undefined ? { notes: dto.notes } : {}) })
      .where('id', '=', id)
      .where('status', '<>', RoomStatus.OCCUPIED)
      .returning(ROOM_COLUMNS)
      .executeTakeFirst();
    if (!updated) throw new ConflictError('INVALID_STATE_TRANSITION', 'Room was checked into meanwhile');
    await this.audit.log({ user, meta }, {
      action: 'room.status',
      entityType: 'Room',
      entityId: id,
      propertyId: room.propertyId,
      before: { status: room.status },
      after: { status: dto.status, blockUntil: dto.blockUntil ?? null, blockId },
    });
    return { room: updated, inventoryBlockId: blockId };
  }

  // ------------------------------------------------------------ retirement

  /** Why a room cannot be retired right now (empty = it can). Read-only; the retire call checks again under a lock. */
  async retirementCheck(id: string) {
    const room = await this.get(id);
    const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', room.propertyId).executeTakeFirstOrThrow();
    const today = todayIn(property.timezone);
    const [upcoming, blocks] = await Promise.all([this.upcomingReservations(this.db, room.id, today), this.activeBlocks(this.db, room.id, today)]);
    return {
      room,
      canRetire: room.status !== RoomStatus.RETIRED && room.status !== RoomStatus.OCCUPIED && upcoming.length === 0,
      alreadyRetired: room.status === RoomStatus.RETIRED,
      occupied: room.status === RoomStatus.OCCUPIED,
      upcomingReservations: upcoming,
      activeBlocks: blocks.length,
    };
  }

  private upcomingReservations(q: Db, roomId: string, today: Date) {
    return q
      .selectFrom('reservations as r')
      .innerJoin('reservationRooms as rr', 'rr.reservationId', 'r.id')
      .select(['r.id as reservationId', 'r.reservationCode', 'r.status', 'r.checkIn', 'r.checkOut'])
      .where('rr.roomId', '=', roomId)
      .where('r.status', 'in', [...ACTIVE_RESERVATION_STATUSES])
      .where('r.checkOut', '>', d(today))
      .orderBy('r.checkIn')
      .execute();
  }

  private activeBlocks(q: Db, roomId: string, today: Date) {
    return q.selectFrom('inventoryBlocks').select(['id', 'propertyId']).where('roomId', '=', roomId).where('status', '=', InventoryBlockStatus.ACTIVE).where('endDate', '>', d(today)).execute();
  }

  /**
   * Takes the room out of the property for good while keeping its row, so past reservations, reports and the audit trail still
   * point at it. Refused while the room is occupied or assigned to an upcoming reservation (reassign those first: the response
   * lists them). Its capacity leaves the inventory of the room type in the same transaction. Retiring a retired room is a no-op.
   */
  async retire(user: AuthUser, meta: RequestMeta, id: string, dto: RetireRoomDto) {
    const first = await this.retirementCheck(id);
    if (first.alreadyRetired) return first.room;
    this.assertRetirable(first);
    // A maintenance/block window on this room would otherwise keep a unit "blocked" that no longer exists.
    const property = await this.db.selectFrom('properties').select('timezone').where('id', '=', first.room.propertyId).executeTakeFirstOrThrow();
    for (const b of await this.activeBlocks(this.db, id, todayIn(property.timezone))) {
      await this.inventory.releaseBlock(b.propertyId, b.id, user.userId);
    }
    const retired = await runInTransaction(this.db, async (tx) => {
      // The same lock room assignment takes: a concurrent assignment of this room queues behind us (or we behind it) and is re-checked.
      const locked = await tx.updateTable('rooms').set({ assignmentVersion: sql`assignment_version + 1` }).where('id', '=', id).returning(['id', 'propertyId', 'roomTypeId', 'status']).executeTakeFirst();
      if (!locked) throw new NotFoundError('Room', id);
      if (locked.status === RoomStatus.RETIRED) return null;
      const today = todayIn(property.timezone);
      const upcoming = await this.upcomingReservations(tx, id, today);
      this.assertRetirable({ occupied: locked.status === RoomStatus.OCCUPIED, upcomingReservations: upcoming });
      await this.inventory.adjustTotal(locked.propertyId, locked.roomTypeId, -1, user.userId, tx);
      const doc = await tx
        .updateTable('rooms')
        .set({ status: RoomStatus.RETIRED, retiredAt: new Date(), retiredReason: dto.reason.trim(), retiredBy: user.userId })
        .where('id', '=', id)
        .returning(ROOM_COLUMNS)
        .executeTakeFirstOrThrow();
      await this.audit.log({ user, meta }, { action: 'room.retire', entityType: 'Room', entityId: id, propertyId: locked.propertyId, before: { status: locked.status }, after: { status: RoomStatus.RETIRED, reason: dto.reason.trim() } }, tx);
      return doc;
    });
    void this.outbox.flush();
    return retired ?? (await this.get(id));
  }

  /** Puts a retired room back: its capacity returns to the room type's inventory. Its number must still be free. */
  async reinstate(user: AuthUser, meta: RequestMeta, id: string) {
    const room = await this.get(id);
    if (room.status !== RoomStatus.RETIRED) return room;
    try {
      const doc = await runInTransaction(this.db, async (tx) => {
        const locked = await tx.updateTable('rooms').set({ assignmentVersion: sql`assignment_version + 1` }).where('id', '=', id).where('status', '=', RoomStatus.RETIRED).returning(['id', 'propertyId', 'roomTypeId']).executeTakeFirst();
        if (!locked) return null;
        await this.inventory.adjustTotal(locked.propertyId, locked.roomTypeId, +1, user.userId, tx);
        const back = await tx
          .updateTable('rooms')
          .set({ status: RoomStatus.AVAILABLE, retiredAt: null, retiredReason: null, retiredBy: null })
          .where('id', '=', id)
          .returning(ROOM_COLUMNS)
          .executeTakeFirstOrThrow();
        await this.audit.log({ user, meta }, { action: 'room.reinstate', entityType: 'Room', entityId: id, propertyId: locked.propertyId }, tx);
        return back;
      });
      void this.outbox.flush();
      return doc ?? (await this.get(id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE', `Room number ${room.roomNumber} is now used by another room; rename that room first`);
      throw err;
    }
  }

  private assertRetirable(c: { occupied: boolean; upcomingReservations: { reservationCode: string; checkIn: Date; checkOut: Date; status: string }[] }) {
    if (c.occupied) throw new ConflictError('INVALID_STATE_TRANSITION', 'A guest is in this room. Check them out before retiring it');
    if (c.upcomingReservations.length) {
      throw new ConflictError('ROOM_HAS_FUTURE_BOOKINGS', `This room is assigned to ${c.upcomingReservations.length} upcoming reservation(s). Reassign them to another room, then retire it.`, {
        reservations: c.upcomingReservations.map((r) => ({
          reservationCode: r.reservationCode,
          status: r.status,
          checkIn: r.checkIn.toISOString().slice(0, 10),
          checkOut: r.checkOut.toISOString().slice(0, 10),
        })),
      });
    }
  }
}
