import { Schema, Types } from 'mongoose';
import { COLLECTION, MAX_STAY_NIGHTS, MODEL } from '../constants';
import { eachNight, nightsBetween } from '../common/dates';
import { sum } from '../common/money';
import {
  baseSchemaOptions,
  boundedArray,
  count,
  currency,
  dateOnly,
  email,
  enumOf,
  money,
  objectId,
  phone,
} from '../common/schema-helpers';
import {
  MealPlan,
  OTA_SOURCES,
  RatePlanType,
  ReservationPaymentStatus,
  ReservationSource,
  ReservationStatus,
} from '../enums';
import { CancellationPolicy, CancellationPolicySchema } from './property.schema';

// ---------------------------------------------------------------- embedded types

export interface NightlyRate {
  date: Date;
  /** Price of one room for this night, minor units, frozen at booking time. */
  amount: number;
}

const NightlyRateSchema = new Schema<NightlyRate>(
  { date: dateOnly(), amount: money() },
  { _id: false, strict: 'throw', versionKey: false },
);

/** Frozen copy of the rate plan as sold. Later edits to rate_plans never touch it. */
export interface RatePlanSnapshot {
  code: string;
  name: string;
  type: RatePlanType;
  mealPlan: MealPlan;
  cancellationPolicy: CancellationPolicy;
}

const RatePlanSnapshotSchema = new Schema<RatePlanSnapshot>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    type: enumOf(RatePlanType),
    mealPlan: enumOf(MealPlan),
    cancellationPolicy: { type: CancellationPolicySchema, required: true },
  },
  { _id: false, strict: 'throw', versionKey: false },
);

export interface ReservationRoom {
  _id: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  roomTypeName: string;
  /** Physical room; null until assigned. Must be null when quantity > 1. */
  roomId: Types.ObjectId | null;
  roomNumber: string | null;
  quantity: number;
  /** Null for OTA bookings whose external rate plan is not mapped. */
  ratePlanId: Types.ObjectId | null;
  ratePlan: RatePlanSnapshot | null;
  nightlyRates: NightlyRate[];
  /** sum(nightlyRates.amount) * quantity */
  subtotal: number;
  tax: number;
  /** subtotal + tax */
  total: number;
}

const ReservationRoomSchema = new Schema<ReservationRoom>(
  {
    roomTypeId: objectId(MODEL.RoomType),
    roomTypeName: { type: String, required: true },
    roomId: objectId(MODEL.Room, false),
    roomNumber: { type: String, default: null },
    quantity: { ...count(true, 1), max: 100 },
    ratePlanId: objectId(MODEL.RatePlan, false),
    ratePlan: { type: RatePlanSnapshotSchema, default: null },
    nightlyRates: { type: [NightlyRateSchema], required: true, validate: boundedArray(MAX_STAY_NIGHTS) },
    subtotal: money(),
    tax: money(),
    total: money(),
  },
  // _id is kept: it is the stable handle for "assign a room to line X".
  { _id: true, strict: 'throw', versionKey: false },
);

export interface GuestSnapshot {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

const GuestSnapshotSchema = new Schema<GuestSnapshot>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: '' },
    email: email(),
    phone: phone(),
  },
  { _id: false, strict: 'throw', versionKey: false },
);

export interface StatusChange {
  status: ReservationStatus;
  at: Date;
  by: Types.ObjectId | null;
  reason?: string;
}

const StatusChangeSchema = new Schema<StatusChange>(
  {
    status: enumOf(ReservationStatus),
    at: { type: Date, required: true },
    by: objectId(MODEL.User, false),
    reason: { type: String, maxlength: 500 },
  },
  { _id: false, strict: 'throw', versionKey: false },
);

// ---------------------------------------------------------------- reservation

export interface Reservation {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  /** Human-facing code, e.g. TRV-7K3M9QXD. Globally unique. */
  reservationCode: string;
  source: ReservationSource;
  /** The booking's ID on the source channel. Unique per source when present. */
  externalReservationId?: string;
  channelListingId: Types.ObjectId | null;
  /** Client-supplied key that makes direct-booking retries safe (double-click, network retry). */
  idempotencyKey?: string;
  status: ReservationStatus;
  guestId: Types.ObjectId;
  guest: GuestSnapshot;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  adults: number;
  children: number;
  specialRequests?: string;
  reservationRooms: ReservationRoom[];
  subtotal: number;
  tax: number;
  /** Post-tax adjustment. To discount pre-tax, lower the nightly rates instead. */
  discount: number;
  total: number;
  currency: string;
  amountPaid: number;
  amountRefunded: number;
  paymentStatus: ReservationPaymentStatus;
  /** Unpaid PENDING bookings release their inventory after this instant. */
  holdExpiresAt: Date | null;
  /** True when an OTA booking landed on zero availability (see inventory.overbooked). */
  overbooked: boolean;
  /**
   * Nights on or after this date have been handed back to inventory (cancellation,
   * no-show, early check-out). Null while every night is held. Inventory held by a
   * reservation is therefore [checkIn, min(checkOut, inventoryReleasedFrom)).
   */
  inventoryReleasedFrom: Date | null;
  checkedInAt?: Date;
  checkedOutAt?: Date;
  statusHistory: StatusChange[];
  cancelledAt?: Date;
  cancellationReason?: string;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ReservationSchema = new Schema<Reservation>(
  {
    propertyId: objectId(MODEL.Property),
    reservationCode: { type: String, required: true, uppercase: true, match: /^TRV-[0-9A-Z]{8}$/ },
    source: enumOf(ReservationSource),
    // No default: the partial unique index only covers documents where it is a string.
    externalReservationId: { type: String, trim: true, maxlength: 100 },
    channelListingId: objectId(MODEL.ChannelListing, false),
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
    status: enumOf(ReservationStatus, true, ReservationStatus.PENDING),
    guestId: objectId(MODEL.Guest),
    guest: { type: GuestSnapshotSchema, required: true },
    checkIn: dateOnly(),
    checkOut: dateOnly(),
    nights: { ...count(true, 1), max: MAX_STAY_NIGHTS },
    adults: { ...count(true, 1), max: 100 },
    children: { ...count(true, 0), max: 100, default: 0 },
    specialRequests: { type: String, trim: true, maxlength: 2000 },
    reservationRooms: {
      type: [ReservationRoomSchema],
      required: true,
      validate: [
        { validator: (v: unknown[]) => v.length > 0, message: 'A reservation needs at least one room' },
        boundedArray(50),
      ],
    },
    subtotal: money(),
    tax: money(),
    discount: money(false),
    total: money(),
    currency: currency(),
    amountPaid: money(false),
    amountRefunded: money(false),
    paymentStatus: enumOf(ReservationPaymentStatus, true, ReservationPaymentStatus.UNPAID),
    holdExpiresAt: { type: Date, default: null },
    overbooked: { type: Boolean, default: false },
    inventoryReleasedFrom: dateOnly(false),
    checkedInAt: { type: Date },
    checkedOutAt: { type: Date },
    statusHistory: { type: [StatusChangeSchema], default: [], validate: boundedArray(50) },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
    createdBy: objectId(MODEL.User, false),
  },
  baseSchemaOptions(COLLECTION.reservations),
);

/**
 * Financial and calendar consistency. Runs on create()/save(); every write
 * that changes money or dates goes through ReservationService, which uses
 * create()/save() for exactly that reason.
 */
ReservationSchema.pre('validate', function () {
  if (!this.checkIn || !this.checkOut) return; // `required` reports it
  const nights = nightsBetween(this.checkIn, this.checkOut);
  if (nights < 1) {
    this.invalidate('checkOut', 'checkOut must be after checkIn');
    return;
  }
  if (nights > MAX_STAY_NIGHTS) {
    this.invalidate('checkOut', `Stay cannot exceed ${MAX_STAY_NIGHTS} nights`);
    return;
  }
  if (this.nights !== nights) this.invalidate('nights', `nights must equal ${nights}`);

  if (OTA_SOURCES.has(this.source) && !this.externalReservationId) {
    this.invalidate('externalReservationId', `externalReservationId is required for ${this.source} reservations`);
  }

  const expectedNights = eachNight(this.checkIn, this.checkOut).map((d) => d.getTime());
  this.reservationRooms.forEach((line, i) => {
    const path = `reservationRooms.${i}`;
    const dates = line.nightlyRates.map((r) => r.date.getTime());
    if (dates.length !== expectedNights.length || dates.some((t, j) => t !== expectedNights[j])) {
      this.invalidate(`${path}.nightlyRates`, 'nightlyRates must contain exactly one entry per night, in order');
    }
    if (line.roomId && line.quantity !== 1) {
      this.invalidate(`${path}.roomId`, 'A physical room can only be assigned to a line with quantity 1');
    }
    if (line.subtotal !== sum(line.nightlyRates.map((r) => r.amount)) * line.quantity) {
      this.invalidate(`${path}.subtotal`, 'subtotal must equal sum(nightlyRates) * quantity');
    }
    if (line.total !== line.subtotal + line.tax) this.invalidate(`${path}.total`, 'total must equal subtotal + tax');
  });

  if (this.subtotal !== sum(this.reservationRooms.map((l) => l.subtotal))) {
    this.invalidate('subtotal', 'subtotal must equal the sum of room subtotals');
  }
  if (this.tax !== sum(this.reservationRooms.map((l) => l.tax))) {
    this.invalidate('tax', 'tax must equal the sum of room taxes');
  }
  if (this.discount > this.subtotal + this.tax) this.invalidate('discount', 'discount cannot exceed subtotal + tax');
  if (this.total !== this.subtotal + this.tax - this.discount) {
    this.invalidate('total', 'total must equal subtotal + tax - discount');
  }
  if (this.amountRefunded > this.amountPaid) this.invalidate('amountRefunded', 'Cannot refund more than was paid');
});

// Human-facing lookup (front desk, guest emails).
ReservationSchema.index({ reservationCode: 1 }, { unique: true });

// OTA idempotency: AIRBNB + ABC123 can exist exactly once. Partial, so the many
// direct/walk-in bookings without an external ID are not indexed at all.
ReservationSchema.index(
  { source: 1, externalReservationId: 1 },
  { unique: true, partialFilterExpression: { externalReservationId: { $type: 'string' } } },
);

// Direct-booking idempotency (client retries).
ReservationSchema.index(
  { propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

// Date-overlap queries: calendar, occupancy, "who is in-house on X".
ReservationSchema.index({ propertyId: 1, checkIn: 1, checkOut: 1 });

// Status boards: today's arrivals (CONFIRMED, checkIn = today), in-house (CHECKED_IN), pending holds.
ReservationSchema.index({ propertyId: 1, status: 1, checkIn: 1 });

// Room assignment conflicts and the room-by-room tape chart. Multikey over the embedded lines.
ReservationSchema.index({ 'reservationRooms.roomId': 1, checkIn: 1 });

// Guest stay history.
ReservationSchema.index({ guestId: 1, checkIn: -1 });

// Sweeper for expired unpaid holds. Partial, so only PENDING docs are indexed.
ReservationSchema.index(
  { holdExpiresAt: 1 },
  { partialFilterExpression: { status: ReservationStatus.PENDING, holdExpiresAt: { $type: 'date' } } },
);
