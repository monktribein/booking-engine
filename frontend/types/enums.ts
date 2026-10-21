/**
 * Enums matching Tirvona NestJS backend specifications
 */

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  OPERATIONS_ADMIN = 'OPERATIONS_ADMIN',
  PROPERTY_OWNER = 'PROPERTY_OWNER',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  STAFF = 'STAFF',
  RECEPTION = 'RECEPTION',
  DEVELOPER = 'DEVELOPER',
}

/** Where a partner organization stands with the platform. */
export enum OrganizationStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

export enum MarketplaceStatus {
  NOT_LISTED = 'NOT_LISTED',
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INVITED = 'INVITED',
  SUSPENDED = 'SUSPENDED',
  DISABLED = 'DISABLED',
}

export enum PropertyUserRole {
  PROPERTY_OWNER = 'PROPERTY_OWNER',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  STAFF = 'STAFF',
  RECEPTION = 'RECEPTION',
}

export enum PropertyStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum RoomTypeStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum RoomStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  CLEANING = 'CLEANING',
  MAINTENANCE = 'MAINTENANCE',
  BLOCKED = 'BLOCKED',
  /** Permanently out of the inventory; history is kept. */
  RETIRED = 'RETIRED',
}

export enum RatePlanType {
  STANDARD = 'STANDARD',
  NON_REFUNDABLE = 'NON_REFUNDABLE',
  BREAKFAST = 'BREAKFAST',
  CUSTOM = 'CUSTOM',
}

export enum MealPlan {
  ROOM_ONLY = 'ROOM_ONLY',
  BREAKFAST = 'BREAKFAST',
  HALF_BOARD = 'HALF_BOARD',
  FULL_BOARD = 'FULL_BOARD',
  ALL_INCLUSIVE = 'ALL_INCLUSIVE',
}

export enum CancellationPenaltyType {
  NONE = 'NONE',
  FIRST_NIGHT = 'FIRST_NIGHT',
  PERCENTAGE = 'PERCENTAGE',
  FULL_STAY = 'FULL_STAY',
}

export enum InventoryBlockReason {
  MAINTENANCE = 'MAINTENANCE',
  PRIVATE_EVENT = 'PRIVATE_EVENT',
  OWNER_BLOCK = 'OWNER_BLOCK',
  MANUAL_BLOCK = 'MANUAL_BLOCK',
  OTHER = 'OTHER',
}

export enum InventoryBlockStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
}

export enum ReservationSource {
  TIRVONA = 'TIRVONA',
  DIRECT = 'DIRECT',
  API = 'API',
  AIRBNB = 'AIRBNB',
  BOOKING_COM = 'BOOKING_COM',
  AGODA = 'AGODA',
  WALK_IN = 'WALK_IN',
  PHONE = 'PHONE',
  AGENT = 'AGENT',
  OTHER = 'OTHER',
  MOCK = 'MOCK',
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  CHECKED_IN = 'CHECKED_IN',
  CHECKED_OUT = 'CHECKED_OUT',
  NO_SHOW = 'NO_SHOW',
}

export enum ReservationPaymentStatus {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  CHANNEL_COLLECTED = 'CHANNEL_COLLECTED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  /** A channel booking whose payment the channel has not reported and nobody recorded here. Never read it as paid or unpaid. */
  UNKNOWN = 'UNKNOWN',
}

export enum PaymentProvider {
  RAZORPAY = 'RAZORPAY',
  CASH = 'CASH',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CHANNEL_COLLECTED = 'CHANNEL_COLLECTED',
  OTHER = 'OTHER',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  PAID = 'PAID',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum RefundStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export enum ChannelCode {
  TIRVONA = 'TIRVONA',
  DIRECT = 'DIRECT',
  AIRBNB = 'AIRBNB',
  BOOKING_COM = 'BOOKING_COM',
  AGODA = 'AGODA',
  OTHER = 'OTHER',
  MOCK = 'MOCK',
}

export enum ChannelKind {
  MARKETPLACE = 'MARKETPLACE',
  DIRECT = 'DIRECT',
  OTA = 'OTA',
}

export enum ChannelConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
  EXPIRED = 'EXPIRED',
}

export enum ChannelListingStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum MappingStatus {
  MAPPED = 'MAPPED',
  UNMAPPED = 'UNMAPPED',
  CONFLICT = 'CONFLICT',
  ERROR = 'ERROR',
}

export enum MarkupType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
  NONE = 'NONE',
}

export enum SyncJobType {
  INVENTORY = 'INVENTORY',
  RATES = 'RATES',
  RESTRICTIONS = 'RESTRICTIONS',
  RESERVATION = 'RESERVATION',
  LISTING = 'LISTING',
}

export enum SyncEntityType {
  ROOM_TYPE = 'ROOM_TYPE',
  RATE_PLAN = 'RATE_PLAN',
  RESERVATION = 'RESERVATION',
  CHANNEL_LISTING = 'CHANNEL_LISTING',
  PROPERTY = 'PROPERTY',
}

export enum SyncJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
}

export enum SyncLogStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}
