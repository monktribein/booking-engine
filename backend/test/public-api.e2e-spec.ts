import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';
import { verifySignature } from '../src/modules/public-api/webhook-signature';
import { d } from '../src/database/sql';

/** A local webhook receiver that records every request and answers with a scripted status. */
async function startReceiver() {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let respond: (attempt: number) => number = () => 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respond(received.length);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/tirvona`,
    received,
    respondWith: (fn: (attempt: number) => number) => (respond = fn),
    reset: () => (received.length = 0),
    close: () => new Promise<void>((r) => server.close(() => r())),
    events: () => received.map((x) => JSON.parse(x.body) as { id: string; type: string; apiVersion: string; data: Record<string, any> }),
  };
}

describe('Public API v1: keys, tenant isolation, idempotency, signed webhooks', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let a: PropertySetup; // organization A
  let a2: PropertySetup; // organization A, second property
  let b: PropertySetup; // organization B
  let rzp: ReturnType<typeof mockRazorpay>;
  let key: string; // full-access key of org A
  let n = 0;

  const auth = (k = key) => ({ Authorization: `Bearer ${k}` });
  const createKey = async (session: Session, body: Record<string, unknown>) =>
    (await t.http().post('/api-keys').set(bearer(session.token)).send(body).expect(201)).body.data as { _id: string; key: string; keyPrefix: string };
  const bookingBody = (s: PropertySetup, checkIn: string, checkOut: string, email = 'guest@example.com') => ({
    propertySlug: s.slug,
    checkIn,
    checkOut,
    adults: 2,
    rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
    guest: { firstName: 'Emma', lastName: 'Clarke', email, phone: '+447700900123' },
  });
  const book = (s: PropertySetup, checkIn: string, checkOut: string, idem = `idem-${Date.now()}-${++n}-abcdef`, k = key) =>
    t.http().post('/v1/reservations').set(auth(k)).set('Idempotency-Key', idem).send(bookingBody(s, checkIn, checkOut));
  const sold = async (owner_: Session, s: PropertySetup, from: string, to: string) => (await inventoryFor(t, owner_.token, s, from, to)).map((d) => d.sold);
  const pay = async (orderId: string, paymentId: string) =>
    t.http().post('/payments/verify').send({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: checkoutSignature(orderId, paymentId) }).expect(200);

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t, 'orga');
    other = await registerOwner(t, 'orgb');
    a = await createPropertyWithRooms(t, owner.token, 3);
    a2 = await createPropertyWithRooms(t, owner.token, 3);
    b = await createPropertyWithRooms(t, other.token, 3);
    key = (await createKey(owner, { name: 'Full access', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] })).key;
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  // ------------------------------------------------------------------ API keys

  describe('API keys', () => {
    it('returns the key once, stores only a hash, and never lists the secret', async () => {
      const created = await createKey(owner, { name: 'Marketplace', scopes: ['availability:read'] });
      expect(created.key).toMatch(/^tvk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(created.keyPrefix).toBe(created.key.slice(0, 13));

      const stored = await t.db.selectFrom('apiKeys').selectAll().where('prefix', '=', created.key.slice(4, 12)).executeTakeFirst();
      expect(JSON.stringify(stored)).not.toContain(created.key); // not even a substring of the secret part
      expect(JSON.stringify(stored)).not.toContain(created.key.slice(13));
      expect(stored!.keyHash).toMatch(/^[a-f0-9]{64}$/);

      const list = (await t.http().get('/api-keys').set(bearer(owner.token)).expect(200)).body.data;
      expect(JSON.stringify(list)).not.toContain(created.key.slice(13));
      expect(JSON.stringify(list)).not.toContain('keyHash');
      expect(list.find((k: { _id: string }) => k._id === created._id).keyPrefix).toBe(created.keyPrefix);
    });

    it('rejects unknown scopes, foreign property ids and past expiry; needs the owner role and a login', async () => {
      const post = (body: Record<string, unknown>, token = owner.token) => t.http().post('/api-keys').set(bearer(token)).send(body);
      expect((await post({ name: 'x1', scopes: ['admin:everything'] })).status).toBe(400);
      expect((await post({ name: 'x2', scopes: ['availability:read'], propertyIds: [b.propertyId] })).status).toBe(400); // org B's property
      expect((await post({ name: 'x3', scopes: ['availability:read'], expiresAt: '2020-01-01T00:00:00Z' })).status).toBe(400);
      expect((await t.http().post('/api-keys').send({ name: 'x4', scopes: ['availability:read'] })).status).toBe(401);
    });

    it('a user session cannot call /v1, and an API key cannot call dashboard routes', async () => {
      expect((await t.http().get('/v1/properties').set(bearer(owner.token))).body.error.code).toBe('API_KEY_INVALID');
      const dash = await t.http().get(`/properties/${a.propertyId}`).set(auth());
      expect(dash.status).toBe(401);
      expect(dash.body.error.code).toBe('TOKEN_INVALID');
    });

    it('requires a key; malformed, unknown and tampered keys are all 401 with the same error', async () => {
      const missing = await t.http().get('/v1/properties');
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('API_KEY_MISSING');
      for (const bad of ['tvk_nope', 'tvk_abcdefgh_' + 'A'.repeat(43), key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')]) {
        const res = await t.http().get('/v1/properties').set(auth(bad));
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('API_KEY_INVALID');
      }
      expect((await t.http().get('/v1/properties').set('X-API-Key', key)).status).toBe(200); // header alternative
    });

    it('enforces scopes', async () => {
      const readOnly = (await createKey(owner, { name: 'Search only', scopes: ['availability:read'] })).key;
      expect((await t.http().get(`/v1/properties/${a.slug}/availability`).query({ checkIn: day(3), checkOut: day(4), adults: 2 }).set(auth(readOnly))).status).toBe(200);
      const denied = await book(a, day(3), day(4), undefined, readOnly);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('API_SCOPE_MISSING');
      expect((await t.http().get('/v1/properties').set(auth(readOnly))).status).toBe(403);
    });

    it('revocation is immediate; expiry is enforced; revoking another organization\'s key is a 404', async () => {
      const k = await createKey(owner, { name: 'Temporary', scopes: ['properties:read'] });
      expect((await t.http().get('/v1/properties').set(auth(k.key))).status).toBe(200);
      expect((await t.http().delete(`/api-keys/${k._id}`).set(bearer(other.token))).status).toBe(404);
      expect((await t.http().get('/v1/properties').set(auth(k.key))).status).toBe(200);
      await t.http().delete(`/api-keys/${k._id}`).set(bearer(owner.token)).expect(200);
      const after = await t.http().get('/v1/properties').set(auth(k.key));
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('API_KEY_REVOKED');

      const e = await createKey(owner, { name: 'Expiring', scopes: ['properties:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await t.db.updateTable('apiKeys').set({ expiresAt: new Date(Date.now() - 1000) }).where('prefix', '=', e.key.slice(4, 12)).execute();
      const expired = await t.http().get('/v1/properties').set(auth(e.key));
      expect(expired.body.error.code).toBe('API_KEY_EXPIRED');
    });
  });

  // ------------------------------------------------------------------ tenant isolation

  describe('tenant isolation', () => {
    it('lists only the organization\'s own properties and hides everyone else\'s as 404', async () => {
      const mine = (await t.http().get('/v1/properties').set(auth()).expect(200)).body.data as { slug: string }[];
      expect(mine.map((p) => p.slug).sort()).toEqual([a.slug, a2.slug].sort());
      expect((await t.http().get(`/v1/properties/${b.slug}`).set(auth())).status).toBe(404);
      expect((await t.http().get(`/v1/properties/${b.slug}/availability`).query({ checkIn: day(3), checkOut: day(4), adults: 2 }).set(auth())).status).toBe(404);
      const res = await book(b, day(3), day(4)); // booking into another tenant's property
      expect(res.status).toBe(404);
      expect(await sold(other, b, day(3), day(4))).toEqual([0]);
    });

    it('another organization cannot read, list or cancel my reservations', async () => {
      const made = (await book(a, day(20), day(22)).expect(201)).body.data.reservation;
      const otherKey = (await createKey(other, { name: 'Org B', scopes: ['properties:read', 'reservations:read', 'reservations:write'] })).key;
      expect((await t.http().get(`/v1/reservations/${made.reservationCode}`).set(auth(otherKey))).status).toBe(404);
      expect((await t.http().post(`/v1/reservations/${made.reservationCode}/cancel`).set(auth(otherKey)).send({})).status).toBe(404);
      const theirs = (await t.http().get('/v1/reservations').set(auth(otherKey)).expect(200)).body.data;
      expect(theirs.total).toBe(0);
      expect((await t.http().get('/v1/reservations').query({ propertySlug: a.slug }).set(auth(otherKey))).status).toBe(404);
      // still confirmed untouched by their attempts
      expect((await t.http().get(`/v1/reservations/${made.reservationCode}`).set(auth()).expect(200)).body.data.status).toBe('PENDING');
    });

    it('a key restricted to one property cannot reach the organization\'s other property', async () => {
      const k = (await createKey(owner, { name: 'Only A', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'], propertyIds: [a.propertyId] })).key;
      const list = (await t.http().get('/v1/properties').set(auth(k)).expect(200)).body.data as { slug: string }[];
      expect(list.map((p) => p.slug)).toEqual([a.slug]);
      expect((await t.http().get(`/v1/properties/${a2.slug}`).set(auth(k))).status).toBe(404);
      expect((await book(a2, day(3), day(4), undefined, k)).status).toBe(404);
      const onA2 = (await book(a2, day(25), day(26)).expect(201)).body.data.reservation.reservationCode; // full key can
      expect((await t.http().get(`/v1/reservations/${onA2}`).set(auth(k))).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ booking, idempotency, cancellation

  describe('reservations', () => {
    it('searches availability, creates a hold with a Razorpay order, and tags the booking as API', async () => {
      const avail = (await t.http().get(`/v1/properties/${a.slug}/availability`).query({ checkIn: day(5), checkOut: day(7), adults: 2 }).set(auth()).expect(200)).body.data;
      expect(avail[0].roomTypeId).toBe(a.roomTypeId);
      expect(avail[0].ratePlans[0].ratePlanId).toBe(a.ratePlanId);

      const res = await book(a, day(5), day(7)).expect(201);
      expect(res.headers['x-tirvona-api-version']).toBe('v1');
      expect(res.headers['ratelimit-limit']).toBeDefined();
      const { reservation, payment, created } = res.body.data;
      expect(created).toBe(true);
      expect(reservation).toMatchObject({ status: 'PENDING', source: 'API', propertySlug: a.slug, checkIn: day(5), checkOut: day(7), nights: 2, currency: 'INR' });
      expect(reservation.holdExpiresAt).toBeTruthy();
      expect(payment.orderId).toBeTruthy();
      expect(payment.amount).toBe(reservation.total);
      expect(await sold(owner, a, day(5), day(7))).toEqual([1, 1]);
    });

    it('requires an Idempotency-Key and validates the body', async () => {
      const noKey = await t.http().post('/v1/reservations').set(auth()).send(bookingBody(a, day(8), day(9)));
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await book(a, day(8), day(9), 'short')).status).toBe(400);
      const bad = await t.http().post('/v1/reservations').set(auth()).set('Idempotency-Key', 'valid-key-12345').send({ ...bookingBody(a, day(8), day(9)), source: 'AIRBNB' });
      expect(bad.status).toBe(400); // `source` is not part of the v1 contract
      expect((await book(a, day(9), day(8))).status).toBeGreaterThanOrEqual(400); // check-out before check-in
    });

    it('a retried request returns the original booking; a different body under the same key is refused; nothing is double-booked', async () => {
      const idem = 'idem-retry-0001-abcdef';
      const first = await book(a, day(10), day(12), idem).expect(201);
      const again = await book(a, day(10), day(12), idem);
      expect(again.status).toBe(200);
      expect(again.body.data.created).toBe(false);
      expect(again.body.data.reservation.reservationCode).toBe(first.body.data.reservation.reservationCode);
      expect(again.body.data.payment.orderId).toBe(first.body.data.payment.orderId);
      expect(await sold(owner, a, day(10), day(12))).toEqual([1, 1]);

      const different = await book(a, day(14), day(16), idem);
      expect(different.status).toBe(422);
      expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await sold(owner, a, day(14), day(16))).toEqual([0, 0]);
    });

    it('idempotency keys are private per API key', async () => {
      const k2 = (await createKey(owner, { name: 'Second client', scopes: ['reservations:write', 'reservations:read'] })).key;
      const idem = 'idem-shared-string-0001';
      const one = await book(a, day(30), day(31), idem, key).expect(201);
      const two = await book(a, day(32), day(33), idem, k2).expect(201); // same string, different key: independent
      expect(two.body.data.created).toBe(true);
      expect(two.body.data.reservation.reservationCode).not.toBe(one.body.data.reservation.reservationCode);
    });

    it('parallel identical requests create exactly one reservation', async () => {
      const idem = 'idem-parallel-0001-abcdef';
      const results = await Promise.all(Array.from({ length: 6 }, () => book(a, day(40), day(42), idem)));
      const bodies = results.filter((r) => [200, 201].includes(r.status));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(new Set(bodies.map((r) => r.body.data.reservation.reservationCode)).size).toBe(1);
      expect(Number((await t.db.selectFrom('reservations').select((eb) => eb.fn.countAll<string>().as('n')).where('checkIn', '=', d(day(40))).where('source', '=', 'API').executeTakeFirstOrThrow()).n)).toBe(1);
      expect(await sold(owner, a, day(40), day(42))).toEqual([1, 1]);
    });

    it('does not oversell: the last rooms go to exactly as many bookings as there are rooms', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => book(a2, day(50), day(51), `idem-last-room-${i}-abcdef`)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ROOM_NOT_AVAILABLE')).toBe(true);
      expect(await sold(owner, a2, day(50), day(51))).toEqual([3]);
    });

    it('retrieves, lists with filters and paginates', async () => {
      const code = (await book(a, day(55), day(56)).expect(201)).body.data.reservation.reservationCode as string;
      const got = (await t.http().get(`/v1/reservations/${code.toLowerCase()}`).set(auth()).expect(200)).body.data;
      expect(got).toMatchObject({ reservationCode: code, guest: { email: 'guest@example.com' } });
      expect((await t.http().get('/v1/reservations/TRV-NOPE0000').set(auth())).status).toBe(404);

      const page = (await t.http().get('/v1/reservations').query({ propertySlug: a.slug, status: 'PENDING', checkInFrom: day(55), checkInTo: day(55) }).set(auth()).expect(200)).body.data;
      expect(page.items.map((r: { reservationCode: string }) => r.reservationCode)).toEqual([code]);
      const two = (await t.http().get('/v1/reservations').query({ limit: 2 }).set(auth()).expect(200)).body.data;
      expect(two.items).toHaveLength(2);
      expect(two.total).toBeGreaterThan(2);
      expect((await t.http().get('/v1/reservations').query({ limit: 1000 }).set(auth())).status).toBe(400);
    });

    it('cancels once, releases the rooms, and is safe to repeat', async () => {
      const made = (await book(a, day(45), day(47)).expect(201)).body.data;
      await pay(made.payment.orderId, 'pay_V1CANCEL001');
      expect((await t.http().get(`/v1/reservations/${made.reservation.reservationCode}`).set(auth()).expect(200)).body.data).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
      expect(await sold(owner, a, day(45), day(47))).toEqual([1, 1]);

      const cancelled = (await t.http().post(`/v1/reservations/${made.reservation.reservationCode}/cancel`).set(auth()).send({ reason: 'Guest changed plans' }).expect(200)).body.data;
      expect(cancelled.reservation.status).toBe('CANCELLED');
      expect(cancelled.alreadyCancelled).toBe(false);
      expect(Array.isArray(cancelled.refunds)).toBe(true);
      expect(await sold(owner, a, day(45), day(47))).toEqual([0, 0]);

      const repeat = (await t.http().post(`/v1/reservations/${made.reservation.reservationCode}/cancel`).set(auth()).send({}).expect(200)).body.data;
      expect(repeat.alreadyCancelled).toBe(true);
      expect(await sold(owner, a, day(45), day(47))).toEqual([0, 0]);
    });
  });

  // ------------------------------------------------------------------ webhooks

  describe('webhooks', () => {
    let rx: Awaited<ReturnType<typeof startReceiver>>;
    let endpoint: { _id: string; secret: string };
    const post = (path: string, body: Record<string, unknown> = {}, session = owner) => t.http().post(path).set(bearer(session.token)).send(body);
    const deliveries = async (id = endpoint._id) => (await t.http().get(`/webhook-endpoints/${id}/deliveries`).set(bearer(owner.token)).expect(200)).body.data.items as { _id: string; eventType: string; status: string; attempts: number; eventId: string }[];

    beforeAll(async () => {
      rx = await startReceiver();
      endpoint = (await post('/webhook-endpoints', { url: rx.url, events: ['*'], description: 'test receiver' }).expect(201)).body.data;
    });
    afterAll(async () => {
      await rx.close();
    });
    beforeEach(() => rx.reset());

    it('returns the signing secret once and stores it encrypted', async () => {
      expect(endpoint.secret).toMatch(/^whsec_/);
      const list = (await t.http().get('/webhook-endpoints').set(bearer(owner.token)).expect(200)).body.data;
      expect(JSON.stringify(list)).not.toContain('whsec_');
      const stored = await t.db.selectFrom('webhookEndpoints').selectAll().where('id', '=', endpoint._id).executeTakeFirst();
      expect(stored!.secretEncrypted).toMatch(/^v1:/);
      expect(JSON.stringify(stored)).not.toContain(endpoint.secret);
    });

    it('delivers a signed ping that the receiver can verify', async () => {
      await post(`/webhook-endpoints/${endpoint._id}/test`).expect(202);
      await t.drain();
      expect(rx.received).toHaveLength(1);
      const [req] = rx.received;
      expect(req.headers['tirvona-event-type']).toBe('ping');
      expect(req.headers['content-type']).toBe('application/json');
      expect(verifySignature(endpoint.secret, req.headers['tirvona-signature'] as string, req.body)).toBe(true);
      expect(rx.events()[0]).toMatchObject({ type: 'ping', apiVersion: 'v1' });
    });

    it('the signature fails for a tampered body, a wrong secret and a stale timestamp', async () => {
      await post(`/webhook-endpoints/${endpoint._id}/test`).expect(202);
      await t.drain();
      const [{ headers, body }] = rx.received;
      const sig = headers['tirvona-signature'] as string;
      expect(verifySignature(endpoint.secret, sig, body.replace('ping', 'pong'))).toBe(false);
      expect(verifySignature('whsec_wrong', sig, body)).toBe(false);
      expect(verifySignature(endpoint.secret, sig, body, { nowMs: Date.now() + 3_600_000 })).toBe(false); // replay an hour later
    });

    it('a booking journey emits created → payment.succeeded → confirmed, each exactly once despite duplicate payment callbacks', async () => {
      const made = (await book(a, day(48), day(50)).expect(201)).body.data;
      // the browser callback is hit three times in parallel
      await Promise.all([1, 2, 3].map(() => pay(made.payment.orderId, 'pay_WH00000001')));
      await t.drain();

      const mine = rx.events().filter((e) => e.data.reservation?.reservationCode === made.reservation.reservationCode);
      const types = mine.map((e) => e.type).sort();
      expect(types).toEqual(['payment.succeeded', 'reservation.confirmed', 'reservation.created']);
      expect(new Set(mine.map((e) => e.id)).size).toBe(3); // distinct ids
      const paid = mine.find((e) => e.type === 'payment.succeeded')!;
      expect(paid.data.payment).toMatchObject({ amount: made.reservation.total, currency: 'INR' });
      expect(mine.find((e) => e.type === 'reservation.confirmed')!.data.reservation).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', source: 'API' });
      // every request really carried a valid signature
      for (const r of rx.received) expect(verifySignature(endpoint.secret, r.headers['tirvona-signature'] as string, r.body)).toBe(true);
      expect(await deliveries()).not.toContainEqual(expect.objectContaining({ status: 'FAILED' }));
    });

    it('a cancellation emits reservation.cancelled', async () => {
      const made = (await book(a, day(51), day(52)).expect(201)).body.data;
      await t.drain();
      rx.reset();
      await t.http().post(`/v1/reservations/${made.reservation.reservationCode}/cancel`).set(auth()).send({}).expect(200);
      await t.drain();
      expect(rx.events().map((e) => e.type)).toEqual(['reservation.cancelled']);
    });

    it('a failed payment emits payment.failed', async () => {
      const made = (await book(a, day(53), day(54)).expect(201)).body.data;
      await t.drain();
      rx.reset();
      const svc = t.app.get((await import('../src/modules/payments/payments.service')).PaymentsService);
      await svc.markFailed(made.payment.orderId, 'Card declined by issuer');
      await t.drain();
      const ev = rx.events().find((e) => e.type === 'payment.failed');
      expect(ev?.data.payment).toMatchObject({ reason: 'Card declined by issuer' });
    });

    it('retries a failing receiver with the SAME event id and body until it succeeds', async () => {
      rx.respondWith((attempt) => (attempt <= 2 ? 500 : 200));
      await post(`/webhook-endpoints/${endpoint._id}/test`).expect(202);
      await t.drain();
      expect(rx.received).toHaveLength(3);
      expect(new Set(rx.received.map((r) => r.headers['tirvona-event-id'])).size).toBe(1);
      expect(new Set(rx.received.map((r) => r.body)).size).toBe(1); // byte-identical
      expect(rx.received.map((r) => r.headers['tirvona-delivery-attempt'])).toEqual(['1', '2', '3']);
      const d = (await deliveries()).find((x) => x.eventId === rx.received[0].headers['tirvona-event-id'])!;
      expect(d).toMatchObject({ status: 'DELIVERED', attempts: 3 });
      rx.respondWith(() => 200);
    });

    it('gives up after the attempt limit, keeps the failure visible, and can be redelivered', async () => {
      rx.respondWith(() => 503);
      await post(`/webhook-endpoints/${endpoint._id}/test`).expect(202);
      await t.drain();
      expect(rx.received).toHaveLength(12);
      const failed = (await deliveries()).find((x) => x.status === 'FAILED')!;
      expect(failed.attempts).toBe(12);

      rx.reset();
      rx.respondWith(() => 200);
      await post(`/webhook-endpoints/${endpoint._id}/deliveries/${failed._id}/redeliver`).expect(202);
      await t.drain();
      expect(rx.received).toHaveLength(1);
      expect(rx.received[0].headers['tirvona-event-id']).toBe(failed.eventId);
      expect((await deliveries()).find((x) => x._id === failed._id)!.status).toBe('DELIVERED');
    });

    it('rotating the secret invalidates the old one', async () => {
      const rotated = (await post(`/webhook-endpoints/${endpoint._id}/rotate-secret`).expect(200)).body.data;
      expect(rotated.secret).not.toBe(endpoint.secret);
      await post(`/webhook-endpoints/${endpoint._id}/test`).expect(202);
      await t.drain();
      const [{ headers, body }] = rx.received;
      expect(verifySignature(rotated.secret, headers['tirvona-signature'] as string, body)).toBe(true);
      expect(verifySignature(endpoint.secret, headers['tirvona-signature'] as string, body)).toBe(false);
      endpoint.secret = rotated.secret;
    });

    it('event type and property filters decide who receives what', async () => {
      const only = (await post('/webhook-endpoints', { url: rx.url, events: ['reservation.cancelled'], propertyIds: [a2.propertyId] }).expect(201)).body.data;
      const mkA2 = (await book(a2, day(57), day(58), 'idem-filter-a2-0001').expect(201)).body.data.reservation.reservationCode;
      const mkA = (await book(a, day(57), day(58), 'idem-filter-a-00001').expect(201)).body.data.reservation.reservationCode;
      await t.drain();
      expect((await deliveries(only._id)).length).toBe(0); // created events are not subscribed
      await t.http().post(`/v1/reservations/${mkA}/cancel`).set(auth()).send({}).expect(200);
      await t.http().post(`/v1/reservations/${mkA2}/cancel`).set(auth()).send({}).expect(200);
      await t.drain();
      const got = await deliveries(only._id);
      expect(got.map((d) => d.eventType)).toEqual(['reservation.cancelled']); // property A2 only
    });

    it('a disabled endpoint receives nothing; another organization never receives my events', async () => {
      await t.http().patch(`/webhook-endpoints/${endpoint._id}`).set(bearer(owner.token)).send({ status: 'DISABLED' }).expect(200);
      const otherRx = await startReceiver();
      try {
        await post('/webhook-endpoints', { url: otherRx.url, events: ['*'] }, other).expect(201);
        await book(a, day(36), day(37), 'idem-disabled-0001').expect(201);
        await t.drain();
        expect(rx.received).toHaveLength(0);
        expect(otherRx.received).toHaveLength(0);
        // and org B cannot see, change or delete org A's endpoint
        expect((await t.http().patch(`/webhook-endpoints/${endpoint._id}`).set(bearer(other.token)).send({ status: 'ACTIVE' })).status).toBe(404);
        expect((await t.http().delete(`/webhook-endpoints/${endpoint._id}`).set(bearer(other.token))).status).toBe(404);
        expect((await t.http().get(`/webhook-endpoints/${endpoint._id}/deliveries`).set(bearer(other.token))).status).toBe(404);
      } finally {
        await otherRx.close();
        await t.http().patch(`/webhook-endpoints/${endpoint._id}`).set(bearer(owner.token)).send({ status: 'ACTIVE' }).expect(200);
      }
    });

    it('validates endpoint registrations', async () => {
      expect((await post('/webhook-endpoints', { url: 'ftp://example.com/x', events: ['*'] })).status).toBe(400);
      expect((await post('/webhook-endpoints', { url: 'https://user:pw@example.com/x', events: ['*'] })).status).toBe(400);
      expect((await post('/webhook-endpoints', { url: 'https://example.com/x', events: ['reservation.exploded'] })).status).toBe(400);
      expect((await post('/webhook-endpoints', { url: 'https://example.com/x', events: [] })).status).toBe(400);
    });
  });
});

describe('Public API v1: rate limiting and the published contract', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ API_KEY_RATE_LIMIT: '4', API_KEY_RATE_TTL_MS: '60000', SWAGGER_ENABLED: 'true' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('limits each key separately and tells the client when to retry', async () => {
    const owner = await registerOwner(t, 'rl');
    const mk = async (name: string) => (await t.http().post('/api-keys').set(bearer(owner.token)).send({ name, scopes: ['properties:read'] }).expect(201)).body.data.key as string;
    const k1 = await mk('limited one');
    const k2 = await mk('limited two');
    const get = (k: string) => t.http().get('/v1/properties').set({ Authorization: `Bearer ${k}` });
    for (let i = 0; i < 4; i++) expect((await get(k1)).status).toBe(200);
    const blocked = await get(k1);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(k2)).status).toBe(200); // another key is unaffected
  });

  it('publishes an OpenAPI document containing only the /v1 contract', async () => {
    const doc = (await t.http().get('/docs/v1/openapi.json').expect(200)).body;
    expect(doc.info).toMatchObject({ title: 'Tirvona Public API', version: 'v1' });
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining(['/v1/properties', '/v1/properties/{slug}', '/v1/properties/{slug}/availability', '/v1/reservations', '/v1/reservations/{code}', '/v1/reservations/{code}/cancel', '/payments/verify']),
    );
    expect(paths.filter((p) => !p.startsWith('/v1/') && p !== '/payments/verify')).toEqual([]);
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['api-key']);
    expect(doc.paths['/v1/reservations'].post.parameters.find((p: { name: string }) => p.name === 'Idempotency-Key').required).toBe(true);
    // every $ref resolves
    const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const r of refs) expect(doc.components.schemas[r]).toBeDefined();
  });
});
