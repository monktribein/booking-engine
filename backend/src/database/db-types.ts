import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Table types for Kysely. Names are camelCase here; the CamelCasePlugin maps them to the snake_case columns of
 * migrations/0001_init.sql. The id column is `id` (a uuid string); the HTTP layer renames it to `_id` on the way out.
 *
 *  - `Instant`: a timestamptz. Read as Date, written as Date or ISO string.
 *  - `DateOnly`: a calendar `date`. Read as a Date at 00:00Z, WRITTEN AS 'YYYY-MM-DD' (never a Date: a Date would be
 *    serialised in the server's local zone and could land on the previous day).
 *  - `Json<T>`: a jsonb column. Read as T, written as a JSON string (use `j()` from kysely.ts), so arrays are never
 *    mistaken for Postgres arrays by the driver.
 */
export type Instant = ColumnType<Date, Date | string, Date | string>;
export type InstantNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
export type GeneratedInstant = ColumnType<Date, Date | string | undefined, Date | string>;
export type DateOnly = ColumnType<Date, string, string>;
export type DateOnlyNullable = ColumnType<Date | null, string | null | undefined, string | null>;
export type Json<T> = ColumnType<T, string, string>;
export type JsonDefault<T> = ColumnType<T, string | undefined, string>;

// -------------------------------------------------------------------- identity

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<string>;
  statusReason: string | null;
  statusChangedAt: InstantNullable;
  statusChangedBy: string | null;
  approvedAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface UsersTable {
  id: Generated<string>;
  organizationId: string | null;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: string;
  status: Generated<string>;
  lastLoginAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface PropertiesTable {
  id: Generated<string>;
  organizationId: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string | null;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  currency: string;
  checkInTime: Generated<string>;
  checkOutTime: Generated<string>;
  taxPercent: Generated<number>;
  bookingHorizonDays: Generated<number>;
  images: JsonDefault<Image[]>;
  amenities: Generated<string[]>;
  status: Generated<string>;
  directBookingEnabled: Generated<boolean>;
  marketplaceStatus: Generated<string>;
  marketplaceConsentAt: InstantNullable;
  marketplaceConsentBy: string | null;
  marketplaceReviewedAt: InstantNullable;
  marketplaceReviewedBy: string | null;
  marketplaceNote: string | null;
  suspendedReason: string | null;
  suspendedAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface Image {
  url: string;
  caption?: string;
  sortOrder: number;
}

export interface PropertyUsersTable {
  id: Generated<string>;
  propertyId: string;
  userId: string;
  role: string;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

// -------------------------------------------------------------------- catalogue

export interface RoomTypesTable {
  id: Generated<string>;
  propertyId: string;
  name: string;
  slug: string;
  description: string | null;
  maxOccupancy: number;
  basePrice: number;
  currency: string;
  totalRooms: number;
  baseOccupancy: number | null;
  extraAdultCharge: Generated<number>;
  extraChildCharge: Generated<number>;
  amenities: Generated<string[]>;
  images: JsonDefault<Image[]>;
  sortOrder: Generated<number>;
  status: Generated<string>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface RoomsTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: Generated<string>;
  notes: string | null;
  assignmentVersion: Generated<number>;
  retiredAt: InstantNullable;
  retiredReason: string | null;
  retiredBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface CancellationPolicy {
  refundable: boolean;
  /** Free cancellation until this many hours before local check-in time. */
  freeCancellationHours: number;
  penaltyType: string;
  /** Percentage (0-100) for PERCENTAGE; ignored otherwise. */
  penaltyValue: number;
  description?: string;
}

export interface RatePlansTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  name: string;
  code: string;
  type: Generated<string>;
  basePrice: number;
  currency: string;
  mealPlan: Generated<string>;
  cancellationPolicy: Json<CancellationPolicy>;
  status: Generated<string>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface PromotionsTable {
  id: Generated<string>;
  propertyId: string;
  code: string;
  name: string;
  type: string;
  value: number;
  validFrom: DateOnly;
  validTo: DateOnly;
  minNights: Generated<number>;
  roomTypeIds: Generated<string[]>;
  active: Generated<boolean>;
  maxRedemptions: number | null;
  maxPerGuest: number | null;
  minBookingValue: Generated<number>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface RateRulesTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string | null;
  name: string;
  startDate: DateOnly;
  endDate: DateOnly;
  daysOfWeek: number[] | null;
  adjustment: string;
  amount: number | null;
  percent: number | null;
  priority: Generated<number>;
  status: Generated<string>;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface PromotionRedemptionsTable {
  id: Generated<string>;
  promotionId: string;
  reservationId: string;
  guestId: string;
  amount: number;
  status: Generated<string>;
  createdAt: GeneratedInstant;
  releasedAt: InstantNullable;
}

export interface DataRetentionPoliciesTable {
  organizationId: string;
  guestAnonymizeAfterDays: number | null;
  notificationRedactAfterDays: number | null;
  inboundPayloadRedactAfterDays: number | null;
  enabled: Generated<boolean>;
  approvedBy: string | null;
  approvedAt: InstantNullable;
  updatedBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface DataRetentionRunsTable {
  id: Generated<string>;
  organizationId: string;
  dryRun: boolean;
  triggeredBy: string;
  summary: Json<{ guests: number; reservations: number; notifications: number; inboundEvents: number }>;
  createdAt: GeneratedInstant;
}

// -------------------------------------------------------------------- inventory

export interface InventoryTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  date: DateOnly;
  total: number;
  sold: Generated<number>;
  blocked: Generated<number>;
  available: number;
  overbooked: Generated<number>;
  stopSell: Generated<boolean>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface InventoryBlocksTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  roomId: string | null;
  startDate: DateOnly;
  endDate: DateOnly;
  quantity: number;
  reason: string;
  notes: string | null;
  status: Generated<string>;
  createdBy: string | null;
  releasedAt: InstantNullable;
  releasedBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface RestrictionsTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  date: DateOnly;
  minimumStay: number | null;
  maximumStay: number | null;
  closed: Generated<boolean>;
  closedToArrival: Generated<boolean>;
  closedToDeparture: Generated<boolean>;
  stopSell: Generated<boolean>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

// -------------------------------------------------------------------- guests, reservations

export interface GuestDocument {
  type: string;
  numberEncrypted?: string;
  numberLast4?: string;
  issuingCountry?: string;
  expiresAt?: string;
  fileKey?: string;
  verifiedAt?: string;
}

export interface GuestsTable {
  id: Generated<string>;
  propertyId: string;
  firstName: string;
  lastName: Generated<string>;
  email: string | null;
  phone: string | null;
  country: string | null;
  documents: JsonDefault<GuestDocument[]>;
  notes: string | null;
  anonymizedAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface GuestSnapshot {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

export interface StatusChange {
  status: string;
  at: string;
  by: string | null;
  reason?: string;
}

export interface ReservationsTable {
  id: Generated<string>;
  propertyId: string;
  reservationCode: string;
  source: string;
  externalReservationId: string | null;
  /** Connection scope of the external id; the zero uuid (default) is the historic global scope. */
  externalScope: Generated<string>;
  channelListingId: string | null;
  idempotencyKey: string | null;
  status: Generated<string>;
  guestId: string;
  guest: Json<GuestSnapshot>;
  checkIn: DateOnly;
  checkOut: DateOnly;
  nights: number;
  adults: number;
  children: Generated<number>;
  specialRequests: string | null;
  subtotal: number;
  tax: number;
  discount: Generated<number>;
  total: number;
  currency: string;
  amountPaid: Generated<number>;
  amountRefunded: Generated<number>;
  paymentStatus: Generated<string>;
  collectionModel: string | null;
  collectionSource: string | null;
  providerPaymentStatusRaw: string | null;
  providerPaymentStatus: string | null;
  payoutStatusRaw: string | null;
  payoutStatus: string | null;
  payoutDate: InstantNullable;
  commissionAmount: number | null;
  netAmount: number | null;
  paymentInfoUpdatedAt: InstantNullable;
  holdExpiresAt: InstantNullable;
  overbooked: Generated<boolean>;
  inventoryReleasedFrom: DateOnlyNullable;
  checkedInAt: InstantNullable;
  checkedOutAt: InstantNullable;
  statusHistory: JsonDefault<StatusChange[]>;
  cancelledAt: InstantNullable;
  cancellationReason: string | null;
  apiKeyId: string | null;
  partnerReference: string | null;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface NightlyRate {
  /** YYYY-MM-DD */
  date: string;
  /** What the room costs that night (minor units): rate + extra. This is the figure that is summed. */
  amount: number;
  /** Breakdown for server-priced bookings; absent on OTA / imported / older bookings (then rate = amount, extra = 0). */
  rate?: number;
  extra?: number;
  /** Id of the rate rule that set `rate`, when one applied. */
  ruleId?: string;
}

export interface RatePlanSnapshot {
  code: string;
  name: string;
  type: string;
  mealPlan: string;
  cancellationPolicy: CancellationPolicy;
}

export interface ReservationRoomsTable {
  id: Generated<string>;
  reservationId: string;
  position: number;
  roomTypeId: string;
  roomTypeName: string;
  roomId: string | null;
  roomNumber: string | null;
  quantity: number;
  ratePlanId: string | null;
  ratePlan: ColumnType<RatePlanSnapshot | null, string | null, string | null>;
  nightlyRates: Json<NightlyRate[]>;
  subtotal: number;
  tax: number;
  total: number;
}

// -------------------------------------------------------------------- payments

export interface PaymentsTable {
  id: Generated<string>;
  propertyId: string;
  reservationId: string;
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  amount: number;
  amountRefunded: Generated<number>;
  currency: string;
  status: Generated<string>;
  paidAt: InstantNullable;
  failureReason: string | null;
  metadata: JsonDefault<Record<string, unknown>>;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface RefundsTable {
  id: Generated<string>;
  propertyId: string;
  reservationId: string;
  paymentId: string;
  provider: string;
  providerRefundId: string | null;
  amount: number;
  currency: string;
  status: Generated<string>;
  reason: string | null;
  requestedBy: string | null;
  processedAt: InstantNullable;
  lastError: string | null;
  enqueuedAt: InstantNullable;
  metadata: JsonDefault<Record<string, unknown>>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

// -------------------------------------------------------------------- channels

export interface ChannelsTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: string;
  status: Generated<string>;
  capabilities: JsonDefault<Record<string, boolean>>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ChannelConnectionsTable {
  id: Generated<string>;
  propertyId: string;
  channel: string;
  status: Generated<string>;
  externalAccountId: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  expiresAt: InstantNullable;
  oauthStateHash: string | null;
  oauthStateExpiresAt: InstantNullable;
  connectedAt: InstantNullable;
  lastSyncAt: InstantNullable;
  lastError: string | null;
  metadata: JsonDefault<Record<string, unknown>>;
  providerId: string | null;
  providerVersionId: string | null;
  accountLabel: string | null;
  pollIntervalSeconds: number | null;
  pollCursor: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  lastPollAt: InstantNullable;
  lastPollError: string | null;
  webhookKey: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ChannelListingsTable {
  id: Generated<string>;
  propertyId: string;
  channelConnectionId: string | null;
  channel: string;
  externalListingId: string;
  externalScope: Generated<string>;
  name: string;
  status: Generated<string>;
  lastSyncedAt: InstantNullable;
  metadata: JsonDefault<Record<string, unknown>>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ChannelRoomMappingsTable {
  id: Generated<string>;
  propertyId: string;
  channel: string;
  channelListingId: string;
  externalRoomId: string | null;
  roomTypeId: string;
  status: Generated<string>;
  syncAvailability: Generated<boolean>;
  syncRates: Generated<boolean>;
  syncRestrictions: Generated<boolean>;
  lastSyncedAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ChannelRateMappingsTable {
  id: Generated<string>;
  propertyId: string;
  channel: string;
  channelRoomMappingId: string;
  externalRatePlanId: string;
  ratePlanId: string;
  markupType: Generated<string>;
  markupValue: Generated<number>;
  status: Generated<string>;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

// -------------------------------------------------------------------- channel providers (configuration-driven integrations)

export interface ChannelProvidersTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: string;
  protocol: Generated<string>;
  status: Generated<string>;
  visibility: Generated<string>;
  ownerOrganizationId: string | null;
  adapterKey: string | null;
  builtIn: Generated<boolean>;
  currentVersionId: string | null;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ChannelProviderVersionsTable {
  id: Generated<string>;
  providerId: string;
  version: number;
  status: Generated<string>;
  definition: Json<Record<string, unknown>>;
  definitionHash: string;
  validation: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  notes: string | null;
  createdBy: string | null;
  publishedBy: string | null;
  publishedAt: InstantNullable;
  createdAt: GeneratedInstant;
}

export interface ChannelConnectionSecretsTable {
  id: Generated<string>;
  connectionId: string;
  kind: string;
  name: Generated<string>;
  ciphertext: string;
  createdAt: GeneratedInstant;
  rotatedAt: InstantNullable;
}

export interface ReconciliationRunsTable {
  id: Generated<string>;
  connectionId: string;
  propertyId: string;
  status: Generated<string>;
  windowFrom: DateOnly;
  windowTo: DateOnly;
  remoteCount: number | null;
  localCount: number | null;
  issueCount: Generated<number>;
  error: string | null;
  startedAt: GeneratedInstant;
  completedAt: InstantNullable;
}

export interface ReconciliationIssuesTable {
  id: Generated<string>;
  runId: string;
  connectionId: string;
  propertyId: string;
  kind: string;
  externalReservationId: string | null;
  reservationId: string | null;
  details: JsonDefault<Record<string, unknown>>;
  status: Generated<string>;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: InstantNullable;
  createdAt: GeneratedInstant;
}

export interface IcalExportFeedsTable {
  id: Generated<string>;
  propertyId: string;
  roomTypeId: string;
  label: string | null;
  tokenHash: string;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  lastFetchedAt: InstantNullable;
  revokedAt: InstantNullable;
}

export interface ChannelProviderTestsTable {
  id: Generated<string>;
  providerId: string;
  versionId: string | null;
  environment: string;
  passed: boolean;
  results: JsonDefault<Record<string, unknown>[]>;
  runBy: string | null;
  createdAt: GeneratedInstant;
}

// -------------------------------------------------------------------- queues, notifications, audit

export interface WebhookEventsTable {
  id: Generated<string>;
  channel: string;
  externalScope: Generated<string>;
  propertyId: string | null;
  eventType: string;
  externalEventId: string;
  payload: Json<Record<string, unknown>>;
  signature: string | null;
  signatureValid: boolean;
  status: Generated<string>;
  attempts: Generated<number>;
  lockedUntil: InstantNullable;
  enqueuedAt: InstantNullable;
  processedAt: InstantNullable;
  error: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface SyncJobsTable {
  id: Generated<string>;
  propertyId: string;
  channel: string;
  channelListingId: string | null;
  roomTypeId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  dateFrom: DateOnlyNullable;
  dateTo: DateOnlyNullable;
  status: Generated<string>;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  scheduledAt: GeneratedInstant;
  lockedUntil: InstantNullable;
  lockedBy: string | null;
  enqueuedAt: InstantNullable;
  startedAt: InstantNullable;
  completedAt: InstantNullable;
  lastError: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface SyncLogsTable {
  id: Generated<string>;
  propertyId: string;
  channel: string;
  syncJobId: string | null;
  action: string;
  status: string;
  requestMetadata: JsonDefault<Record<string, unknown>>;
  responseMetadata: JsonDefault<Record<string, unknown>>;
  error: string | null;
  duration: number;
  createdAt: GeneratedInstant;
}

export interface NotificationsTable {
  id: Generated<string>;
  propertyId: string | null;
  userId: string | null;
  reservationId: string | null;
  type: string;
  channel: string;
  recipient: string | null;
  status: Generated<string>;
  subject: string | null;
  message: string;
  metadata: JsonDefault<Record<string, unknown>>;
  attempts: Generated<number>;
  dedupeKey: string | null;
  enqueuedAt: InstantNullable;
  lockedUntil: InstantNullable;
  lastError: string | null;
  sentAt: InstantNullable;
  readAt: InstantNullable;
  redactedAt: InstantNullable;
  createdAt: GeneratedInstant;
}

export interface AuditLogsTable {
  id: Generated<string>;
  organizationId: string | null;
  propertyId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: ColumnType<Record<string, unknown> | null, string | null, never>;
  after: ColumnType<Record<string, unknown> | null, string | null, never>;
  metadata: JsonDefault<Record<string, unknown>>;
  createdAt: GeneratedInstant;
}

// -------------------------------------------------------------------- sessions, public API

export interface AuthSessionsTable {
  id: Generated<string>;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  expiresAt: Instant;
  revokedAt: InstantNullable;
  revokedReason: string | null;
  rotatedAt: InstantNullable;
  ip: string | null;
  userAgent: string | null;
  lastUsedAt: Instant;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  userId: string;
  tokenHash: string;
  expiresAt: Instant;
  usedAt: InstantNullable;
  createdAt: GeneratedInstant;
}

export interface ApiKeysTable {
  id: Generated<string>;
  organizationId: string;
  propertyIds: Generated<string[]>;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  status: Generated<string>;
  expiresAt: InstantNullable;
  lastUsedAt: InstantNullable;
  revokedAt: InstantNullable;
  environment: Generated<string>;
  rotatedFrom: string | null;
  lastUsedIp: string | null;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface ApiKeyUsageTable {
  apiKeyId: string;
  day: DateOnly;
  requests: Generated<number>;
  clientErrors: Generated<number>;
  serverErrors: Generated<number>;
  rateLimited: Generated<number>;
}

export interface IntegrationRequestsTable {
  id: Generated<string>;
  organizationId: string;
  propertyId: string | null;
  channel: string;
  status: Generated<string>;
  note: string | null;
  decisionNote: string | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface WebhookEndpointsTable {
  id: Generated<string>;
  organizationId: string;
  propertyIds: Generated<string[]>;
  url: string;
  description: string | null;
  events: string[];
  secretEncrypted: string;
  includeGuestDetails: Generated<boolean>;
  status: Generated<string>;
  createdBy: string | null;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  organizationId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  body: string;
  status: Generated<string>;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  lockedUntil: InstantNullable;
  enqueuedAt: InstantNullable;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: InstantNullable;
  createdAt: GeneratedInstant;
  updatedAt: GeneratedInstant;
}

// -------------------------------------------------------------------- the database

export interface DB {
  organizations: OrganizationsTable;
  users: UsersTable;
  properties: PropertiesTable;
  propertyUsers: PropertyUsersTable;
  roomTypes: RoomTypesTable;
  rooms: RoomsTable;
  ratePlans: RatePlansTable;
  promotions: PromotionsTable;
  rateRules: RateRulesTable;
  promotionRedemptions: PromotionRedemptionsTable;
  dataRetentionPolicies: DataRetentionPoliciesTable;
  dataRetentionRuns: DataRetentionRunsTable;
  inventory: InventoryTable;
  inventoryBlocks: InventoryBlocksTable;
  restrictions: RestrictionsTable;
  guests: GuestsTable;
  reservations: ReservationsTable;
  reservationRooms: ReservationRoomsTable;
  payments: PaymentsTable;
  refunds: RefundsTable;
  channels: ChannelsTable;
  channelConnections: ChannelConnectionsTable;
  channelListings: ChannelListingsTable;
  channelProviders: ChannelProvidersTable;
  channelProviderVersions: ChannelProviderVersionsTable;
  channelConnectionSecrets: ChannelConnectionSecretsTable;
  reconciliationRuns: ReconciliationRunsTable;
  reconciliationIssues: ReconciliationIssuesTable;
  channelProviderTests: ChannelProviderTestsTable;
  icalExportFeeds: IcalExportFeedsTable;
  channelRoomMappings: ChannelRoomMappingsTable;
  channelRateMappings: ChannelRateMappingsTable;
  webhookEvents: WebhookEventsTable;
  syncJobs: SyncJobsTable;
  syncLogs: SyncLogsTable;
  notifications: NotificationsTable;
  auditLogs: AuditLogsTable;
  authSessions: AuthSessionsTable;
  passwordResetTokens: PasswordResetTokensTable;
  apiKeys: ApiKeysTable;
  webhookEndpoints: WebhookEndpointsTable;
  webhookDeliveries: WebhookDeliveriesTable;
  apiKeyUsage: ApiKeyUsageTable;
  integrationRequests: IntegrationRequestsTable;
}

// Row helper types, named like the old Mongoose documents so call sites read the same.
export type ChannelProvider = Selectable<ChannelProvidersTable>;
export type ChannelProviderVersion = Selectable<ChannelProviderVersionsTable>;
export type Organization = Selectable<OrganizationsTable>;
export type User = Selectable<UsersTable>;
export type Property = Selectable<PropertiesTable>;
export type PropertyUser = Selectable<PropertyUsersTable>;
export type RoomType = Selectable<RoomTypesTable>;
export type Room = Selectable<RoomsTable>;
export type RatePlan = Selectable<RatePlansTable>;
export type Promotion = Selectable<PromotionsTable>;
export type RateRule = Selectable<RateRulesTable>;
export type DataRetentionPolicy = Selectable<DataRetentionPoliciesTable>;
export type Inventory = Selectable<InventoryTable>;
export type InventoryBlock = Selectable<InventoryBlocksTable>;
export type Restriction = Selectable<RestrictionsTable>;
export type Guest = Selectable<GuestsTable>;
export type Payment = Selectable<PaymentsTable>;
export type Refund = Selectable<RefundsTable>;
export type Channel = Selectable<ChannelsTable>;
export type ChannelConnection = Selectable<ChannelConnectionsTable>;
export type ChannelListing = Selectable<ChannelListingsTable>;
export type ChannelRoomMapping = Selectable<ChannelRoomMappingsTable>;
export type ChannelRateMapping = Selectable<ChannelRateMappingsTable>;
export type WebhookEvent = Selectable<WebhookEventsTable>;
export type SyncJob = Selectable<SyncJobsTable>;
export type SyncLog = Selectable<SyncLogsTable>;
export type Notification = Selectable<NotificationsTable>;
export type AuditLog = Selectable<AuditLogsTable>;
export type AuthSession = Selectable<AuthSessionsTable>;
export type PasswordResetToken = Selectable<PasswordResetTokensTable>;
export type ApiKey = Selectable<ApiKeysTable>;
export type WebhookEndpoint = Selectable<WebhookEndpointsTable>;
export type WebhookDelivery = Selectable<WebhookDeliveriesTable>;
export type IntegrationRequest = Selectable<IntegrationRequestsTable>;
export type { Insertable, Selectable, Updateable };
