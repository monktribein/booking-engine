import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { ENCRYPTED_SECRET_RE } from '../common/crypto';
import { redactSecrets } from '../common/redact';
import { baseSchemaOptions, enumOf, objectId } from '../common/schema-helpers';
import {
  ChannelCode,
  ChannelConnectionStatus,
  ChannelKind,
  ChannelListingStatus,
  ChannelStatus,
  MappingStatus,
  MarkupType,
} from '../enums';

/**
 * The channel model is deliberately generic. Nothing here encodes an OTA's
 * wire format. Anything channel-specific (listing attributes, API hints)
 * goes in `metadata`, which the adapter for that channel owns.
 *
 *   Property ─┬─ channel_connections  (1 per property per channel: credentials, health)
 *             ├─ channel_listings     (what exists on the channel: an Airbnb listing, a Booking.com hotel)
 *             │     └─ channel_room_mappings  (listing[/external room] → Tirvona room type)
 *             │            └─ channel_rate_mappings (external rate plan → Tirvona rate plan + markup)
 *             └─ room_types ← consumed by every mapping
 */

// ================================================================ channels (reference data)

export interface Channel {
  _id: Types.ObjectId;
  code: ChannelCode;
  name: string;
  kind: ChannelKind;
  status: ChannelStatus;
  capabilities: {
    availability: boolean;
    rates: boolean;
    restrictions: boolean;
    reservations: boolean;
    webhooks: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export const ChannelSchema = new Schema<Channel>(
  {
    code: enumOf(ChannelCode),
    name: { type: String, required: true, trim: true },
    kind: enumOf(ChannelKind),
    status: enumOf(ChannelStatus, true, ChannelStatus.ACTIVE),
    capabilities: {
      availability: { type: Boolean, default: false },
      rates: { type: Boolean, default: false },
      restrictions: { type: Boolean, default: false },
      reservations: { type: Boolean, default: false },
      webhooks: { type: Boolean, default: false },
    },
  },
  baseSchemaOptions(COLLECTION.channels),
);

ChannelSchema.index({ code: 1 }, { unique: true });

// ================================================================ channel_connections

export interface ChannelConnection {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channel: ChannelCode;
  status: ChannelConnectionStatus;
  externalAccountId?: string;
  /** AES-256-GCM envelopes (common/crypto.ts). Never plaintext; excluded from queries by default. */
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  expiresAt?: Date;
  /** sha256 of the OAuth `state` issued by connect(); cleared on callback. */
  oauthStateHash?: string | null;
  oauthStateExpiresAt?: Date | null;
  connectedAt?: Date;
  lastSyncAt?: Date;
  lastError?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const encryptedSecret = {
  type: String,
  select: false,
  match: [ENCRYPTED_SECRET_RE, '{PATH} must be an encrypted envelope (v1:...), never a raw credential'] as [RegExp, string],
};

export const ChannelConnectionSchema = new Schema<ChannelConnection>(
  {
    propertyId: objectId(MODEL.Property),
    channel: enumOf(ChannelCode),
    status: enumOf(ChannelConnectionStatus, true, ChannelConnectionStatus.DISCONNECTED),
    externalAccountId: { type: String, trim: true, maxlength: 200 },
    accessTokenEncrypted: encryptedSecret,
    refreshTokenEncrypted: encryptedSecret,
    expiresAt: { type: Date },
    oauthStateHash: { type: String, default: null, select: false },
    oauthStateExpiresAt: { type: Date, default: null },
    connectedAt: { type: Date },
    lastSyncAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    ...baseSchemaOptions(COLLECTION.channelConnections),
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.accessTokenEncrypted;
        delete ret.refreshTokenEncrypted;
        return ret;
      },
    },
  },
);

ChannelConnectionSchema.pre('validate', function () {
  this.metadata = redactSecrets(this.metadata ?? {});
});

// One connection per channel per property. The index also serves propertyId + channel lookups.
ChannelConnectionSchema.index({ propertyId: 1, channel: 1 }, { unique: true });
// OAuth callback lookup.
ChannelConnectionSchema.index({ oauthStateHash: 1 }, { partialFilterExpression: { oauthStateHash: { $type: 'string' } } });

// ================================================================ channel_listings

export interface ChannelListing {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channelConnectionId: Types.ObjectId | null;
  channel: ChannelCode;
  /** Airbnb listing ID, Booking.com hotel ID, Agoda property ID, ... */
  externalListingId: string;
  name: string;
  status: ChannelListingStatus;
  lastSyncedAt?: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const ChannelListingSchema = new Schema<ChannelListing>(
  {
    propertyId: objectId(MODEL.Property),
    channelConnectionId: objectId(MODEL.ChannelConnection, false),
    channel: enumOf(ChannelCode),
    externalListingId: { type: String, required: true, trim: true, maxlength: 100 },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    status: enumOf(ChannelListingStatus, true, ChannelListingStatus.ACTIVE),
    lastSyncedAt: { type: Date },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  baseSchemaOptions(COLLECTION.channelListings),
);

ChannelListingSchema.pre('validate', function () {
  this.metadata = redactSecrets(this.metadata ?? {});
});

// An external listing ID identifies exactly one listing on its channel, so it
// can belong to only one Tirvona property, whichever tenant claims it. This
// is stricter than propertyId + channel + externalListingId and implies it.
// It also routes inbound webhooks, which carry the listing ID but not our propertyId.
ChannelListingSchema.index({ channel: 1, externalListingId: 1 }, { unique: true });
// Listings of a property, per channel (property + channel).
ChannelListingSchema.index({ propertyId: 1, channel: 1 });

// ================================================================ channel_room_mappings

export interface ChannelRoomMapping {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channel: ChannelCode;
  channelListingId: Types.ObjectId;
  /**
   * Room identifier inside the listing, for channels where one listing (a hotel)
   * holds several room types, as Booking.com and Agoda do. Null for
   * one-listing-one-unit channels such as Airbnb.
   */
  externalRoomId: string | null;
  roomTypeId: Types.ObjectId;
  status: MappingStatus;
  syncAvailability: boolean;
  syncRates: boolean;
  syncRestrictions: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const ChannelRoomMappingSchema = new Schema<ChannelRoomMapping>(
  {
    propertyId: objectId(MODEL.Property),
    channel: enumOf(ChannelCode),
    channelListingId: objectId(MODEL.ChannelListing),
    externalRoomId: { type: String, trim: true, maxlength: 100, default: null },
    roomTypeId: objectId(MODEL.RoomType),
    status: enumOf(MappingStatus, true, MappingStatus.ACTIVE),
    syncAvailability: { type: Boolean, default: true },
    syncRates: { type: Boolean, default: true },
    syncRestrictions: { type: Boolean, default: true },
    lastSyncedAt: { type: Date },
  },
  baseSchemaOptions(COLLECTION.channelRoomMappings),
);

// No duplicate mappings: each (listing, external room) maps to exactly one room
// type. A null externalRoomId counts as a value, so an Airbnb listing gets one mapping.
ChannelRoomMappingSchema.index({ channelListingId: 1, externalRoomId: 1 }, { unique: true });
// Outbound fan-out: "room type X changed, which channel listings consume it?"
ChannelRoomMappingSchema.index({ propertyId: 1, roomTypeId: 1, channel: 1 });

// ================================================================ channel_rate_mappings

export interface ChannelRateMapping {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  channel: ChannelCode;
  channelRoomMappingId: Types.ObjectId;
  externalRatePlanId: string;
  ratePlanId: Types.ObjectId;
  markupType: MarkupType;
  /** Percent for PERCENTAGE (may be negative for a channel discount); minor units for FIXED. */
  markupValue: number;
  status: MappingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const ChannelRateMappingSchema = new Schema<ChannelRateMapping>(
  {
    propertyId: objectId(MODEL.Property),
    channel: enumOf(ChannelCode),
    channelRoomMappingId: objectId(MODEL.ChannelRoomMapping),
    externalRatePlanId: { type: String, required: true, trim: true, maxlength: 100 },
    ratePlanId: objectId(MODEL.RatePlan),
    markupType: enumOf(MarkupType, true, MarkupType.NONE),
    markupValue: { type: Number, default: 0 },
    status: enumOf(MappingStatus, true, MappingStatus.ACTIVE),
  },
  baseSchemaOptions(COLLECTION.channelRateMappings),
);

ChannelRateMappingSchema.pre('validate', function () {
  if (this.markupType === MarkupType.NONE && this.markupValue !== 0) {
    this.invalidate('markupValue', 'markupValue must be 0 when markupType is NONE');
  }
  if (this.markupType === MarkupType.PERCENTAGE && (this.markupValue < -90 || this.markupValue > 500)) {
    this.invalidate('markupValue', 'Percentage markup must be between -90 and 500');
  }
  if (this.markupType === MarkupType.FIXED && !Number.isInteger(this.markupValue)) {
    this.invalidate('markupValue', 'Fixed markup must be an integer in minor units');
  }
});

ChannelRateMappingSchema.index({ channelRoomMappingId: 1, externalRatePlanId: 1 }, { unique: true });
// Outbound fan-out on a rate change: "rate plan X changed, which channel rates derive from it?"
ChannelRateMappingSchema.index({ propertyId: 1, ratePlanId: 1 });
