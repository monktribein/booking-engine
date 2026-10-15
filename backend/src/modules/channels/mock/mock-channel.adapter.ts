import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/configuration';
import { ChannelCode } from '../../../database/enums';
import { ChannelError } from '../../../database/errors';
import type { NormalizedReservationEvent } from '../../../database/services/webhook.service';
import type {
  AvailabilityUpdate,
  ChannelAdapter,
  ChannelCredentials,
  CompleteConnectContext,
  ConnectContext,
  ConnectResult,
  ExternalListing,
  ExternalRatePlan,
  ExternalRoomType,
  InboundWebhookRequest,
  ParsedWebhook,
  PushResult,
  RateUpdate,
  RestrictionUpdate,
} from '../interfaces/channel-adapter.interface';

export const MOCK_AUTH_CODE = 'mock-authorization-code';
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

/** The simulated OTA's catalogue: one single-unit listing (Airbnb-like) and one hotel (Booking.com-like). */
const CATALOGUE: Array<ExternalListing & { rooms: ExternalRoomType[]; ratePlans: ExternalRatePlan[] }> = [
  {
    externalListingId: 'MOCK-LISTING-1',
    name: 'Mock single-unit listing',
    rooms: [{ externalRoomId: null, name: 'Entire unit', maxOccupancy: 3 }],
    ratePlans: [{ externalRatePlanId: 'MOCK-RP-DEFAULT', name: 'Default', externalRoomId: null }],
  },
  {
    externalListingId: 'MOCK-HOTEL-1',
    name: 'Mock hotel listing',
    rooms: [
      { externalRoomId: 'MOCK-ROOM-STD', name: 'Standard', maxOccupancy: 2 },
      { externalRoomId: 'MOCK-ROOM-DLX', name: 'Deluxe', maxOccupancy: 3 },
      { externalRoomId: 'MOCK-ROOM-FAM', name: 'Family', maxOccupancy: 5 },
    ],
    ratePlans: ['STD', 'DLX', 'FAM'].flatMap((r) => [
      { externalRatePlanId: `MOCK-ROOM-${r}-FLEX`, name: 'Flexible', externalRoomId: `MOCK-ROOM-${r}` },
      { externalRatePlanId: `MOCK-ROOM-${r}-NRF`, name: 'Non-refundable', externalRoomId: `MOCK-ROOM-${r}` },
    ]),
  },
];

export interface MockWebhookBody {
  eventId: string;
  type: 'reservation.created' | 'reservation.modified' | 'reservation.cancelled' | 'listing.updated';
  reservation?: Omit<NormalizedReservationEvent, 'kind' | 'channel'>;
}

/**
 * In-memory "remote OTA" state. It is per process: run API and workers in one
 * process (the default) when using the mock channel end to end.
 */
@Injectable()
export class MockChannelStore {
  readonly availability = new Map<string, { available: number; stopSell: boolean; at: Date }>();
  readonly rates = new Map<string, { price: number; currency: string }>();
  readonly restrictions = new Map<string, RestrictionUpdate>();
  readonly reservations = new Map<string, NormalizedReservationEvent>();
  readonly acknowledged = new Set<string>();
  readonly pushes: { kind: 'availability' | 'rates' | 'restrictions'; count: number; at: Date }[] = [];
  private failNext = 0;

  key(listing: string, room: string | null, date: string) {
    return `${listing}|${room ?? '-'}|${date}`;
  }

  /** Make the next `n` push calls fail with a retryable error (sync-failure simulation). */
  failNextPushes(n: number) {
    this.failNext = n;
  }

  consumeFailure(): boolean {
    if (this.failNext > 0) {
      this.failNext--;
      return true;
    }
    return false;
  }

  reset() {
    this.availability.clear();
    this.rates.clear();
    this.restrictions.clear();
    this.reservations.clear();
    this.acknowledged.clear();
    this.pushes.length = 0;
    this.failNext = 0;
  }
}

/**
 * A complete, documented-by-us simulated OTA, so that connection, mapping,
 * sync, webhooks, retries and failure handling can be tested end to end
 * before real partner integrations exist. Disabled in production.
 */
@Injectable()
export class MockChannelAdapter implements ChannelAdapter {
  readonly channel = ChannelCode.MOCK;
  readonly displayName = 'Mock OTA';

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    readonly store: MockChannelStore,
  ) {}

  isAvailable(): boolean {
    return this.config.get('mockChannel', { infer: true }).enabled;
  }

  // ------------------------------------------------------------ connection (simulated OAuth)

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    const url = new URL(`${this.config.get('apiUrl', { infer: true })}/channels/MOCK/mock-authorize`);
    url.searchParams.set('state', ctx.state);
    url.searchParams.set('redirect_uri', ctx.redirectUri);
    return { type: 'REDIRECT', authorizationUrl: url.toString() };
  }

  async completeConnect(ctx: CompleteConnectContext): Promise<ChannelCredentials> {
    if (ctx.query.code !== MOCK_AUTH_CODE) throw new ChannelError('CHANNEL_AUTH_FAILED', 'Mock OTA rejected the authorization code');
    return {
      accessToken: `mock-at-${randomBytes(12).toString('hex')}`,
      refreshToken: `mock-rt-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600_000),
      externalAccountId: `mock-account-${ctx.propertyId}`,
      metadata: {},
    };
  }

  async disconnect(_creds: ChannelCredentials): Promise<void> {}

  async refreshCredentials(creds: ChannelCredentials): Promise<ChannelCredentials> {
    if (!creds.refreshToken?.startsWith('mock-rt-')) throw new ChannelError('CHANNEL_AUTH_FAILED', 'Mock OTA: invalid refresh token');
    return { ...creds, accessToken: `mock-at-${randomBytes(12).toString('hex')}`, expiresAt: new Date(Date.now() + 3600_000) };
  }

  // ------------------------------------------------------------ catalogue

  async getListings(creds: ChannelCredentials): Promise<ExternalListing[]> {
    this.auth(creds);
    return CATALOGUE.map(({ externalListingId, name }) => ({ externalListingId, name, metadata: { mock: true } }));
  }

  async getRoomTypes(creds: ChannelCredentials, externalListingId: string): Promise<ExternalRoomType[]> {
    this.auth(creds);
    return CATALOGUE.find((l) => l.externalListingId === externalListingId)?.rooms ?? [];
  }

  async getRates(creds: ChannelCredentials, externalListingId: string): Promise<ExternalRatePlan[]> {
    this.auth(creds);
    return CATALOGUE.find((l) => l.externalListingId === externalListingId)?.ratePlans ?? [];
  }

  async getReservations(creds: ChannelCredentials, _q: { since: Date }): Promise<NormalizedReservationEvent[]> {
    this.auth(creds);
    return [...this.store.reservations.values()];
  }

  async getReservation(creds: ChannelCredentials, id: string): Promise<NormalizedReservationEvent | null> {
    this.auth(creds);
    return this.store.reservations.get(id) ?? null;
  }

  // ------------------------------------------------------------ pushes

  async updateAvailability(creds: ChannelCredentials, updates: AvailabilityUpdate[]): Promise<PushResult> {
    this.auth(creds);
    this.maybeFail();
    const at = new Date();
    for (const u of updates) this.store.availability.set(this.store.key(u.externalListingId, u.externalRoomId, u.date), { available: u.available, stopSell: u.stopSell, at });
    this.store.pushes.push({ kind: 'availability', count: updates.length, at });
    return { accepted: updates.length, rejected: 0 };
  }

  async updateRates(creds: ChannelCredentials, updates: RateUpdate[]): Promise<PushResult> {
    this.auth(creds);
    this.maybeFail();
    for (const u of updates) {
      this.store.rates.set(`${this.store.key(u.externalListingId, u.externalRoomId, u.date)}|${u.externalRatePlanId}`, { price: u.price, currency: u.currency });
    }
    this.store.pushes.push({ kind: 'rates', count: updates.length, at: new Date() });
    return { accepted: updates.length, rejected: 0 };
  }

  async updateRestrictions(creds: ChannelCredentials, updates: RestrictionUpdate[]): Promise<PushResult> {
    this.auth(creds);
    this.maybeFail();
    for (const u of updates) this.store.restrictions.set(this.store.key(u.externalListingId, u.externalRoomId, u.date), u);
    this.store.pushes.push({ kind: 'restrictions', count: updates.length, at: new Date() });
    return { accepted: updates.length, rejected: 0 };
  }

  async acknowledgeReservation(creds: ChannelCredentials, id: string): Promise<void> {
    this.auth(creds);
    this.store.acknowledged.add(id);
  }

  // ------------------------------------------------------------ webhooks

  sign(rawBody: string | Buffer): string {
    return createHmac('sha256', this.config.get('mockChannel', { infer: true }).webhookSecret).update(rawBody).digest('hex');
  }

  verifyWebhook(req: InboundWebhookRequest): boolean {
    const header = req.headers[MOCK_SIGNATURE_HEADER];
    const given = Array.isArray(header) ? header[0] : header;
    if (!given || !/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = Buffer.from(this.sign(req.rawBody), 'hex');
    return timingSafeEqual(expected, Buffer.from(given, 'hex'));
  }

  parseWebhook(body: unknown): ParsedWebhook {
    const b = body as MockWebhookBody;
    if (!b || typeof b.eventId !== 'string' || typeof b.type !== 'string') {
      throw new ChannelError('WEBHOOK_MALFORMED', 'Mock webhook needs eventId and type');
    }
    const kind = ({
      'reservation.created': 'RESERVATION_CREATED',
      'reservation.modified': 'RESERVATION_MODIFIED',
      'reservation.cancelled': 'RESERVATION_CANCELLED',
    } as const)[b.type as 'reservation.created'];
    if (!kind || !b.reservation) return { externalEventId: b.eventId, eventType: b.type };
    return { externalEventId: b.eventId, eventType: b.type, reservation: { ...b.reservation, kind, channel: ChannelCode.MOCK } };
  }

  /** Build a signed webhook as the mock OTA would send it (used by simulation endpoints and tests). */
  buildWebhook(body: MockWebhookBody): { rawBody: Buffer; headers: Record<string, string>; body: MockWebhookBody } {
    if (body.reservation && body.type !== 'listing.updated') {
      const kind = body.type === 'reservation.cancelled' ? 'RESERVATION_CANCELLED' : body.type === 'reservation.modified' ? 'RESERVATION_MODIFIED' : 'RESERVATION_CREATED';
      this.store.reservations.set(body.reservation.externalReservationId, { ...body.reservation, kind, channel: ChannelCode.MOCK });
    }
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: this.sign(rawBody) }, body };
  }

  // ------------------------------------------------------------ internals

  private auth(creds: ChannelCredentials) {
    if (!creds.accessToken?.startsWith('mock-at-')) throw new ChannelError('CHANNEL_AUTH_FAILED', 'Mock OTA: invalid access token', false);
  }

  private maybeFail() {
    const rate = this.config.get('mockChannel', { infer: true }).failureRate;
    if (this.store.consumeFailure() || (rate > 0 && Math.random() < rate)) {
      throw new ChannelError('CHANNEL_UNAVAILABLE', 'Mock OTA: simulated 503 Service Unavailable', true);
    }
  }
}
