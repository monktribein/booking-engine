import { bearer, createPropertyWithRooms, day, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * The dashboard snapshot must equal what is stored: unpaid holds are shown as held (not as revenue or arrivals), cancelled
 * stays vanish, and "today" is the property's own calendar day.
 */
describe('Dashboard snapshot and revenue report', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;
  let stayId: string;

  const dash = (date?: string, token = owner.token, propertyId = s.propertyId) =>
    t.http().get(`/properties/${propertyId}/reports/dashboard`).query(date ? { date } : {}).set(bearer(token));
  const phone = (checkIn: string, checkOut: string) =>
    t
      .http()
      .post('/reservations')
      .set(bearer(owner.token))
      .send({
        propertyId: s.propertyId,
        source: 'PHONE',
        guest: { firstName: 'Priya', lastName: 'Sharma', email: 'priya@example.com' },
        checkIn,
        checkOut,
        adults: 2,
        rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
      });

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 5);
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  it('is empty and truthful for a property with no bookings', async () => {
    const res = await dash().expect(200);
    expect(res.body.data).toMatchObject({
      date: day(0),
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      totalRooms: 5,
      sellableRooms: 5,
      soldRooms: 0,
      heldRooms: 0,
      availableRooms: 5,
      occupancyPercent: 0,
      arrivals: 0,
      departures: 0,
      arrivalsRevenue: 0,
      alerts: [],
    });
  });

  it('counts confirmed arrivals, shows unpaid holds as held, and ignores cancelled stays in revenue', async () => {
    stayId = (await phone(day(0), day(2)).expect(201)).body.data._id;
    const cancelled = (await phone(day(0), day(1)).expect(201)).body.data._id;
    await t.http().post(`/reservations/${cancelled}/cancel`).set(bearer(owner.token)).send({ reason: 'test' }).expect(200);
    // A public direct booking is an unpaid PENDING hold until the payment is verified.
    const hold = await t
      .http()
      .post('/public/reservations')
      .send({
        propertySlug: s.slug,
        checkIn: day(0),
        checkOut: day(1),
        adults: 2,
        rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
        guest: { firstName: 'Emma', lastName: 'Clarke', email: 'emma@example.com', phone: '+447700900123' },
      });
    expect(hold.status).toBe(201);

    const d = (await dash().expect(200)).body.data;
    expect(d).toMatchObject({
      soldRooms: 2, // the confirmed stay and the unpaid hold both take a room off sale
      heldRooms: 1, // ...but only one of them is an unpaid hold
      availableRooms: 3,
      occupancyPercent: 40,
      arrivals: 1, // the hold is not an arrival and the cancelled stay never was
      arrivalsPending: 1,
      arrivalsRevenue: 700000, // 2 nights x 3,500.00 of the confirmed stay only
    });
    expect(d.alerts.map((a: { code: string }) => a.code)).toContain('UNASSIGNED_ARRIVALS');

    const revenue = (await t.http().get(`/properties/${s.propertyId}/reports/revenue`).query({ from: day(0), to: day(1) }).set(bearer(owner.token)).expect(200)).body.data;
    expect(revenue.totalRevenue).toBe(700000);
    expect(revenue.bySource.reduce((a: number, r: { bookings: number }) => a + r.bookings, 0)).toBe(1);
  });

  it('follows the stay through room assignment, check-in and departure day', async () => {
    const r = (await t.http().get(`/reservations/${stayId}`).set(bearer(owner.token)).expect(200)).body.data;
    await t
      .http()
      .post(`/reservations/${stayId}/assign-room`)
      .set(bearer(owner.token))
      .send({ reservationRoomId: r.reservationRooms[0]._id, roomId: s.roomIds[0] })
      .expect(200);
    await t.http().post(`/reservations/${stayId}/check-in`).set(bearer(owner.token)).send({}).expect(200);

    const today = (await dash().expect(200)).body.data;
    expect(today.arrivals).toBe(1);
    expect(today.arrivalsPending).toBe(0); // checked in
    expect(today.alerts.map((a: { code: string }) => a.code)).not.toContain('UNASSIGNED_ARRIVALS');

    const departure = (await dash(day(2)).expect(200)).body.data;
    expect(departure).toMatchObject({ date: day(2), departures: 1, departuresPending: 1, soldRooms: 0 });
    const middle = (await dash(day(1)).expect(200)).body.data;
    expect(middle.soldRooms).toBe(1); // the second night of the stay
  });

  it('rejects bad dates and keeps other organizations out', async () => {
    expect((await dash('2026-02-30')).status).toBe(400);
    expect((await dash('tomorrow')).status).toBe(400);
    const other = await registerOwner(t, 'other');
    expect([403, 404]).toContain((await dash(undefined, other.token)).status);
    expect((await t.http().get(`/properties/${s.propertyId}/reports/dashboard`)).status).toBe(401);
  });
});
