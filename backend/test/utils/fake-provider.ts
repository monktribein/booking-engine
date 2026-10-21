import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for a third-party property-management REST API ("Acme Stay"), used ONLY by tests to exercise the
 * configuration-driven connector. It really speaks HTTP: authentication, pagination, rate limiting, failures, idempotency and signed
 * webhooks are enforced by the server, and every request is recorded. It is not an integration with any real company.
 */
export interface FakeBooking {
  /** Optional payment data the fake provider reports; absent = the provider says nothing about money. */
  payment?: { status?: string; payout_state?: string; payout_date?: string; fee?: number; net?: number };
  id: string;
  status: 'confirmed' | 'modified' | 'cancelled' | string;
  property_id: string;
  room_id: string;
  rate_plan_id: string;
  arrival: string;
  departure: string;
  adults: number;
  children?: number;
  guest: { first_name: string; last_name: string; email?: string; phone?: string };
  currency: string;
  total: number;
  notes?: string;
  updated_at: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: any;
  rawBody: string;
}

/** One customer account of the fake provider: its own listings, bookings and recorded pushes, selected by the API key. */
export class FakeTenant {
  constructor(public apiKey: string) {}
  properties = [
    { id: 'P-1', name: 'Seaside Inn' },
    { id: 'P-2', name: 'Hill House' },
    { id: 'P-3', name: 'Lake Lodge' },
  ];
  rooms: Record<string, { id: string; name: string; max_guests: number }[]> = {
    'P-1': [{ id: 'R-DLX', name: 'Deluxe', max_guests: 3 }],
    'P-2': [{ id: 'R-STD', name: 'Standard', max_guests: 2 }],
    'P-3': [],
  };
  ratePlans: Record<string, { id: string; name: string; room_id: string }[]> = {
    'P-1': [{ id: 'RP-FLEX', name: 'Flexible', room_id: 'R-DLX' }],
    'P-2': [],
    'P-3': [],
  };
  bookings: FakeBooking[] = [];
  /** idempotency key -> the response given the first time */
  seenKeys = new Map<string, unknown>();
  pushed: { availability: any[]; rates: any[] } = { availability: [], rates: [] };
  acked: string[] = [];
  webhookSecret = 'whsec-fake-provider';
  clear() {
    this.seenKeys.clear();
    this.pushed = { availability: [], rates: [] };
    this.acked = [];
  }
}

export class FakeProvider {
  readonly requests: RecordedRequest[] = [];
  /** The default account (what single-tenant tests use). More accounts: `addTenant(key)`. */
  readonly main = new FakeTenant('acme-key-1');
  private readonly tenants = new Map<string, FakeTenant>([[this.main.apiKey, this.main]]);
  /** Responses to inject for upcoming requests to a path prefix, optionally only for one account's key. */
  private failures: { prefix: string; status: number; remaining: number; retryAfter?: string; key?: string }[] = [];
  private server!: http.Server;
  baseUrl = '';
  host = '127.0.0.1';

  addTenant(apiKey: string): FakeTenant {
    const t = new FakeTenant(apiKey);
    t.webhookSecret = `whsec-${apiKey}`;
    this.tenants.set(apiKey, t);
    return t;
  }
  // single-tenant conveniences (the default account)
  get apiKey() { return this.main.apiKey; }
  get webhookSecret() { return this.main.webhookSecret; }
  get bookings() { return this.main.bookings; }
  set bookings(v: FakeBooking[]) { this.main.bookings = v; }
  get pushed() { return this.main.pushed; }
  get acked() { return this.main.acked; }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset() {
    this.requests.length = 0;
    this.failures = [];
    for (const t of this.tenants.values()) t.clear();
  }
  fail(prefix: string, status: number, times: number, retryAfter?: string, onlyForKey?: string) {
    this.failures.push({ prefix, status, remaining: times, retryAfter, key: onlyForKey });
  }
  count(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }

  /** A signed webhook the way this provider sends it. */
  signedWebhook(payload: object, opts: { secret?: string; timestamp?: number; tenant?: FakeTenant } = {}): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(payload);
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', opts.secret ?? (opts.tenant ?? this.main).webhookSecret).update(`${ts}.${rawBody}`).digest('hex');
    return { headers: { 'content-type': 'application/json', 'x-acme-signature': sig, 'x-acme-timestamp': ts }, rawBody };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: any;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = undefined;
    }
    const rec: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, rawBody };
    this.requests.push(rec);
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };

    const key = String(req.headers['x-api-key'] ?? '');
    const tenant = this.tenants.get(key);
    if (!tenant) return send(401, { error: 'invalid api key' });
    const f = this.failures.find((x) => url.pathname.startsWith(x.prefix) && x.remaining > 0 && (!x.key || x.key === key));
    if (f) {
      f.remaining--;
      return send(f.status, { error: 'injected failure' }, f.retryAfter ? { 'retry-after': f.retryAfter } : {});
    }

    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/v1/health') return send(200, { ok: true });

    if (m === 'GET' && p === '/v1/properties') {
      const limit = Number(url.searchParams.get('limit') ?? 2);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const slice = tenant.properties.slice(start, start + limit);
      const next = start + limit < tenant.properties.length ? String(start + limit) : null;
      return send(200, { data: slice, next });
    }
    let mm: RegExpExecArray | null;
    if (m === 'GET' && (mm = /^\/v1\/properties\/([^/]+)\/rooms$/.exec(p))) return send(200, { data: tenant.rooms[decodeURIComponent(mm[1])] ?? [] });
    if (m === 'GET' && (mm = /^\/v1\/properties\/([^/]+)\/rate-plans$/.exec(p))) return send(200, { data: tenant.ratePlans[decodeURIComponent(mm[1])] ?? [] });

    if (m === 'GET' && p === '/v1/bookings') {
      const since = url.searchParams.get('updated_since') ?? '';
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 2);
      const all = tenant.bookings.filter((b) => b.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return send(200, { items: all.slice((page - 1) * per, page * per), page, total_pages: Math.ceil(all.length / per) });
    }
    if (m === 'GET' && (mm = /^\/v1\/bookings\/([^/]+)$/.exec(p))) {
      const b = tenant.bookings.find((x) => x.id === decodeURIComponent(mm![1]));
      return b ? send(200, b) : send(404, { error: 'not found' });
    }
    if (m === 'POST' && (mm = /^\/v1\/bookings\/([^/]+)\/ack$/.exec(p))) {
      tenant.acked.push(decodeURIComponent(mm[1]));
      return send(200, { ok: true });
    }
    if (m === 'PUT' && (mm = /^\/v1\/properties\/([^/]+)\/(availability|rates)$/.exec(p))) {
      const key = String(req.headers['idempotency-key'] ?? '');
      if (key && tenant.seenKeys.has(key)) return send(200, tenant.seenKeys.get(key));
      const list: any[] = (mm[2] === 'availability' ? body?.updates : body?.rates) ?? [];
      if (!Array.isArray(list)) return send(400, { error: 'bad body' });
      const bad = list.filter((u) => !u.room_id || !u.date).length;
      (mm[2] === 'availability' ? tenant.pushed.availability : tenant.pushed.rates).push(...list.map((u) => ({ property: decodeURIComponent(mm![1]), ...u })));
      const out = { accepted: list.length - bad, rejected: bad };
      if (key) tenant.seenKeys.set(key, out);
      return send(200, out);
    }
    return send(404, { error: 'no such route' });
  }
}

export const sampleBooking = (over: Partial<FakeBooking> = {}): FakeBooking => ({
  id: 'BK-1001',
  status: 'confirmed',
  property_id: 'P-1',
  room_id: 'R-DLX',
  rate_plan_id: 'RP-FLEX',
  arrival: '2027-03-10',
  departure: '2027-03-13',
  adults: 2,
  children: 0,
  guest: { first_name: 'Asha', last_name: 'Verma', email: 'asha@example.com', phone: '+919811111111' },
  currency: 'INR',
  total: 9000.5,
  notes: 'Late arrival',
  updated_at: '2027-01-01T10:00:00.000Z',
  ...over,
});
