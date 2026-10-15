import { ReservationService } from '../src/database/services/reservation.service';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

describe('Public booking engine + availability', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;

  const book = (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}, key?: string) => {
    const req = t.http().post('/public/reservations');
    if (key) req.set('Idempotency-Key', key);
    return req.send({
      propertySlug: s.slug,
      checkIn,
      checkOut,
      adults: 2,
      rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
      guest: { firstName: 'Emma', lastName: 'Clarke', email: 'emma@example.com', phone: '+447700900123' },
      ...extra,
    });
  };

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 2);
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  it('serves the public property page without authentication', async () => {
    const res = await t.http().get(`/public/properties/${s.slug}`).expect(200);
    expect(res.body.data).toMatchObject({ slug: s.slug, currency: 'INR', taxPercent: 5 });
    expect(res.body.data.roomTypes[0]).toMatchObject({ name: 'Deluxe AC', fromPrice: 350000 });
    expect(res.body.data.organizationId).toBeUndefined(); // no internal fields
    expect((await t.http().get('/public/properties/does-not-exist')).status).toBe(404);
  });

  it('availability returns rate, tax, discount and restriction reasons', async () => {
    await t.http().put(`/properties/${s.propertyId}/restrictions`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, from: day(10), to: day(11), minimumStay: 2 }).expect(200);
    await t.http().put(`/properties/${s.propertyId}/restrictions`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, from: day(15), to: day(16), stopSell: true }).expect(200);
    await t.http().put(`/properties/${s.propertyId}/restrictions`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, from: day(20), to: day(21), closedToArrival: true }).expect(200);
    await t
      .http()
      .post(`/properties/${s.propertyId}/promotions`)
      .set(bearer(owner.token))
      .send({ code: 'DIWALI10', name: 'Diwali', type: 'PERCENTAGE', value: 10, validFrom: day(0), validTo: day(40) })
      .expect(201);

    const q = (checkIn: string, checkOut: string, extra: Record<string, string> = {}) =>
      t.http().get(`/public/properties/${s.slug}/availability`).query({ checkIn, checkOut, adults: 2, ...extra });

    const plain = (await q(day(3), day(5)).expect(200)).body.data[0];
    expect(plain).toMatchObject({ bookable: true, availableUnits: 2 });
    expect(plain.ratePlans[0]).toMatchObject({ nightly: 350000, subtotal: 700000, tax: 35000, total: 735000 });

    const promo = (await q(day(3), day(5), { promoCode: 'DIWALI10' }).expect(200)).body.data[0];
    expect(promo.ratePlans[0]).toMatchObject({ discount: 73500, total: 661500 });
    expect((await q(day(3), day(5), { promoCode: 'NOPE99' })).body.error.code).toBe('PROMO_INVALID');

    const minStay = (await q(day(10), day(11)).expect(200)).body.data[0];
    expect(minStay.bookable).toBe(false);
    expect(minStay.reasons.join()).toMatch(/minimum stay is 2/);
    expect((await q(day(10), day(12)).expect(200)).body.data[0].bookable).toBe(true);

    const stop = (await q(day(14), day(16)).expect(200)).body.data[0];
    expect(stop.bookable).toBe(false);
    expect(stop.reasons.join()).toMatch(/closed for sale/);

    expect((await q(day(20), day(22)).expect(200)).body.data[0].reasons.join()).toMatch(/closed to arrival/);
    expect((await q(day(3), day(4), { adults: '4' }).expect(200)).body.data[0].reasons.join()).toMatch(/sleeps at most 3/);
  });

  it('restrictions are enforced on booking, not just displayed', async () => {
    const res = await book(day(10), day(11));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESTRICTION_VIOLATION');
  });

  it('public booking holds inventory as PENDING and returns a Razorpay order; Idempotency-Key replays it', async () => {
    const first = await book(day(3), day(5), { promoCode: 'DIWALI10' }, 'web-checkout-0001').expect(201);
    const { reservation, payment } = first.body.data;
    expect(reservation).toMatchObject({ status: 'PENDING', discount: 73500, total: 661500, paymentStatus: 'UNPAID' });
    expect(payment).toMatchObject({ provider: 'RAZORPAY', keyId: 'rzp_test_TIRVONA', amount: 661500, currency: 'INR' });
    expect(payment.orderId).toMatch(/^order_/);
    expect(rzp.calls.find((c) => c.path === '/v1/orders')!.body).toMatchObject({ amount: 661500, currency: 'INR' });

    const replay = await book(day(3), day(5), { promoCode: 'DIWALI10' }, 'web-checkout-0001').expect(201);
    expect(replay.body.data.created).toBe(false);
    expect(replay.body.data.payment.orderId).toBe(payment.orderId);
    expect(rzp.calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);

    const days = await inventoryFor(t, owner.token, s, day(3), day(5));
    expect(days.map((d) => d.sold)).toEqual([1, 1]);
  });

  it('verified Checkout signature confirms the booking; a forged one is rejected', async () => {
    const { reservation, payment } = (await book(day(6), day(7)).expect(201)).body.data;
    const forged = await t.http().post('/payments/verify').send({ razorpayOrderId: payment.orderId, razorpayPaymentId: 'pay_FAKE12345', razorpaySignature: 'a'.repeat(64) });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');

    const paymentId = 'pay_OK1234567';
    const ok = await t
      .http()
      .post('/payments/verify')
      .send({ razorpayOrderId: payment.orderId, razorpayPaymentId: paymentId, razorpaySignature: checkoutSignature(payment.orderId, paymentId) })
      .expect(200);
    expect(ok.body.data.payment.status).toBe('PAID');
    expect(ok.body.data.reservation).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });

    const lookup = await t.http().get(`/public/reservations/${reservation.reservationCode}`).query({ email: 'emma@example.com' }).expect(200);
    expect(lookup.body.data.status).toBe('CONFIRMED');
    expect((await t.http().get(`/public/reservations/${reservation.reservationCode}`).query({ email: 'other@example.com' })).status).toBe(404);
  });

  it('unpaid holds expire and give the rooms back to every channel', async () => {
    const { reservation } = (await book(day(8), day(9)).expect(201)).body.data;
    expect((await inventoryFor(t, owner.token, s, day(8), day(9)))[0].sold).toBe(1);
    const expired = await t.app.get(ReservationService).expirePendingHolds(new Date(Date.now() + 3600_000));
    expect(expired).toBeGreaterThanOrEqual(1);
    const lookup = await t.http().get(`/public/reservations/${reservation.reservationCode}`).query({ email: 'emma@example.com' }).expect(200);
    expect(lookup.body.data.status).toBe('CANCELLED');
    expect((await inventoryFor(t, owner.token, s, day(8), day(9)))[0].sold).toBe(0);
  });

  it('never lets the client set prices', async () => {
    const res = await book(day(12), day(13), { rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1, nightlyRates: [1] }] });
    expect(res.status).toBe(400); // unknown field rejected by the whitelist
  });
});
