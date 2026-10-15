/**
 * Every enum is a string enum so the stored value is readable in Atlas, in
 * logs and in exports, and so reordering members can never change meaning.
 */

export const enumValues = <T extends Record<string, string>>(e: T): string[] => Object.values(e);

// ---------------------------------------------------------------- identity

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  PROPERTY_OWNER = 'PROPERTY_OWNER',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  STAFF = 'STAFF',
  RECEPTION = 'RECEPTION',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INVITED = 'INVITED',
  SUSPENDED = 'SUSPENDED',
  DISABLED = 'DISABLED',
}

/** Roles a user can hold on a single property (SUPER_ADMIN is platform-wide only). */
export enum PropertyUserRole {
  PROPERTY_OWNER = 'PROPERTY_OWNER',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  STAFF = 'STAFF',
  RECEPTION = 'RECEPTION',
}

export enum OrganizationStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

// ---------------------------------------------------------------- property

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

/** Operational (housekeeping) state of a physical room *today*. Future availability lives in inventory. */
export enum RoomStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  CLEANING = 'CLEANING',
  MAINTENANCE = 'MAINTENANCE',
  BLOCKED = 'BLOCKED',
}

// ---------------------------------------------------------------- rates & inventory

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

export enum RatePlanStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum CancellationPenaltyType {
  /** Free cancellation at any time. */
  NONE = 'NONE',
  /** Inside the free window the guest forfeits the first night of every room. */
  FIRST_NIGHT = 'FIRST_NIGHT',
  /** Inside the free window the guest forfeits `penaltyValue` percent of the stay. */
  PERCENTAGE = 'PERCENTAGE',
  /** Inside the free window the guest forfeits the whole stay. */
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

// ---------------------------------------------------------------- reservations & money

export enum ReservationSource {
  TIRVONA = 'TIRVONA',
  DIRECT = 'DIRECT',
  /** Created through the public API (/v1) with an API key. */
  API = 'API',
  AIRBNB = 'AIRBNB',
  BOOKING_COM = 'BOOKING_COM',
  AGODA = 'AGODA',
  WALK_IN = 'WALK_IN',
  PHONE = 'PHONE',
  AGENT = 'AGENT',
  OTHER = 'OTHER',
  /** Test-only channel (MockChannelAdapter). Behaves like an OTA. */
  MOCK = 'MOCK',
}

/** Sources whose bookings already exist on a third-party system before they reach us. */
export const OTA_SOURCES: ReadonlySet<ReservationSource> = new Set([
  ReservationSource.AIRBNB,
  ReservationSource.BOOKING_COM,
  ReservationSource.AGODA,
  ReservationSource.MOCK,
]);

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  CHECKED_IN = 'CHECKED_IN',
  CHECKED_OUT = 'CHECKED_OUT',
  NO_SHOW = 'NO_SHOW',
}

/** Statuses that hold inventory. */
export const ACTIVE_RESERVATION_STATUSES = [
  ReservationStatus.PENDING,
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
] as const;

export enum ReservationPaymentStatus {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  CHANNEL_COLLECTED = 'CHANNEL_COLLECTED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
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

// ---------------------------------------------------------------- channels

export enum ChannelCode {
  TIRVONA = 'TIRVONA',
  DIRECT = 'DIRECT',
  AIRBNB = 'AIRBNB',
  BOOKING_COM = 'BOOKING_COM',
  AGODA = 'AGODA',
  OTHER = 'OTHER',
  /** Simulated OTA for end-to-end channel-manager testing. */
  MOCK = 'MOCK',
}

/**
 * Channels that read the master inventory straight from this database.
 * They never need sync jobs, connections or mappings.
 */
export const INTERNAL_CHANNELS: ReadonlySet<ChannelCode> = new Set([ChannelCode.TIRVONA, ChannelCode.DIRECT]);

export const channelToSource = (channel: ChannelCode): ReservationSource =>
  ReservationSource[channel as keyof typeof ReservationSource] ?? ReservationSource.OTHER;

export enum ChannelKind {
  MARKETPLACE = 'MARKETPLACE',
  DIRECT = 'DIRECT',
  OTA = 'OTA',
}

export enum ChannelStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
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
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}

export enum MarkupType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
  NONE = 'NONE',
}

// ---------------------------------------------------------------- integration plumbing

/** Who sent an inbound webhook: an OTA channel or a payment provider. */
export const WEBHOOK_SOURCES = [...Object.values(ChannelCode), 'RAZORPAY'] as const;
export type WebhookSource = ChannelCode | 'RAZORPAY';

export enum WebhookEventStatus {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
  IGNORED = 'IGNORED',
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

// ---------------------------------------------------------------- notifications

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
  IN_APP = 'IN_APP',
}

export enum NotificationType {
  RESERVATION_CREATED = 'RESERVATION_CREATED',
  RESERVATION_CONFIRMED = 'RESERVATION_CONFIRMED',
  RESERVATION_CANCELLED = 'RESERVATION_CANCELLED',
  CHECKIN_REMINDER = 'CHECKIN_REMINDER',
  PAYMENT_SUCCESS = 'PAYMENT_SUCCESS',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  CHANNEL_SYNC_FAILED = 'CHANNEL_SYNC_FAILED',
  OVERBOOKING_ALERT = 'OVERBOOKING_ALERT',
  PASSWORD_RESET = 'PASSWORD_RESET',
  GENERAL = 'GENERAL',
}

/** Public event names (as used in the product spec and webhooks to customers) for each notification type. */
export const NOTIFICATION_EVENT: Record<NotificationType, string> = {
  [NotificationType.RESERVATION_CREATED]: 'reservation.created',
  [NotificationType.RESERVATION_CONFIRMED]: 'reservation.confirmed',
  [NotificationType.RESERVATION_CANCELLED]: 'reservation.cancelled',
  [NotificationType.CHECKIN_REMINDER]: 'checkin.reminder',
  [NotificationType.PAYMENT_SUCCESS]: 'payment.success',
  [NotificationType.PAYMENT_FAILED]: 'payment.failed',
  [NotificationType.CHANNEL_SYNC_FAILED]: 'channel.sync.failed',
  [NotificationType.OVERBOOKING_ALERT]: 'reservation.overbooked',
  [NotificationType.PASSWORD_RESET]: 'auth.password_reset',
  [NotificationType.GENERAL]: 'general',
};

export enum NotificationStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  READ = 'READ',
}

export enum GuestDocumentType {
  PASSPORT = 'PASSPORT',
  AADHAAR = 'AADHAAR',
  DRIVING_LICENSE = 'DRIVING_LICENSE',
  NATIONAL_ID = 'NATIONAL_ID',
  VISA = 'VISA',
  OTHER = 'OTHER',
}

export enum ApiKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export enum WebhookEndpointStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export enum WebhookDeliveryStatus {
  PENDING = 'PENDING',
  RETRYING = 'RETRYING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

/** Event types delivered to customer webhook endpoints. Part of the public API contract. */
export const API_EVENT_TYPES = ['reservation.created', 'reservation.confirmed', 'reservation.cancelled', 'payment.succeeded', 'payment.failed', 'ping'] as const;
export type ApiEventType = (typeof API_EVENT_TYPES)[number];

/** Scopes an API key can hold. */
export const API_SCOPES = ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
