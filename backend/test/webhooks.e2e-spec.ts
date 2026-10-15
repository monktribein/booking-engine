import { randomBytes } from 'node:crypto';
import { MockChannelAdapter, MockChannelStore, MockWebhookBody } from '../src/modules/channels/mock/mock-channel.adapter';
import { connectMock, mapMock } from './utils/channels';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Webhooks: signature, storage, idempotency, async processing', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let mock: MockChannelAdapter;
  let store: MockChannelStore;

  const event = (type: MockWebhookBody['type'], externalReservationId: string, checkIn = day(4), checkOut = day(6), listing = 'MOCK-HOTEL-1', eventId = `evt_${randomBytes(6).toString('hex')}`): MockWebhookBody => ({
    eventId,
    type,
    reservation: {
      externalListingId: listing,
      externalReservationId,
      checkIn,
      checkOut,
      adults: 2,
      guest: { firstName: 'Ota', lastName: 'Guest', email: 'ota.guest@example.com' },
      rooms: [{ externalRoomId: listing === 'MOCK-HOTEL-1' ? 'MOCK-ROOM-DLX' : null, externalRatePlanId: 'MOCK-ROOM-DLX-FLEX', quantity: 1, nightlyRates: Array.from({ length: 2 }, () => 410000) }],
      currency: 'INR',
      paymentCollectedByChannel: true,
    },
  });
  const post = (body: MockWebhookBody, tamper = false) => {
    const w = mock.buildWebhook(body);
    return t
      .http()
      .post('/webhooks/MOCK')
      .set(w.headers)
      .set(tamper ? { 'x-mock-signature': 'e'.repeat(64) } : {})
      .send(w.rawBody.toString());
  };
  const reservationsFor = (externalReservationId: string) => t.db.selectFrom('reservations').selectAll().where('source', '=', 'MOCK').where('externalReservationId', '=', externalReservationId).execute();

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 5);
    mock = t.app.get(MockChannelAdapter);
    store = t.app.get(MockChannelStore);
    await connectMock(t, owner.token, s);
    await mapMock(t, owner.token, s).expect(201);
    await t.drain();
  });
  afterAll(() => t.close());

  it('stores, enqueues and returns fast; the worker creates the reservation, acknowledges it and syncs other listings', async () => {
    const res = await post(event('reservation.created', 'OTA-1001')).expect(200);
    expect(res.body.data).toMatchObject({ received: true, duplicate: false });
    // HTTP returned before processing: the event is stored first.
    const stored = await t.db.selectFrom('webhookEvents').selectAll().where('id', '=', res.body.data.eventId).executeTakeFirst();
    expect(stored).toBeTruthy();

    await t.drain();
    const [r] = await reservationsFor('OTA-1001');
    expect(r).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'CHANNEL_COLLECTED', total: 2 * 410000 + 2 * 20500 });
    expect((await t.db.selectFrom('webhookEvents').selectAll().where('externalEventId', '=', stored!.externalEventId).executeTakeFirstOrThrow()).status).toBe('PROCESSED');
    expect(store.acknowledged.has('OTA-1001')).toBe(true);
    const days = await inventoryFor(t, owner.token, s, day(4), day(6));
    expect(days.map((d) => d.available)).toEqual([4, 4]);
    // The OTHER mapped listing receives the new availability.
    expect(store.availability.get(store.key('MOCK-LISTING-1', null, day(4)))?.available).toBe(4);
  });

  it('the same event delivered twice is processed once', async () => {
    const body = event('reservation.created', 'OTA-1002', day(8), day(10));
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.body.data.duplicate, b.body.data.duplicate].sort()).toEqual([false, true]);
    await t.drain();
    expect(await reservationsFor('OTA-1002')).toHaveLength(1);
  });

  it('the same booking under different event ids still yields one reservation (channel + externalReservationId)', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post(event('reservation.created', 'OTA-1003', day(12), day(14)))));
    expect(results.every((r) => r.status === 200 && r.body.data.duplicate === false)).toBe(true);
    await t.drain();
    expect(await reservationsFor('OTA-1003')).toHaveLength(1);
    const days = await inventoryFor(t, owner.token, s, day(12), day(14));
    expect(days.map((d) => d.sold)).toEqual([1, 1]);
  });

  it('rejects an invalid signature with 401 and never processes it', async () => {
    const res = await post(event('reservation.created', 'OTA-EVIL'), true);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    await t.drain();
    expect(await reservationsFor('OTA-EVIL')).toHaveLength(0);
    expect(Number((await t.db.selectFrom('webhookEvents').select((eb) => eb.fn.countAll<string>().as('n')).where('signatureValid', '=', false).where('status', '=', 'IGNORED').executeTakeFirstOrThrow()).n)).toBe(1);
  });

  it('modification moves the stay; cancellation releases inventory (and repeats are harmless)', async () => {
    await post(event('reservation.created', 'OTA-1004', day(20), day(22))).expect(200);
    await t.drain();
    await post(event('reservation.modified', 'OTA-1004', day(21), day(23))).expect(200);
    await t.drain();
    let [r] = await reservationsFor('OTA-1004');
    expect(r.checkIn.toISOString().slice(0, 10)).toBe(day(21));
    expect((await inventoryFor(t, owner.token, s, day(20), day(23))).map((d) => d.sold)).toEqual([0, 1, 1]);

    await post(event('reservation.cancelled', 'OTA-1004', day(21), day(23))).expect(200);
    await post(event('reservation.cancelled', 'OTA-1004', day(21), day(23))).expect(200);
    await t.drain();
    [r] = await reservationsFor('OTA-1004');
    expect(r.status).toBe('CANCELLED');
    expect((await inventoryFor(t, owner.token, s, day(20), day(23))).map((d) => d.sold)).toEqual([0, 0, 0]);
  });

  it('a booking for an unmapped listing is retried, then parked as FAILED for staff (admin can retry)', async () => {
    const body = event('reservation.created', 'OTA-UNMAPPED', day(25), day(27));
    body.reservation!.externalListingId = 'MOCK-UNKNOWN-LISTING';
    await post(body).expect(200);
    await t.drain();
    const ev = await t.db.selectFrom('webhookEvents').selectAll().where('externalEventId', '=', body.eventId).executeTakeFirst();
    expect(ev).toMatchObject({ status: 'FAILED', attempts: 10 });
    expect(ev!.error).toMatch(/No room mapping/);
    expect(await reservationsFor('OTA-UNMAPPED')).toHaveLength(0);
  });

  it('simulation endpoint drives the mock OTA through the same pipeline', async () => {
    const res = await t
      .http()
      .post(`/properties/${s.propertyId}/channels/MOCK/simulate/reservation`)
      .set(bearer(owner.token))
      .send({ action: 'created', externalReservationId: 'OTA-SIM-1', externalListingId: 'MOCK-LISTING-1', externalRoomId: null, checkIn: day(30), checkOut: day(31) })
      .expect(200);
    expect(res.body.data.duplicate).toBe(false);
    await t.drain();
    expect(await reservationsFor('OTA-SIM-1')).toHaveLength(1);
  });

  it('unknown channels 404; partner channels without a verifier reject webhooks', async () => {
    const unknown = await t.http().post('/webhooks/EXPEDIA').send({});
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('CHANNEL_NOT_SUPPORTED');
    const airbnb = await t.http().post('/webhooks/AIRBNB').send({ any: 'thing' });
    expect(airbnb.status).toBe(401);
  });
});
