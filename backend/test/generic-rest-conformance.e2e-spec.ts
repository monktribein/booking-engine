import { exampleRestDefinition } from '../src/modules/channels/providers/example-definition';
import { GenericRestAdapter, type GenericRestContext } from '../src/modules/channels/providers/generic-rest.adapter';
import { validateDefinition } from '../src/modules/channels/providers/provider-definition';
import { FakeProvider, sampleBooking } from './utils/fake-provider';

/**
 * Conformance suite for the configuration-driven REST adapter: one stock GenericRestAdapter, one JSON definition, a local
 * server that really speaks HTTP. Nothing here is specific to the fake provider except the definition itself; a new provider
 * is expected to pass the same scenarios with its own definition.
 */
describe('GenericRestAdapter conformance (local fake provider)', () => {
  const fake = new FakeProvider();
  const creds = { metadata: {} };
  const avail = (n: number) => Array.from({ length: n }, (_, i) => ({ externalListingId: 'P-1', externalRoomId: 'R-DLX', date: `2027-04-${String(i + 1).padStart(2, '0')}`, available: 3 - (i % 2), stopSell: i === 1 }));
  let def: ReturnType<typeof exampleRestDefinition>;

  const adapter = (over: Partial<GenericRestContext> = {}, mutate?: (d: any) => void) => {
    const d: any = JSON.parse(JSON.stringify(def));
    mutate?.(d);
    const checked = validateDefinition(d, { allowInsecureHosts: true });
    expect(checked.errors).toEqual([]);
    return new GenericRestAdapter(checked.definition!, {
      providerCode: 'ACME_STAY',
      displayName: 'Acme Stay',
      environment: 'production',
      connectionId: '11111111-1111-1111-1111-111111111111',
      secrets: { API_KEY: fake.apiKey, WEBHOOK_SECRET: fake.webhookSecret },
      allowPrivate: true,
      sleep: async () => undefined,
      ...over,
    });
  };

  beforeAll(async () => {
    await fake.start();
    def = exampleRestDefinition({ baseUrl: fake.baseUrl, host: fake.host });
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    fake.reset();
    fake.bookings = [];
  });

  describe('connection', () => {
    it('verifies the connection with the read-only health call before reporting connected', async () => {
      const a = adapter();
      expect((await a.testConnection()).ok).toBe(true);
      const res = await a.connect({ propertyId: 'p', connectionId: 'c', state: 's', redirectUri: 'r' });
      expect(res.type).toBe('CONNECTED');
      expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    });
    it('wrong credentials are reported as an authentication failure, never as connected', async () => {
      const a = adapter({ secrets: { API_KEY: 'nope' } });
      const t = await a.testConnection();
      expect(t.ok).toBe(false);
      expect(t.status).toBe(401);
      await expect(a.connect({ propertyId: 'p', connectionId: 'c', state: 's', redirectUri: 'r' })).rejects.toMatchObject({ code: 'CHANNEL_CONNECTION_TEST_FAILED' });
      await expect(a.getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_AUTH_FAILED', retryable: false });
    });
    it('a connection without the configured secret never reaches the network', async () => {
      fake.reset();
      await expect(adapter({ secrets: {} }).getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_NOT_CONNECTED' });
      expect(fake.requests).toHaveLength(0);
    });
    it('never leaks the API key in errors', async () => {
      const a = adapter({ secrets: { API_KEY: 'super-secret-key-value' } });
      const t = await a.testConnection();
      expect(JSON.stringify(t)).not.toContain('super-secret-key-value');
    });
  });

  describe('master data', () => {
    it('follows cursor pagination to the end and maps fields', async () => {
      const a = adapter();
      const listings = await a.getListings(creds);
      expect(listings.map((l) => l.externalListingId)).toEqual(['P-1', 'P-2', 'P-3']);
      expect(listings[0].name).toBe('Seaside Inn');
      expect(fake.count('GET', '/v1/properties')).toBe(2); // two pages of up to 2
      expect(fake.requests[0].headers['x-api-key']).toBe(fake.apiKey);
    });
    it('maps rooms and rate plans using a listing id placed safely in the path', async () => {
      const a = adapter();
      expect(await a.getRoomTypes(creds, 'P-1')).toEqual([{ externalRoomId: 'R-DLX', name: 'Deluxe', maxOccupancy: 3 }]);
      expect(await a.getRates(creds, 'P-1')).toEqual([{ externalRatePlanId: 'RP-FLEX', name: 'Flexible', externalRoomId: 'R-DLX' }]);
      await a.getRoomTypes(creds, 'weird/../id').catch(() => undefined);
      expect(fake.requests.at(-1)!.path).not.toContain('/../');
    });
    it('refuses an identifier that would climb out of the path', async () => {
      await expect(adapter().getRoomTypes(creds, '..')).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_INVALID', retryable: false });
    });
  });

  describe('capabilities', () => {
    it('an unsupported operation fails explicitly and never touches the network', async () => {
      const a = adapter();
      expect(a.supports('pushRestrictions')).toBe(false);
      fake.reset();
      await expect(a.updateRestrictions(creds, [])).rejects.toMatchObject({ code: 'CHANNEL_OPERATION_NOT_SUPPORTED', retryable: false });
      expect(fake.requests).toHaveLength(0);
    });
    it('a capability switched off in the definition disables the operation even though it is defined', async () => {
      const a = adapter({}, (d) => (d.capabilities.pushRates = false));
      expect(a.supports('pushRates')).toBe(false);
      await expect(a.updateRates(creds, [])).rejects.toMatchObject({ code: 'CHANNEL_OPERATION_NOT_SUPPORTED' });
    });
  });

  describe('reservations', () => {
    it('payment data: nothing declared and nothing reported means no payment information at all', async () => {
      fake.bookings = [sampleBooking({ id: 'BK-NP' })];
      const pull = await adapter({}, (d) => delete d.reservationMapping.paymentCollection).pullReservations(new Date('2027-01-01T00:00:00Z'));
      expect(pull.events[0].payment).toBeUndefined();
    });

    it('payment data: a legacy boolean is read as an operator declaration', async () => {
      fake.bookings = [sampleBooking({ id: 'BK-LG' })];
      const pull = await adapter({}, (d) => { delete d.reservationMapping.paymentCollection; d.reservationMapping.paymentCollectedByChannel = false; }).pullReservations(new Date('2027-01-01T00:00:00Z'));
      expect(pull.events[0].payment).toEqual({ collectedBy: 'PROPERTY', collectionSource: 'OPERATOR_CONFIG' });
    });

    it('payment data: only what the provider response contains is read, through the operator mapping', async () => {
      const fields = { statusPath: '$.payment.status', statusMap: { captured: 'PAID' }, payoutStatusPath: '$.payment.payout_state', payoutStatusMap: { sent: 'COMPLETED' }, payoutDatePath: '$.payment.payout_date', commissionPath: '$.payment.fee', netAmountPath: '$.payment.net', amountUnit: 'MAJOR' };
      fake.bookings = [
        sampleBooking({ id: 'BK-P1', payment: { status: 'captured', payout_state: 'sent', payout_date: '2027-03-20T00:00:00Z', fee: 1234.5, net: 7766 } }),
        sampleBooking({ id: 'BK-P2', payment: { status: 'weird-word' } }), // unmapped word: raw only
        sampleBooking({ id: 'BK-P3' }), // the provider says nothing: the declaration alone is kept, no status is invented
      ];
      const pull = await adapter({}, (d) => (d.reservationMapping.paymentFields = fields)).pullReservations(new Date('2027-01-01T00:00:00Z'));
      const byId = Object.fromEntries(pull.events.map((e) => [e.externalReservationId, e.payment]));
      expect(byId['BK-P1']).toEqual({
        collectedBy: 'CHANNEL',
        collectionSource: 'OPERATOR_CONFIG',
        providerStatusRaw: 'captured',
        providerStatus: 'PAID',
        payoutStatusRaw: 'sent',
        payoutStatus: 'COMPLETED',
        payoutDate: new Date('2027-03-20T00:00:00Z'),
        commissionAmount: 123450,
        netAmount: 776600,
      });
      expect(byId['BK-P2']).toEqual({ collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG', providerStatusRaw: 'weird-word' });
      expect(byId['BK-P3']).toEqual({ collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' });
    });

    it('pulls and normalises reservations across pages', async () => {
      fake.bookings = [sampleBooking({ id: 'BK-1', updated_at: '2027-01-01T10:00:00.000Z' }), sampleBooking({ id: 'BK-2', updated_at: '2027-01-01T11:00:00.000Z' }), sampleBooking({ id: 'BK-3', updated_at: '2027-01-01T12:00:00.000Z' })];
      const pull = await adapter().pullReservations(new Date('2027-01-01T00:00:00Z'));
      expect(pull.events.map((e) => e.externalReservationId)).toEqual(['BK-1', 'BK-2', 'BK-3']);
      expect(pull.newestUpdatedAt).toBe('2027-01-01T12:00:00.000Z');
      const e = pull.events[0];
      expect(e).toMatchObject({ kind: 'RESERVATION_CREATED', channel: 'ACME_STAY', externalScope: '11111111-1111-1111-1111-111111111111', externalListingId: 'P-1', checkIn: '2027-03-10', checkOut: '2027-03-13', adults: 2, currency: 'INR' });
      // The example definition DECLARES that the channel collects; the fake provider reports nothing about money, so nothing else is claimed.
      expect(e.payment).toEqual({ collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' });
      expect(e.guest).toMatchObject({ firstName: 'Asha', lastName: 'Verma', email: 'asha@example.com' });
      // 9000.50 major = 900050 minor over 3 nights: the remainder lands on the first night and the sum is exact
      expect(e.rooms[0].nightlyRates).toEqual([300017, 300017, 300016]);
      expect(e.rooms[0].nightlyRates.reduce((a, b) => a + b, 0)).toBe(900050);
      expect(fake.requests[0].query.updated_since).toBe('2027-01-01T00:00:00.000Z');
    });
    it('maps cancellations and modifications; unmapped statuses and bad rows are reported, not guessed', async () => {
      fake.bookings = [
        sampleBooking({ id: 'A', status: 'cancelled', updated_at: '2027-01-01T10:00:00.000Z' }),
        sampleBooking({ id: 'B', status: 'modified', updated_at: '2027-01-01T10:01:00.000Z' }),
        sampleBooking({ id: 'C', status: 'on_hold', updated_at: '2027-01-01T10:02:00.000Z' }),
        sampleBooking({ id: 'D', arrival: '03/10/2027', updated_at: '2027-01-01T10:03:00.000Z' }),
        sampleBooking({ id: 'E', departure: '2027-03-10', updated_at: '2027-01-01T10:04:00.000Z' }),
      ];
      const pull = await adapter().pullReservations(new Date('2027-01-01T00:00:00Z'));
      expect(pull.events.map((e) => [e.externalReservationId, e.kind])).toEqual([
        ['A', 'RESERVATION_CANCELLED'],
        ['B', 'RESERVATION_MODIFIED'],
      ]);
      expect(pull.skipped.map((s) => s.externalReservationId).sort()).toEqual(['C', 'D', 'E']);
      expect(pull.skipped.find((s) => s.externalReservationId === 'C')!.reason).toMatch(/not mapped/);
    });
    it('fetches one reservation and returns null for an unknown one', async () => {
      fake.bookings = [sampleBooking({ id: 'BK-9' })];
      const a = adapter();
      expect((await a.getReservation(creds, 'BK-9'))!.externalReservationId).toBe('BK-9');
      expect(await a.getReservation(creds, 'NOPE')).toBeNull();
    });
    it('stops with an error instead of silently truncating when the page ceiling is hit', async () => {
      fake.bookings = Array.from({ length: 8 }, (_, i) => sampleBooking({ id: `B${i}`, updated_at: `2027-01-01T10:0${i}:00.000Z` }));
      const a = adapter({}, (d) => (d.operations.listReservations.pagination.maxPages = 2));
      await expect(a.pullReservations(new Date('2027-01-01T00:00:00Z'))).rejects.toMatchObject({ code: 'CHANNEL_PAGINATION_LIMIT' });
    });
    it('acknowledges a reservation', async () => {
      await adapter().acknowledgeReservation(creds, 'BK-77');
      expect(fake.acked).toEqual(['BK-77']);
    });
  });

  describe('pushes', () => {
    it('batches by the configured batch size and reports accepted/rejected from the response', async () => {
      const r = await adapter().updateAvailability(creds, avail(7));
      expect(r).toEqual({ accepted: 7, rejected: 0 });
      expect(fake.count('PUT', '/v1/properties/P-1/availability')).toBe(3); // 3 + 3 + 1
      expect(fake.pushed.availability[1]).toMatchObject({ room_id: 'R-DLX', date: '2027-04-02', available: 2, stop_sell: true });
    });
    it('converts prices with the declared transform (minor units -> major) and keeps booleans/numbers typed', async () => {
      await adapter().updateRates(creds, [{ externalListingId: 'P-1', externalRoomId: 'R-DLX', externalRatePlanId: 'RP-FLEX', date: '2027-04-01', price: 450075, currency: 'INR' }]);
      expect(fake.pushed.rates[0]).toMatchObject({ rate_plan_id: 'RP-FLEX', amount: 4500.75, currency: 'INR' });
      expect(typeof fake.pushed.rates[0].amount).toBe('number');
    });
    it('counts rejected updates the provider reports', async () => {
      const r = await adapter().updateAvailability(creds, [{ externalListingId: 'P-1', externalRoomId: null as never, date: '2027-04-01', available: 1, stopSell: false }]);
      expect(r).toEqual({ accepted: 0, rejected: 1 });
    });
    it('sends an idempotency key that is stable across retries of one call', async () => {
      fake.fail('/v1/properties/P-1/availability', 503, 2);
      await adapter().updateAvailability(creds, avail(1));
      const keys = fake.requests.filter((r) => r.path.endsWith('/availability')).map((r) => r.headers['idempotency-key']);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(1);
      expect(fake.pushed.availability).toHaveLength(1); // applied once
    });
  });

  describe('retries and limits', () => {
    it('retries transient 5xx/429 with backoff and succeeds', async () => {
      fake.fail('/v1/health', 503, 1);
      fake.fail('/v1/health', 429, 1, '1');
      const sleeps: number[] = [];
      const t = await adapter({ sleep: async (ms) => void sleeps.push(ms) }).testConnection();
      expect(t.ok).toBe(true);
      expect(fake.count('GET', '/v1/health')).toBe(3);
      expect(sleeps).toHaveLength(2);
      expect(sleeps[1]).toBeGreaterThanOrEqual(1000); // Retry-After honoured
    });
    it('gives up after the configured attempts with a retryable error (the sync layer retries later)', async () => {
      fake.fail('/v1/properties', 500, 99);
      await expect(adapter().getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_UNAVAILABLE', retryable: true });
      expect(fake.count('GET', '/v1/properties')).toBe(3);
    });
    it('does not retry a client error', async () => {
      fake.fail('/v1/properties', 400, 99);
      await expect(adapter().getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_REJECTED', retryable: false });
      expect(fake.count('GET', '/v1/properties')).toBe(1);
    });
    it('rejects a request larger than the configured limit before sending it', async () => {
      fake.reset();
      const a = adapter({}, (d) => {
        d.limits.maxRequestBytes = 1024;
        d.operations.pushAvailability.batchSize = 500;
      });
      await expect(a.updateAvailability(creds, avail(400))).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_INVALID' });
      expect(fake.requests).toHaveLength(0);
    });
    it('refuses a base URL host that is not in the allowed hosts (defence in depth beyond validation)', async () => {
      // Validation already refuses this definition; the adapter must ALSO refuse the request on its own if one ever got through.
      const bad: any = JSON.parse(JSON.stringify(def));
      bad.allowedHosts = ['not-the-host.example.com'];
      const a = new GenericRestAdapter(bad, { providerCode: 'ACME_STAY', displayName: 'Acme Stay', environment: 'production', connectionId: '11111111-1111-1111-1111-111111111111', secrets: { API_KEY: fake.apiKey }, allowPrivate: true, sleep: async () => undefined });
      fake.reset();
      await expect(a.getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_REFUSED' });
      expect(fake.requests).toHaveLength(0);
    });
    it('a private target is refused unless explicitly enabled (as in production)', async () => {
      await expect(adapter({ allowPrivate: false }).getListings(creds)).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_REFUSED' });
    });
  });

  describe('webhooks', () => {
    const event = (over: object = {}) => ({ event_id: 'evt-1', type: 'booking.created', booking: sampleBooking(), ...over });

    it('accepts a correctly signed webhook and normalises the reservation', () => {
      const a = adapter();
      const w = fake.signedWebhook(event());
      const req = { headers: w.headers, rawBody: Buffer.from(w.rawBody), body: JSON.parse(w.rawBody) };
      expect(a.verifyWebhook(req)).toBe(true);
      const parsed = a.parseWebhook(req.body);
      expect(parsed.externalEventId).toBe('evt-1');
      expect(parsed.reservation).toMatchObject({ kind: 'RESERVATION_CREATED', externalReservationId: 'BK-1001', channel: 'ACME_STAY' });
    });
    it('rejects a wrong secret, a tampered body, a missing signature and a stale timestamp', () => {
      const a = adapter();
      const good = fake.signedWebhook(event());
      const mk = (w: { headers: Record<string, string>; rawBody: string }, raw = w.rawBody) => ({ headers: w.headers, rawBody: Buffer.from(raw), body: JSON.parse(raw) });
      expect(a.verifyWebhook(mk(fake.signedWebhook(event(), { secret: 'other' })))).toBe(false);
      expect(a.verifyWebhook(mk(good, good.rawBody.replace('Asha', 'Eve')))).toBe(false);
      expect(a.verifyWebhook({ ...mk(good), headers: {} })).toBe(false);
      expect(a.verifyWebhook(mk(fake.signedWebhook(event(), { timestamp: Math.floor(Date.now() / 1000) - 3600 })))).toBe(false); // replay
    });
    it("one connection's secret does not verify another connection's webhook", () => {
      const other = adapter({ secrets: { API_KEY: 'x', WEBHOOK_SECRET: 'a-different-tenants-secret' }, connectionId: '22222222-2222-2222-2222-222222222222' });
      const w = fake.signedWebhook(event());
      expect(other.verifyWebhook({ headers: w.headers, rawBody: Buffer.from(w.rawBody), body: JSON.parse(w.rawBody) })).toBe(false);
    });
    it('a connection without a webhook secret verifies nothing', () => {
      const a = adapter({ secrets: { API_KEY: 'x' } });
      const w = fake.signedWebhook(event());
      expect(a.verifyWebhook({ headers: w.headers, rawBody: Buffer.from(w.rawBody), body: JSON.parse(w.rawBody) })).toBe(false);
    });
    it('an authentic event type we do not act on is returned without a reservation', () => {
      const parsed = adapter().parseWebhook({ event_id: 'e2', type: 'property.updated' });
      expect(parsed.reservation).toBeUndefined();
      expect(parsed.eventType).toBe('property.updated');
    });
  });
});
