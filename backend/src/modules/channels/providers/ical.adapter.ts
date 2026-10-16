import { createHash } from 'node:crypto';
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
import { IcalError, parseIcal } from './ical';
import { redactText } from './provider-engine';
import { HttpSafetyError, secureRequest } from './secure-http';

export interface IcalFeed {
  id: string;
  name: string;
  url: string;
}

export interface IcalContext {
  providerCode: string;
  displayName: string;
  connectionId: string;
  feeds: IcalFeed[];
  /** Currency of the property: calendar blocks carry no money, but a reservation needs a currency. */
  currency: string;
  allowPrivate?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface IcalPull {
  events: NormalizedReservationEvent[];
  skipped: { externalReservationId?: string; reason: string }[];
  /** Every external id the feeds currently contain (cancelled ones included): the basis for detecting removals. */
  presentExternalIds: string[];
  newestUpdatedAt?: undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const feedIdFor = (url: string) => `f-${createHash('sha256').update(url).digest('hex').slice(0, 10)}`;
const OWN_UID_SUFFIX = '@tirvona';

/**
 * Imports availability calendars (iCal/ICS feeds, as offered by many OTAs and channel managers) as blocked stays.
 *
 * Honest scope: a feed only says "these dates are taken". It carries no prices, guests, payments or restrictions, so this adapter
 * can read dates and nothing else, and every other operation is reported as unsupported. Each event becomes a zero-priced channel
 * booking of the mapped room type, so the dates leave the inventory through the same atomic path as any other booking.
 */
export class IcalAdapter implements ChannelAdapter {
  readonly channel: string;
  readonly displayName: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secretValues: string[];

  constructor(private readonly ctx: IcalContext) {
    this.channel = ctx.providerCode;
    this.displayName = ctx.displayName;
    this.sleep = ctx.sleep ?? realSleep;
    this.secretValues = ctx.feeds.map((f) => f.url);
  }

  isAvailable(): boolean {
    return true;
  }

  supports(operation: string): boolean {
    return ['listings', 'pullReservations', 'polling'].includes(operation);
  }

  async connect(_ctx: ConnectContext): Promise<ConnectResult> {
    void _ctx;
    if (!this.ctx.feeds.length) throw new ChannelError('CHANNEL_CONNECTION_TEST_FAILED', 'Add at least one calendar feed', false);
    // every feed must be reachable and a valid calendar before we call it connected
    for (const f of this.ctx.feeds) {
      try {
        await this.fetchFeed(f);
      } catch (e) {
        throw new ChannelError('CHANNEL_CONNECTION_TEST_FAILED', (e as Error).message, false);
      }
    }
    return { type: 'CONNECTED', credentials: { metadata: {} } };
  }

  async testConnection() {
    const started = Date.now();
    try {
      for (const f of this.ctx.feeds) await this.fetchFeed(f);
      return { ok: true, latencyMs: Date.now() - started, message: 'All calendars were read' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: (e as Error).message };
    }
  }

  async completeConnect(_ctx: CompleteConnectContext): Promise<ChannelCredentials> {
    void _ctx;
    throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', 'iCal feeds do not use an authorization redirect', false);
  }
  async disconnect(_c: ChannelCredentials): Promise<void> {
    void _c;
  }

  async getListings(_c: ChannelCredentials): Promise<ExternalListing[]> {
    void _c;
    return this.ctx.feeds.map((f) => ({ externalListingId: f.id, name: f.name, metadata: { rooms: [], ratePlans: [] } }));
  }

  private unsupported(op: string): never {
    throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', `${this.displayName} (iCal) cannot ${op}: a calendar feed only carries blocked dates`, false, { operation: op });
  }
  async getRoomTypes(_c: ChannelCredentials, _l: string): Promise<ExternalRoomType[]> {
    void _c, _l;
    return this.unsupported('list room types');
  }
  async getRates(_c: ChannelCredentials, _l: string): Promise<ExternalRatePlan[]> {
    void _c, _l;
    return this.unsupported('list rate plans');
  }
  async getReservation(_c: ChannelCredentials, _id: string): Promise<NormalizedReservationEvent | null> {
    void _c, _id;
    return this.unsupported('fetch a single reservation');
  }
  async updateAvailability(_c: ChannelCredentials, _u: AvailabilityUpdate[]): Promise<PushResult> {
    void _c, _u;
    return this.unsupported('receive availability (publish a Tirvona iCal feed for the other platform to import instead)');
  }
  async updateRates(_c: ChannelCredentials, _u: RateUpdate[]): Promise<PushResult> {
    void _c, _u;
    return this.unsupported('receive prices');
  }
  async updateRestrictions(_c: ChannelCredentials, _u: RestrictionUpdate[]): Promise<PushResult> {
    void _c, _u;
    return this.unsupported('receive restrictions');
  }
  async acknowledgeReservation(_c: ChannelCredentials, _id: string): Promise<void> {
    void _c, _id;
    return this.unsupported('acknowledge a reservation');
  }
  verifyWebhook(_req: InboundWebhookRequest): boolean {
    void _req;
    return false; // calendars are polled; nothing is ever pushed to us
  }
  parseWebhook(_body: unknown): ParsedWebhook {
    void _body;
    return this.unsupported('receive webhooks');
  }

  async getReservations(_c: ChannelCredentials, query: { since: Date }): Promise<NormalizedReservationEvent[]> {
    void _c;
    return (await this.pullReservations(query.since)).events;
  }

  /** Reads every feed. A failure of any feed fails the whole pull, so the absence of a failed feed's events is never mistaken for removal. */
  async pullReservations(_since: Date): Promise<IcalPull> {
    void _since; // a calendar has no "changed since": the whole feed is read each time and unchanged events are deduplicated downstream
    const events: NormalizedReservationEvent[] = [];
    const skipped: IcalPull['skipped'] = [];
    const present: string[] = [];
    for (const feed of this.ctx.feeds) {
      const parsed = await this.fetchFeed(feed);
      for (const s of parsed.skipped) skipped.push({ externalReservationId: s.uid ? this.externalId(feed.id, s.uid) : undefined, reason: s.reason });
      for (const e of parsed.events) {
        if (e.uid.toLowerCase().endsWith(OWN_UID_SUFFIX)) {
          skipped.push({ externalReservationId: this.externalId(feed.id, e.uid), reason: "it is one of Tirvona's own exported events (importing it would block the dates twice)" });
          continue;
        }
        const id = this.externalId(feed.id, e.uid);
        present.push(id);
        const nights = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86_400_000);
        if (nights < 1 || nights > 90) {
          skipped.push({ externalReservationId: id, reason: `stay of ${nights} nights is outside 1-90` });
          continue;
        }
        const revision = createHash('sha256').update([e.start, e.end, e.cancelled, e.summary ?? '', e.lastModified ?? ''].join('|')).digest('hex').slice(0, 16);
        events.push({
          kind: e.cancelled ? 'RESERVATION_CANCELLED' : 'RESERVATION_MODIFIED', // a modification of an unknown booking is applied as its creation
          channel: this.channel,
          externalScope: this.ctx.connectionId,
          revision,
          externalListingId: feed.id,
          externalReservationId: id,
          checkIn: e.start,
          checkOut: e.end,
          adults: 1,
          children: 0,
          guest: { firstName: 'Calendar', lastName: 'block' },
          rooms: [{ externalRoomId: null, quantity: 1, nightlyRates: Array.from({ length: nights }, () => 0) }],
          currency: this.ctx.currency,
          paymentCollectedByChannel: true,
          specialRequests: e.summary ? `iCal: ${e.summary}`.slice(0, 200) : 'iCal calendar block',
        });
      }
    }
    return { events, skipped, presentExternalIds: present };
  }

  private externalId(feedId: string, uid: string): string {
    return `${feedId}:${createHash('sha256').update(uid).digest('hex').slice(0, 24)}`;
  }

  private async fetchFeed(feed: IcalFeed) {
    let url: URL;
    try {
      url = new URL(feed.url);
    } catch {
      throw new ChannelError('CHANNEL_REQUEST_INVALID', `Calendar "${feed.name}" has an invalid address`, false);
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await secureRequest({
          url,
          method: 'GET',
          headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1' },
          allowedHosts: new Set([url.hostname.replace(/^\[|\]$/g, '').toLowerCase()]),
          timeoutMs: this.ctx.timeoutMs ?? 10_000,
          maxRequestBytes: 1024,
          maxResponseBytes: this.ctx.maxBytes ?? 2 * 1024 * 1024,
          allowPrivate: this.ctx.allowPrivate,
        });
        if (res.status === 404 || res.status === 410) throw new ChannelError('CHANNEL_REQUEST_REJECTED', `Calendar "${feed.name}" no longer exists (${res.status}). Check the address.`, false, { status: res.status });
        if (res.status === 401 || res.status === 403) throw new ChannelError('CHANNEL_AUTH_FAILED', `Calendar "${feed.name}" refused access (${res.status}). The address may have been revoked.`, false, { status: res.status });
        if (res.status < 200 || res.status >= 300) throw new HttpSafetyError('NETWORK', `HTTP ${res.status}`);
        return parseIcal(res.body);
      } catch (e) {
        lastError = e;
        if (e instanceof ChannelError) throw e;
        if (e instanceof IcalError) throw new ChannelError('CHANNEL_BAD_RESPONSE', `Calendar "${feed.name}" is not a valid iCalendar: ${e.message}`, false);
        if (e instanceof HttpSafetyError && !['TIMEOUT', 'NETWORK'].includes(e.code)) throw new ChannelError('CHANNEL_REQUEST_REFUSED', `Calendar "${feed.name}": ${this.safe(e.message)}`, false, { reason: e.code });
        if (attempt < 3) await this.sleep(300 * attempt);
      }
    }
    throw new ChannelError('CHANNEL_UNAVAILABLE', `Calendar "${feed.name}" could not be read: ${this.safe((lastError as Error)?.message ?? 'no answer')}`, true);
  }

  private safe(text: string) {
    return redactText(text, this.secretValues).slice(0, 200);
  }
}
