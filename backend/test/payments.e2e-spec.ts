import { bearer, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { mockRazorpay, razorpayWebhook } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

describe('Payments', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;

  const newReservation = async (checkIn = day(30), checkOut = day(32)) =>
    (await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, checkIn, checkOut)).expect(201)).body.data;
  const sendWebhook = (w: ReturnType<typeof razorpayWebhook>, headers: Record<string, string> = {}) =>
    t.http().post('/payments/webhook').set({ ...w.headers, ...headers }).send(w.raw);

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

  it('records a cash payment and updates the reservation balance', async () => {
    const r = await newReservation();
    const res = await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'CASH', amount: 100000, reference: 'RCPT-1' }).expect(201);
    expect(res.body.data.payment).toMatchObject({ provider: 'CASH', status: 'PAID', amount: 100000 });
    expect(res.body.data.checkout).toBeNull();
    const after = (await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token))).body.data;
    expect(after).toMatchObject({ amountPaid: 100000, paymentStatus: 'PARTIALLY_PAID' });
    const over = await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'CASH', amount: r.total });
    expect(over.status).toBe(400);
  });

  it('webhook payment.captured is verified, stored once, and captured exactly once', async () => {
    const r = await newReservation(day(33), day(34));
    const order = (await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'RAZORPAY' }).expect(201)).body.data;
    expect(order.checkout.orderId).toMatch(/^order_/);
    const w = razorpayWebhook('payment.captured', { id: 'pay_WEBHOOK001', order_id: order.checkout.orderId, amount: r.total, currency: 'INR', method: 'upi' }, 'evt_capture_1');

    const [a, b] = await Promise.all([sendWebhook(w), sendWebhook(w)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.duplicate, b.body.data.duplicate].sort()).toEqual([false, true]);
    await t.drain();

    const payments = (await t.http().get('/payments').query({ reservationId: r._id }).set(bearer(owner.token)).expect(200)).body.data;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'PAID', providerPaymentId: 'pay_WEBHOOK001' });
    const after = (await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token))).body.data;
    expect(after).toMatchObject({ amountPaid: r.total, paymentStatus: 'PAID' });

    // A redelivery under a NEW event id is still captured only once (state-based idempotency).
    await sendWebhook(razorpayWebhook('payment.captured', { id: 'pay_WEBHOOK001', order_id: order.checkout.orderId, amount: r.total, currency: 'INR' }, 'evt_capture_2')).expect(200);
    await t.drain();
    expect((await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token))).body.data.amountPaid).toBe(r.total);
  });

  it('rejects webhooks with a bad signature (stored for forensics, never processed)', async () => {
    const w = razorpayWebhook('payment.captured', { id: 'pay_EVIL', order_id: 'order_EVIL', amount: 1 }, 'evt_evil');
    const res = await sendWebhook(w, { 'X-Razorpay-Signature': 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await t.db.selectFrom('webhookEvents').selectAll().where('externalEventId', '=', 'evt_evil').executeTakeFirst()).toBeUndefined(); // cannot squat the id
    const stored = await t.db.selectFrom('webhookEvents').selectAll().where('channel', '=', 'RAZORPAY').where('signatureValid', '=', false).executeTakeFirst();
    expect(stored).toMatchObject({ status: 'IGNORED', signatureValid: false });
  });

  it('payment.failed marks the payment FAILED and tells the guest', async () => {
    const r = await newReservation(day(35), day(36));
    const order = (await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'RAZORPAY' }).expect(201)).body.data;
    await sendWebhook(razorpayWebhook('payment.failed', { id: 'pay_FAILED01', order_id: order.checkout.orderId, amount: r.total, currency: 'INR', error_description: 'Card declined' })).expect(200);
    await t.drain();
    expect((await t.http().get(`/payments/${order.payment._id}`).set(bearer(owner.token))).body.data.status).toBe('FAILED');
    expect(Number((await t.db.selectFrom('notifications').select((eb) => eb.fn.countAll<string>().as('n')).where('type', '=', 'PAYMENT_FAILED').where('recipient', '=', r.guest.email).executeTakeFirstOrThrow()).n)).toBeGreaterThanOrEqual(1);
  });

  it('partial then full refunds through the gateway, never beyond what was paid', async () => {
    const r = await newReservation(day(37), day(38));
    const order = (await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'RAZORPAY' }).expect(201)).body.data;
    await sendWebhook(razorpayWebhook('payment.captured', { id: 'pay_REFUNDME1', order_id: order.checkout.orderId, amount: r.total, currency: 'INR' })).expect(200);
    await t.drain();
    const paymentId = order.payment._id;

    const partial = await t.http().post(`/payments/${paymentId}/refund`).set(bearer(owner.token)).send({ amount: 100000, reason: 'Late check-in' }).expect(201);
    expect(partial.body.data.status).toBe('PENDING');
    await t.drain();
    let p = (await t.http().get(`/payments/${paymentId}`).set(bearer(owner.token))).body.data;
    expect(p).toMatchObject({ status: 'PARTIALLY_REFUNDED', amountRefunded: 100000 });
    expect(p.refunds[0]).toMatchObject({ status: 'PROCESSED', providerRefundId: expect.stringMatching(/^rfnd_/) });
    expect(rzp.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/refund'))[0].body).toMatchObject({ amount: 100000 });

    const tooMuch = await t.http().post(`/payments/${paymentId}/refund`).set(bearer(owner.token)).send({ amount: r.total, reason: 'x' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');

    await t.http().post(`/payments/${paymentId}/refund`).set(bearer(owner.token)).send({ reason: 'Full refund of the rest' }).expect(201);
    await t.drain();
    p = (await t.http().get(`/payments/${paymentId}`).set(bearer(owner.token))).body.data;
    expect(p).toMatchObject({ status: 'REFUNDED', amountRefunded: r.total });
    expect((await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token))).body.data.paymentStatus).toBe('REFUNDED');
  });

  it('cancelling a paid, flexible booking early queues and processes the policy refund', async () => {
    const r = await newReservation(day(40), day(41));
    await t.http().post('/payments/create').set(bearer(owner.token)).send({ reservationId: r._id, provider: 'CASH' }).expect(201);
    const res = await t.http().post(`/reservations/${r._id}/cancel`).set(bearer(owner.token)).send({ reason: 'Plans changed' }).expect(200);
    expect(res.body.data.refunds[0]).toMatchObject({ amount: r.total, status: 'PENDING' });
    await t.drain();
    const after = (await t.http().get(`/reservations/${r._id}`).set(bearer(owner.token))).body.data;
    expect(after).toMatchObject({ status: 'CANCELLED', amountRefunded: r.total, paymentStatus: 'REFUNDED' });
  });

  it('payment responses never contain secrets', async () => {
    const all = await t.db.selectFrom('payments').selectAll().execute();
    expect(JSON.stringify(all)).not.toMatch(/rzp_test_secret_value|rzp_test_webhook_secret/);
  });
});
