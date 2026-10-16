import { SchedulerService } from '../src/jobs/scheduler.module';
import { exampleRestDefinition } from '../src/modules/channels/providers/example-definition';
import { FakeProvider, sampleBooking } from './utils/fake-provider';
import { bearer, createPlatformAdmin, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * The whole configuration-driven path through the real application: an administrator defines and publishes a provider as DATA, two
 * unrelated tenants connect to it with their own credentials, and bookings, availability pushes, webhooks and polling flow through
 * the same engine as any built-in channel, with no provider-specific code. The "provider" is a local HTTP server.
 */
describe('Configuration-driven providers (no provider-specific code)', () => {
  let t: TestApp;
  const fake = new FakeProvider();
  let admin: Session;
  let ops: Session;
  let providerId: string;
  let versionId: string;
  const KEY_A = fake.main.apiKey; // 'acme-key-1'
  const KEY_B = 'acme-key-B';
  const tenantB = fake.addTenant(KEY_B);

  let ownerA: Session;
  let ownerB: Session;
  let a: PropertySetup;
  let b: PropertySetup;
  let connKeyA = '';
  let connKeyB = '';

  const ymd = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const http = () => t.http();
  const connection = (o: Session, s: PropertySetup) => http().get(`/properties/${s.propertyId}/channels/ACME_STAY/connection`).set(bearer(o.token));
  const reservationsOf = (propertyId: string) => t.db.selectFrom('reservations').selectAll().where('source', '=', 'ACME_STAY').where('propertyId', '=', propertyId).execute();
  const webhook = (key: string, payload: object, opts: Parameters<FakeProvider['signedWebhook']>[1] = {}) => {
    const w = fake.signedWebhook(payload, opts);
    return http().post(`/webhooks/c/${key}`).set(w.headers).send(w.rawBody);
  };
  const bookingEvent = (type: string, id: string, over: object = {}, eventId = `evt-${id}-${type}`) => ({ event_id: eventId, type, booking: sampleBooking({ id, arrival: day(10), departure: day(12), total: 9000, updated_at: new Date().toISOString(), ...over }) });

  beforeAll(async () => {
    await fake.start();
    t = await createTestApp();
    admin = await createPlatformAdmin(t, 'SUPER_ADMIN', 'root');
    ops = await createPlatformAdmin(t, 'OPERATIONS_ADMIN', 'ops');
    ownerA = await registerOwner(t, 'tenant-a');
    ownerB = await registerOwner(t, 'tenant-b');
    a = await createPropertyWithRooms(t, ownerA.token, 10);
    b = await createPropertyWithRooms(t, ownerB.token, 10);
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
  });

  describe('provider administration', () => {
    const def = () => exampleRestDefinition({ baseUrl: fake.baseUrl, host: fake.host });

    it('only platform administrators manage providers, and only a super admin publishes', async () => {
      await http().get('/admin/channel-providers').set(bearer(ownerA.token)).expect(403);
      await http().post('/admin/channel-providers').set(bearer(ops.token)).send({ code: 'ACME_STAY', name: 'Acme Stay', kind: 'PMS' }).expect(403);
    });

    it('creates a provider, rejects reserved and malformed codes', async () => {
      await http().post('/admin/channel-providers').set(bearer(admin.token)).send({ code: 'AIRBNB', name: 'x', kind: 'OTA' }).expect(409);
      await http().post('/admin/channel-providers').set(bearer(admin.token)).send({ code: 'bad code', name: 'x', kind: 'OTA' }).expect(400);
      const res = await http().post('/admin/channel-providers').set(bearer(admin.token)).send({ code: 'ACME_STAY', name: 'Acme Stay', kind: 'PMS' }).expect(201);
      providerId = res.body.data._id;
      expect(res.body.data).toMatchObject({ code: 'ACME_STAY', status: 'DRAFT', builtIn: false });
      await http().post('/admin/channel-providers').set(bearer(admin.token)).send({ code: 'ACME_STAY', name: 'dup', kind: 'PMS' }).expect(409);
    });

    it('a draft provider is invisible to partners and cannot be connected', async () => {
      const cat = await http().get('/channel-providers').set(bearer(ownerA.token)).expect(200);
      expect(cat.body.data.map((p: { code: string }) => p.code)).not.toContain('ACME_STAY');
      await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: { API_KEY: KEY_A } }).expect(404);
    });

    it('stores an invalid definition as a draft with its errors, and refuses to publish it', async () => {
      const bad = def() as unknown as Record<string, unknown>;
      bad.script = 'process.exit(1)';
      const res = await http().post(`/admin/channel-providers/${providerId}/versions`).set(bearer(admin.token)).send({ definition: bad }).expect(201);
      expect(res.body.data.version.status).toBe('DRAFT');
      expect(res.body.data.validation.errors.map((e: { path: string }) => e.path)).toContain('script');
      await http().post(`/admin/channel-providers/versions/${res.body.data.version._id}/publish`).set(bearer(admin.token)).expect(409);
    });

    it('validates, dry-runs read-only against the provider, then publishes', async () => {
      const checked = await http().post('/admin/channel-providers/validate').set(bearer(admin.token)).send({ definition: def() }).expect(200);
      expect(checked.body.data.ok).toBe(true);

      const v = await http().post(`/admin/channel-providers/${providerId}/versions`).set(bearer(admin.token)).send({ definition: def(), notes: 'first' }).expect(201);
      versionId = v.body.data.version._id;
      expect(v.body.data.version.status).toBe('VALIDATED');

      fake.reset();
      const dry = await http().post(`/admin/channel-providers/versions/${versionId}/dry-run`).set(bearer(admin.token)).send({ environment: 'sandbox', credentials: { API_KEY: KEY_A } }).expect(200);
      expect(dry.body.data.passed).toBe(true);
      expect(dry.body.data.steps.map((s: { step: string }) => s.step)).toEqual(['healthCheck', 'listListings', 'listRoomTypes', 'listRatePlans', 'listReservations']);
      expect(fake.requests.every((r) => r.method === 'GET')).toBe(true); // a dry run never writes
      expect(JSON.stringify(dry.body)).not.toContain(KEY_A);
      const stored = await t.db.selectFrom('channelProviderTests').selectAll().where('providerId', '=', providerId).execute();
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(KEY_A);

      await http().post(`/admin/channel-providers/versions/${versionId}/publish`).set(bearer(ops.token)).expect(403);
      const pub = await http().post(`/admin/channel-providers/versions/${versionId}/publish`).set(bearer(admin.token)).expect(200);
      expect(pub.body.data.version.status).toBe('PUBLISHED');
      expect(pub.body.data.provider).toMatchObject({ status: 'ACTIVE', currentVersionId: versionId });
    });

    it('a published version is immutable; changes go into a new version; rollback publishes a copy', async () => {
      await http().put(`/admin/channel-providers/versions/${versionId}`).set(bearer(admin.token)).send({ definition: def() }).expect(409);
      const changed = def();
      changed.rateLimit = { requestsPerSecond: 5 };
      const v2 = await http().post(`/admin/channel-providers/${providerId}/versions`).set(bearer(admin.token)).send({ definition: changed }).expect(201);
      const v2Id = v2.body.data.version._id;
      const diff = await http().get(`/admin/channel-providers/versions/${versionId}/diff/${v2Id}`).set(bearer(admin.token)).expect(200);
      expect(diff.body.data.map((d: { path: string }) => d.path)).toContain('$.rateLimit.requestsPerSecond');
      await http().post(`/admin/channel-providers/versions/${v2Id}/publish`).set(bearer(admin.token)).expect(200);
      const detail = await http().get(`/admin/channel-providers/${providerId}`).set(bearer(admin.token)).expect(200);
      expect(detail.body.data.versions.map((x: { status: string }) => x.status)).toEqual(['PUBLISHED', 'RETIRED', 'DRAFT']); // newest first; the DRAFT is the invalid one stored earlier

      const back = await http().post(`/admin/channel-providers/${providerId}/rollback`).set(bearer(admin.token)).send({ toVersionId: versionId }).expect(200);
      expect(back.body.data.version.version).toBe(4);
      expect((await http().get(`/admin/channel-providers/versions/${back.body.data.version._id}`).set(bearer(admin.token))).body.data.definition.rateLimit.requestsPerSecond).toBe(20);
    });

    it('the catalogue shows partners what the provider can do and needs', async () => {
      const cat = await http().get('/channel-providers').set(bearer(ownerA.token)).expect(200);
      const entry = cat.body.data.find((p: { code: string }) => p.code === 'ACME_STAY');
      expect(entry).toMatchObject({ protocol: 'REST_JSON', authType: 'API_KEY_HEADER', operational: true, supportsWebhooks: true, supportsPolling: true, sandboxAvailable: true, builtIn: false });
      expect(entry.capabilities).toEqual(expect.arrayContaining(['listings', 'pushAvailability', 'pushRates', 'pullReservations']));
      expect(entry.capabilities).not.toContain('pushRestrictions');
      expect(entry.requiredCredentials).toContain('API_KEY');
      expect(JSON.stringify(entry)).not.toContain(fake.baseUrl); // no definition internals
      // the built-in OTAs are listed too, and are not operational
      expect(cat.body.data.find((p: { code: string }) => p.code === 'AIRBNB')).toMatchObject({ operational: false });
    });
  });

  describe('connecting', () => {
    it('is not connected by merely entering credentials: a rejected key leaves the connection in ERROR', async () => {
      const res = await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: { API_KEY: 'wrong-key' } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CHANNEL_CONNECTION_TEST_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('wrong-key');
      const c = await connection(ownerA, a).expect(200);
      expect(c.body.data.status).toBe('ERROR');
      expect(c.body.data.lastError).toBeTruthy();
    });

    it('required credentials are enforced', async () => {
      const res = await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: {} });
      expect(res.status).toBe(400);
    });

    it('connects tenant A and tenant B with their own credentials, verified by the provider', async () => {
      const ra = await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: { API_KEY: KEY_A, WEBHOOK_SECRET: fake.main.webhookSecret } }).expect(200);
      const rb = await http().post(`/properties/${b.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerB.token)).send({ credentials: { API_KEY: KEY_B, WEBHOOK_SECRET: tenantB.webhookSecret } }).expect(200);
      expect(ra.body.data).toMatchObject({ status: 'CONNECTED', provider: { code: 'ACME_STAY' } });
      expect(rb.body.data.status).toBe('CONNECTED');
      connKeyA = new URL(ra.body.data.webhook.url).pathname.split('/').pop()!;
      connKeyB = new URL(rb.body.data.webhook.url).pathname.split('/').pop()!;
      expect(connKeyA).not.toBe(connKeyB);
      expect(connKeyA.length).toBeGreaterThanOrEqual(32);
      // credentials are described, never returned
      expect(ra.body.data.credentials.map((c: { kind: string }) => c.kind).sort()).toEqual(['API_KEY', 'WEBHOOK_SECRET']);
      const all = JSON.stringify([ra.body, rb.body]);
      for (const secret of [KEY_A, KEY_B, fake.main.webhookSecret, tenantB.webhookSecret]) expect(all).not.toContain(secret);
    });

    it('credentials are stored encrypted, bound to their own connection', async () => {
      const rows = await t.db.selectFrom('channelConnectionSecrets').selectAll().execute();
      expect(rows.length).toBe(4);
      for (const r of rows) {
        expect(r.ciphertext).toMatch(/^v1:/);
        for (const secret of [KEY_A, KEY_B]) expect(r.ciphertext).not.toContain(secret);
      }
      const connIds = new Set(rows.map((r) => r.connectionId));
      expect(connIds.size).toBe(2);
    });

    it("another tenant cannot see or use a tenant's connection", async () => {
      await http().get(`/properties/${a.propertyId}/channels/ACME_STAY/connection`).set(bearer(ownerB.token)).expect((r) => expect([403, 404]).toContain(r.status));
      await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/test`).set(bearer(ownerB.token)).expect((r) => expect([403, 404]).toContain(r.status));
      await http().put(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerB.token)).send({ credentials: { API_KEY: KEY_B } }).expect((r) => expect([403, 404]).toContain(r.status));
    });

    it('imports the provider listings through pagination and maps them with the usual mapping API', async () => {
      const res = await http().get(`/properties/${a.propertyId}/channels/ACME_STAY/listings`).set(bearer(ownerA.token)).expect(200);
      expect(res.body.data.map((l: { externalListingId: string }) => l.externalListingId).sort()).toEqual(['P-1', 'P-2', 'P-3']);
      for (const [o, s] of [[ownerA, a], [ownerB, b]] as const) {
        const m = await http()
          .post(`/properties/${s.propertyId}/channels/ACME_STAY/mappings`)
          .set(bearer(o.token))
          .send({ mappings: [{ externalListingId: 'P-1', externalRoomId: 'R-DLX', roomTypeId: s.roomTypeId, ratePlans: [{ externalRatePlanId: 'RP-FLEX', ratePlanId: s.ratePlanId }] }] })
          .expect(201);
        expect(m.body.data[0].created).toBe(true);
      }
      // the same external ids exist for both tenants, each in its own connection scope
      const listings = await t.db.selectFrom('channelListings').select(['propertyId', 'externalListingId', 'externalScope']).where('channel', '=', 'ACME_STAY').where('externalListingId', '=', 'P-1').execute();
      expect(listings).toHaveLength(2);
      expect(new Set(listings.map((l) => l.externalScope)).size).toBe(2);
      expect(listings.every((l) => l.externalScope !== '00000000-0000-0000-0000-000000000000')).toBe(true);
      await t.drain();
    });
  });

  describe('public API: connection status for partner software', () => {
    it('shows status and capabilities of the property connections, and nothing a partner could abuse', async () => {
      const key = await http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'Status reader', scopes: ['properties:read'] }).expect(201);
      const res = await http().get(`/v1/properties/${a.slug}/connections`).set('Authorization', `Bearer ${key.body.data.key}`).expect(200);
      const acme = res.body.data.find((c: { channel: string }) => c.channel === 'ACME_STAY');
      expect(acme).toMatchObject({ name: 'Acme Stay', protocol: 'REST_JSON', status: 'CONNECTED', healthy: true });
      expect(acme.capabilities).toEqual(expect.arrayContaining(['pushAvailability', 'pullReservations']));
      expect(Object.keys(acme).sort()).toEqual(['capabilities', 'channel', 'healthy', 'lastSyncAt', 'name', 'protocol', 'status']);
      expect(JSON.stringify(res.body)).not.toMatch(/acme-key|whsec|baseUrl|127.0.0.1/);
      // a key without the scope, and a key of another tenant, get nothing
      const weak = await http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'Only rates', scopes: ['rates:read'] }).expect(201);
      await http().get(`/v1/properties/${a.slug}/connections`).set('Authorization', `Bearer ${weak.body.data.key}`).expect(403);
      const foreign = await http().post('/api-keys').set(bearer(ownerB.token)).send({ name: 'Foreign', scopes: ['properties:read'] }).expect(201);
      await http().get(`/v1/properties/${a.slug}/connections`).set('Authorization', `Bearer ${foreign.body.data.key}`).expect(404);
    });
  });

  describe('outbound sync through the generic adapter', () => {
    it('pushes availability and prices (with the declared money transform) after a booking; each tenant only to its own account', async () => {
      fake.reset();
      await http().post('/reservations').set(bearer(ownerA.token)).send(reservationBody(a, day(5), day(7))).expect(201);
      await t.drain();
      const pushed = fake.main.pushed.availability;
      expect(pushed.length).toBeGreaterThan(0);
      expect(pushed.find((u) => u.date === day(5))).toMatchObject({ property: 'P-1', room_id: 'R-DLX', available: 9, stop_sell: false });
      expect(tenantB.pushed.availability).toHaveLength(0); // B's account saw nothing of A's booking
      // prices are pushed on a full resync (and when rates change); the money transform turns minor units into the provider's major units
      await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/sync`).set(bearer(ownerA.token)).expect(202);
      await t.drain();
      expect(fake.main.pushed.rates.find((r) => r.date === day(5))).toMatchObject({ rate_plan_id: 'RP-FLEX', amount: 3500, currency: 'INR' });
      // every request used A's credentials only
      expect(fake.requests.every((r) => r.headers['x-api-key'] === KEY_A)).toBe(true);
    });

    it('an operation the provider does not offer (restrictions) is skipped visibly, never faked or sent', async () => {
      fake.reset();
      await http().put(`/properties/${a.propertyId}/restrictions`).set(bearer(ownerA.token)).send({ roomTypeId: a.roomTypeId, from: day(20), to: day(21), stopSell: true }).expect(200);
      await t.drain();
      expect(fake.requests.filter((r) => /restriction/i.test(r.path))).toHaveLength(0);
      const jobs = await t.db.selectFrom('syncJobs').selectAll().where('propertyId', '=', a.propertyId).where('type', '=', 'RESTRICTIONS').execute();
      expect(jobs.length).toBeGreaterThan(0);
      const logs = await t.db.selectFrom('syncLogs').selectAll().where('propertyId', '=', a.propertyId).where('channel', '=', 'ACME_STAY').execute();
      expect(JSON.stringify(logs.map((l) => l.responseMetadata))).toMatch(/does not support pushRestrictions/);
    });

    it("one tenant's provider failures do not stop another tenant's synchronisation", async () => {
      fake.reset();
      fake.fail('/v1/properties/P-1/availability', 500, 999, undefined, KEY_A);
      await http().post('/reservations').set(bearer(ownerA.token)).send(reservationBody(a, day(30), day(31))).expect(201);
      const rb = await http().post('/reservations').set(bearer(ownerB.token)).send(reservationBody(b, day(30), day(31))).expect(201);
      await t.drain();
      expect(tenantB.pushed.availability.find((u) => u.date === day(30))).toMatchObject({ available: 9 });
      expect(fake.main.pushed.availability).toHaveLength(0);
      expect(rb.body.data.status).toBe('CONFIRMED');
      const failed = await t.db.selectFrom('syncLogs').select('propertyId').where('channel', '=', 'ACME_STAY').where('status', '=', 'FAILED').execute();
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((f) => f.propertyId === a.propertyId)).toBe(true);
      // A's booking is still confirmed: a failing channel never affects the reservation
      const mine = await t.db.selectFrom('reservations').select('status').where('propertyId', '=', a.propertyId).where('checkIn', '=', day(30) as never).executeTakeFirst();
      expect(mine?.status).toBe('CONFIRMED');
    });
  });

  describe('inbound webhooks (connection-addressed)', () => {
    it('creates one reservation from a signed webhook, deduplicates redelivery and acknowledges it', async () => {
      fake.reset();
      const ev = bookingEvent('booking.created', 'BK-1001');
      const first = await webhook(connKeyA, ev).expect(200);
      expect(first.body.data).toMatchObject({ received: true, duplicate: false });
      await t.drain();
      const [r] = await reservationsOf(a.propertyId);
      expect(r).toMatchObject({ externalReservationId: 'BK-1001', status: 'CONFIRMED', source: 'ACME_STAY', paymentStatus: 'CHANNEL_COLLECTED' });
      expect(r.externalScope).not.toBe('00000000-0000-0000-0000-000000000000');
      expect(fake.main.acked).toEqual(['BK-1001']);
      // the dashboard can filter by a configured provider's code
      const list = await http().get(`/reservations?propertyId=${a.propertyId}&source=ACME_STAY`).set(bearer(ownerA.token)).expect(200);
      expect(list.body.data.items.map((x: { source: string }) => x.source)).toEqual(['ACME_STAY']);
      await http().get(`/reservations?propertyId=${a.propertyId}&source=not-a-code`).set(bearer(ownerA.token)).expect(400);

      const again = await webhook(connKeyA, ev).expect(200);
      expect(again.body.data.duplicate).toBe(true);
      // a different event id for the same booking is still the same reservation
      await webhook(connKeyA, bookingEvent('booking.created', 'BK-1001', {}, 'evt-other-id')).expect(200);
      await t.drain();
      expect(await reservationsOf(a.propertyId)).toHaveLength(1);
    });

    it('the same booking id and event id at a different tenant is an independent reservation', async () => {
      const ev = bookingEvent('booking.created', 'BK-1001'); // identical external reservation id and event id
      await webhook(connKeyB, ev, { tenant: tenantB }).expect(200);
      await t.drain();
      const mineA = await reservationsOf(a.propertyId);
      const mineB = await reservationsOf(b.propertyId);
      expect(mineA).toHaveLength(1);
      expect(mineB).toHaveLength(1);
      expect(mineA[0].id).not.toBe(mineB[0].id);
      expect(mineA[0].externalScope).not.toBe(mineB[0].externalScope);
      expect(tenantB.acked).toContain('BK-1001');
    });

    it('refuses forged, cross-tenant, stale and unknown deliveries without creating anything', async () => {
      const before = (await t.db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n;
      const ev = bookingEvent('booking.created', 'BK-EVIL', {}, 'evt-evil');
      expect((await webhook(connKeyA, ev, { secret: 'attacker-secret' })).status).toBe(401);
      expect((await webhook(connKeyA, ev, { tenant: tenantB })).status).toBe(401); // B's secret does not open A's endpoint
      expect((await webhook(connKeyA, ev, { timestamp: Math.floor(Date.now() / 1000) - 7200 })).status).toBe(401); // replay
      expect((await webhook('x'.repeat(43), ev)).status).toBe(404);
      const w = fake.signedWebhook(ev);
      expect((await http().post(`/webhooks/c/${connKeyA}`).set({ 'content-type': 'application/json' }).send(w.rawBody)).status).toBe(401); // unsigned
      await t.drain();
      expect((await t.db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n).toBe(before);
      const stored = await t.db.selectFrom('webhookEvents').selectAll().where('channel', '=', 'ACME_STAY').where('signatureValid', '=', false).execute();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((e) => e.status === 'IGNORED')).toBe(true);
      expect(JSON.stringify(stored.map((e) => e.payload))).not.toContain('asha@example.com'); // nothing from an unauthenticated delivery is kept
    });

    it('modifications move the stay and cancellations release the inventory', async () => {
      await webhook(connKeyA, bookingEvent('booking.updated', 'BK-1001', { arrival: day(14), departure: day(16), total: 12000 }, 'evt-mod')).expect(200);
      await t.drain();
      const [mod] = await reservationsOf(a.propertyId);
      expect(ymd(mod.checkIn)).toBe(day(14));
      await webhook(connKeyA, bookingEvent('booking.cancelled', 'BK-1001', { status: 'cancelled' }, 'evt-cancel')).expect(200);
      await t.drain();
      const [gone] = await reservationsOf(a.propertyId);
      expect(gone.status).toBe('CANCELLED');
      // the channel owns this booking: it cannot be cancelled or changed through the public API
      const keyRes = await http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'Partner key', scopes: ['reservations:write', 'reservations:read'] }).expect(201);
      const code = gone.reservationCode;
      const attempt = await http().post(`/v1/reservations/${code}/cancel`).set('Authorization', `Bearer ${keyRes.body.data.key}`).send({});
      expect(attempt.status).toBe(409);
      expect(attempt.body.error.code).toBe('CHANNEL_OWNED_RESERVATION');
    });

    it('an event for a listing that is not mapped is parked for staff, not guessed', async () => {
      await webhook(connKeyA, bookingEvent('booking.created', 'BK-UNMAPPED', { property_id: 'P-2' }, 'evt-unmapped')).expect(200);
      await t.drain();
      expect(await t.db.selectFrom('reservations').select('id').where('externalReservationId', '=', 'BK-UNMAPPED').execute()).toHaveLength(0);
      const ev = await t.db.selectFrom('webhookEvents').select(['status', 'error']).where('externalEventId', '=', 'evt-unmapped').executeTakeFirstOrThrow();
      expect(ev.status).toBe('FAILED');
      expect(ev.error).toMatch(/No room mapping/);
    });
  });

  describe('polling with a persisted cursor', () => {
    const pollNow = async (connId: string) => {
      await t.db.updateTable('channelConnections').set({ lastPollAt: new Date(Date.now() - 3_600_000) }).where('id', '=', connId).execute();
      const queued = await t.app.get(SchedulerService).queueReservationPulls();
      await t.drain();
      return queued;
    };
    let connIdA = '';

    it('reads new reservations incrementally and moves the cursor only after they are stored', async () => {
      connIdA = (await t.db.selectFrom('channelConnections').select('id').where('propertyId', '=', a.propertyId).where('channel', '=', 'ACME_STAY').executeTakeFirstOrThrow()).id;
      const stamp = new Date().toISOString();
      fake.main.bookings = [sampleBooking({ id: 'BK-POLL-1', arrival: day(40), departure: day(42), total: 7000, updated_at: stamp })];
      expect(await pollNow(connIdA)).toBeGreaterThanOrEqual(1);
      const conn = await t.db.selectFrom('channelConnections').selectAll().where('id', '=', connIdA).executeTakeFirstOrThrow();
      expect((conn.pollCursor as { updatedSince: string }).updatedSince).toBe(stamp);
      expect(conn.lastPollError).toBeNull();
      const res = (await reservationsOf(a.propertyId)).filter((r) => r.externalReservationId === 'BK-POLL-1');
      expect(res).toHaveLength(1);
    });

    it('a repeated poll (overlap window) creates no duplicate; a changed booking is applied once', async () => {
      await pollNow(connIdA);
      expect((await reservationsOf(a.propertyId)).filter((r) => r.externalReservationId === 'BK-POLL-1')).toHaveLength(1);
      fake.main.bookings = [sampleBooking({ id: 'BK-POLL-1', status: 'modified', arrival: day(41), departure: day(43), total: 7000, updated_at: new Date(Date.now() + 1000).toISOString() })];
      await pollNow(connIdA);
      await pollNow(connIdA);
      const rows = (await reservationsOf(a.propertyId)).filter((r) => r.externalReservationId === 'BK-POLL-1');
      expect(rows).toHaveLength(1);
      expect(ymd(rows[0].checkIn)).toBe(day(41));
    });

    it('does not poll before the connection interval has elapsed, and not at all when polling is switched off', async () => {
      const sched = t.app.get(SchedulerService);
      await t.db.updateTable('channelConnections').set({ lastPollAt: new Date() }).where('id', '=', connIdA).execute();
      expect(await sched.queueReservationPulls()).toBe(0);
      await http().patch(`/properties/${a.propertyId}/channels/ACME_STAY/settings`).set(bearer(ownerA.token)).send({ pollIntervalSeconds: null }).expect(200);
      await t.db.updateTable('channelConnections').set({ lastPollAt: new Date(Date.now() - 86_400_000) }).where('id', '=', connIdA).execute();
      const queued = await sched.queueReservationPulls();
      const conn = await t.db.selectFrom('channelConnections').select('lastPollAt').where('id', '=', connIdA).executeTakeFirstOrThrow();
      expect(queued).toBe(0); // B is not due either
      expect(conn.lastPollAt!.getTime()).toBeLessThan(Date.now() - 80_000_000);
      await http().patch(`/properties/${a.propertyId}/channels/ACME_STAY/settings`).set(bearer(ownerA.token)).send({ pollIntervalSeconds: 30 }).expect(400); // below the 60 s floor
      await http().patch(`/properties/${a.propertyId}/channels/ACME_STAY/settings`).set(bearer(ownerA.token)).send({ pollIntervalSeconds: 300 }).expect(200);
    });

    it('a provider outage leaves the cursor where it was and records the error; recovery picks the same window up', async () => {
      const before = (await t.db.selectFrom('channelConnections').select('pollCursor').where('id', '=', connIdA).executeTakeFirstOrThrow()).pollCursor;
      fake.reset();
      fake.fail('/v1/bookings', 503, 999, undefined, KEY_A);
      fake.main.bookings = [sampleBooking({ id: 'BK-POLL-2', arrival: day(45), departure: day(47), total: 5000, updated_at: new Date(Date.now() + 5000).toISOString() })];
      await pollNow(connIdA);
      const mid = await t.db.selectFrom('channelConnections').select(['pollCursor', 'lastPollError']).where('id', '=', connIdA).executeTakeFirstOrThrow();
      expect(mid.pollCursor).toEqual(before);
      expect(mid.lastPollError).toBeTruthy();
      expect((await reservationsOf(a.propertyId)).some((r) => r.externalReservationId === 'BK-POLL-2')).toBe(false);
      fake.reset();
      await pollNow(connIdA);
      expect((await reservationsOf(a.propertyId)).some((r) => r.externalReservationId === 'BK-POLL-2')).toBe(true);
      expect((await t.db.selectFrom('channelConnections').select('lastPollError').where('id', '=', connIdA).executeTakeFirstOrThrow()).lastPollError).toBeNull();
    });

    it('reservations the mapping cannot import are reported in the sync log, not dropped silently', async () => {
      fake.main.bookings = [sampleBooking({ id: 'BK-ODD', status: 'on_hold', updated_at: new Date(Date.now() + 9000).toISOString() })];
      await pollNow(connIdA);
      const logs = await t.db.selectFrom('syncLogs').select('error').where('propertyId', '=', a.propertyId).where('action', '=', 'poll_skipped').execute();
      expect(logs.map((l) => l.error).join(' ')).toMatch(/BK-ODD.*not mapped/);
    });
  });

  describe('reconciliation', () => {
    const base = () => `/properties/${a.propertyId}/channels/ACME_STAY/reconciliation`;
    const run = () => http().post(base()).set(bearer(ownerA.token));
    const issues = async () => (await http().get(base()).set(bearer(ownerA.token)).expect(200)).body.data.issues as { _id: string; kind: string; externalReservationId: string; status: string; details: Record<string, any> }[];
    const localOf = async (ext: string) => (await reservationsOf(a.propertyId)).find((r) => r.externalReservationId === ext);

    it('imports a reservation the provider has and we missed, through the normal pipeline, and closes the issue on the next run', async () => {
      fake.reset();
      fake.main.bookings = [sampleBooking({ id: 'BK-REC-1', arrival: day(50), departure: day(52), total: 8000, updated_at: new Date().toISOString() })];
      const res = await run().expect(200);
      expect(res.body.data).toMatchObject({ status: 'COMPLETED' });
      expect((await issues()).find((i) => i.externalReservationId === 'BK-REC-1')).toMatchObject({ kind: 'MISSING_LOCAL' });
      await t.drain();
      expect(await localOf('BK-REC-1')).toMatchObject({ status: 'CONFIRMED', source: 'ACME_STAY' });
      await run().expect(200);
      expect((await issues()).some((i) => i.externalReservationId === 'BK-REC-1')).toBe(false); // no longer detected, so closed
      await t.drain();
      expect((await reservationsOf(a.propertyId)).filter((r) => r.externalReservationId === 'BK-REC-1')).toHaveLength(1);
    });

    it('reports a status difference and a date difference but never cancels or moves a reservation by itself', async () => {
      const poll1 = (await localOf('BK-POLL-1'))!;
      const poll2 = (await localOf('BK-POLL-2'))!;
      expect(poll1.status).toBe('CONFIRMED');
      expect(poll2.status).toBe('CONFIRMED');
      const stamp = new Date(Date.now() + 20_000).toISOString();
      fake.main.bookings = [
        sampleBooking({ id: 'BK-POLL-1', arrival: day(60), departure: day(62), total: 7000, updated_at: stamp }), // dates differ
        sampleBooking({ id: 'BK-POLL-2', status: 'cancelled', arrival: day(45), departure: day(47), total: 5000, updated_at: stamp }), // cancelled over there
        sampleBooking({ id: 'BK-REC-1', arrival: day(50), departure: day(52), total: 8000, updated_at: stamp }),
      ];
      await run().expect(200);
      const open = await issues();
      expect(open.find((i) => i.externalReservationId === 'BK-POLL-1')).toMatchObject({ kind: 'DATE_MISMATCH', details: { remote: { checkIn: day(60) }, local: { checkIn: day(41) } } });
      expect(open.find((i) => i.externalReservationId === 'BK-POLL-2')).toMatchObject({ kind: 'STATUS_MISMATCH', details: { remote: 'CANCELLED', local: 'CONFIRMED' } });
      await t.drain();
      expect((await localOf('BK-POLL-2'))!.status).toBe('CONFIRMED'); // untouched
      expect(ymd((await localOf('BK-POLL-1'))!.checkIn)).toBe(day(41)); // untouched
    });

    it('reports a booking we hold that the provider does not know', async () => {
      fake.main.bookings = [sampleBooking({ id: 'BK-REC-1', arrival: day(50), departure: day(52), total: 8000, updated_at: new Date(Date.now() + 30_000).toISOString() })];
      await run().expect(200);
      const open = await issues();
      expect(open.find((i) => i.externalReservationId === 'BK-POLL-1')).toMatchObject({ kind: 'MISSING_REMOTE' });
      expect((await localOf('BK-POLL-1'))!.status).toBe('CONFIRMED'); // reported, not cancelled
      expect(open.find((i) => i.externalReservationId === 'BK-POLL-2')?.kind).toBe('MISSING_REMOTE');
      expect(open.some((i) => i.externalReservationId === 'BK-POLL-1' && i.kind === 'DATE_MISMATCH')).toBe(false); // superseded: the earlier finding is closed
    });

    it('does not import what it cannot place: an unmapped listing is reported as such', async () => {
      fake.main.bookings = [sampleBooking({ id: 'BK-REC-X', property_id: 'P-2', room_id: 'R-STD', updated_at: new Date(Date.now() + 40_000).toISOString() })];
      await run().expect(200);
      await t.drain();
      expect((await issues()).find((i) => i.externalReservationId === 'BK-REC-X')).toMatchObject({ kind: 'UNMAPPED', details: { externalListingId: 'P-2' } });
      expect(await localOf('BK-REC-X')).toBeUndefined();
    });

    it('issues are resolved with a note (audited) and stay private to their tenant', async () => {
      const open = await issues();
      const target = open.find((i) => i.kind === 'UNMAPPED')!;
      await http().post(`${base()}/issues/${target._id}`).set(bearer(ownerA.token)).send({ status: 'IGNORED', resolution: 'Test booking on the provider side' }).expect(200);
      expect((await issues()).some((i) => i._id === target._id)).toBe(false);
      await http().post(`${base()}/issues/${target._id}`).set(bearer(ownerA.token)).send({ status: 'IGNORED', resolution: 'again' }).expect(404); // already closed
      const audit = await t.db.selectFrom('auditLogs').select('action').where('entityId', '=', target._id).execute();
      expect(audit.map((x) => x.action)).toContain('channel.reconcile_issue_resolve');
      // tenant B can neither read nor resolve tenant A's issues
      await http().get(base()).set(bearer(ownerB.token)).expect((r) => expect([403, 404]).toContain(r.status));
      await http().post(`${base()}/issues/${open[0]._id}`).set(bearer(ownerB.token)).send({ status: 'IGNORED', resolution: 'x' }).expect((r) => expect([403, 404]).toContain(r.status));
      const bOwn = await http().get(`/properties/${b.propertyId}/channels/ACME_STAY/reconciliation`).set(bearer(ownerB.token)).expect(200);
      expect(bOwn.body.data.issues.every((i: { externalReservationId: string }) => !['BK-POLL-1', 'BK-POLL-2', 'BK-REC-X'].includes(i.externalReservationId))).toBe(true);
    });

    it('a provider outage fails the run visibly and leaves the data alone', async () => {
      fake.reset();
      fake.fail('/v1/bookings', 503, 999, undefined, KEY_A);
      const before = await reservationsOf(a.propertyId);
      const res = await run();
      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain(KEY_A);
      const runs = (await http().get(base()).set(bearer(ownerA.token)).expect(200)).body.data.runs;
      expect(runs[0]).toMatchObject({ status: 'FAILED' });
      expect(await reservationsOf(a.propertyId)).toHaveLength(before.length);
      fake.reset();
    });
  });

  describe('credential rotation and disconnect', () => {
    it('rotation verifies the new credentials first and keeps the old ones when they fail', async () => {
      const bad = await http().put(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: { API_KEY: 'not-a-key' } });
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body)).not.toContain('not-a-key');
      const stillWorks = await http().post(`/properties/${a.propertyId}/channels/ACME_STAY/test`).set(bearer(ownerA.token)).expect(200);
      expect(stillWorks.body.data.ok).toBe(true);

      fake.main.apiKey = 'acme-key-1-rotated';
      (fake as unknown as { tenants: Map<string, unknown> }).tenants.set('acme-key-1-rotated', fake.main);
      const ok = await http().put(`/properties/${a.propertyId}/channels/ACME_STAY/credentials`).set(bearer(ownerA.token)).send({ credentials: { API_KEY: 'acme-key-1-rotated' } }).expect(200);
      expect(ok.body.data.status).toBe('CONNECTED');
      expect(ok.body.data.credentials.find((c: { kind: string; rotatedAt: string | null }) => c.kind === 'API_KEY').rotatedAt).toBeTruthy();
    });

    it('disconnecting deletes the credentials and switches the webhook address off', async () => {
      await http().post(`/properties/${b.propertyId}/channels/ACME_STAY/disconnect`).set(bearer(ownerB.token)).expect(200);
      expect(await t.db.selectFrom('channelConnectionSecrets').select('id').where('connectionId', 'in', t.db.selectFrom('channelConnections').select('id').where('propertyId', '=', b.propertyId)).execute()).toHaveLength(0);
      expect((await webhook(connKeyB, bookingEvent('booking.created', 'BK-AFTER', {}, 'evt-after'), { tenant: tenantB })).status).toBe(404);
      // tenant A is unaffected
      expect((await connection(ownerA, a)).body.data.status).toBe('CONNECTED');
    });

    it('a disabled provider stops every connection to it', async () => {
      await http().patch(`/admin/channel-providers/${providerId}/status`).set(bearer(admin.token)).send({ status: 'DISABLED' }).expect(200);
      expect((await webhook(connKeyA, bookingEvent('booking.created', 'BK-DISABLED', {}, 'evt-disabled'))).status).toBe(404);
      expect((await http().get('/channel-providers').set(bearer(ownerA.token))).body.data.map((p: { code: string }) => p.code)).not.toContain('ACME_STAY');
      await http().patch(`/admin/channel-providers/${providerId}/status`).set(bearer(admin.token)).send({ status: 'ACTIVE' }).expect(200);
    });
  });

  it('built-in channels and internal inventory are untouched by the framework', async () => {
    const list = await http().get(`/properties/${a.propertyId}/channels`).set(bearer(ownerA.token)).expect(200);
    const codes = list.body.data.map((c: { channel: string }) => c.channel);
    expect(codes).toEqual(expect.arrayContaining(['TIRVONA', 'DIRECT', 'AIRBNB', 'BOOKING_COM', 'AGODA', 'MOCK', 'ACME_STAY']));
    expect(list.body.data.find((c: { channel: string }) => c.channel === 'AIRBNB')).toMatchObject({ available: false, status: 'DISCONNECTED' });
    expect(list.body.data.find((c: { channel: string }) => c.channel === 'ACME_STAY')).toMatchObject({ configured: true, status: 'CONNECTED' });
    // Airbnb still refuses to pretend
    const airbnb = await http().post(`/properties/${a.propertyId}/channels/AIRBNB/connect`).set(bearer(ownerA.token));
    expect(airbnb.status).toBe(422);
    expect(airbnb.body.error.code).toBe('CHANNEL_INTEGRATION_NOT_AVAILABLE');
  });
});
