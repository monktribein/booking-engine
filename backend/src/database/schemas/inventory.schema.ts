import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { baseSchemaOptions, count, dateOnly, enumOf, objectId } from '../common/schema-helpers';
import { InventoryBlockReason, InventoryBlockStatus } from '../enums';

// ================================================================ inventory

/**
 * One document per (property, room type, night): the master inventory that
 * every channel sells from.
 *
 * Invariant, enforced by a server-side collection validator (scripts/setup-db.ts):
 *
 *     available + sold + blocked == total + overbooked,  all counters >= 0
 *
 * `overbooked` counts rooms sold beyond capacity. That happens only when an
 * OTA delivers a booking that already exists on its side while our inventory
 * is 0 (sync lag). Direct/PMS bookings can never overbook.
 *
 * All counter changes go through InventoryService using conditional updates
 * inside transactions. Never $set these counters from application code.
 */
export interface Inventory {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  date: Date;
  total: number;
  sold: number;
  blocked: number;
  available: number;
  overbooked: number;
  /** Mirrors restrictions.stopSell || restrictions.closed so the booking filter is a single-document check. */
  stopSell: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const InventorySchema = new Schema<Inventory>(
  {
    propertyId: objectId(MODEL.Property),
    roomTypeId: objectId(MODEL.RoomType),
    date: dateOnly(),
    total: count(),
    sold: { ...count(), default: 0 },
    blocked: { ...count(), default: 0 },
    available: count(),
    overbooked: { ...count(), default: 0 },
    stopSell: { type: Boolean, default: false },
  },
  baseSchemaOptions(COLLECTION.inventory),
);

InventorySchema.pre('validate', function () {
  if (this.available + this.sold + this.blocked !== this.total + this.overbooked) {
    this.invalidate('available', 'available + sold + blocked must equal total + overbooked');
  }
});

// THE inventory key: one row per room type per night, and the index behind
// every booking, availability and calendar query. Calendar reads for a whole
// property use its propertyId prefix plus date bounds, so no separate
// {propertyId, date} index is needed.
InventorySchema.index({ propertyId: 1, roomTypeId: 1, date: 1 }, { unique: true });

// ================================================================ inventory_blocks

export interface InventoryBlock {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  /** Set when a specific physical room is taken out (quantity must then be 1). */
  roomId: Types.ObjectId | null;
  startDate: Date;
  /** Exclusive: the block covers nights startDate .. endDate-1. */
  endDate: Date;
  quantity: number;
  reason: InventoryBlockReason;
  notes?: string;
  status: InventoryBlockStatus;
  createdBy: Types.ObjectId | null;
  releasedAt?: Date;
  releasedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const InventoryBlockSchema = new Schema<InventoryBlock>(
  {
    propertyId: objectId(MODEL.Property),
    roomTypeId: objectId(MODEL.RoomType),
    roomId: objectId(MODEL.Room, false),
    startDate: dateOnly(),
    endDate: dateOnly(),
    quantity: { ...count(true, 1), max: 5000 },
    reason: enumOf(InventoryBlockReason),
    notes: { type: String, trim: true, maxlength: 2000 },
    status: enumOf(InventoryBlockStatus, true, InventoryBlockStatus.ACTIVE),
    createdBy: objectId(MODEL.User, false),
    releasedAt: { type: Date },
    releasedBy: objectId(MODEL.User, false),
  },
  baseSchemaOptions(COLLECTION.inventoryBlocks),
);

InventoryBlockSchema.pre('validate', function () {
  if (this.endDate <= this.startDate) this.invalidate('endDate', 'endDate must be after startDate');
  if (this.roomId && this.quantity !== 1) this.invalidate('quantity', 'A room-level block must have quantity 1');
});

// Calendar overlay: blocks for a property/type that overlap a window.
InventoryBlockSchema.index({ propertyId: 1, roomTypeId: 1, startDate: 1, endDate: 1 });
// Room-assignment conflict checks, only for room-level blocks.
InventoryBlockSchema.index(
  { roomId: 1, startDate: 1 },
  { partialFilterExpression: { roomId: { $type: 'objectId' } } },
);

// ================================================================ restrictions

/**
 * Per-night sell rules for a room type. A missing document means "no
 * restrictions". Rows are sparse: only nights with a rule exist.
 */
export interface Restriction {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  date: Date;
  /** Evaluated on the arrival date, the usual channel-manager convention. */
  minimumStay: number | null;
  maximumStay: number | null;
  /** Closed on every channel for this night (hard close). */
  closed: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const RestrictionSchema = new Schema<Restriction>(
  {
    propertyId: objectId(MODEL.Property),
    roomTypeId: objectId(MODEL.RoomType),
    date: dateOnly(),
    minimumStay: { ...count(false, 1), max: 365, default: null },
    maximumStay: { ...count(false, 1), max: 365, default: null },
    closed: { type: Boolean, default: false },
    closedToArrival: { type: Boolean, default: false },
    closedToDeparture: { type: Boolean, default: false },
    stopSell: { type: Boolean, default: false },
  },
  baseSchemaOptions(COLLECTION.restrictions),
);

RestrictionSchema.pre('validate', function () {
  if (this.minimumStay != null && this.maximumStay != null && this.maximumStay < this.minimumStay) {
    this.invalidate('maximumStay', 'maximumStay must be >= minimumStay');
  }
});

RestrictionSchema.index({ propertyId: 1, roomTypeId: 1, date: 1 }, { unique: true });
