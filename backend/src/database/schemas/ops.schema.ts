import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL, SYNC_JOB_SUCCESS_RETENTION_DAYS, SYNC_LOG_RETENTION_DAYS } from '../constants';
import { redactSecrets } from '../common/redact';
import { baseSchemaOptions, count, dateOnly, enumOf, objectId } from '../common/schema-helpers';
import {
  ChannelCode,
  NotificationChannel,
  WEBHOOK_SOURCES,
  WebhookSource,
  NotificationStatus,
  NotificationType,
  SyncEntityType,
  SyncJobStatus,
  SyncJobType,
  SyncLogStatus,
  WebhookEventStatus,
} from '../enums';

const DAY_S = 86_400;

// ================================================================ webhook_events

/**
 * Inbound webhook inbox. The HTTP handler inserts the raw event and returns
 * 2xx at once. A worker processes it later. The unique (channel,
 * externalEventId) index makes redelivery a no-op. When a channel sends no
 * event ID, the adapter derives one (for example sha256 of the canonical body).
 */
export interface WebhookEvent {
  _id: Types.ObjectId;
  /** An OTA channel code, or a payment provider (RAZORPAY). */
  channel: WebhookSource;
  /** Resolved from the listing during processing. May be null on arrival. */
  propertyId: Types.ObjectId | null;
  eventType: string;
  externalEventId: string;
  payload: Record<string, unknown>;
  signature?: string;
  signatureValid: boolean;
  status: WebhookEventStatus;
  attempts: number;
  lockedUntil: Date | null;
  /** Set when handed to the queue. The outbox relay re-enqueues rows that stay RECEIVED too long. */
  enqueuedAt: Date | null;
  processedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const WebhookEventSchema = new Schema<WebhookEvent>(
  {
    channel: { type: String, enum: [...WEBHOOK_SOURCES], required: true },
    propertyId: objectId(MODEL.Property, false),
    eventType: { type: String, required: true, trim: true, maxlength: 100 },
    externalEventId: { type: String, required: true, trim: true, maxlength: 200 },
    payload: { type: Schema.Types.Mixed, required: true },
    signature: { type: String, maxlength: 1000 },
    signatureValid: { type: Boolean, required: true },
    status: enumOf(WebhookEventStatus, true, WebhookEventStatus.RECEIVED),
    attempts: { ...count(), default: 0 },
    lockedUntil: { type: Date, default: null },
    enqueuedAt: { type: Date, default: null },
    processedAt: { type: Date },
    error: { type: String, maxlength: 4000 },
  },
  baseSchemaOptions(COLLECTION.webhookEvents),
);

WebhookEventSchema.index({ channel: 1, externalEventId: 1 }, { unique: true });
// Worker queue: oldest unprocessed first.
WebhookEventSchema.index({ status: 1, createdAt: 1 });

// ================================================================ sync_jobs

/**
 * Outbound work queue (transactional outbox). Rows are inserted in the same
 * transaction as the inventory, rate or reservation change that caused them,
 * so a committed change always has a pending sync and a rolled-back change
 * never does. Jobs carry a date range, not values. The worker reads the
 * current master data when it runs and pushes absolute numbers, so retries,
 * duplicates and reordering are harmless.
 */
export interface SyncJob {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channel: ChannelCode;
  channelListingId: Types.ObjectId | null;
  /** Room type whose master data this job pushes (null for listing-level jobs). */
  roomTypeId: Types.ObjectId | null;
  type: SyncJobType;
  entityType: SyncEntityType;
  entityId: Types.ObjectId;
  dateFrom: Date | null;
  /** Exclusive. */
  dateTo: Date | null;
  status: SyncJobStatus;
  attempts: number;
  maxAttempts: number;
  scheduledAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  /** Set when handed to BullMQ; null means "not yet enqueued" for the outbox relay. */
  enqueuedAt: Date | null;
  startedAt?: Date;
  completedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const SyncJobSchema = new Schema<SyncJob>(
  {
    propertyId: objectId(MODEL.Property),
    channel: enumOf(ChannelCode),
    channelListingId: objectId(MODEL.ChannelListing, false),
    roomTypeId: objectId(MODEL.RoomType, false),
    type: enumOf(SyncJobType),
    entityType: enumOf(SyncEntityType),
    entityId: { type: Schema.Types.ObjectId, required: true },
    dateFrom: dateOnly(false),
    dateTo: dateOnly(false),
    status: enumOf(SyncJobStatus, true, SyncJobStatus.PENDING),
    attempts: { ...count(), default: 0 },
    maxAttempts: { ...count(true, 1), max: 50, default: 8 },
    scheduledAt: { type: Date, required: true, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    enqueuedAt: { type: Date, default: null },
    startedAt: { type: Date },
    completedAt: { type: Date },
    lastError: { type: String, maxlength: 4000 },
  },
  baseSchemaOptions(COLLECTION.syncJobs),
);

// Worker claim: status in (PENDING, RETRYING) and scheduledAt <= now, sorted by scheduledAt.
SyncJobSchema.index({ status: 1, scheduledAt: 1 });
// Per-property/channel job history in the channel-manager UI (property + channel).
SyncJobSchema.index({ propertyId: 1, channel: 1, createdAt: -1 });
// Successful jobs are only kept for a while. Partial TTL, so failures stay until someone resolves them.
SyncJobSchema.index(
  { completedAt: 1 },
  {
    expireAfterSeconds: SYNC_JOB_SUCCESS_RETENTION_DAYS * DAY_S,
    partialFilterExpression: { status: SyncJobStatus.SUCCESS },
  },
);

// ================================================================ sync_logs

export interface SyncLog {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channel: ChannelCode;
  syncJobId: Types.ObjectId | null;
  action: string;
  status: SyncLogStatus;
  requestMetadata: Record<string, unknown>;
  responseMetadata: Record<string, unknown>;
  error?: string;
  /** Milliseconds. */
  duration: number;
  createdAt: Date;
}

export const SyncLogSchema = new Schema<SyncLog>(
  {
    propertyId: objectId(MODEL.Property),
    channel: enumOf(ChannelCode),
    syncJobId: objectId(MODEL.SyncJob, false),
    action: { type: String, required: true, trim: true, maxlength: 100 },
    status: enumOf(SyncLogStatus),
    requestMetadata: { type: Schema.Types.Mixed, default: {} },
    responseMetadata: { type: Schema.Types.Mixed, default: {} },
    error: { type: String, maxlength: 4000 },
    duration: { type: Number, min: 0, required: true },
  },
  baseSchemaOptions(COLLECTION.syncLogs, 'createdOnly'),
);

// Tokens, passwords and payment secrets never reach this collection.
SyncLogSchema.pre('validate', function () {
  this.requestMetadata = redactSecrets(this.requestMetadata ?? {});
  this.responseMetadata = redactSecrets(this.responseMetadata ?? {});
  if (this.error) this.error = redactSecrets(this.error);
});

SyncLogSchema.index({ propertyId: 1, channel: 1, createdAt: -1 });
SyncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: SYNC_LOG_RETENTION_DAYS * DAY_S });

// ================================================================ notifications

export interface Notification {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  /** Staff recipient (IN_APP and staff alerts). */
  userId: Types.ObjectId | null;
  reservationId: Types.ObjectId | null;
  type: NotificationType;
  channel: NotificationChannel;
  /** Email address / E.164 phone for EMAIL, SMS and WHATSAPP. */
  recipient?: string;
  status: NotificationStatus;
  subject?: string;
  message: string;
  metadata: Record<string, unknown>;
  attempts: number;
  /** Makes scheduled notifications (reminders) idempotent. */
  dedupeKey?: string;
  enqueuedAt: Date | null;
  /** Worker lease; a notification is sent by one worker at a time. */
  lockedUntil: Date | null;
  lastError?: string;
  sentAt?: Date;
  readAt?: Date;
  createdAt: Date;
}

export const NotificationSchema = new Schema<Notification>(
  {
    propertyId: objectId(MODEL.Property),
    userId: objectId(MODEL.User, false),
    reservationId: objectId(MODEL.Reservation, false),
    type: enumOf(NotificationType),
    channel: enumOf(NotificationChannel),
    recipient: { type: String, trim: true, maxlength: 254 },
    status: enumOf(NotificationStatus, true, NotificationStatus.QUEUED),
    subject: { type: String, maxlength: 300 },
    message: { type: String, required: true, maxlength: 5000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    attempts: { ...count(), default: 0 },
    dedupeKey: { type: String, maxlength: 200 },
    enqueuedAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, maxlength: 2000 },
    sentAt: { type: Date },
    readAt: { type: Date },
  },
  baseSchemaOptions(COLLECTION.notifications, 'createdOnly'),
);

NotificationSchema.pre('validate', function () {
  if (this.channel === NotificationChannel.IN_APP && !this.userId) {
    this.invalidate('userId', 'IN_APP notifications need a userId');
  }
  if (this.channel !== NotificationChannel.IN_APP && !this.recipient) {
    this.invalidate('recipient', `${this.channel} notifications need a recipient`);
  }
  this.metadata = redactSecrets(this.metadata ?? {});
});

// Dispatcher queue.
NotificationSchema.index({ status: 1, createdAt: 1 });
NotificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
// In-app inbox.
NotificationSchema.index(
  { userId: 1, createdAt: -1 },
  { partialFilterExpression: { userId: { $type: 'objectId' } } },
);
// Communication history on the reservation page.
NotificationSchema.index(
  { reservationId: 1 },
  { partialFilterExpression: { reservationId: { $type: 'objectId' } } },
);

// ================================================================ audit_logs

/** Append-only. The update/delete hooks below reject mutations from the application. */
export interface AuditLog {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId | null;
  propertyId: Types.ObjectId | null;
  /** Null for system actors (workers, webhooks). */
  userId: Types.ObjectId | null;
  action: string;
  entityType: string;
  entityId: Types.ObjectId;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export const AuditLogSchema = new Schema<AuditLog>(
  {
    organizationId: objectId(MODEL.Organization, false),
    propertyId: objectId(MODEL.Property, false),
    userId: objectId(MODEL.User, false),
    action: { type: String, required: true, trim: true, maxlength: 100 },
    entityType: { type: String, required: true, trim: true, maxlength: 60 },
    entityId: { type: Schema.Types.ObjectId, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  baseSchemaOptions(COLLECTION.auditLogs, 'createdOnly'),
);

AuditLogSchema.pre('validate', function () {
  this.before = redactSecrets(this.before);
  this.after = redactSecrets(this.after);
  this.metadata = redactSecrets(this.metadata ?? {});
});

const rejectMutation = () => {
  throw new Error('audit_logs is append-only');
};
AuditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectMutation,
);

AuditLogSchema.index({ propertyId: 1, createdAt: -1 });
AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
