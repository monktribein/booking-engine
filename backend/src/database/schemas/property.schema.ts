import { Schema, Types } from 'mongoose';
import { COLLECTION, DEFAULT_BOOKING_HORIZON_DAYS, MODEL } from '../constants';
import { isValidTimeZone } from '../common/dates';
import {
  HHMM_RE,
  ImageSchema,
  baseSchemaOptions,
  boundedArray,
  count,
  currency,
  enumOf,
  money,
  objectId,
  slug,
} from '../common/schema-helpers';
import {
  CancellationPenaltyType,
  MealPlan,
  PropertyStatus,
  RatePlanStatus,
  RatePlanType,
  RoomStatus,
  RoomTypeStatus,
} from '../enums';

export interface Image {
  url: string;
  caption?: string;
  sortOrder: number;
}

// ================================================================ properties

export interface Property {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  address: string;
  city: string;
  state: string;
  /** ISO-3166-1 alpha-2. */
  country: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  /** IANA zone. Defines what "today" and every inventory date mean for this property. */
  timezone: string;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  /** Flat tax rate applied to room revenue. Replace with a tax-rule engine when multi-slab rules are needed. */
  taxPercent: number;
  /** Days ahead for which inventory rows are materialised and sellable. */
  bookingHorizonDays: number;
  images: Image[];
  amenities: string[];
  status: PropertyStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const PropertySchema = new Schema<Property>(
  {
    organizationId: objectId(MODEL.Organization),
    ownerId: objectId(MODEL.User),
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: slug(),
    description: { type: String, trim: true, maxlength: 5000 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    country: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z]{2}$/ },
    postalCode: { type: String, required: true, trim: true, maxlength: 20 },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    timezone: {
      type: String,
      required: true,
      validate: { validator: isValidTimeZone, message: '{VALUE} is not a valid IANA time zone' },
    },
    currency: currency(),
    checkInTime: { type: String, required: true, match: HHMM_RE, default: '14:00' },
    checkOutTime: { type: String, required: true, match: HHMM_RE, default: '11:00' },
    taxPercent: { type: Number, required: true, min: 0, max: 100, default: 0 },
    bookingHorizonDays: { ...count(true, 1), max: 730, default: DEFAULT_BOOKING_HORIZON_DAYS },
    images: { type: [ImageSchema], default: [], validate: boundedArray(50) },
    amenities: { type: [{ type: String, trim: true, maxlength: 60 }], default: [], validate: boundedArray(100) },
    status: enumOf(PropertyStatus, true, PropertyStatus.DRAFT),
  },
  baseSchemaOptions(COLLECTION.properties),
);

PropertySchema.pre('validate', function () {
  if ((this.latitude == null) !== (this.longitude == null)) {
    this.invalidate('latitude', 'latitude and longitude must be set together');
  }
});

// Unique per tenant; the organizationId prefix also serves "all properties of an org".
PropertySchema.index({ organizationId: 1, slug: 1 }, { unique: true });
PropertySchema.index({ ownerId: 1 });
// Public direct-booking URLs (/public/properties/:slug) resolve by slug, so it is unique platform-wide.
PropertySchema.index({ slug: 1 }, { unique: true });

// ================================================================ room_types

export interface RoomType {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  maxOccupancy: number;
  /** Rack rate in minor units; rate plans price from their own basePrice. */
  basePrice: number;
  currency: string;
  /**
   * Denormalised count of active physical rooms. It seeds `inventory.total` for
   * newly materialised dates. Changing it goes through InventoryService.adjustTotal.
   */
  totalRooms: number;
  amenities: string[];
  images: Image[];
  sortOrder: number;
  status: RoomTypeStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const RoomTypeSchema = new Schema<RoomType>(
  {
    propertyId: objectId(MODEL.Property),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: slug(),
    description: { type: String, trim: true, maxlength: 5000 },
    maxOccupancy: { ...count(true, 1), max: 50 },
    basePrice: money(),
    currency: currency(),
    totalRooms: { ...count(true, 0), max: 5000 },
    amenities: { type: [{ type: String, trim: true, maxlength: 60 }], default: [], validate: boundedArray(100) },
    images: { type: [ImageSchema], default: [], validate: boundedArray(50) },
    sortOrder: { type: Number, default: 0 },
    status: enumOf(RoomTypeStatus, true, RoomTypeStatus.ACTIVE),
  },
  baseSchemaOptions(COLLECTION.roomTypes),
);

RoomTypeSchema.index({ propertyId: 1, slug: 1 }, { unique: true });

// ================================================================ rooms (physical)

export interface Room {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  roomNumber: string;
  floor?: string;
  status: RoomStatus;
  notes?: string;
  /**
   * Bumped by every room-assignment and room-level block transaction. Two
   * concurrent transactions that assign the same room then write the same
   * document, so MongoDB raises a WriteConflict and one of them retries and
   * sees the other's assignment. Without it, two transactions could each read
   * "no overlap" and both commit (write skew).
   */
  assignmentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export const RoomSchema = new Schema<Room>(
  {
    propertyId: objectId(MODEL.Property),
    roomTypeId: objectId(MODEL.RoomType),
    roomNumber: { type: String, required: true, trim: true, maxlength: 20 },
    floor: { type: String, trim: true, maxlength: 20 },
    status: enumOf(RoomStatus, true, RoomStatus.AVAILABLE),
    notes: { type: String, trim: true, maxlength: 2000 },
    assignmentVersion: { type: Number, default: 0 },
  },
  baseSchemaOptions(COLLECTION.rooms),
);

RoomSchema.index({ propertyId: 1, roomNumber: 1 }, { unique: true });
// Rooms of a type (room assignment picker, housekeeping board by type).
RoomSchema.index({ roomTypeId: 1, status: 1 });

// ================================================================ rate_plans

export interface CancellationPolicy {
  refundable: boolean;
  /** Free cancellation until this many hours before local check-in time. */
  freeCancellationHours: number;
  /** What the guest forfeits after the free window closes. */
  penaltyType: CancellationPenaltyType;
  /** Percentage (0-100) for PERCENTAGE; ignored otherwise. */
  penaltyValue: number;
  description?: string;
}

export const CancellationPolicySchema = new Schema<CancellationPolicy>(
  {
    refundable: { type: Boolean, required: true },
    freeCancellationHours: { ...count(true, 0), max: 24 * 365, default: 0 },
    penaltyType: enumOf(CancellationPenaltyType, true, CancellationPenaltyType.NONE),
    penaltyValue: { type: Number, min: 0, max: 100, default: 0 },
    description: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false, strict: 'throw', versionKey: false },
);

export interface RatePlan {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomTypeId: Types.ObjectId;
  name: string;
  code: string;
  type: RatePlanType;
  /** Per room per night, in minor units. */
  basePrice: number;
  currency: string;
  mealPlan: MealPlan;
  cancellationPolicy: CancellationPolicy;
  status: RatePlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const RatePlanSchema = new Schema<RatePlan>(
  {
    propertyId: objectId(MODEL.Property),
    roomTypeId: objectId(MODEL.RoomType),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40, match: /^[A-Z0-9_-]+$/ },
    type: enumOf(RatePlanType, true, RatePlanType.STANDARD),
    basePrice: money(),
    currency: currency(),
    mealPlan: enumOf(MealPlan, true, MealPlan.ROOM_ONLY),
    cancellationPolicy: { type: CancellationPolicySchema, required: true },
    status: enumOf(RatePlanStatus, true, RatePlanStatus.ACTIVE),
  },
  baseSchemaOptions(COLLECTION.ratePlans),
);

RatePlanSchema.pre('validate', function () {
  if (this.type === RatePlanType.NON_REFUNDABLE && this.cancellationPolicy?.refundable) {
    this.invalidate('cancellationPolicy.refundable', 'NON_REFUNDABLE rate plans cannot have a refundable policy');
  }
});

RatePlanSchema.index({ propertyId: 1, roomTypeId: 1, code: 1 }, { unique: true });
