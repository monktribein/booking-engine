import type { ChannelCode } from '../../../database/enums';
import type { NormalizedReservationEvent } from '../../../database/services/webhook.service';

/**
 * The contract every OTA integration implements. The PMS core only ever
 * talks to channels through this interface, using channel-neutral values.
 * Anything specific to one OTA (endpoints, payload shapes, auth quirks,
 * webhook formats) stays inside that OTA's adapter folder.
 */

/** Decrypted credentials, held in memory only for the duration of a call. */
export interface ChannelCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  externalAccountId?: string;
  metadata: Record<string, unknown>;
}

export interface ConnectContext {
  propertyId: string;
  connectionId: string;
  /** Opaque anti-CSRF value; must come back unchanged on the OAuth callback. */
  state: string;
  redirectUri: string;
}

/**
 * Owners never paste API keys. connect() either returns the channel's
 * official authorization URL (OAuth-style consent) or, for channels that
 * connect by partner-side provisioning, finishes immediately.
 */
export type ConnectResult =
  | { type: 'REDIRECT'; authorizationUrl: string }
  | { type: 'CONNECTED'; credentials: ChannelCredentials };

export interface CompleteConnectContext {
  propertyId: string;
  connectionId: string;
  redirectUri: string;
  /** Query parameters the channel sent to the callback (code, etc.). */
  query: Record<string, string>;
}

export interface ExternalListing {
  externalListingId: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalRoomType {
  /** Null for channels where the listing itself is the sellable unit (Airbnb-style). */
  externalRoomId: string | null;
  name: string;
  maxOccupancy?: number;
}

export interface ExternalRatePlan {
  externalRatePlanId: string;
  name: string;
  externalRoomId: string | null;
}

export interface AvailabilityUpdate {
  externalListingId: string;
  externalRoomId: string | null;
  /** YYYY-MM-DD, property-local calendar date. */
  date: string;
  available: number;
  stopSell: boolean;
}

export interface RateUpdate {
  externalListingId: string;
  externalRoomId: string | null;
  externalRatePlanId: string;
  date: string;
  /** Minor units. */
  price: number;
  currency: string;
}

export interface RestrictionUpdate {
  externalListingId: string;
  externalRoomId: string | null;
  date: string;
  minimumStay: number | null;
  maximumStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  closed: boolean;
}

export interface PushResult {
  accepted: number;
  rejected: number;
  details?: Record<string, unknown>;
}

export interface InboundWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: unknown;
}

export interface ParsedWebhook {
  /** The channel's own event id (idempotency key). Absent → a hash of the body is used. */
  externalEventId?: string;
  eventType: string;
  /** Present for reservation events. Other events are stored and marked IGNORED. */
  reservation?: NormalizedReservationEvent;
}

export interface ChannelAdapter {
  readonly channel: ChannelCode;
  readonly displayName: string;

  /** False when this deployment lacks the partner access needed to talk to the channel. */
  isAvailable(): boolean;

  connect(ctx: ConnectContext): Promise<ConnectResult>;
  completeConnect(ctx: CompleteConnectContext): Promise<ChannelCredentials>;
  disconnect(creds: ChannelCredentials): Promise<void>;
  /** Exchange an expiring access token for a new one (OAuth refresh). Optional. */
  refreshCredentials?(creds: ChannelCredentials): Promise<ChannelCredentials>;

  getListings(creds: ChannelCredentials): Promise<ExternalListing[]>;
  getRoomTypes(creds: ChannelCredentials, externalListingId: string): Promise<ExternalRoomType[]>;
  getRates(creds: ChannelCredentials, externalListingId: string): Promise<ExternalRatePlan[]>;
  getReservations(creds: ChannelCredentials, query: { since: Date }): Promise<NormalizedReservationEvent[]>;
  getReservation(creds: ChannelCredentials, externalReservationId: string): Promise<NormalizedReservationEvent | null>;

  updateAvailability(creds: ChannelCredentials, updates: AvailabilityUpdate[]): Promise<PushResult>;
  updateRates(creds: ChannelCredentials, updates: RateUpdate[]): Promise<PushResult>;
  updateRestrictions(creds: ChannelCredentials, updates: RestrictionUpdate[]): Promise<PushResult>;
  acknowledgeReservation(creds: ChannelCredentials, externalReservationId: string): Promise<void>;

  /** Authenticate an inbound webhook (signature over the raw body). Must not throw. */
  verifyWebhook(req: InboundWebhookRequest): boolean;
  /** Translate a verified webhook body into channel-neutral terms. */
  parseWebhook(body: unknown): ParsedWebhook;
}

export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
