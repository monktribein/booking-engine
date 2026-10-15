import { ReservationService } from '../src/database/services/reservation.service';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay, razorpayWebhook } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * Phase 6: the public booking + Razorpay journey under races, retries and failure.
 * Journey: search -> 20-minute hold (PENDING, inventory reserved) -> Razorpay order -> browser callback and/or webhook
 * -> exactly one confirmed reservation with the right inventory.
 */
describe('Public booking + payment reliability', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;
  let n = 0;

  const book = (checkIn: string, checkOut: string, key?: string, email = 'guest@example.com') => {
    const req = t.http().post('/public/reservations');
    req.set('Idempotency-Key', key ?? `key-${Date.now()}-${++n}-abcdefgh`);
    req.set('X-Forwarded-For', `10.1.${Math.floor(++n / 250)}.${n % 250}`); // distinct client IP: the route's own 10/min throttle is not under test here
    return req.send({
      propertySlug: s.slug,
      checkIn,
      checkOut,
      adults: 2,
      rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
      guest: { firstName: 'Emma', lastName: 'Clarke', email, phone: '+447700900123' },
    });
  };
  const hold = async (checkIn: string, checkOut: string) => {
    const res = await book(checkIn, checkOut).expect(201);
    return res.body.data as { reservation: { reservationCode: string; total: number; status: string }; payment: { orderId: string; amount: number } };
  };
  const verify = (orderId: string, paymentId: string, signature = checkoutSignature(orderId, paymentId)) =>
    t.http().post('/payments/verify').send({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature });
  const webhook = (event: string, entity: Record<string, unknown>, id?: string) => {
    const w = razorpayWebhook(event, entity, id);
    return t.http().post('/payments/webhook').set(w.headers).send(w.raw);
  };
  const lookup = async (code: string, email = 'guest@example.com') => (await t.http().get(`/public/reservations/${code}`).query({ email }).expect(200)).body.data;
  const reservationDoc = (code: string) => t.conn.db!.collection('reservations').findOne({ reservationCode: code });
  const paymentsOf = async (code: string) => {
    const r = await reservationDoc(code);
    return t.conn.db!.collection('payments').find({ reservationId: r!._id }).toArray();
  };
  const sold = async (from: string, to: string) => (await inventoryFor(t, owner.token, s, from, to)).map((d) => d.sold);
  const orders = () => rzp.calls.filter((c) => c.path === '/v1/orders').length;

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 3);
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  it('the hold is PENDING with an expiry about 20 minutes out and the nights are reserved', async () => {
    const { reservation } = await hold(day(3), day(5));
    expect(reservation.status).toBe('PENDING');
    const doc = await reservationDoc(reservation.reservationCode);
    const minutes = (new Date(doc!.holdExpiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(19);
    expect(minutes).toBeLessThanOrEqual(20.1);
    expect(await sold(day(3), day(5))).toEqual([1, 1]);
  });

  it('browser callback + webhook + a repeated callback racing each other confirm and charge ONCE', async () => {
    const { reservation, payment } = await hold(day(6), day(8));
    const paymentId = 'pay_RACE00001';
    const entity = { id: paymentId, order_id: payment.orderId, amount: payment.amount, currency: 'INR', method: 'upi' };

    const results = await Promise.all([
      verify(payment.orderId, paymentId),
      webhook('payment.captured', entity, 'evt_race_1'),
      verify(payment.orderId, paymentId),
      webhook('payment.captured', entity, 'evt_race_2'), // same payment, different event id
      verify(payment.orderId, paymentId),
    ]);
    results.forEach((r) => expect(r.status).toBe(200));
    await t.drain();

    const payments = await paymentsOf(reservation.reservationCode);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'PAID', providerPaymentId: paymentId, amount: reservation.total });
    const doc = await reservationDoc(reservation.reservationCode);
    expect(doc).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', amountPaid: reservation.total, holdExpiresAt: null });
    // one confirmation and one receipt for the guest, no matter how many callbacks arrived
    expect(await t.conn.db!.collection('notifications').countDocuments({ reservationId: doc!._id, type: 'RESERVATION_CONFIRMED' })).toBe(1);
    expect(await t.conn.db!.collection('notifications').countDocuments({ reservationId: doc!._id, type: 'PAYMENT_SUCCESS' })).toBe(1);
    expect(await sold(day(6), day(8))).toEqual([1, 1]); // paying does not sell the room a second time
    expect((await lookup(reservation.reservationCode)).status).toBe('CONFIRMED');
  });

  it('repeating the browser callback many times (sequentially and in parallel) never double-charges', async () => {
    const { reservation, payment } = await hold(day(9), day(10));
    const paymentId = 'pay_REPEAT0001';
    for (let i = 0; i < 3; i++) await verify(payment.orderId, paymentId).expect(200);
    await Promise.all(Array.from({ length: 6 }, () => verify(payment.orderId, paymentId).expect(200)));
    const doc = await reservationDoc(reservation.reservationCode);
    expect(doc!.amountPaid).toBe(reservation.total);
    expect(await paymentsOf(reservation.reservationCode)).toHaveLength(1);
  });

  it('a forged, tampered or replayed signature never confirms anything', async () => {
    const a = await hold(day(11), day(12));
    const b = await hold(day(13), day(14));
    // signature genuinely issued for order A, replayed against order B
    const replay = await verify(b.payment.orderId, 'pay_REPLAY0001', checkoutSignature(a.payment.orderId, 'pay_REPLAY0001'));
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    // right order, tampered payment id
    expect((await verify(a.payment.orderId, 'pay_TAMPERED01', checkoutSignature(a.payment.orderId, 'pay_ORIGINAL01'))).status).toBe(400);
    expect((await lookup(a.reservation.reservationCode)).status).toBe('PENDING');
    expect((await lookup(b.reservation.reservationCode, 'guest@example.com')).status).toBe('PENDING');
  });

  it('cancelled checkout: the hold and the unpaid order stay as they were, then the hold expires and frees the rooms', async () => {
    const { reservation, payment } = await hold(day(15), day(16));
    // (the guest closes the Razorpay window: nothing reaches the server)
    expect((await lookup(reservation.reservationCode)).status).toBe('PENDING');
    expect((await paymentsOf(reservation.reservationCode))[0]).toMatchObject({ status: 'PENDING', providerOrderId: payment.orderId });
    expect(await sold(day(15), day(16))).toEqual([1]);

    await t.app.get(ReservationService).expirePendingHolds(new Date(Date.now() + 3600_000));
    expect((await lookup(reservation.reservationCode)).status).toBe('CANCELLED');
    expect(await sold(day(15), day(16))).toEqual([0]);
  });

  it('failed payment, then a successful retry on the same order, confirms the held booking once', async () => {
    const { reservation, payment } = await hold(day(17), day(18));
    await webhook('payment.failed', { id: 'pay_FAILED0001', order_id: payment.orderId, amount: payment.amount, currency: 'INR', error_description: 'Card declined' }).expect(200);
    await t.drain();
    expect((await paymentsOf(reservation.reservationCode))[0].status).toBe('FAILED');
    expect((await lookup(reservation.reservationCode)).status).toBe('PENDING'); // hold intact: the guest can retry

    await verify(payment.orderId, 'pay_RETRYOK001').expect(200);
    const doc = await reservationDoc(reservation.reservationCode);
    expect(doc).toMatchObject({ status: 'CONFIRMED', amountPaid: reservation.total });
    expect(await paymentsOf(reservation.reservationCode)).toHaveLength(1);
  });

  it('expired hold + late payment: the rooms are NOT re-sold, the booking stays cancelled and the money is refunded', async () => {
    const { reservation, payment } = await hold(day(19), day(20));
    await t.app.get(ReservationService).expirePendingHolds(new Date(Date.now() + 3600_000));
    expect(await sold(day(19), day(20))).toEqual([0]);

    await verify(payment.orderId, 'pay_LATE000001').expect(200); // Razorpay did capture it; the browser callback arrives late
    await t.drain();

    const doc = await reservationDoc(reservation.reservationCode);
    expect(doc!.status).toBe('CANCELLED'); // not resurrected
    expect(await sold(day(19), day(20))).toEqual([0]); // inventory untouched: no phantom sale
    const [p] = await paymentsOf(reservation.reservationCode);
    expect(p).toMatchObject({ status: 'REFUNDED', amountRefunded: reservation.total });
    expect(rzp.calls.some((c) => c.method === 'POST' && c.path.endsWith('/refund') && (c.body as { amount?: number })?.amount === reservation.total)).toBe(true);
  });

  it('paying a booking whose nights were taken by someone else still cannot oversell', async () => {
    const one = await createPropertyWithRooms(t, owner.token, 1); // a single room
    const mk = (key: string) =>
      t.http().post('/public/reservations').set('Idempotency-Key', key).set('X-Forwarded-For', `10.2.0.${++n % 250}`).send({
        propertySlug: one.slug,
        checkIn: day(21),
        checkOut: day(22),
        adults: 2,
        rooms: [{ roomTypeId: one.roomTypeId, ratePlanId: one.ratePlanId, quantity: 1 }],
        guest: { firstName: 'A', lastName: 'B', email: 'ab@example.com', phone: '+447700900123' },
      });
    const before = orders();
    const [x, y, z] = await Promise.all([mk('conflict-key-0001'), mk('conflict-key-0002'), mk('conflict-key-0003')]);
    const statuses = [x.status, y.status, z.status].sort();
    expect(statuses).toEqual([201, 409, 409]);
    [x, y, z].filter((r) => r.status === 409).forEach((r) => expect(r.body.error.code).toBe('ROOM_NOT_AVAILABLE'));
    expect(orders() - before).toBe(1); // a Razorpay order only for the booking that holds the room
    const days = await inventoryFor(t, owner.token, one, day(21), day(22));
    expect(days[0]).toMatchObject({ total: 1, sold: 1, available: 0 });
  });

  it('the same Idempotency-Key sent concurrently creates one reservation and one order', async () => {
    const before = orders();
    const key = 'same-key-concurrent-1';
    const res = await Promise.all(Array.from({ length: 5 }, () => book(day(23), day(24), key)));
    res.forEach((r) => expect([200, 201]).toContain(r.status));
    const codes = new Set(res.map((r) => r.body.data.reservation.reservationCode));
    expect(codes.size).toBe(1);
    expect(res.filter((r) => r.body.data.created === true)).toHaveLength(1);
    expect(new Set(res.map((r) => r.body.data.payment.orderId)).size).toBe(1);
    expect(orders() - before).toBe(1);
    expect(await sold(day(23), day(24))).toEqual([1]);
  });

  it('a confirmed booking is never touched by hold expiry', async () => {
    const { reservation, payment } = await hold(day(25), day(26));
    await verify(payment.orderId, 'pay_KEEP000001').expect(200);
    await t.app.get(ReservationService).expirePendingHolds(new Date(Date.now() + 24 * 3600_000));
    expect((await lookup(reservation.reservationCode)).status).toBe('CONFIRMED');
    expect(await sold(day(25), day(26))).toEqual([1]);
  });

  it('refund rules: an unpaid order cannot be refunded; a paid one refunds at most what was paid, via the gateway', async () => {
    const { reservation, payment } = await hold(day(27), day(28));
    const [unpaid] = await paymentsOf(reservation.reservationCode);
    const early = await t.http().post(`/payments/${unpaid._id}/refund`).set(bearer(owner.token)).send({ reason: 'x' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');

    await verify(payment.orderId, 'pay_REFUND0001').expect(200);
    const over = await t.http().post(`/payments/${unpaid._id}/refund`).set(bearer(owner.token)).send({ amount: reservation.total + 1, reason: 'too much' });
    expect(over.status).toBe(422);
    const callsBefore = rzp.calls.filter((c) => c.path.endsWith('/refund')).length;
    await t.http().post(`/payments/${unpaid._id}/refund`).set(bearer(owner.token)).send({ reason: 'goodwill' }).expect(201);
    await t.drain();
    expect(rzp.calls.filter((c) => c.path.endsWith('/refund')).length).toBe(callsBefore + 1); // mocked gateway: no real money moves
    expect((await paymentsOf(reservation.reservationCode))[0]).toMatchObject({ status: 'REFUNDED', amountRefunded: reservation.total });
  });
});
