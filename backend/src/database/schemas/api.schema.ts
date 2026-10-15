import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { baseSchemaOptions, count, enumOf, objectId } from '../common/schema-helpers';
import { ApiKeyStatus, WebhookDeliveryStatus, WebhookEndpointStatus } from '../enums';

const DAY_S = 86_400;
/** Delivery history is kept this long (a TTL on the terminal states only). */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

// ================================================================ api_keys

/**
 * Credential for the public API (/v1). Only a SHA-256 hash of the key is
 * stored (keys are 256-bit random, so a fast hash is appropriate); the key
 * itself is shown once at creation. `prefix` is the non-secret lookup handle.
 */
export interface ApiKey {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** Empty = every property of the organization. */
  propertyIds: Types.ObjectId[];
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  status: ApiKeyStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ApiKeySchema = new Schema<ApiKey>(
  {
    organizationId: objectId(MODEL.Organization),
    propertyIds: { type: [Schema.Types.ObjectId], default: [], validate: { validator: (v: unknown[]) => v.length <= 100, message: 'at most 100 properties' } },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    prefix: { type: String, required: true, match: /^[a-z0-9]{8}$/ },
    keyHash: { type: String, required: true, select: false, match: /^[a-f0-9]{64}$/ },
    scopes: { type: [String], required: true, validate: { validator: (v: string[]) => v.length > 0 && v.length <= 20, message: 'scopes must hold 1-20 entries' } },
    status: enumOf(ApiKeyStatus, true, ApiKeyStatus.ACTIVE),
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: objectId(MODEL.User, false),
  },
  baseSchemaOptions(COLLECTION.apiKeys),
);

ApiKeySchema.index({ prefix: 1 }, { unique: true });
ApiKeySchema.index({ organizationId: 1, status: 1 });

// ================================================================ webhook_endpoints

/** A customer URL that receives signed event deliveries. The signing secret is stored encrypted (AES-256-GCM). */
export interface WebhookEndpoint {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** Empty = events of every property of the organization. */
  propertyIds: Types.ObjectId[];
  url: string;
  description?: string;
  /** Event types, or '*' for all. */
  events: string[];
  secretEncrypted: string;
  status: WebhookEndpointStatus;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const WebhookEndpointSchema = new Schema<WebhookEndpoint>(
  {
    organizationId: objectId(MODEL.Organization),
    propertyIds: { type: [Schema.Types.ObjectId], default: [], validate: { validator: (v: unknown[]) => v.length <= 100, message: 'at most 100 properties' } },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    description: { type: String, trim: true, maxlength: 300 },
    events: { type: [String], required: true, validate: { validator: (v: string[]) => v.length > 0 && v.length <= 30, message: 'events must hold 1-30 entries' } },
    secretEncrypted: { type: String, required: true, select: false },
    status: enumOf(WebhookEndpointStatus, true, WebhookEndpointStatus.ACTIVE),
    createdBy: objectId(MODEL.User, false),
  },
  baseSchemaOptions(COLLECTION.webhookEndpoints),
);

WebhookEndpointSchema.index({ organizationId: 1, status: 1 });

// ================================================================ webhook_deliveries

/**
 * Outbound delivery of one event to one endpoint (transactional outbox, like
 * sync_jobs). Inserted in the transaction that caused the event. The body is
 * stored exactly as it is sent, so every retry carries identical bytes and the
 * same event id; unique (endpointId, eventId) makes event emission idempotent.
 */
export interface WebhookDelivery {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  endpointId: Types.ObjectId;
  eventId: string;
  eventType: string;
  body: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lockedUntil: Date | null;
  enqueuedAt: Date | null;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const WebhookDeliverySchema = new Schema<WebhookDelivery>(
  {
    organizationId: objectId(MODEL.Organization),
    endpointId: objectId(MODEL.WebhookEndpoint),
    eventId: { type: String, required: true, maxlength: 80 },
    eventType: { type: String, required: true, maxlength: 60 },
    body: { type: String, required: true, maxlength: 200_000 },
    status: enumOf(WebhookDeliveryStatus, true, WebhookDeliveryStatus.PENDING),
    attempts: { ...count(), default: 0 },
    maxAttempts: { ...count(true, 1), max: 50, default: 12 },
    lockedUntil: { type: Date, default: null },
    enqueuedAt: { type: Date, default: null },
    lastStatusCode: { type: Number },
    lastError: { type: String, maxlength: 2000 },
    deliveredAt: { type: Date },
  },
  baseSchemaOptions(COLLECTION.webhookDeliveries),
);

WebhookDeliverySchema.index({ endpointId: 1, eventId: 1 }, { unique: true });
// Outbox relay: rows that were never handed to the queue.
WebhookDeliverySchema.index({ status: 1, enqueuedAt: 1 });
WebhookDeliverySchema.index({ endpointId: 1, createdAt: -1 });
WebhookDeliverySchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_S,
    partialFilterExpression: { status: { $in: [WebhookDeliveryStatus.DELIVERED, WebhookDeliveryStatus.FAILED] } },
  },
);
