import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiUsageService } from '../src/modules/public-api/api-usage.service';
import { bearer, createMember, createPropertyWithRooms, day, publicBookingBody, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

async function startReceiver() {
  const received: { body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    reset: () => (received.length = 0),
    close: () => new Promise<void>((r) => server.close(() => r())),
    events: () => received.map((x) => JSON.parse(x.body) as { id: string; type: string; data: Record<string, any> }),
  };
}

/**
 * The partner-facing API surface added on top of v1: key lifecycle (environment, rotation with grace, usage), scoped access to
 * rates, inventory, payments and guest details, modifying bookings, the partner's own reference, and the new webhook events.
 */
describe('Public API v1: partner features', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rx: Awaited<ReturnType<typeof startReceiver>>;
  let n = 0;

  const makeKey = async (scopes: string[], extra: Record<string, unknown> = {}) =>
    (await t.http().post('/api-keys').set(bearer(owner.token)).send({ name: `Key ${++n}`, scopes, ...extra }).expect(201)).body.data as { _id: string; key: string; environment: string; keyPrefix: string };
  const asKey = (k: string) => ({ Authorization: `Bearer ${k}` });
  const idem = () => `idem-${Date.now()}-${++n}-abcdefgh`;
  const ALL = ['properties:read', 'availability:read', 'rates:read', 'rates:write', 'inventory:read', 'inventory:write', 'reservations:read', 'reservations:write', 'guests:read', 'payments:read'];
  const apiBooking = (k: string, extra: Record<string, unknown> = {}, from = day(20), to = day(22), key = idem()) =>
    t.http().post('/v1/reservations').set(asKey(k)).set('Idempotency-Key', key).send({ ...publicBookingBody(s, from, to), ...extra });

  beforeAll(async () => {
    t = await createTestApp({ BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' });
    owner = await registerOwner(t, 'partnerapi');
    s = await createPropertyWithRooms(t, owner.token, 4);
    rx = await startReceiver();
  });
  afterAll(async () => {
    await rx.close();
    await t.close();
  });

  describe('API keys: environment, rotation, usage', () => {
    it('a key records where it was issued and its last use', async () => {
      const k = await makeKey(['properties:read']);
      expect(k.environment).toBe('test'); // NODE_ENV of this run
      await t.http().get('/v1/properties').set(asKey(k.key)).expect(200);
      await new Promise((r) => setTimeout(r, 100));
      const row = (await t.http().get(`/api-keys/${k._id}`).set(bearer(owner.token)).expect(200)).body.data;
      expect(row).toMatchObject({ environment: 'test', status: 'ACTIVE', rotatedFrom: null });
      expect(row.lastUsedAt).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain(k.key);
    });

    it('rotation returns a new secret once, keeps scopes and restrictions, and revokes the old key at once', async () => {
      const old = await makeKey(['properties:read', 'availability:read'], { propertyIds: [s.propertyId] });
      const rotated = (await t.http().post(`/api-keys/${old._id}/rotate`).set(bearer(owner.token)).send({}).expect(200)).body.data;
      expect(rotated.key).toMatch(/^tvk_[a-z0-9]{8}_/);
      expect(rotated.key).not.toBe(old.key);
      expect(rotated).toMatchObject({ scopes: ['properties:read', 'availability:read'], propertyIds: [s.propertyId], rotatedFrom: old._id, status: 'ACTIVE' });
      const dead = await t.http().get('/v1/properties').set(asKey(old.key));
      expect([dead.status, dead.body.error.code]).toEqual([401, 'API_KEY_REVOKED']);
      expect((await t.http().get('/v1/properties').set(asKey(rotated.key))).status).toBe(200);
      // The list shows both, and never a secret.
      const list = JSON.stringify((await t.http().get('/api-keys').set(bearer(owner.token)).expect(200)).body.data);
      expect(list).not.toContain(rotated.key);
      expect((await t.http().post(`/api-keys/${old._id}/rotate`).set(bearer(owner.token)).send({})).status).toBe(404); // already revoked
    });

    it('rotation with a grace period lets the old key work until it expires', async () => {
      const old = await makeKey(['properties:read']);
      const rotated = (await t.http().post(`/api-keys/${old._id}/rotate`).set(bearer(owner.token)).send({ graceHours: 2 }).expect(200)).body.data;
      expect((await t.http().get('/v1/properties').set(asKey(old.key))).status).toBe(200); // both work during the overlap
      expect((await t.http().get('/v1/properties').set(asKey(rotated.key))).status).toBe(200);
      const exp = (await t.db.selectFrom('apiKeys').select('expiresAt').where('id', '=', old._id).executeTakeFirstOrThrow()).expiresAt!;
      expect(exp.getTime() - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
      expect(exp.getTime() - Date.now()).toBeLessThan(2.1 * 3_600_000);
      await t.db.updateTable('apiKeys').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', old._id).execute(); // the grace period ends
      expect((await t.http().get('/v1/properties').set(asKey(old.key))).body.error.code).toBe('API_KEY_EXPIRED');
      expect((await t.http().post(`/api-keys/${old._id}/rotate`).set(bearer(owner.token)).send({ graceHours: 100 })).status).toBe(400); // at most 72 hours
    });

    it('rotation and usage of another organization\'s key are 404', async () => {
      const other = await registerOwner(t, 'otherorg');
      const k = await makeKey(['properties:read']);
      expect((await t.http().post(`/api-keys/${k._id}/rotate`).set(bearer(other.token)).send({})).status).toBe(404);
      expect((await t.http().get(`/api-keys/${k._id}/usage`).set(bearer(other.token))).status).toBe(404);
      expect((await t.http().get(`/api-keys/${k._id}`).set(bearer(other.token))).status).toBe(404);
    });

    it('usage counts real requests, errors and rate limits per day', async () => {
      const k = await makeKey(['properties:read']);
      for (let i = 0; i < 3; i++) await t.http().get('/v1/properties').set(asKey(k.key)).expect(200);
      await t.http().get('/v1/properties/does-not-exist').set(asKey(k.key)).expect(404);
      await t.http().get('/v1/reservations').set(asKey(k.key)).expect(403); // lacks reservations:read
      await t.app.get(ApiUsageService).flush();
      const usage = (await t.http().get(`/api-keys/${k._id}/usage`).set(bearer(owner.token)).expect(200)).body.data.days as { requests: number; clientErrors: number }[];
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ requests: 5, clientErrors: 2, serverErrors: 0, rateLimited: 0 });
    });

    it('the developer overview reports real numbers for the organization only', async () => {
      const developer = await createMember(t, owner, 'DEVELOPER');
      const o = (await t.http().get('/developer/overview').set(bearer(developer.token)).expect(200)).body.data;
      expect(o.apiKeys.active).toBeGreaterThanOrEqual(3);
      expect(o.apiKeys.revoked).toBeGreaterThanOrEqual(1);
      expect(o.apiUsageLast7Days.requests).toBeGreaterThanOrEqual(5);
      const stranger = await registerOwner(t, 'nobody');
      const empty = (await t.http().get('/developer/overview').set(bearer(stranger.token)).expect(200)).body.data;
      expect(empty).toMatchObject({ apiKeys: { active: 0, revoked: 0 }, apiUsageLast7Days: { requests: 0 }, deliveriesLast24h: { total: 0 } });
      // A developer picks properties to scope keys without seeing any booking data.
      const props = (await t.http().get('/developer/properties').set(bearer(developer.token)).expect(200)).body.data;
      expect(props.map((p: { slug: string }) => p.slug)).toContain(s.slug);
      expect(Object.keys(props[0]).sort()).toEqual(['_id', 'name', 'slug', 'status']);
    });
  });

  describe('scopes: sensitive data and writes are never granted by accident', () => {
    let fullKey: string;
    beforeAll(async () => {
      fullKey = (await makeKey(ALL)).key;
    });

    it('every new endpoint demands its own scope', async () => {
      const readOnly = (await makeKey(['properties:read', 'availability:read', 'reservations:read'])).key;
      const code = (await apiBooking(fullKey, {}, day(30), day(31)).expect(201)).body.data.reservation.reservationCode as string;
      const calls: [string, string, Record<string, unknown>?][] = [
        ['get', `/v1/properties/${s.slug}/rate-plans`],
        ['put', `/v1/properties/${s.slug}/rates`, { updates: [{ ratePlanId: s.ratePlanId, basePrice: 1 }] }],
        ['get', `/v1/properties/${s.slug}/inventory?from=${day(1)}&to=${day(3)}`],
        ['put', `/v1/properties/${s.slug}/inventory`, { roomTypeId: s.roomTypeId, from: day(1), to: day(2), stopSell: true }],
        ['patch', `/v1/reservations/${code}`, { adults: 1 }],
        ['get', `/v1/reservations/${code}/payments`],
        ['post', `/v1/reservations/${code}/cancel`, {}],
      ];
      for (const [method, path, body] of calls) {
        const res = await (t.http() as any)[method](path).set(asKey(readOnly)).send(body ?? {});
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 403, 'API_SCOPE_MISSING']);
      }
    });
  });

  describe('rates', () => {
    let full: string;
    beforeAll(async () => {
      full = (await makeKey(ALL)).key;
    });

    it('lists rate plans and changes prices: future quotes change, existing bookings keep their price, repeating is a no-op', async () => {
      const plans = (await t.http().get(`/v1/properties/${s.slug}/rate-plans`).set(asKey(full)).expect(200)).body.data as { id: string; basePrice: number; roomTypeName: string }[];
      expect(plans[0]).toMatchObject({ id: s.ratePlanId, basePrice: 350000, roomTypeName: 'Deluxe AC' });
      const sold = (await apiBooking(full, {}, day(40), day(41)).expect(201)).body.data.reservation as { total: number; reservationCode: string };
      expect(sold.total).toBe(367500); // 3,500 + 5% tax

      await t.http().put(`/v1/properties/${s.slug}/rates`).set(asKey(full)).send({ updates: [{ ratePlanId: s.ratePlanId, basePrice: 400000 }] }).expect(200);
      const quote = (await t.http().get(`/v1/properties/${s.slug}/availability`).query({ checkIn: day(40), checkOut: day(41), adults: 1 }).set(asKey(full)).expect(200)).body.data;
      expect(JSON.stringify(quote)).toContain('420000'); // 4,000 + 5%
      const again = (await t.http().get(`/v1/reservations/${sold.reservationCode}`).set(asKey(full)).expect(200)).body.data;
      expect(again.total).toBe(367500); // the booking keeps the price it was sold at

      const jobs = async () => Number((await t.db.selectFrom('syncJobs').select((eb) => eb.fn.countAll<string>().as('n')).where('propertyId', '=', s.propertyId).executeTakeFirstOrThrow()).n);
      const before = await jobs();
      await t.http().put(`/v1/properties/${s.slug}/rates`).set(asKey(full)).send({ updates: [{ ratePlanId: s.ratePlanId, basePrice: 400000 }] }).expect(200);
      expect(await jobs()).toBe(before); // identical request: nothing changed, nothing queued

      const audit = await t.db.selectFrom('auditLogs').select(['action', 'metadata', 'after']).where('action', '=', 'api.rate_plan_update').executeTakeFirstOrThrow();
      expect(audit.after).toMatchObject({ basePrice: 400000 });
      expect(audit.metadata).toMatchObject({ via: 'public-api-v1' });
      expect(audit.metadata.apiKeyId).toBeTruthy();
      await t.http().put(`/v1/properties/${s.slug}/rates`).set(asKey(full)).send({ updates: [{ ratePlanId: s.ratePlanId, basePrice: 350000 }] }).expect(200); // restore
    });

    it('rejects bad input and plans that are not this property\'s', async () => {
      const put = (body: unknown) => t.http().put(`/v1/properties/${s.slug}/rates`).set(asKey(full)).send(body as object);
      expect((await put({ updates: [] })).status).toBe(400);
      expect((await put({ updates: [{ ratePlanId: s.ratePlanId, basePrice: -5 }] })).status).toBe(400);
      expect((await put({ updates: [{ ratePlanId: s.ratePlanId, basePrice: 1.5 }] })).status).toBe(400);
      expect((await put({ updates: [{ ratePlanId: s.ratePlanId, basePrice: 1 }, { ratePlanId: s.ratePlanId, basePrice: 2 }] })).status).toBe(400);
      const stranger = await registerOwner(t, 'ratestranger');
      const theirs = await createPropertyWithRooms(t, stranger.token, 1);
      expect((await put({ updates: [{ ratePlanId: theirs.ratePlanId, basePrice: 1 }] })).status).toBe(404);
      expect((await t.http().get(`/v1/properties/${s.slug}/rate-plans`).set(asKey(full)).expect(200)).body.data[0].basePrice).toBe(350000);
    });
  });

  describe('inventory and restrictions', () => {
    let full: string;
    beforeAll(async () => {
      full = (await makeKey(ALL)).key;
      await t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url: rx.url, events: ['*'] }).expect(201);
    });

    it('reads inventory per room type and night, including restrictions', async () => {
      const inv = (await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(1), to: day(4) }).set(asKey(full)).expect(200)).body.data;
      expect(inv.roomTypes).toHaveLength(1);
      expect(inv.roomTypes[0].days).toHaveLength(3);
      expect(inv.roomTypes[0].days[0]).toMatchObject({ total: 4, available: 4, sold: 0, stopSell: false, restrictions: { minimumStay: null, closed: false } });
      expect((await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(4), to: day(1) }).set(asKey(full))).status).toBe(400);
      expect((await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(0), to: day(400) }).set(asKey(full))).status).toBe(400);
    });

    it('stop-sell and stay limits take effect on availability at once, and inventory.updated is announced without guest data', async () => {
      rx.reset();
      const res = await t.http().put(`/v1/properties/${s.slug}/inventory`).set(asKey(full)).send({ roomTypeId: s.roomTypeId, from: day(50), to: day(52), stopSell: true, minimumStay: 2 }).expect(200);
      expect(res.body.data).toMatchObject({ roomTypeId: s.roomTypeId, applied: { stopSell: true, minimumStay: 2 } });
      const inv = (await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(50), to: day(52) }).set(asKey(full)).expect(200)).body.data;
      expect(inv.roomTypes[0].days.every((x: { stopSell: boolean; restrictions: { minimumStay: number } }) => x.stopSell && x.restrictions.minimumStay === 2)).toBe(true);
      const blocked = await apiBooking(full, {}, day(50), day(52));
      expect([blocked.status, blocked.body.error.code]).toEqual([409, 'RESTRICTION_VIOLATION']);

      await t.drain();
      const ev = rx.events().filter((e) => e.type === 'inventory.updated');
      expect(ev).toHaveLength(1);
      expect(ev[0].data).toEqual({ propertyId: s.propertyId, propertySlug: s.slug, roomTypeId: s.roomTypeId, from: day(50), to: day(52), reason: 'restrictions' });

      await t.http().put(`/v1/properties/${s.slug}/inventory`).set(asKey(full)).send({ roomTypeId: s.roomTypeId, from: day(50), to: day(52), stopSell: false, minimumStay: null }).expect(200);
      expect((await apiBooking(full, {}, day(50), day(52))).status).toBe(201);
    });

    it('validates the request and keeps room types of other properties out', async () => {
      const put = (body: unknown) => t.http().put(`/v1/properties/${s.slug}/inventory`).set(asKey(full)).send(body as object);
      expect((await put({ roomTypeId: s.roomTypeId, from: day(5), to: day(6) })).status).toBe(400); // nothing to change
      expect((await put({ roomTypeId: s.roomTypeId, from: day(6), to: day(5), stopSell: true })).status).toBe(400);
      expect((await put({ roomTypeId: s.roomTypeId, from: day(5), to: day(6), minimumStay: 5, maximumStay: 2 })).status).toBe(400);
      const stranger = await registerOwner(t, 'invstranger');
      const theirs = await createPropertyWithRooms(t, stranger.token, 1);
      expect((await put({ roomTypeId: theirs.roomTypeId, from: day(5), to: day(6), stopSell: true })).status).toBe(404);
    });
  });

  describe('reservations: your reference, modification, guest data and payments', () => {
    let full: string;
    let noGuests: string;
    beforeAll(async () => {
      full = (await makeKey(ALL)).key;
      noGuests = (await makeKey(['properties:read', 'reservations:read', 'reservations:write'])).key;
    });

    it('externalReference makes booking ingestion idempotent across retries with fresh idempotency keys', async () => {
      const ref = `PMS-${Date.now()}`;
      const first = await apiBooking(full, { externalReference: ref }, day(12), day(14)).expect(201);
      expect(first.body.data.reservation.externalReference).toBe(ref);
      expect(first.body.data.reservation.source).toBe('API');
      const retry = await apiBooking(full, { externalReference: ref }, day(12), day(14)); // a brand-new Idempotency-Key
      expect(retry.status).toBe(200);
      expect(retry.body.data).toMatchObject({ created: false });
      expect(retry.body.data.reservation.reservationCode).toBe(first.body.data.reservation.reservationCode);
      const clash = await apiBooking(full, { externalReference: ref }, day(16), day(17));
      expect([clash.status, clash.body.error.code]).toEqual([422, 'EXTERNAL_REFERENCE_REUSED']);
      const found = (await t.http().get('/v1/reservations').query({ externalReference: ref }).set(asKey(full)).expect(200)).body.data;
      expect(found.items.map((r: { reservationCode: string }) => r.reservationCode)).toEqual([first.body.data.reservation.reservationCode]);
      expect((await apiBooking(full, { externalReference: 'bad ref with spaces' }, day(12), day(14))).status).toBe(400);
      // Inventory was taken once.
      const inv = (await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(12), to: day(14) }).set(asKey(full)).expect(200)).body.data;
      expect(inv.roomTypes[0].days.map((x: { sold: number }) => x.sold)).toEqual([1, 1]);
    });

    it('concurrent deliveries of the same reference create exactly one booking', async () => {
      const ref = `RACE-${Date.now()}`;
      const results = await Promise.all(Array.from({ length: 6 }, () => apiBooking(full, { externalReference: ref }, day(18), day(20))));
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(results.map((r) => r.body.data.reservation.reservationCode)).size).toBe(1);
      expect(Number((await t.db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).where('partnerReference', '=', ref).executeTakeFirstOrThrow()).n)).toBe(1);
      const inv = (await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(18), to: day(20) }).set(asKey(full)).expect(200)).body.data;
      expect(inv.roomTypes[0].days.map((x: { sold: number }) => x.sold)).toEqual([1, 1]);
    });

    it('the same reference may be used by different properties', async () => {
      const s2 = await createPropertyWithRooms(t, owner.token, 2);
      const body = { ...publicBookingBody(s2, day(20), day(21)), externalReference: 'SAME-REF-1' };
      expect((await t.http().post('/v1/reservations').set(asKey(full)).set('Idempotency-Key', idem()).send(body)).status).toBe(201);
      expect((await t.http().post('/v1/reservations').set(asKey(full)).set('Idempotency-Key', idem()).send({ ...publicBookingBody(s, day(22), day(23)), externalReference: 'SAME-REF-1' })).status).toBe(201);
    });

    it('PATCH changes dates atomically, announces reservation.updated, and refuses other states and channel-owned bookings', async () => {
      const made = (await apiBooking(full, {}, day(24), day(26)).expect(201)).body.data.reservation as { reservationCode: string; total: number };
      rx.reset();
      const patched = (await t.http().patch(`/v1/reservations/${made.reservationCode}`).set(asKey(full)).send({ checkIn: day(25), checkOut: day(28), adults: 1, guest: { phone: '+919876543210' } }).expect(200)).body.data;
      expect(patched).toMatchObject({ checkIn: day(25), checkOut: day(28), nights: 3, adults: 1 });
      expect(patched.guest.phone).toBe('+919876543210');
      expect(patched.total).toBeGreaterThan(made.total);
      const inv = (await t.http().get(`/v1/properties/${s.slug}/inventory`).query({ from: day(24), to: day(29) }).set(asKey(full)).expect(200)).body.data;
      expect(inv.roomTypes[0].days.map((x: { sold: number }) => x.sold)).toEqual([0, 1, 1, 1, 0]); // old night released, new nights taken
      await t.drain();
      const ev = rx.events().filter((e) => e.type === 'reservation.updated');
      expect(ev).toHaveLength(1);
      expect(ev[0].data).toMatchObject({ change: 'dates', reservation: { reservationCode: made.reservationCode, checkIn: day(25), checkOut: day(28) } });

      expect((await t.http().patch(`/v1/reservations/${made.reservationCode}`).set(asKey(full)).send({})).status).toBe(400);
      expect((await t.http().patch(`/v1/reservations/${made.reservationCode}`).set(asKey(full)).send({ checkIn: day(29), checkOut: day(28) })).status).toBe(400);
      await t.http().post(`/v1/reservations/${made.reservationCode}/cancel`).set(asKey(full)).send({}).expect(200);
      const gone = await t.http().patch(`/v1/reservations/${made.reservationCode}`).set(asKey(full)).send({ adults: 2 });
      expect([gone.status, gone.body.error.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);

      // A booking that arrived from a channel is owned by the channel.
      const ota = (await apiBooking(full, {}, day(30), day(31)).expect(201)).body.data.reservation.reservationCode as string;
      await t.db.updateTable('reservations').set({ source: 'MOCK', externalReservationId: 'MOCK-OTA-1' }).where('reservationCode', '=', ota).execute();
      for (const [method, path] of [['patch', `/v1/reservations/${ota}`], ['post', `/v1/reservations/${ota}/cancel`]] as const) {
        const res = await (t.http() as any)[method](path).set(asKey(full)).send(method === 'patch' ? { adults: 1 } : {});
        expect([res.status, res.body.error.code]).toEqual([409, 'CHANNEL_OWNED_RESERVATION']);
      }
    });

    it('guest contact details are shown only with guests:read, or on bookings that same key created', async () => {
      const theirs = (await t.http().post('/public/reservations').send(publicBookingBody(s, day(32), day(33))).expect(201)).body.data.reservation.reservationCode as string; // booked on the property site
      const mine = (await apiBooking(noGuests, {}, day(34), day(35)).expect(201)).body.data.reservation;
      expect(mine.guest).toMatchObject({ email: 'emma@example.com', phone: '+447700900123', redacted: false });

      const seen = (await t.http().get(`/v1/reservations/${theirs}`).set(asKey(noGuests)).expect(200)).body.data;
      expect(seen.guest).toEqual({ firstName: 'Emma', lastName: 'C.', email: null, phone: null, redacted: true });
      expect(seen.specialRequests).toBeNull();
      const list = JSON.stringify((await t.http().get('/v1/reservations').query({ limit: 100 }).set(asKey(noGuests)).expect(200)).body.data);
      expect(list).toContain('"redacted":true');
      const listed = (JSON.parse(list).items as { reservationCode: string; guest: { redacted: boolean } }[]);
      expect(listed.find((r) => r.reservationCode === theirs)!.guest.redacted).toBe(true); // the guest of a booking made elsewhere is hidden in lists too
      expect(listed.find((r) => r.reservationCode === mine.reservationCode)!.guest.redacted).toBe(false);
      const full1 = (await t.http().get(`/v1/reservations/${theirs}`).set(asKey(full)).expect(200)).body.data;
      expect(full1.guest).toMatchObject({ email: 'emma@example.com', phone: '+447700900123', redacted: false });
      expect(full1.source).toBe('DIRECT');
    });

    it('payments need payments:read and carry no gateway details', async () => {
      const made = (await t.http().post('/public/reservations').send(publicBookingBody(s, day(36), day(37))).expect(201)).body.data.reservation.reservationCode as string;
      const bookingRow = await t.db.selectFrom('reservations').select(['id', 'propertyId', 'total']).where('reservationCode', '=', made).executeTakeFirstOrThrow();
      await t.db
        .insertInto('payments')
        .values({ propertyId: bookingRow.propertyId, reservationId: bookingRow.id, provider: 'RAZORPAY', providerPaymentId: 'pay_TESTPAY001', providerOrderId: 'order_X', amount: bookingRow.total, currency: 'INR', status: 'PAID', paidAt: new Date(), metadata: JSON.stringify({ vpa: 'guest@okaxis', card: { last4: '4242' } }) })
        .execute();
      const res = (await t.http().get(`/v1/reservations/${made}/payments`).set(asKey(full)).expect(200)).body.data;
      expect(res.payments).toHaveLength(1);
      expect(res.payments[0]).toMatchObject({ provider: 'RAZORPAY', status: 'PAID', amount: bookingRow.total, providerPaymentId: 'pay_TESTPAY001' });
      expect(JSON.stringify(res)).not.toMatch(/okaxis|4242|metadata|order_X/);
      expect((await t.http().get(`/v1/reservations/${made}/payments`).set(asKey(noGuests))).body.error.code).toBe('API_SCOPE_MISSING');
    });
  });

  describe('webhook payloads respect guest privacy', () => {
    it('endpoints get the guest as first name + last initial unless the owner opts in', async () => {
      const lean = await startReceiver();
      const rich = await startReceiver();
      try {
        const a = (await t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url: lean.url, events: ['reservation.created'] }).expect(201)).body.data;
        const b = (await t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url: rich.url, events: ['reservation.created'], includeGuestDetails: true }).expect(201)).body.data;
        expect([a.includeGuestDetails, b.includeGuestDetails]).toEqual([false, true]);
        await t.http().post('/public/reservations').send(publicBookingBody(s, day(42), day(43), { specialRequests: 'Late arrival, call 9000000000' })).expect(201);
        await t.drain();
        const l = lean.events().find((e) => e.type === 'reservation.created')!;
        const r = rich.events().find((e) => e.type === 'reservation.created')!;
        expect(l.id).toBe(r.id); // one event, two renderings
        expect(l.data.reservation.guest).toEqual({ firstName: 'Emma', lastName: 'C.', email: null, phone: null, redacted: true });
        expect(JSON.stringify(l)).not.toMatch(/emma@example\.com|447700900123|9000000000/);
        expect(r.data.reservation.guest).toMatchObject({ email: 'emma@example.com', phone: '+447700900123', redacted: false });
        // Owners can flip the choice later.
        const flipped = (await t.http().patch(`/webhook-endpoints/${a._id}`).set(bearer(owner.token)).send({ includeGuestDetails: true }).expect(200)).body.data;
        expect(flipped.includeGuestDetails).toBe(true);
      } finally {
        await lean.close();
        await rich.close();
      }
    });
  });

  describe('booking sources stay distinguishable', () => {
    it('dashboard, property site, marketplace and API bookings carry their own source', async () => {
      const k = (await makeKey(ALL)).key;
      const staff = (await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(44), day(45))).expect(201)).body.data.reservationCode as string;
      const site = (await t.http().post('/public/reservations').send(publicBookingBody(s, day(46), day(47))).expect(201)).body.data.reservation.reservationCode as string;
      const api = (await apiBooking(k, {}, day(48), day(49)).expect(201)).body.data.reservation.reservationCode as string;
      const sources = Object.fromEntries((await t.db.selectFrom('reservations').select(['reservationCode', 'source', 'apiKeyId']).where('reservationCode', 'in', [staff, site, api]).execute()).map((r) => [r.reservationCode, r]));
      expect(sources[staff]).toMatchObject({ source: 'PHONE', apiKeyId: null });
      expect(sources[site]).toMatchObject({ source: 'DIRECT', apiKeyId: null });
      expect(sources[api].source).toBe('API');
      expect(sources[api].apiKeyId).toBeTruthy(); // bookings made by software say which key made them
    });
  });
});
