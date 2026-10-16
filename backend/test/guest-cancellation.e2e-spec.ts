import { bearer, createPropertyWithRooms, day, inventoryFor, publicBookingBody, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { checkoutSignature, mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

/** A guest looks up and cancels their own booking with the booking code and the e-mail they booked with. */
describe('Guest self-service cancellation', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;
  let n = 0;

  const ip = () => `10.20.${Math.floor(++n / 250)}.${n % 250}`; // each call counts against its own rate-limit bucket
  const lookup = (code: string, email = 'emma@example.com') => t.http().get(`/public/reservations/${code}`).set('X-Forwarded-For', ip()).query({ email });
  const cancel = (code: string, email = 'emma@example.com') => t.http().post(`/public/reservations/${code}/cancel`).set('X-Forwarded-For', ip()).send({ email });
  const sold = async (from: string, to: string) => (await inventoryFor(t, owner.token, s, from, to)).map((d) => d.sold);

  /** A paid booking (the sandbox gateway confirms it). */
  async function paidBooking(from: string, to: string) {
    const made = (await t.http().post('/public/reservations').send(publicBookingBody(s, from, to)).expect(201)).body.data;
    const paymentId = `pay_GC${Date.now()}${++n}`.slice(0, 20);
    await t.http().post('/payments/verify').send({ razorpayOrderId: made.payment.orderId, razorpayPaymentId: paymentId, razorpaySignature: checkoutSignature(made.payment.orderId, paymentId) }).expect(200);
    return made.reservation as { reservationCode: string; total: number };
  }

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t, 'guestcancel');
    s = await createPropertyWithRooms(t, owner.token, 3);
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  it('the lookup tells the guest whether they can cancel and what they would get back', async () => {
    const b = await paidBooking(day(20), day(22));
    const view = (await lookup(b.reservationCode).expect(200)).body.data;
    expect(view).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    expect(view.cancellation).toEqual({ allowed: true, reason: null, refundIfCancelledNow: b.total }); // far outside the 48 h window: everything
  });

  it('cancels, queues the policy refund, releases the rooms, and is safe to repeat', async () => {
    const b = await paidBooking(day(24), day(26));
    expect(await sold(day(24), day(26))).toEqual([1, 1]);
    const res = (await cancel(b.reservationCode).expect(200)).body.data;
    expect(res.reservation.status).toBe('CANCELLED');
    expect(res.alreadyCancelled).toBe(false);
    expect(res.refunds).toEqual([{ amount: b.total, currency: 'INR', status: 'PENDING' }]);
    expect(await sold(day(24), day(26))).toEqual([0, 0]);

    const again = (await cancel(b.reservationCode).expect(200)).body.data;
    expect(again.alreadyCancelled).toBe(true);
    expect(again.refunds).toEqual([]);
    const refunds = await t.db.selectFrom('refunds').select('amount').where('reservationId', '=', (await t.db.selectFrom('reservations').select('id').where('reservationCode', '=', b.reservationCode).executeTakeFirstOrThrow()).id).execute();
    expect(refunds).toHaveLength(1); // two requests, one refund
    expect((await lookup(b.reservationCode).expect(200)).body.data.cancellation).toMatchObject({ allowed: false, reason: 'This booking is already cancelled.' });
  });

  it('an unpaid hold can be cancelled too (nothing to refund) and gives the rooms back', async () => {
    const hold = (await t.http().post('/public/reservations').send(publicBookingBody(s, day(30), day(31))).expect(201)).body.data.reservation;
    expect(hold.status).toBe('PENDING');
    expect((await lookup(hold.reservationCode).expect(200)).body.data.cancellation).toMatchObject({ allowed: true, refundIfCancelledNow: 0 });
    const res = (await cancel(hold.reservationCode).expect(200)).body.data;
    expect(res).toMatchObject({ alreadyCancelled: false, refunds: [] });
    expect(await sold(day(30), day(31))).toEqual([0]);
  });

  it('the booking e-mail is required: a wrong or missing e-mail is the same 404 as an unknown code, and nothing is cancelled', async () => {
    const b = await paidBooking(day(34), day(35));
    for (const email of ['someone-else@example.com', 'EMMA@EXAMPLE.COM.evil.test']) {
      expect((await cancel(b.reservationCode, email)).status).toBe(404);
    }
    expect((await t.http().post(`/public/reservations/${b.reservationCode}/cancel`).set('X-Forwarded-For', ip()).send({})).status).toBe(400); // email required
    expect((await cancel('TRV-ZZZZZZZZ')).status).toBe(404);
    expect((await lookup(b.reservationCode).expect(200)).body.data.status).toBe('CONFIRMED');
    expect(await sold(day(34), day(35))).toEqual([1]);
    expect((await cancel(b.reservationCode.toLowerCase())).status).toBe(200); // the code itself is case-insensitive for the guest
  });

  it('bookings that were not made on the public site cannot be cancelled here', async () => {
    const staff = (await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(40), day(41), { guest: { firstName: 'Priya', lastName: 'Sharma', email: 'emma@example.com' } })).expect(201)).body.data;
    expect((await lookup(staff.reservationCode).expect(200)).body.data.cancellation).toMatchObject({ allowed: false });
    const res = await cancel(staff.reservationCode);
    expect([res.status, res.body.error.code]).toEqual([409, 'CANCELLATION_NOT_ALLOWED']);
    expect(await sold(day(40), day(41))).toEqual([1]);
  });

  it('a stay that has started or finished cannot be cancelled online', async () => {
    const b = await paidBooking(day(44), day(45));
    await t.db.updateTable('reservations').set({ checkIn: '2020-01-01', checkOut: '2020-01-02', nights: 1 }).where('reservationCode', '=', b.reservationCode).execute();
    expect((await lookup(b.reservationCode).expect(200)).body.data.cancellation).toEqual({ allowed: false, reason: 'The stay has already started. Contact the property.', refundIfCancelledNow: 0 });
    const res = await cancel(b.reservationCode);
    expect([res.status, res.body.error.code]).toEqual([409, 'CANCELLATION_NOT_ALLOWED']);
  });

  it('a checked-in guest cannot cancel online', async () => {
    const b = await paidBooking(day(48), day(49));
    await t.db.updateTable('reservations').set({ status: 'CHECKED_IN' }).where('reservationCode', '=', b.reservationCode).execute();
    expect((await lookup(b.reservationCode).expect(200)).body.data.cancellation.allowed).toBe(false);
    expect((await cancel(b.reservationCode)).status).toBe(409);
  });

  it('cancellation attempts are rate limited per client (the e-mail check cannot be brute-forced)', async () => {
    const b = await paidBooking(day(52), day(53));
    const same = '10.99.99.99';
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await t.http().post(`/public/reservations/${b.reservationCode}/cancel`).set('X-Forwarded-For', same).send({ email: `guess${i}@example.com` })).status);
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  });
});
