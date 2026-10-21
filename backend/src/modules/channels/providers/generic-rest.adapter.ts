import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ChannelError } from '../../../database/errors';
import type { ChannelPaymentInfo } from '../../../database/common/payment-info';
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
import {
  DEFAULT_LIMITS,
  DEFAULT_RETRY,
  type OperationName,
  OPERATION_CAPABILITY,
  type OperationSpec,
  PLATFORM_LIMITS,
  type ProviderDefinition,
} from './provider-definition';
import { DefinitionRuntimeError, extractAll, extractOne, readField, redactText, renderBody, renderString, type TemplateContext } from './provider-engine';
import { HttpSafetyError, secureRequest } from './secure-http';

/** Decrypted credentials of one connection, held in memory for the life of the adapter instance only. */
export interface ProviderSecrets {
  API_KEY?: string;
  BEARER_TOKEN?: string;
  BASIC_USERNAME?: string;
  BASIC_PASSWORD?: string;
  SIGNING_SECRET?: string;
  FEED_URLS?: string;
  WEBHOOK_SECRET?: string;
}

export interface GenericRestContext {
  providerCode: string;
  displayName: string;
  environment: 'production' | 'sandbox';
  connectionId: string;
  externalAccountId?: string | null;
  secrets: ProviderSecrets;
  /** Local fake servers in tests/dev only. */
  allowPrivate?: boolean;
  /** Test hook: replaces real sleeping between retries. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReservationPull {
  events: NormalizedReservationEvent[];
  skipped: { externalReservationId?: string; reason: string }[];
  /** Newest `updatedAt` seen among the mapped items, when the provider supplies it; the polling cursor advances to it. */
  newestUpdatedAt?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ per-connection throttling (shared by every instance)

class Throttle {
  private nextSlot = 0;
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private readonly minIntervalMs: number,
    private readonly maxConcurrent: number,
  ) {}
  async acquire(): Promise<() => void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await realSleep(slot - now);
    while (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
const throttles = new Map<string, Throttle>();
function throttleFor(connectionId: string, rps: number): Throttle {
  const key = `${connectionId}:${rps}`;
  let t = throttles.get(key);
  if (!t) {
    if (throttles.size > 5000) throttles.clear();
    t = new Throttle(Math.ceil(1000 / rps), 4);
    throttles.set(key, t);
  }
  return t;
}

// ------------------------------------------------------------------ the adapter

/**
 * A ChannelAdapter driven entirely by a validated ProviderDefinition. One instance serves one connection: the credentials
 * and the connection id are bound at construction, so one tenant's secrets can never be used for another tenant's call.
 * It has no per-provider code: everything provider-specific is in the definition.
 */
export class GenericRestAdapter implements ChannelAdapter {
  private readonly logger = new Logger('GenericRestAdapter');
  readonly channel: string;
  readonly displayName: string;
  private readonly allowedHosts: Set<string>;
  private readonly baseUrl: URL;
  private readonly limits: { timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number };
  private readonly retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; retryOnStatus: number[] };
  private readonly rps: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secretValues: string[];

  constructor(
    private readonly def: ProviderDefinition,
    private readonly ctx: GenericRestContext,
  ) {
    this.channel = ctx.providerCode;
    this.displayName = ctx.displayName;
    this.allowedHosts = new Set(def.allowedHosts.map((h) => h.toLowerCase()));
    const env = def.environments[ctx.environment] ?? null;
    if (!env) throw new ChannelError('CHANNEL_ENVIRONMENT_UNAVAILABLE', `${ctx.displayName} has no ${ctx.environment} environment configured`, false);
    this.baseUrl = new URL(env.baseUrl);
    this.limits = { ...DEFAULT_LIMITS, ...(def.limits ?? {}) };
    this.retry = { ...DEFAULT_RETRY, retryOnStatus: [...DEFAULT_RETRY.retryOnStatus], ...(def.retry ?? {}) };
    this.rps = Math.min(def.rateLimit?.requestsPerSecond ?? 10, PLATFORM_LIMITS.requestsPerSecond);
    this.sleep = ctx.sleep ?? realSleep;
    this.secretValues = Object.values(ctx.secrets).filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  isAvailable(): boolean {
    return true;
  }

  /** Whether the definition declares (and defines) this operation. Callers gate on it; calling an unsupported operation throws. */
  supports(op: OperationName | string): boolean {
    const cap = (OPERATION_CAPABILITY as Record<string, string | null>)[op];
    if (cap === undefined) {
      // capability names are also accepted (listings, roomTypes, ...)
      return this.def.capabilities[op as keyof ProviderDefinition['capabilities']] === true;
    }
    return cap === null ? !!this.def.operations[op as OperationName] : this.def.capabilities[cap as keyof ProviderDefinition['capabilities']] === true && !!this.def.operations[op as OperationName];
  }

  // ------------------------------------------------------------ connection

  async connect(_ctx: ConnectContext): Promise<ConnectResult> {
    void _ctx;
    const t = await this.testConnection();
    if (!t.ok) throw new ChannelError('CHANNEL_CONNECTION_TEST_FAILED', `${this.displayName}: ${t.message}`, false);
    return { type: 'CONNECTED', credentials: { metadata: {}, externalAccountId: this.ctx.externalAccountId ?? undefined } };
  }

  async completeConnect(_ctx: CompleteConnectContext): Promise<ChannelCredentials> {
    void _ctx;
    throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', `${this.displayName} does not use an authorization redirect`, false);
  }

  async disconnect(_creds: ChannelCredentials): Promise<void> {
    void _creds; // nothing to revoke remotely: credentials are deleted locally by the caller
  }

  /** The configured read-only health call. Never changes remote data. */
  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const r = await this.request('healthCheck', this.baseContext(), {});
      return { ok: true, status: r.status, latencyMs: Date.now() - started, message: 'Connection verified' };
    } catch (e) {
      const err = e as ChannelError;
      return { ok: false, latencyMs: Date.now() - started, message: this.safeMessage(err.message), status: (err.details?.status as number | undefined) };
    }
  }

  // ------------------------------------------------------------ master data

  async getListings(_creds: ChannelCredentials): Promise<ExternalListing[]> {
    void _creds;
    const spec = this.spec('listListings');
    const items = await this.fetchAll('listListings', spec, this.baseContext());
    return items.map((it) => {
      const f = this.mapFields(it, spec);
      return { externalListingId: this.req(f, 'externalListingId', 'listing'), name: String(f.name ?? f.externalListingId), metadata: {} };
    });
  }

  async getRoomTypes(_creds: ChannelCredentials, externalListingId: string): Promise<ExternalRoomType[]> {
    void _creds;
    const spec = this.spec('listRoomTypes');
    const items = await this.fetchAll('listRoomTypes', spec, { ...this.baseContext(), externalListingId });
    return items.map((it) => {
      const f = this.mapFields(it, spec);
      const max = f.maxOccupancy === undefined ? undefined : Number(f.maxOccupancy);
      return { externalRoomId: f.externalRoomId === undefined || f.externalRoomId === null ? null : String(f.externalRoomId), name: String(f.name ?? f.externalRoomId ?? externalListingId), ...(max !== undefined && Number.isFinite(max) ? { maxOccupancy: max } : {}) };
    });
  }

  async getRates(_creds: ChannelCredentials, externalListingId: string): Promise<ExternalRatePlan[]> {
    void _creds;
    const spec = this.spec('listRatePlans');
    const items = await this.fetchAll('listRatePlans', spec, { ...this.baseContext(), externalListingId });
    return items.map((it) => {
      const f = this.mapFields(it, spec);
      return {
        externalRatePlanId: this.req(f, 'externalRatePlanId', 'rate plan'),
        name: String(f.name ?? f.externalRatePlanId),
        externalRoomId: f.externalRoomId === undefined || f.externalRoomId === null ? null : String(f.externalRoomId),
      };
    });
  }

  // ------------------------------------------------------------ reservations (inbound)

  async getReservations(_creds: ChannelCredentials, query: { since: Date }): Promise<NormalizedReservationEvent[]> {
    return (await this.pullReservations(query.since)).events;
  }

  /** Like getReservations but also reports what was skipped and why, and the newest provider timestamp seen (for the cursor). */
  async pullReservations(since: Date): Promise<ReservationPull> {
    const spec = this.spec('listReservations');
    const items = await this.fetchAll('listReservations', spec, { ...this.baseContext(), since: since.toISOString(), sinceDate: since.toISOString().slice(0, 10) });
    return this.normalizeAll(items.map((it) => this.mapFields(it, spec)), items);
  }

  async getReservation(_creds: ChannelCredentials, externalReservationId: string): Promise<NormalizedReservationEvent | null> {
    void _creds;
    const spec = this.spec('getReservation');
    let res;
    try {
      res = await this.request('getReservation', { ...this.baseContext(), externalReservationId }, {});
    } catch (e) {
      if ((e as ChannelError).details?.status === 404) return null;
      throw e;
    }
    const item = spec.items && spec.items !== '$' ? extractOne(res.json, spec.items) : res.json;
    if (item === undefined || item === null) return null;
    const out = this.normalizeAll([this.mapFields(item, spec)], [item]);
    return out.events[0] ?? null;
  }

  // ------------------------------------------------------------ pushes (outbound)

  async updateAvailability(_creds: ChannelCredentials, updates: AvailabilityUpdate[]): Promise<PushResult> {
    void _creds;
    return this.push('pushAvailability', updates.map((u) => ({ externalListingId: u.externalListingId, externalRoomId: u.externalRoomId, date: u.date, available: u.available, stopSell: u.stopSell })));
  }

  async updateRates(_creds: ChannelCredentials, updates: RateUpdate[]): Promise<PushResult> {
    void _creds;
    return this.push('pushRates', updates.map((u) => ({ externalListingId: u.externalListingId, externalRoomId: u.externalRoomId, externalRatePlanId: u.externalRatePlanId, date: u.date, price: u.price, currency: u.currency })));
  }

  async updateRestrictions(_creds: ChannelCredentials, updates: RestrictionUpdate[]): Promise<PushResult> {
    void _creds;
    return this.push(
      'pushRestrictions',
      updates.map((u) => ({
        externalListingId: u.externalListingId,
        externalRoomId: u.externalRoomId,
        date: u.date,
        minimumStay: u.minimumStay,
        maximumStay: u.maximumStay,
        closedToArrival: u.closedToArrival,
        closedToDeparture: u.closedToDeparture,
        closed: u.closed,
      })),
    );
  }

  async acknowledgeReservation(_creds: ChannelCredentials, externalReservationId: string): Promise<void> {
    void _creds;
    await this.request('ackReservation', { ...this.baseContext(), externalReservationId }, {});
  }

  // ------------------------------------------------------------ inbound webhooks

  /** Verifies the signature with THIS connection's secret. Never throws; false on any problem. */
  verifyWebhook(req: InboundWebhookRequest): boolean {
    try {
      const w = this.def.webhook;
      const secret = this.ctx.secrets.WEBHOOK_SECRET;
      if (!w || !secret || !this.def.capabilities.webhooks) return false;
      const header = pickHeader(req.headers, w.signature.header);
      if (!header) return false;
      let provided: string;
      let timestamp: string | undefined;
      if (w.signature.format === 'stripe') {
        const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
        provided = parts.v1;
        timestamp = parts.t;
        if (!provided || !timestamp) return false;
      } else {
        provided = header.trim();
        if (w.signature.signedPayload === 'TIMESTAMP.RAW_BODY') {
          timestamp = pickHeader(req.headers, w.signature.timestampHeader ?? '');
          if (!timestamp) return false;
        }
      }
      if (w.signature.signedPayload === 'TIMESTAMP.RAW_BODY') {
        const ts = Number(timestamp);
        if (!Number.isFinite(ts)) return false;
        const tolerance = w.signature.toleranceSeconds ?? 300;
        const nowSec = (this.ctx.now?.() ?? Date.now()) / 1000;
        if (Math.abs(nowSec - ts) > tolerance) return false; // replay / clock-skew protection
      }
      const signed = w.signature.signedPayload === 'TIMESTAMP.RAW_BODY' ? Buffer.concat([Buffer.from(`${timestamp}.`), req.rawBody]) : req.rawBody;
      const enc = w.signature.format === 'base64' ? 'base64' : 'hex';
      const expected = createHmac('sha256', secret).update(signed).digest(enc);
      return safeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  parseWebhook(body: unknown): ParsedWebhook {
    const w = this.def.webhook;
    if (!w) throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', `${this.displayName} does not send webhooks`, false);
    const eventId = extractOne(body, w.eventIdPath);
    const type = extractOne(body, w.eventTypePath);
    if (typeof type !== 'string') throw new DefinitionRuntimeError('webhook has no event type');
    const kind = w.typeMap[type];
    const parsed: ParsedWebhook = { externalEventId: typeof eventId === 'string' || typeof eventId === 'number' ? String(eventId) : undefined, eventType: type };
    if (!kind) return parsed; // a known-authentic event we do not act on: stored as IGNORED
    const item = extractOne(body, w.reservationPath);
    if (item === undefined || item === null) throw new DefinitionRuntimeError('webhook has no reservation');
    const spec = this.def.operations.getReservation ?? this.def.operations.listReservations;
    if (!spec) throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', 'the definition has no reservation field mapping', false);
    const mapped = this.mapFields(item, spec);
    const out = this.normalizeAll([mapped], [item], kind);
    if (!out.events[0]) throw new DefinitionRuntimeError(out.skipped[0]?.reason ?? 'reservation could not be mapped');
    parsed.reservation = out.events[0];
    return parsed;
  }

  // ================================================================ internals

  private baseContext(): TemplateContext {
    return { environment: this.ctx.environment, externalAccountId: this.ctx.externalAccountId ?? undefined };
  }

  private spec(op: OperationName): OperationSpec {
    const spec = this.def.operations[op];
    const cap = OPERATION_CAPABILITY[op];
    if (!spec || (cap !== null && this.def.capabilities[cap] !== true)) {
      throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', `${this.displayName} does not support ${op}`, false, { operation: op });
    }
    return spec;
  }

  private req(fields: Record<string, unknown>, name: string, what: string): string {
    const v = fields[name];
    if (v === undefined || v === null || v === '') throw new ChannelError('CHANNEL_BAD_RESPONSE', `${this.displayName} returned a ${what} without ${name}`, false);
    return String(v);
  }

  private mapFields(item: unknown, spec: OperationSpec): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(spec.fields ?? {})) out[k] = readField(item, f);
    return out;
  }

  private async push(op: 'pushAvailability' | 'pushRates' | 'pushRestrictions', updates: TemplateContext[]): Promise<PushResult> {
    const spec = this.spec(op);
    const batchSize = Math.min(spec.batchSize ?? PLATFORM_LIMITS.batchSize, PLATFORM_LIMITS.batchSize);
    // one request per listing (the listing id is part of the path) and per batch
    // (and per room / rate plan when the path carries them)
    const byListing = new Map<string, TemplateContext[]>();
    const roomInPath = spec.path.includes('{externalRoomId}');
    const rateInPath = spec.path.includes('{externalRatePlanId}');
    for (const u of updates) {
      const key = [u.externalListingId, roomInPath ? u.externalRoomId : '', rateInPath ? u.externalRatePlanId : ''].join('\u0000');
      byListing.set(key, [...(byListing.get(key) ?? []), u]);
    }
    let accepted = 0;
    let rejected = 0;
    for (const list of byListing.values()) {
      const externalListingId = String(list[0].externalListingId);
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        const dates = batch.map((b) => String(b.date)).sort();
        const res = await this.request(op, { ...this.baseContext(), externalListingId, externalRoomId: batch[0].externalRoomId as string | null, externalRatePlanId: batch[0].externalRatePlanId as string | undefined, from: dates[0], to: dates[dates.length - 1] }, { updates: batch });
        const a = spec.acceptedPath ? Number(extractOne(res.json, spec.acceptedPath)) : NaN;
        const r = spec.rejectedPath ? Number(extractOne(res.json, spec.rejectedPath)) : NaN;
        accepted += Number.isFinite(a) ? a : batch.length;
        rejected += Number.isFinite(r) ? r : 0;
      }
    }
    return { accepted, rejected };
  }

  private async fetchAll(op: OperationName, spec: OperationSpec, base: TemplateContext): Promise<unknown[]> {
    const pg = spec.pagination ?? { type: 'NONE' as const };
    const maxPages = Math.min(pg.maxPages ?? 50, PLATFORM_LIMITS.maxPages);
    const out: unknown[] = [];
    let cursor: string | undefined;
    let page = pg.firstPage ?? 1;
    let offset = 0;
    for (let n = 0; n < (pg.type === 'NONE' ? 1 : maxPages); n++) {
      const extra: Record<string, string> = {};
      if (pg.type !== 'NONE' && pg.param) {
        if (pg.type === 'CURSOR' && cursor) extra[pg.param] = cursor;
        if (pg.type === 'PAGE') extra[pg.param] = String(page);
        if (pg.type === 'OFFSET') extra[pg.param] = String(offset);
        if (pg.sizeParam && pg.pageSize) extra[pg.sizeParam] = String(pg.pageSize);
      }
      const res = await this.request(op, { ...base, cursor, page, pageSize: pg.pageSize }, { extraQuery: extra });
      const raw = spec.items ? extractAll(res.json, spec.items) : Array.isArray(res.json) ? res.json : [];
      const items = spec.items === '$' && Array.isArray(res.json) ? (res.json as unknown[]) : raw;
      out.push(...items);
      if (out.length > 10_000) throw new ChannelError('CHANNEL_PAGINATION_LIMIT', `${this.displayName} returned too many items`, false);
      if (pg.type === 'NONE') return out;
      if (pg.type === 'CURSOR') {
        const next = pg.nextPath ? extractOne(res.json, pg.nextPath) : undefined;
        if (next === undefined || next === null || next === '') return out;
        cursor = String(next);
      } else {
        if (items.length === 0) return out;
        if (pg.pageSize && items.length < pg.pageSize) return out;
        if (pg.type === 'PAGE') page++;
        else offset += pg.pageSize ?? items.length;
      }
    }
    // Reaching the page ceiling with more data pending must not look like a complete read (a cursor must not advance past it).
    throw new ChannelError('CHANNEL_PAGINATION_LIMIT', `${this.displayName} has more than ${maxPages} pages of ${op}; narrow the window or raise the poll frequency`, false);
  }

  /** One logical call with auth, signing, throttling and retries. Returns the parsed JSON body. */
  private async request(op: OperationName, tctx: TemplateContext, opts: { updates?: TemplateContext[]; extraQuery?: Record<string, string> }): Promise<{ status: number; json: unknown }> {
    const spec = this.spec(op);
    let url: URL;
    let body: string | undefined;
    const headers: Record<string, string> = {};
    try {
      const path = renderString(spec.path, tctx, 'path');
      url = new URL(this.baseUrl.toString().replace(/\/+$/, '') + path);
      if (url.host !== this.baseUrl.host || !url.pathname.startsWith(this.baseUrl.pathname.replace(/\/+$/, '') + '/')) throw new DefinitionRuntimeError('path escapes the base URL');
      for (const [k, tpl] of Object.entries(spec.query ?? {})) {
        const v = optionalRender(tpl, tctx);
        if (v !== undefined) url.searchParams.set(k, v);
      }
      for (const [k, v] of Object.entries(opts.extraQuery ?? {})) url.searchParams.set(k, v);
      for (const [k, tpl] of Object.entries(spec.headers ?? {})) {
        const v = optionalRender(tpl, tctx);
        if (v !== undefined) headers[k] = v;
      }
      if (spec.body !== undefined) body = JSON.stringify(renderBody(spec.body, tctx, opts.updates));
    } catch (e) {
      if (e instanceof DefinitionRuntimeError) throw new ChannelError('CHANNEL_REQUEST_INVALID', `${this.displayName}: ${e.message}`, false, { operation: op });
      throw e;
    }
    if (body !== undefined && Buffer.byteLength(body) > this.limits.maxRequestBytes) {
      throw new ChannelError('CHANNEL_REQUEST_INVALID', `${this.displayName}: request for ${op} is larger than ${this.limits.maxRequestBytes} bytes; lower the batch size`, false);
    }
    this.applyAuth(headers, url);
    if (spec.idempotencyHeader && spec.method !== 'GET') headers[spec.idempotencyHeader] = randomUUID(); // one key per logical call, reused by every retry below
    this.applySigning(headers, body);

    const throttle = throttleFor(this.ctx.connectionId, this.rps);
    let lastError: ChannelError | null = null;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      const releaseSlot = await throttle.acquire();
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          releaseSlot();
        }
      };
      try {
        const res = await secureRequest({
          url,
          method: spec.method,
          headers,
          body,
          allowedHosts: this.allowedHosts,
          timeoutMs: this.limits.timeoutMs,
          maxRequestBytes: this.limits.maxRequestBytes,
          maxResponseBytes: this.limits.maxResponseBytes,
          allowPrivate: this.ctx.allowPrivate,
        });
        release();
        if (res.status >= 200 && res.status < 300) return { status: res.status, json: this.parseJson(res.body, op) };
        const retryable = this.retry.retryOnStatus.includes(res.status);
        lastError = this.statusError(op, res.status, res.body, retryable);
        if (!retryable || attempt === this.retry.maxAttempts) throw lastError;
        await this.sleep(this.delayFor(attempt, res.headers['retry-after']));
      } catch (e) {
        release();
        if (e instanceof ChannelError) {
          if (!e.retryable || attempt === this.retry.maxAttempts) throw e;
          lastError = e;
          continue;
        }
        if (e instanceof HttpSafetyError) {
          const transient = e.code === 'TIMEOUT' || e.code === 'NETWORK';
          lastError = new ChannelError(transient ? 'CHANNEL_UNAVAILABLE' : 'CHANNEL_REQUEST_REFUSED', `${this.displayName}: ${this.safeMessage(e.message)}`, transient, { operation: op, reason: e.code });
          if (!transient || attempt === this.retry.maxAttempts) throw lastError;
          await this.sleep(this.delayFor(attempt));
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new ChannelError('CHANNEL_UNAVAILABLE', `${this.displayName} did not respond`, true);
  }

  private statusError(op: OperationName, status: number, body: string, retryable: boolean): ChannelError {
    const snippet = this.safeMessage(body.slice(0, 200));
    if (status === 401 || status === 403) return new ChannelError('CHANNEL_AUTH_FAILED', `${this.displayName} rejected the credentials (${status}). Check or rotate the API credentials.`, false, { operation: op, status });
    if (retryable) return new ChannelError('CHANNEL_UNAVAILABLE', `${this.displayName} answered ${status} to ${op}`, true, { operation: op, status });
    return new ChannelError('CHANNEL_REQUEST_REJECTED', `${this.displayName} rejected ${op} with ${status}${snippet ? `: ${snippet}` : ''}`, false, { operation: op, status });
  }

  private delayFor(attempt: number, retryAfter?: string): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exp * (0.5 + Math.random() * 0.5));
    if (retryAfter) {
      const secs = Number(retryAfter);
      const ms = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - (this.ctx.now?.() ?? Date.now()));
      if (Number.isFinite(ms)) return Math.min(Math.max(ms, jittered), 30_000); // honour Retry-After, but never park a worker for long
    }
    return jittered;
  }

  private parseJson(text: string, op: OperationName): unknown {
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ChannelError('CHANNEL_BAD_RESPONSE', `${this.displayName} returned a response to ${op} that is not valid JSON`, false, { operation: op });
    }
  }

  private applyAuth(headers: Record<string, string>, url: URL) {
    const a = this.def.auth;
    const s = this.ctx.secrets;
    const missing = (what: string): never => {
      throw new ChannelError('CHANNEL_NOT_CONNECTED', `${this.displayName}: ${what} is not configured for this connection`, false);
    };
    switch (a.type) {
      case 'NONE':
        return;
      case 'API_KEY_HEADER':
        headers[a.header] = s.API_KEY ?? missing('the API key');
        return;
      case 'API_KEY_QUERY':
        url.searchParams.set(a.param, s.API_KEY ?? missing('the API key'));
        return;
      case 'BEARER':
        headers.Authorization = `Bearer ${s.BEARER_TOKEN ?? s.API_KEY ?? missing('the access token')}`;
        return;
      case 'BASIC':
        headers.Authorization = `Basic ${Buffer.from(`${s.BASIC_USERNAME ?? missing('the username')}:${s.BASIC_PASSWORD ?? missing('the password')}`).toString('base64')}`;
        return;
    }
  }

  private applySigning(headers: Record<string, string>, body: string | undefined) {
    const sg = this.def.signing;
    if (!sg) return;
    const secret = this.ctx.secrets.SIGNING_SECRET;
    if (!secret) throw new ChannelError('CHANNEL_NOT_CONNECTED', `${this.displayName}: the signing secret is not configured for this connection`, false);
    const ts = String(Math.floor((this.ctx.now?.() ?? Date.now()) / 1000));
    const payload = sg.payload === 'TIMESTAMP.BODY' ? `${ts}.${body ?? ''}` : (body ?? '');
    headers[sg.header] = createHmac('sha256', secret).update(payload).digest(sg.encoding);
    if (sg.payload === 'TIMESTAMP.BODY' && sg.timestampHeader) headers[sg.timestampHeader] = ts;
  }

  /** Error text for storage/logs/UI: credentials removed, bounded. */
  private safeMessage(text: string): string {
    return redactText(text, this.secretValues).slice(0, 300);
  }

  // ------------------------------------------------------------ reservation normalisation

  private normalizeAll(mapped: Record<string, unknown>[], rawItems: unknown[], forcedKind?: NormalizedReservationEvent['kind']): ReservationPull {
    const m = this.def.reservationMapping;
    if (!m) throw new ChannelError('CHANNEL_OPERATION_NOT_SUPPORTED', `${this.displayName} has no reservation mapping`, false);
    const events: NormalizedReservationEvent[] = [];
    const skipped: ReservationPull['skipped'] = [];
    let newest: string | undefined;
    mapped.forEach((f, i) => {
      const raw = rawItems[i];
      const id = f.externalReservationId === undefined ? undefined : String(f.externalReservationId);
      try {
        const status = extractOne(raw, m.statusPath);
        const kind = forcedKind ?? (status === undefined ? undefined : m.statusMap[String(status)]);
        if (!kind) return void skipped.push({ externalReservationId: id, reason: `status ${status === undefined ? '(missing)' : String(status)} is not mapped` });
        const need = (name: string) => {
          const v = f[name];
          if (v === undefined || v === null || v === '') throw new DefinitionRuntimeError(`missing ${name}`);
          return v;
        };
        const checkIn = toDate(need('checkIn'), m.dateFormat);
        const checkOut = toDate(need('checkOut'), m.dateFormat);
        const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
        if (!(nights >= 1 && nights <= 90)) throw new DefinitionRuntimeError('stay length is outside 1-90 nights');
        const adults = Number(need('adults'));
        if (!Number.isInteger(adults) || adults < 1) throw new DefinitionRuntimeError('adults must be a positive integer');
        const children = f.children === undefined || f.children === null ? 0 : Number(f.children);
        if (!Number.isInteger(children) || children < 0) throw new DefinitionRuntimeError('children must be a non-negative integer');
        const nightlyRates = this.nightly(raw, nights);
        const event: NormalizedReservationEvent = {
          kind,
          channel: this.channel,
          externalScope: this.ctx.connectionId,
          revision: typeof f.updatedAt === 'string' ? f.updatedAt : undefined,
          externalListingId: String(need('externalListingId')),
          externalReservationId: String(need('externalReservationId')),
          checkIn,
          checkOut,
          adults,
          children,
          guest: {
            firstName: String(need('guestFirstName')),
            lastName: f.guestLastName === undefined || f.guestLastName === null ? '' : String(f.guestLastName),
            email: f.guestEmail ? String(f.guestEmail) : undefined,
            phone: f.guestPhone ? String(f.guestPhone) : undefined,
          },
          rooms: [{ externalRoomId: f.externalRoomId === undefined || f.externalRoomId === null ? null : String(f.externalRoomId), externalRatePlanId: f.externalRatePlanId ? String(f.externalRatePlanId) : undefined, quantity: f.quantity ? Math.max(1, Number(f.quantity)) : 1, nightlyRates }],
          currency: String(need('currency')).toUpperCase(),
          payment: this.paymentInfo(raw),
          specialRequests: f.specialRequests ? String(f.specialRequests).slice(0, 1000) : undefined,
        };
        events.push(event);
        if (typeof f.updatedAt === 'string' && (!newest || f.updatedAt > newest)) newest = f.updatedAt;
      } catch (e) {
        skipped.push({ externalReservationId: id, reason: e instanceof DefinitionRuntimeError ? e.message : 'could not be mapped' });
      }
    });
    if (skipped.length) this.logger.warn(`${this.channel}: skipped ${skipped.length} reservation(s): ${skipped.slice(0, 5).map((s) => `${s.externalReservationId ?? '?'}: ${s.reason}`).join('; ')}`);
    return { events, skipped, newestUpdatedAt: newest };
  }

  /**
   * Payment data for one booking. Only what the provider's own response contains (through the operator's paths) or the operator
   * explicitly declared is returned; nothing is defaulted. Returns undefined when nothing is known.
   */
  private paymentInfo(raw: unknown): ChannelPaymentInfo | undefined {
    const m = this.def.reservationMapping!;
    const info: ChannelPaymentInfo = {};
    const declared = m.paymentCollection ?? (m.paymentCollectedByChannel === undefined ? undefined : m.paymentCollectedByChannel ? 'CHANNEL' : 'PROPERTY');
    if (declared) {
      info.collectedBy = declared;
      info.collectionSource = 'OPERATOR_CONFIG';
    }
    const f = m.paymentFields;
    if (f) {
      const word = (path?: string): string | undefined => {
        if (!path) return undefined;
        const v = extractOne(raw, path);
        return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
      };
      const money = (path?: string): number | undefined => {
        if (!path) return undefined;
        const v = extractOne(raw, path);
        const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
        if (!Number.isFinite(n) || n < 0) return undefined;
        return f.amountUnit === 'MAJOR' ? Math.round(n * 100) : Math.round(n);
      };
      const status = word(f.statusPath);
      if (status !== undefined) {
        info.providerStatusRaw = status;
        info.providerStatus = f.statusMap?.[status];
      }
      const payout = word(f.payoutStatusPath);
      if (payout !== undefined) {
        info.payoutStatusRaw = payout;
        info.payoutStatus = f.payoutStatusMap?.[payout];
      }
      const dateWord = word(f.payoutDatePath);
      if (dateWord !== undefined) {
        const d = new Date(dateWord);
        if (!Number.isNaN(d.getTime())) info.payoutDate = d;
      }
      info.commissionAmount = money(f.commissionPath);
      info.netAmount = money(f.netAmountPath);
    }
    return Object.values(info).some((v) => v !== undefined) ? info : undefined;
  }

  private nightly(raw: unknown, nights: number): number[] {
    const p = this.def.reservationMapping!.pricing;
    const values = extractAll(raw, p.path).flatMap((v) => (Array.isArray(v) ? v : [v]));
    const toMinor = (v: unknown) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new DefinitionRuntimeError('price is not a non-negative number');
      return p.unit === 'MAJOR' ? Math.round(n * 100) : Math.round(n);
    };
    if (values.length === 0) throw new DefinitionRuntimeError('price is missing');
    if (p.mode === 'TOTAL') {
      const total = toMinor(values[0]);
      const base = Math.floor(total / nights);
      const rest = total - base * nights;
      return Array.from({ length: nights }, (_, i) => base + (i < rest ? 1 : 0)); // the remainder goes to the first nights, so the sum is exact
    }
    if (values.length === 1) return Array.from({ length: nights }, () => toMinor(values[0]));
    if (values.length !== nights) throw new DefinitionRuntimeError(`got ${values.length} nightly prices for ${nights} nights`);
    return values.map(toMinor);
  }
}

// ------------------------------------------------------------------ helpers

function optionalRender(template: string, ctx: TemplateContext): string | undefined {
  try {
    return renderString(template, ctx, 'text');
  } catch (e) {
    if (e instanceof DefinitionRuntimeError && /not available/.test(e.message)) return undefined; // optional placeholder (first page has no cursor)
    throw e;
  }
}

function toDate(v: unknown, format: 'YYYY-MM-DD' | 'ISO_DATETIME'): string {
  const s = String(v);
  const m = format === 'YYYY-MM-DD' ? /^(\d{4}-\d{2}-\d{2})$/.exec(s) : /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new DefinitionRuntimeError(`date "${s.slice(0, 30)}" does not match ${format}`);
  return m[1];
}

function pickHeader(headers: InboundWebhookRequest['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
