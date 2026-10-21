import { percentOf } from '../src/database/common/money';
import { BookingEngineService } from '../src/modules/booking-engine/booking-engine.module';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { mockRazorpay } from './utils/razorpay-mock';
import { createTestApp, TestApp } from './utils/test-app';

const dow = (isoDay: string) => new Date(`${isoDay}T00:00:00Z`).getUTCDay();
const BASE = 350000;

describe('Date-level pricing, occupancy pricing and promotion limits', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let rzp: ReturnType<typeof mockRazorpay>;

  const post = (path: string, body: unknown) => t.http().post(path).set(bearer(owner.token)).send(body as object);
  const rule = (extra: Record<string, unknown>) =>
    post(`/properties/${s.propertyId}/rate-rules`, { roomTypeId: s.roomTypeId, name: 'rule', adjustment: 'FIXED', amount: 500000, ...extra });
  const quote = async (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) => {
    const res = await t.http().get(`/public/properties/${s.slug}/availability`).query({ checkIn, checkOut, adults: 2, ...extra }).expect(200);
    return res.body.data[0].ratePlans[0] as { subtotal: number; tax: number; total: number; discount?: number; nightlyRates: { date: string; amount: number; rate: number; extra: number }[]; extraGuestCharges: number; promoProblem?: string };
  };
  let guestSeq = 0;
  const publicBook = (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}, email = `guest${++guestSeq}-${Date.now()}@example.com`) =>
    t
      .http()
      .post('/public/reservations')
      .send({
        propertySlug: s.slug,
        checkIn,
        checkOut,
        adults: 2,
        rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
        guest: { firstName: 'Asha', lastName: 'Verma', email, phone: '+919811111111' },
        ...extra,
      });

  /**
   * The public endpoint is limited to 10 bookings a minute per address, so the many-booking promotion scenarios call the same
   * service the endpoint calls. Resolves to the outcome instead of throwing, like an HTTP status would.
   */
  const bookDirect = async (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}, email = `direct${++guestSeq}-${Date.now()}@example.com`) => {
    try {
      const out = await t.app.get(BookingEngineService).book(
        {
          propertySlug: s.slug,
          checkIn,
          checkOut,
          adults: 2,
          rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
          guest: { firstName: 'Asha', lastName: 'Verma', email, phone: '+919811111111' },
          ...extra,
        } as never,
        undefined,
        {},
      );
      return { ok: true as const, reservation: out.reservation };
    } catch (err) {
      const e = err as { code?: string; message: string };
      return { ok: false as const, code: e.code, message: e.message };
    }
  };
  /** The staff view of a booking made through the public endpoint (the public view hides the room lines). */
  const staffView = async (code: string) => {
    const list = await t.http().get('/reservations').query({ propertyId: s.propertyId, q: code }).set(bearer(owner.token)).expect(200);
    return list.body.data.items[0];
  };

  beforeAll(async () => {
    t = await createTestApp();
    rzp = mockRazorpay();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 8);
    await t.http().patch(`/room-types/${s.roomTypeId}`).set(bearer(owner.token)).send({ baseOccupancy: 2, extraAdultCharge: 50000, extraChildCharge: 20000 }).expect(200);
  });
  afterAll(async () => {
    rzp.restore();
    await t.close();
  });

  describe('rate rules', () => {
    it('validates the shape and the scope', async () => {
      expect((await rule({ startDate: day(10), endDate: day(10) })).status).toBe(400); // empty range
      expect((await rule({ startDate: day(10), endDate: day(12), adjustment: 'FIXED', amount: undefined })).status).toBe(400);
      expect((await rule({ startDate: day(10), endDate: day(12), adjustment: 'PERCENT', percent: 600, amount: undefined })).status).toBe(400);
      expect((await rule({ startDate: day(10), endDate: day(12), adjustment: 'PERCENT', percent: 10 })).status).toBe(400); // amount AND percent
      expect((await rule({ startDate: day(10), endDate: day(12), ratePlanId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
      expect((await rule({ startDate: day(10), endDate: day(12), daysOfWeek: [7] })).status).toBe(400);
      const other = await registerOwner(t, 'other');
      expect([403, 404]).toContain((await t.http().post(`/properties/${s.propertyId}/rate-rules`).set(bearer(other.token)).send({ roomTypeId: s.roomTypeId, name: 'x', adjustment: 'FIXED', amount: 1, startDate: day(10), endDate: day(12) })).status);
    });

    it('layers a weekend price over a season, shows the winner per date, and refuses ambiguous overlaps', async () => {
      const season = await rule({ name: 'Season +20%', startDate: day(10), endDate: day(40), adjustment: 'PERCENT', percent: 20, amount: undefined }).expect(201);
      const weekend = await rule({ name: 'Weekend', startDate: day(10), endDate: day(40), daysOfWeek: [5, 6], amount: 450000 }).expect(201);
      expect(weekend.body.data.daysOfWeek).toEqual([5, 6]);

      // Same priority, same scope, both every-day, overlapping: a coin toss, so refused.
      const clash = await rule({ name: 'Clash', startDate: day(20), endDate: day(30), adjustment: 'PERCENT', percent: 5, amount: undefined });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('RATE_RULE_CONFLICT');
      // A higher priority is a deliberate override and is allowed.
      const holiday = await rule({ name: 'Holiday', startDate: day(20), endDate: day(22), priority: 10, amount: 700000 }).expect(201);

      const cal = (await t.http().get(`/properties/${s.propertyId}/rate-calendar`).query({ roomTypeId: s.roomTypeId, from: day(8), to: day(24) }).set(bearer(owner.token)).expect(200)).body.data as {
        date: string;
        base: number;
        rate: number;
        ruleName: string | null;
      }[];
      for (const c of cal) {
        const n = Number(c.date.slice(8)) ; // only used for readable failures
        void n;
        const inSeason = c.date >= day(10);
        const holidayNight = c.date >= day(20) && c.date < day(22);
        const expected = holidayNight ? 700000 : !inSeason ? BASE : [5, 6].includes(dow(c.date)) ? 450000 : Math.round(BASE * 1.2);
        expect({ date: c.date, rate: c.rate }).toEqual({ date: c.date, rate: expected });
        expect(c.base).toBe(BASE);
      }
      expect(cal.find((c) => c.date === day(20))?.ruleName).toBe('Holiday');

      // Deactivating frees the slot; the conflicting rule can then be created.
      await t.http().delete(`/rate-rules/${holiday.body.data._id}`).set(bearer(owner.token)).expect(200);
      expect((await rule({ name: 'Clash', startDate: day(20), endDate: day(30), priority: 5, amount: 600000 })).status).toBe(201);
      // Re-activating the season is itself checked against the others.
      const dup = await t.http().patch(`/rate-rules/${season.body.data._id}`).set(bearer(owner.token)).send({ priority: 5 });
      expect(dup.status).toBe(409);
    });
  });

  describe('quote = booking = payment', () => {
    it('the quote, the reservation and the payment order agree, and the booking keeps its price when rates change later', async () => {
      // 3 nights inside the season: mix of weekday/weekend prices, 2 guests (no extras).
      const checkIn = day(12);
      const checkOut = day(15);
      const q = await quote(checkIn, checkOut);
      const nightly = q.nightlyRates.map((n) => n.rate);
      const expectedNights = q.nightlyRates.map((n) => (n.date >= day(20) ? 0 : [5, 6].includes(dow(n.date)) ? 450000 : 420000));
      expect(nightly).toEqual(expectedNights);
      const subtotal = expectedNights.reduce((a, b) => a + b, 0);
      expect(q).toMatchObject({ subtotal, tax: percentOf(subtotal, 5), total: subtotal + percentOf(subtotal, 5), extraGuestCharges: 0 });

      const booked = await publicBook(checkIn, checkOut, { expectedTotal: q.total }).expect(201);
      const { reservation, payment } = booked.body.data;
      expect(reservation).toMatchObject({ subtotal, tax: q.tax, total: q.total, status: 'PENDING' });
      expect(payment.amount).toBe(q.total); // the gateway is asked for exactly what the server priced
      const staff = await staffView(reservation.reservationCode);
      expect(staff.reservationRooms[0].nightlyRates.map((n: { amount: number }) => n.amount)).toEqual(expectedNights);

      // Rates change afterwards: the booking keeps what it was sold at, a new quote is different.
      await t.http().patch(`/room-types/${s.roomTypeId}`).set(bearer(owner.token)).send({ extraAdultCharge: 99000 }).expect(200);
      await post(`/properties/${s.propertyId}/rate-rules`, { roomTypeId: s.roomTypeId, name: 'Later', adjustment: 'FIXED', amount: 999000, startDate: day(12), endDate: day(15), priority: 50 }).expect(201);
      const again = await staffView(reservation.reservationCode);
      expect(again.total).toBe(q.total);
      const q2 = await quote(checkIn, checkOut);
      expect(q2.total).toBeGreaterThan(q.total);
      await t.http().patch(`/room-types/${s.roomTypeId}`).set(bearer(owner.token)).send({ extraAdultCharge: 50000 }).expect(200);
    });

    it('refuses a booking whose quoted total is stale (PRICE_CHANGED) and holds nothing', async () => {
      const before = (await inventoryFor(t, owner.token, s, day(30), day(31)))[0].sold;
      const q = await quote(day(30), day(31));
      const stale = await publicBook(day(30), day(31), { expectedTotal: q.total + 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('PRICE_CHANGED');
      expect(stale.body.error.details).toMatchObject({ expectedTotal: q.total + 1, total: q.total });
      expect((await inventoryFor(t, owner.token, s, day(30), day(31)))[0].sold).toBe(before);
    });
  });

  describe('occupancy pricing', () => {
    it('charges guests above the base occupancy per night, in the quote and in the booking', async () => {
      const [a, b] = [day(50), day(52)]; // two nights outside every rule
      const two = await quote(a, b, { adults: 2 });
      const three = await quote(a, b, { adults: 3 });
      const withChild = await quote(a, b, { adults: 2, children: 1 });
      expect(two).toMatchObject({ subtotal: 2 * BASE, extraGuestCharges: 0 });
      expect(three).toMatchObject({ subtotal: 2 * (BASE + 50000), extraGuestCharges: 100000 });
      expect(withChild).toMatchObject({ subtotal: 2 * (BASE + 20000), extraGuestCharges: 40000 });

      const booked = await publicBook(a, b, { adults: 3, expectedTotal: three.total }).expect(201);
      const line = (await staffView(booked.body.data.reservation.reservationCode)).reservationRooms[0];
      expect(line.nightlyRates[0]).toMatchObject({ rate: BASE, extra: 50000, amount: BASE + 50000 });
      expect(booked.body.data.payment.amount).toBe(three.total);
    });

    it('re-prices extras when the party changes on a confirmed stay, and refuses to while a payment is pending', async () => {
      const create = await post('/reservations', reservationBody(s, day(53), day(55), { adults: 3 })).expect(201);
      const r = create.body.data;
      expect(r.subtotal).toBe(2 * (BASE + 50000));
      const fewer = await t.http().patch(`/reservations/${r._id}`).set(bearer(owner.token)).send({ adults: 2 }).expect(200);
      expect(fewer.body.data).toMatchObject({ subtotal: 2 * BASE, total: 2 * BASE + percentOf(2 * BASE, 5) });
      expect(fewer.body.data.reservationRooms[0].nightlyRates[0]).toMatchObject({ rate: BASE, extra: 0 });
      const more = await t.http().patch(`/reservations/${r._id}`).set(bearer(owner.token)).send({ adults: 2, children: 1 }).expect(200);
      expect(more.body.data.subtotal).toBe(2 * (BASE + 20000));
      // beyond the room's capacity (3) is refused
      expect((await t.http().patch(`/reservations/${r._id}`).set(bearer(owner.token)).send({ adults: 3, children: 1 })).status).toBe(400);

      const pending = await staffView((await publicBook(day(53), day(54), { adults: 2 }).expect(201)).body.data.reservation.reservationCode);
      const refused = await t.http().patch(`/reservations/${pending._id}`).set(bearer(owner.token)).send({ adults: 3 });
      expect(refused.status).toBe(400);
      expect(refused.body.error.message).toMatch(/payment/i);
    });

    it('prices only the NEW nights today when dates are extended; kept nights keep their sold price', async () => {
      const created = (await post('/reservations', reservationBody(s, day(56), day(57))).expect(201)).body.data;
      expect(created.reservationRooms[0].nightlyRates).toHaveLength(1);
      await post(`/properties/${s.propertyId}/rate-rules`, { roomTypeId: s.roomTypeId, name: 'Late', adjustment: 'FIXED', amount: 480000, startDate: day(57), endDate: day(58) }).expect(201);
      const longer = await t.http().patch(`/reservations/${created._id}`).set(bearer(owner.token)).send({ checkOut: day(58) }).expect(200);
      expect(longer.body.data.reservationRooms[0].nightlyRates.map((n: { amount: number }) => n.amount)).toEqual([BASE, 480000]);
      expect(longer.body.data.subtotal).toBe(BASE + 480000);
    });
  });

  describe('promotion limits', () => {
    const promo = (extra: Record<string, unknown>) =>
      post(`/properties/${s.propertyId}/promotions`, { code: `P${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: 'Promo', type: 'PERCENTAGE', value: 10, validFrom: day(0), validTo: day(60), ...extra });

    it('a usage limit holds under concurrent redemptions and gives the use back on cancellation', async () => {
      const p = (await promo({ maxRedemptions: 2 }).expect(201)).body.data;
      const results = await Promise.all(Array.from({ length: 6 }, () => bookDirect(day(44), day(45), { promoCode: p.code })));
      const ok = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      expect({ ok: ok.length, refused: refused.length }).toEqual({ ok: 2, refused: 4 });
      refused.forEach((r) => {
        expect(r.ok === false && r.code).toBe('PROMO_INVALID');
        expect(r.ok === false && r.message).toMatch(/usage limit/i);
      });
      ok.forEach((r) => expect(r.ok && r.reservation.discount).toBeGreaterThan(0));

      const listed = (await t.http().get(`/properties/${s.propertyId}/promotions`).set(bearer(owner.token)).expect(200)).body.data.find((x: { _id: string }) => x._id === p._id);
      expect(listed).toMatchObject({ maxRedemptions: 2, redeemed: 2 });

      // The preview refuses too, with the reason.
      const preview = await t.http().get(`/public/properties/${s.slug}/availability`).query({ checkIn: day(46), checkOut: day(47), adults: 2, promoCode: p.code });
      expect(preview.status).toBe(422);

      // Cancelling a redeemed booking frees one use; the next booking takes it and the one after is refused again.
      const first = ok[0].ok ? ok[0].reservation : undefined;
      const staff = await staffView(first!.reservationCode);
      await t.http().post(`/reservations/${staff._id}/cancel`).set(bearer(owner.token)).send({ reason: 'test' }).expect(200);
      expect((await bookDirect(day(46), day(47), { promoCode: p.code })).ok).toBe(true);
      expect((await bookDirect(day(46), day(47), { promoCode: p.code })).ok).toBe(false);
    });

    it('an expired payment hold gives its use back', async () => {
      const p = (await promo({ maxRedemptions: 1 }).expect(201)).body.data;
      const held = await bookDirect(day(42), day(43), { promoCode: p.code });
      expect(held.ok).toBe(true);
      expect((await bookDirect(day(42), day(43), { promoCode: p.code })).ok).toBe(false); // the unpaid hold still counts
      await t.db.updateTable('reservations').set({ holdExpiresAt: new Date(Date.now() - 60_000) }).where('reservationCode', '=', held.ok ? held.reservation.reservationCode : '').execute();
      const { ReservationService } = await import('../src/database/services/reservation.service');
      expect(await t.app.get(ReservationService).expirePendingHolds()).toBeGreaterThanOrEqual(1);
      expect((await bookDirect(day(42), day(43), { promoCode: p.code })).ok).toBe(true);
    });

    it('a per-guest limit counts the guest, not the booking, and is not shared with other guests', async () => {
      const p = (await promo({ maxPerGuest: 1 }).expect(201)).body.data;
      const email = `repeat-${Date.now()}@example.com`;
      expect((await bookDirect(day(47), day(48), { promoCode: p.code }, email)).ok).toBe(true);
      const second = await bookDirect(day(48), day(49), { promoCode: p.code }, email.toUpperCase());
      expect(second.ok).toBe(false);
      expect(!second.ok && second.message).toMatch(/already used/i);
      expect((await bookDirect(day(48), day(49), { promoCode: p.code }, `someone-else-${Date.now()}@example.com`)).ok).toBe(true);
    });

    it('a minimum booking value is checked against the server price, with a clear reason', async () => {
      const p = (await promo({ minBookingValue: 3_000_000 }).expect(201)).body.data;
      const preview = await quote(day(40), day(41), { promoCode: p.code });
      expect(preview.promoProblem).toMatch(/at least/i);
      expect(preview.discount).toBe(0);
      const refused = await bookDirect(day(40), day(41), { promoCode: p.code });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.code).toBe('PROMO_INVALID');
      // Long enough to clear the minimum: applies.
      const ok = await bookDirect(day(40), day(52), { promoCode: p.code });
      expect(ok).toMatchObject({ ok: true });
      expect(ok.ok && ok.reservation.discount).toBeGreaterThan(0);
    });

    it('rejects unknown, inactive and out-of-window codes, and cannot be combined with a manual discount', async () => {
      expect((await bookDirect(day(41), day(42), { promoCode: 'NOPE1234' })).ok).toBe(false);
      expect(((await bookDirect(day(41), day(42), { promoCode: 'NOPE1234' })) as { message: string }).message).toMatch(/unknown/i);
      const off = (await promo({ active: false }).expect(201)).body.data;
      expect(((await bookDirect(day(41), day(42), { promoCode: off.code })) as { message: string }).message).toMatch(/no longer active/i);
      const later = (await promo({ validFrom: day(58), validTo: day(60) }).expect(201)).body.data;
      expect(((await bookDirect(day(41), day(42), { promoCode: later.code })) as { message: string }).message).toMatch(/not valid for these dates/i);
    });
  });
});
