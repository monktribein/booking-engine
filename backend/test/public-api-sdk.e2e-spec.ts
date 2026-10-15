import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TirvonaClient, TirvonaError, constructWebhookEvent } from '../../sdk/src';
import { bearer, createPropertyWithRooms, day, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * The real SDK against the real API over HTTP: proves the published client, the server's JSON contract and the
 * server's webhook signing agree with each other.
 */
describe('@tirvona/sdk against the running API', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;
  let client: TirvonaClient;
  let baseUrl: string;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let receiver: http.Server;
  let webhookSecret: string;

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay(); // intercepts only calls to api.razorpay.com; local HTTP to the app is untouched
    owner = await registerOwner(t, 'sdk');
    s = await createPropertyWithRooms(t, owner.token, 2);
    baseUrl = await t.app.getUrl();
    const key = (await t.http().post('/api-keys').set(bearer(owner.token)).send({ name: 'SDK test', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] }).expect(201)).body.data.key;
    client = new TirvonaClient({ apiKey: key, baseUrl: baseUrl.replace('[::1]', 'localhost'), maxRetries: 0 });

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    webhookSecret = (await t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url, events: ['*'] }).expect(201)).body.data.secret;
  });
  afterAll(async () => {
    await new Promise<void>((r) => receiver.close(() => r()));
    rzp.restore();
    await t.close();
  });

  it('walks the whole booking journey and verifies the webhooks the server signed', async () => {
    const properties = await client.listProperties();
    expect(properties.map((p) => p.slug)).toEqual([s.slug]);
    expect((await client.getProperty(s.slug)).roomTypes[0]._id).toBe(s.roomTypeId);

    const rooms = await client.searchAvailability(s.slug, { checkIn: day(5), checkOut: day(7), adults: 2 });
    const input = {
      propertySlug: s.slug,
      checkIn: day(5),
      checkOut: day(7),
      adults: 2,
      rooms: [{ roomTypeId: rooms[0].roomTypeId, ratePlanId: rooms[0].ratePlans[0].ratePlanId, quantity: 1 }],
      guest: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+919811111111' },
    };

    const first = await client.createReservation(input, { idempotencyKey: 'sdk-order-0001-abcdef' });
    expect(first).toMatchObject({ created: true, reservation: { status: 'PENDING', source: 'API' } });
    expect(first.payment?.orderId).toBeTruthy();
    const again = await client.createReservation(input, { idempotencyKey: 'sdk-order-0001-abcdef' });
    expect(again.created).toBe(false);
    expect(again.reservation.reservationCode).toBe(first.reservation.reservationCode);

    // the guest pays (the checkout callback), the booking confirms
    await t.http().post('/payments/verify').send({ razorpayOrderId: first.payment!.orderId, razorpayPaymentId: 'pay_SDK000001', razorpaySignature: checkoutSignature(first.payment!.orderId, 'pay_SDK000001') }).expect(200);
    const code = first.reservation.reservationCode;
    expect(await client.getReservation(code)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', amountPaid: first.reservation.total });
    expect((await client.listReservations({ propertySlug: s.slug, status: 'CONFIRMED' })).items.map((r) => r.reservationCode)).toEqual([code]);

    const cancelled = await client.cancelReservation(code, 'SDK test');
    expect(cancelled).toMatchObject({ alreadyCancelled: false, reservation: { status: 'CANCELLED' } });

    // every event the server sent verifies with the SDK, with the endpoint's secret
    await t.drain();
    const events = received.map((r) => constructWebhookEvent(webhookSecret, r.headers['tirvona-signature'] as string, r.body));
    expect(events.map((e) => e.type).sort()).toEqual(['payment.succeeded', 'reservation.cancelled', 'reservation.confirmed', 'reservation.created']);
    expect(events.every((e) => e.apiVersion === 'v1' && e.data.reservation.reservationCode === code)).toBe(true);
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
  });

  it('maps API errors to TirvonaError with status and code', async () => {
    await expect(client.getReservation('TRV-NOPE0000')).rejects.toMatchObject({ name: 'TirvonaError', status: 404, code: 'NOT_FOUND' });
    await expect(client.getProperty('no-such-property')).rejects.toBeInstanceOf(TirvonaError);
    const bad = new TirvonaClient({ apiKey: 'tvk_abcdefgh_' + 'A'.repeat(43), baseUrl: baseUrl.replace('[::1]', 'localhost'), maxRetries: 0 });
    await expect(bad.listProperties()).rejects.toMatchObject({ status: 401, code: 'API_KEY_INVALID' });
  });

  it('reports sold-out as ROOM_NOT_AVAILABLE', async () => {
    const rooms = await client.searchAvailability(s.slug, { checkIn: day(20), checkOut: day(21), adults: 2 });
    const line = { roomTypeId: rooms[0].roomTypeId, ratePlanId: rooms[0].ratePlans[0].ratePlanId, quantity: 2 };
    const base = { propertySlug: s.slug, checkIn: day(20), checkOut: day(21), adults: 2, guest: { firstName: 'A', lastName: 'B', email: 'ab@example.com', phone: '+919811111111' } };
    await client.createReservation({ ...base, rooms: [line] });
    await expect(client.createReservation({ ...base, rooms: [{ ...line, quantity: 1 }] })).rejects.toMatchObject({ status: 409, code: 'ROOM_NOT_AVAILABLE' });
  });
});
