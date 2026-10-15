import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { toObjectId } from '../../common/utils';
import { todayIn, toDateOnly } from '../../database/common/dates';
import { isDuplicateKeyError } from '../../database/common/schema-helpers';
import { runInTransaction } from '../../database/common/transaction';
import { ACTIVE_RESERVATION_STATUSES, InventoryBlockReason, RoomStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Room } from '../../database/schemas/property.schema';
import { InventoryService } from '../../database/services/inventory.service';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import type { ChangeRoomStatusDto, CreateRoomDto, UpdateRoomDto } from './rooms.dto';

@Injectable()
export class RoomsService {
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  list(roomTypeId: Types.ObjectId): Promise<Room[]> {
    return this.m.Room.find({ roomTypeId }, { assignmentVersion: 0 }).sort({ roomNumber: 1 }).lean();
  }

  async get(id: Types.ObjectId): Promise<Room> {
    const r = await this.m.Room.findById(id, { assignmentVersion: 0 }).lean();
    if (!r) throw new NotFoundError('Room', id);
    return r;
  }

  /** A new physical room adds one unit of sellable inventory on every future night, in the same transaction. */
  async create(user: AuthUser, meta: RequestMeta, roomTypeId: Types.ObjectId, dto: CreateRoomDto): Promise<Room> {
    const rt = await this.m.RoomType.findById(roomTypeId, { propertyId: 1 }).lean();
    if (!rt) throw new NotFoundError('RoomType', roomTypeId);
    try {
      const room = await runInTransaction(this.connection, async (session) => {
        const [doc] = await this.m.Room.create([{ ...dto, propertyId: rt.propertyId, roomTypeId }], { session });
        await this.inventory.adjustTotal(rt.propertyId, roomTypeId, +1, user.userId, session);
        await this.audit.log({ user, meta }, { action: 'room.create', entityType: 'Room', entityId: doc._id, propertyId: rt.propertyId, after: { roomNumber: doc.roomNumber } }, session);
        return doc.toObject();
      });
      void this.outbox.flush();
      return room;
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', `Room number ${dto.roomNumber} already exists in this property`);
      throw err;
    }
  }

  async update(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: UpdateRoomDto): Promise<Room> {
    const room = await this.get(id);
    const newTypeId = dto.roomTypeId ? toObjectId(dto.roomTypeId, 'roomTypeId') : null;
    const moving = newTypeId && !newTypeId.equals(room.roomTypeId);
    if (moving) {
      const target = await this.m.RoomType.findOne({ _id: newTypeId, propertyId: room.propertyId }, { _id: 1 }).lean();
      if (!target) throw new DomainValidationError('roomTypeId must be a room type of the same property');
      if (room.status === RoomStatus.OCCUPIED) throw new ConflictError('INVALID_STATE_TRANSITION', 'Check the guest out before changing the room type');
      const property = await this.m.Property.findById(room.propertyId, { timezone: 1 }).lean();
      const upcoming = await this.m.Reservation.countDocuments({
        'reservationRooms.roomId': room._id,
        status: { $in: [...ACTIVE_RESERVATION_STATUSES] },
        checkOut: { $gt: todayIn(property!.timezone) },
      });
      if (upcoming) throw new ConflictError('ROOM_ASSIGNMENT_CONFLICT', `Room is assigned to ${upcoming} upcoming reservation(s); reassign them first`);
    }
    try {
      const updated = await runInTransaction(this.connection, async (session) => {
        const { roomTypeId: _t, ...fields } = dto;
        const doc = await this.m.Room.findByIdAndUpdate(
          id,
          { $set: { ...fields, ...(moving ? { roomTypeId: newTypeId } : {}) }, $inc: { assignmentVersion: 1 } },
          { new: true, runValidators: true, session },
        ).lean();
        if (moving) {
          // Capacity moves between types atomically with the room itself.
          await this.inventory.adjustTotal(room.propertyId, room.roomTypeId, -1, user.userId, session);
          await this.inventory.adjustTotal(room.propertyId, newTypeId!, +1, user.userId, session);
        }
        await this.audit.log({ user, meta }, {
          action: moving ? 'room.change_type' : 'room.update',
          entityType: 'Room',
          entityId: id,
          propertyId: room.propertyId,
          before: { roomNumber: room.roomNumber, roomTypeId: room.roomTypeId },
          after: { ...fields, roomTypeId: newTypeId ?? room.roomTypeId },
        }, session);
        return doc!;
      });
      if (moving) void this.outbox.flush();
      return updated;
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('DUPLICATE', 'Room number already exists in this property');
      throw err;
    }
  }

  /**
   * Housekeeping/maintenance status for today. MAINTENANCE/BLOCKED with
   * `blockUntil` also removes the room from sellable inventory through a
   * room-level inventory block, which channels receive as reduced availability.
   */
  async changeStatus(user: AuthUser, meta: RequestMeta, id: Types.ObjectId, dto: ChangeRoomStatusDto) {
    const room = await this.get(id);
    if (room.status === RoomStatus.OCCUPIED) {
      throw new ConflictError('INVALID_STATE_TRANSITION', 'An occupied room changes status through check-out');
    }
    let blockId: Types.ObjectId | null = null;
    if (dto.blockUntil) {
      if (![RoomStatus.MAINTENANCE, RoomStatus.BLOCKED].includes(dto.status)) {
        throw new DomainValidationError('blockUntil is only valid with MAINTENANCE or BLOCKED');
      }
      const property = await this.m.Property.findById(room.propertyId, { timezone: 1 }).lean();
      const block = await this.inventory.createBlock({
        propertyId: room.propertyId,
        roomTypeId: room.roomTypeId,
        roomId: room._id,
        startDate: todayIn(property!.timezone),
        endDate: toDateOnly(dto.blockUntil),
        reason: dto.status === RoomStatus.MAINTENANCE ? InventoryBlockReason.MAINTENANCE : InventoryBlockReason.MANUAL_BLOCK,
        notes: dto.notes,
        createdBy: user.userId,
      });
      blockId = block._id;
      void this.outbox.flush();
    }
    const updated = await this.m.Room.findOneAndUpdate(
      { _id: id, status: { $ne: RoomStatus.OCCUPIED } },
      { $set: { status: dto.status, ...(dto.notes !== undefined ? { notes: dto.notes } : {}) } },
      { new: true, projection: { assignmentVersion: 0 } },
    ).lean();
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
}
