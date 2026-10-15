import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Reservations API', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;

  const create = (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    t.http().post('/reservations').set(bearer(owner.token)).set(headers).send(reservationBody(s, checkIn, checkOut, extra));

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 3);
  });
  afterAll(() => t.close());

  it('creates a reservation with frozen nightly rates, tax and totals', async () => {
    const res = await create(day(5), day(7)).expect(201);
    const r = res.body.data;
    expect(r).toMatchObject({ status: 'CONFIRMED', source: 'PHONE', nights: 2, currency: 'INR', subtotal: 700000, tax: 35000, total: 735000 });
    expect(r.reservationRooms[0].nightlyRates).toHaveLength(2);
    expect(r.reservationRooms[0].ratePlan.code).toBe('STD');
    expect(r.reservationRooms[0].roomId).toBeNull(); // physical room assigned later

    // Later price change does not touch existing bookings.
    await t.http().patch(`/rate-plans/${s.ratePlanId}`).set(bearer(owner.token)).send({ basePrice: 999900 }).expect(200);
    const again = await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token)).expect(200);
    expect(again.body.data.total).toBe(735000);
    await t.http().patch(`/rate-plans/${s.ratePlanId}`).set(bearer(owner.token)).send({ basePrice: 350000 }).expect(200);
  });

  it('validates dates and payloads', async () => {
    expect((await create(day(7), day(5))).body.error.code).toBe('VALIDATION_ERROR');
    expect((await create('2026-02-30', day(5))).status).toBe(400);
    expect((await create(day(-3), day(-1))).body.error.code).toBe('VALIDATION_ERROR'); // past
    expect((await create(day(5), day(6), { source: 'AIRBNB' })).status).toBe(400); // OTA sources only via channels
  });

  it('Idempotency-Key makes retries safe', async () => {
    const key = 'retry-key-0001';
    const a = await create(day(9), day(10), {}, { 'Idempotency-Key': key }).expect(201);
    const b = await create(day(9), day(10), {}, { 'Idempotency-Key': key }).expect(201);
    expect(b.body.data._id).toBe(a.body.data._id);
    const [night] = await inventoryFor(t, owner.token, s, day(9), day(10));
    expect(night.sold).toBe(1);
  });

  it('lists and searches reservations of the property', async () => {
    const list = await t.http().get('/reservations').query({ propertyId: s.propertyId, from: day(0), to: day(30) }).set(bearer(owner.token)).expect(200);
    expect(list.body.data.total).toBeGreaterThanOrEqual(2);
    const code = list.body.data.items[0].reservationCode;
    const found = await t.http().get('/reservations').query({ propertyId: s.propertyId, q: code }).set(bearer(owner.token)).expect(200);
    expect(found.body.data.items).toHaveLength(1);
  });

  it('PATCH with new dates moves inventory atomically and re-prices', async () => {
    const r = (await create(day(12), day(14)).expect(201)).body.data;
    const res = await t.http().patch(`/reservations/${r._id}`).set(bearer(owner.token)).send({ checkIn: day(13), checkOut: day(16) }).expect(200);
    expect(res.body.data.nights).toBe(3);
    expect(res.body.data.total).toBe(3 * 350000 + 3 * 17500);
    const days = await inventoryFor(t, owner.token, s, day(12), day(16));
    expect(days.map((d) => d.sold)).toEqual([0, 1, 1, 1]);
  });

  it('PATCH to dates that are sold out fails and leaves the original stay intact', async () => {
    for (let i = 0; i < 3; i++) await create(day(20), day(21)).expect(201); // day 20 full
    const r = (await create(day(18), day(19)).expect(201)).body.data;
    const res = await t.http().patch(`/reservations/${r._id}`).set(bearer(owner.token)).send({ checkIn: day(19), checkOut: day(21) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROOM_NOT_AVAILABLE');
    const days = await inventoryFor(t, owner.token, s, day(18), day(21));
    expect(days.map((d) => d.sold)).toEqual([1, 0, 3]);
  });

  it('cancel releases inventory, is idempotent, and cannot be repeated into a double release', async () => {
    const r = (await create(day(25), day(27)).expect(201)).body.data;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => t.http().post(`/reservations/${r._id}/cancel`).set(bearer(owner.token)).send({ reason: 'Guest request' })),
    );
    expect(results.every((x) => x.status === 200)).toBe(true);
    expect(results.filter((x) => x.body.data.alreadyCancelled === false)).toHaveLength(1);
    const days = await inventoryFor(t, owner.token, s, day(25), day(27));
    expect(days.map((d) => [d.sold, d.available])).toEqual([
      [0, 3],
      [0, 3],
    ]);
  });

  it('check-in requires an assigned, clean room; check-out frees it for cleaning', async () => {
    const r = (await create(day(0), day(2)).expect(201)).body.data;
    const noRoom = await t.http().post(`/reservations/${r._id}/check-in`).set(bearer(owner.token)).send({});
    expect(noRoom.status).toBe(400);

    const checkedIn = await t
      .http()
      .post(`/reservations/${r._id}/check-in`)
      .set(bearer(owner.token))
      .send({ assignments: [{ reservationRoomId: r.reservationRooms[0]._id, roomId: s.roomIds[0] }] })
      .expect(200);
    expect(checkedIn.body.data.status).toBe('CHECKED_IN');
    expect(checkedIn.body.data.reservationRooms[0].roomNumber).toBe('101');
    expect((await t.http().get(`/rooms/${s.roomIds[0]}`).set(bearer(owner.token))).body.data.status).toBe('OCCUPIED');

    // Another stay cannot take room 101 for overlapping nights.
    const other = (await create(day(1), day(2)).expect(201)).body.data;
    const clash = await t.http().post(`/reservations/${other._id}/assign-room`).set(bearer(owner.token)).send({ reservationRoomId: other.reservationRooms[0]._id, roomId: s.roomIds[0] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('ROOM_ASSIGNMENT_CONFLICT');

    const out = await t.http().post(`/reservations/${r._id}/check-out`).set(bearer(owner.token)).expect(200);
    expect(out.body.data.reservation.status).toBe('CHECKED_OUT');
    expect(out.body.data.balanceDue).toBe(r.total);
    expect((await t.http().get(`/rooms/${s.roomIds[0]}`).set(bearer(owner.token))).body.data.status).toBe('CLEANING');
    // Early departure (booked until day 2): tonight is released for resale.
    const [tonight] = await inventoryFor(t, owner.token, s, day(0), day(1));
    expect(tonight.sold).toBe(0);
  });

  it('no-show is only possible from the arrival date and releases remaining nights', async () => {
    const future = (await create(day(3), day(4)).expect(201)).body.data;
    expect((await t.http().post(`/reservations/${future._id}/no-show`).set(bearer(owner.token))).status).toBe(400);

    const today = (await create(day(0), day(3)).expect(201)).body.data;
    const before = await inventoryFor(t, owner.token, s, day(0), day(3));
    const res = await t.http().post(`/reservations/${today._id}/no-show`).set(bearer(owner.token)).expect(200);
    expect(res.body.data.status).toBe('NO_SHOW');
    const after = await inventoryFor(t, owner.token, s, day(0), day(3));
    expect(after.map((d, i) => before[i].sold - d.sold)).toEqual([1, 1, 1]);
    // A no-show cannot be checked in or cancelled.
    expect((await t.http().post(`/reservations/${today._id}/check-in`).set(bearer(owner.token)).send({})).body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('every reservation change is audited', async () => {
    const logs = (await t.db.selectFrom('auditLogs').select('action').distinct().where('propertyId', 'is not', null).execute()).map((r) => r.action);
    expect(logs).toEqual(
      expect.arrayContaining(['reservation.create', 'reservation.cancel', 'reservation.modify_dates', 'reservation.check_in', 'reservation.check_out', 'reservation.no_show']),
    );
  });
});
