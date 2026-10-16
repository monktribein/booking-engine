/**
 * Every enum is a string enum so the stored value is readable in Atlas, in
 * logs and in exports, and so reordering members can never change meaning.
 */

export const enumValues = <T extends Record<string, string>>(e: T): string[] => Object.values(e);

// ---------------------------------------------------------------- identity

export enum UserRole {
  /** Platform owner: everything, including suspending partners and reaching any property. */
  SUPER_ADMIN = 'SUPER_ADMIN',
  /** Platform operations: reviews and approves partners, marketplace listings and integration requests; read-only elsewhere. */
  OPERATIONS_ADMIN = 'OPERATIONS_ADMIN',
  PROPERTY_OWNER = 'PROPERTY_OWNER',
  PROPERTY_MANAGER = 'PROPERTY_MANAGER',
  STAFF = 'STAFF',
  RECEPTION = 'RECEPTION',
  /** Organization-level technical user: manages API keys and webhooks, sees no guest or booking data. */
  DEVELOPER = 'DEVELOPER',
}

/** Roles that belong to the platform operator, not to a partner organization. */
export const PLATFORM_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN];

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
  /** Registered, waiting for platform approval. May use the PMS privately; cannot be public, issue API keys or connect channels. */
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

// ---------------------------------------------------------------- property

export enum PropertyStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  /** Set by the platform only. The owner cannot lift it. Not bookable by anyone but staff. */
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

/** Tirvona marketplace listing state. Listing needs the owner's explicit consent and the platform's approval. */
export enum MarketplaceStatus {
  NOT_LISTED = 'NOT_LISTED',
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export enum IntegrationRequestStatus {
  REQUESTED = 'REQUESTED',
  IN_REVIEW = 'IN_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
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

/** Sources that are NOT an external channel: Tirvona's own sites, the public API, and bookings typed in by staff. */
const NON_CHANNEL_SOURCES: ReadonlySet<string> = new Set([ReservationSource.TIRVONA, ReservationSource.DIRECT, ReservationSource.API, ReservationSource.WALK_IN, ReservationSource.PHONE, ReservationSource.AGENT, ReservationSource.OTHER]);

/** True for a booking that belongs to an external channel (a built-in OTA or any configured provider): the channel owns it. */
export const isChannelSource = (source: string): boolean => !NON_CHANNEL_SOURCES.has(source);

/** A built-in channel maps to its ReservationSource; a configured provider's code is its own source. */
export const channelToSource = (channel: string): string => (channel === ChannelCode.OTHER ? ReservationSource.OTHER : ((ReservationSource as Record<string, string>)[channel] ?? channel));

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
export type WebhookSource = string;

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
export const API_EVENT_TYPES = [
  'reservation.created',
  'reservation.confirmed',
  'reservation.updated',
  'reservation.cancelled',
  'payment.succeeded',
  'payment.failed',
  'inventory.updated',
  'ping',
] as const;
export type ApiEventType = (typeof API_EVENT_TYPES)[number];

/** Scopes an API key can hold. */
export const API_SCOPES = [
  'properties:read',
  'availability:read',
  'rates:read',
  'rates:write',
  'inventory:read',
  'inventory:write',
  'reservations:read',
  'reservations:write',
  'guests:read',
  'payments:read',
] as const;

/** Scopes that reveal personal or financial data, or change inventory and prices. Never granted by default. */
export const SENSITIVE_API_SCOPES: readonly (typeof API_SCOPES)[number][] = ['rates:write', 'inventory:write', 'reservations:write', 'guests:read', 'payments:read'];
export type ApiScope = (typeof API_SCOPES)[number];

export enum PromotionType {
  PERCENTAGE = 'PERCENTAGE',
  /** Minor units off the whole stay. */
  FIXED = 'FIXED',
}

// ------------------------------------------------------------------ channel providers (configuration-driven integrations)

export enum ProviderKind {
  MARKETPLACE = 'MARKETPLACE',
  DIRECT = 'DIRECT',
  OTA = 'OTA',
  PMS = 'PMS',
  PAYMENT = 'PAYMENT',
  TEST = 'TEST',
}

/** How a provider is reached. INTERNAL = Tirvona's own inventory (no remote API); CODE = a registered TypeScript adapter. */
export enum ProviderProtocol {
  INTERNAL = 'INTERNAL',
  CODE = 'CODE',
  REST_JSON = 'REST_JSON',
  ICAL = 'ICAL',
  CSV = 'CSV',
  XML = 'XML',
  SOAP = 'SOAP',
}

export enum ProviderStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export enum ProviderVisibility {
  PLATFORM = 'PLATFORM',
  PRIVATE = 'PRIVATE',
}

export enum ProviderVersionStatus {
  DRAFT = 'DRAFT',
  VALIDATED = 'VALIDATED',
  PUBLISHED = 'PUBLISHED',
  RETIRED = 'RETIRED',
}

export enum ConnectionSecretKind {
  API_KEY = 'API_KEY',
  BASIC_USERNAME = 'BASIC_USERNAME',
  BASIC_PASSWORD = 'BASIC_PASSWORD',
  BEARER_TOKEN = 'BEARER_TOKEN',
  CUSTOM_HEADER = 'CUSTOM_HEADER',
  OAUTH_CLIENT_SECRET = 'OAUTH_CLIENT_SECRET',
  WEBHOOK_SECRET = 'WEBHOOK_SECRET',
  SIGNING_SECRET = 'SIGNING_SECRET',
  /** iCal providers: a JSON list of { id, name, url } (each URL is itself a bearer secret). */
  FEED_URLS = 'FEED_URLS',
}

export enum ReconciliationRunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum ReconciliationIssueKind {
  MISSING_LOCAL = 'MISSING_LOCAL',
  MISSING_REMOTE = 'MISSING_REMOTE',
  STATUS_MISMATCH = 'STATUS_MISMATCH',
  DATE_MISMATCH = 'DATE_MISMATCH',
  UNMAPPED = 'UNMAPPED',
  INGEST_FAILED = 'INGEST_FAILED',
}

export enum ReconciliationIssueStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  IGNORED = 'IGNORED',
}

export enum ProviderTestEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
  LOCAL_FAKE = 'LOCAL_FAKE',
}

/** The all-zero scope: external ids of built-in channels keep their historic global uniqueness. */
export const GLOBAL_EXTERNAL_SCOPE = '00000000-0000-0000-0000-000000000000';
