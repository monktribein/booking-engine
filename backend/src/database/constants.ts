/** Physical collection names. One database, one collection per aggregate. */
export const COLLECTION = {
  users: 'users',
  organizations: 'organizations',
  propertyUsers: 'property_users',
  properties: 'properties',
  roomTypes: 'room_types',
  rooms: 'rooms',
  ratePlans: 'rate_plans',
  inventory: 'inventory',
  inventoryBlocks: 'inventory_blocks',
  restrictions: 'restrictions',
  guests: 'guests',
  reservations: 'reservations',
  payments: 'payments',
  refunds: 'refunds',
  channels: 'channels',
  channelConnections: 'channel_connections',
  channelListings: 'channel_listings',
  channelRoomMappings: 'channel_room_mappings',
  channelRateMappings: 'channel_rate_mappings',
  webhookEvents: 'webhook_events',
  syncJobs: 'sync_jobs',
  syncLogs: 'sync_logs',
  notifications: 'notifications',
  auditLogs: 'audit_logs',
  authSessions: 'auth_sessions',
  passwordResetTokens: 'password_reset_tokens',
  promotions: 'promotions',
  apiKeys: 'api_keys',
  webhookEndpoints: 'webhook_endpoints',
  webhookDeliveries: 'webhook_deliveries',
} as const;

/** Mongoose model names (used for `ref` and for `connection.model(name)`). */
export const MODEL = {
  User: 'User',
  Organization: 'Organization',
  PropertyUser: 'PropertyUser',
  Property: 'Property',
  RoomType: 'RoomType',
  Room: 'Room',
  RatePlan: 'RatePlan',
  Inventory: 'Inventory',
  InventoryBlock: 'InventoryBlock',
  Restriction: 'Restriction',
  Guest: 'Guest',
  Reservation: 'Reservation',
  Payment: 'Payment',
  Refund: 'Refund',
  Channel: 'Channel',
  ChannelConnection: 'ChannelConnection',
  ChannelListing: 'ChannelListing',
  ChannelRoomMapping: 'ChannelRoomMapping',
  ChannelRateMapping: 'ChannelRateMapping',
  WebhookEvent: 'WebhookEvent',
  SyncJob: 'SyncJob',
  SyncLog: 'SyncLog',
  Notification: 'Notification',
  AuditLog: 'AuditLog',
  AuthSession: 'AuthSession',
  PasswordResetToken: 'PasswordResetToken',
  Promotion: 'Promotion',
  ApiKey: 'ApiKey',
  WebhookEndpoint: 'WebhookEndpoint',
  WebhookDelivery: 'WebhookDelivery',
} as const;

/**
 * Hard cap on nights per reservation. It keeps the embedded `nightlyRates`
 * arrays bounded and multi-night inventory transactions small.
 */
export const MAX_STAY_NIGHTS = 90;

/** Default number of days ahead that inventory rows are materialised and sellable. */
export const DEFAULT_BOOKING_HORIZON_DAYS = 365;

/** How long an unpaid PENDING direct booking holds inventory. */
export const DEFAULT_PENDING_HOLD_MINUTES = 20;

export const SYNC_LOG_RETENTION_DAYS = 90;
export const SYNC_JOB_SUCCESS_RETENTION_DAYS = 30;
