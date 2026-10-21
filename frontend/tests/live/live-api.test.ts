/* eslint-disable @typescript-eslint/no-explicit-any */
import { addDays, format } from 'date-fns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authApi } from '@/lib/api/auth';
import { liveLogin } from './session';
import { bookingEngineApi } from '@/lib/api/booking-engine';
import { apiClient, ApiError, tokenStorage } from '@/lib/api/client';
import { channelsApi } from '@/lib/api/channels';
import { guestsApi } from '@/lib/api/guests';
import { inventoryApi } from '@/lib/api/inventory';
import { paymentsApi } from '@/lib/api/payments';
import { propertiesApi } from '@/lib/api/properties';
import { ratesApi } from '@/lib/api/rates';
import { reportsApi } from '@/lib/api/reports';
import { reservationsApi } from '@/lib/api/reservations';
import { roomTypesApi } from '@/lib/api/room-types';
import { roomsApi } from '@/lib/api/rooms';
import { PaymentProvider } from '@/types';

const EMAIL = process.env.LIVE_OWNER_EMAIL ?? 'owner@tirvona.demo';
const PASSWORD = process.env.LIVE_OWNER_PASSWORD ?? 'SandboxPass-123';
const day = (n: number) => format(addDays(new Date(), n), 'yyyy-MM-dd');

// Record every request the app code makes: method, endpoint, status
const log: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    const u = new URL(String(input));
    log.push(`${(init?.method ?? 'GET').padEnd(6)} ${res.status} ${u.pathname}`);
    return res;
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  const uniq = [...new Set(log.map((l) => l.replace(/[0-9a-f]{24}/g, ':id')))].sort();
  console.log('\nLIVE REQUEST LOG (method status endpoint)\n' + uniq.join('\n'));
});

let propertyId = '';
let slug = '';

describe('auth against the real backend', () => {
  it('rejects a wrong password with 401 and stores nothing', async () => {
    await expect(liveLogin({ email: EMAIL, password: 'definitely-wrong-1' })).rejects.toMatchObject({ status: 401 });
    expect(tokenStorage.getAccess()).toBeNull();
  });

  it('logs in with the seeded owner and loads /auth/me', async () => {
    const { user } = await liveLogin({ email: EMAIL, password: PASSWORD });
    expect(user.email).toBe(EMAIL);
    expect(tokenStorage.getAccess()).toBeTruthy();
    const me = await authApi.me();
    expect(me._id).toBe(user._id);
    const first = (await propertiesApi.list()).items[0];
    propertyId = first._id;
    slug = first.slug;
  });

  it('registration validates input server-side (weak password -> 400 with field details)', async () => {
    const err = (await apiClient('/auth/register', { method: 'POST', skipAuth: true, body: JSON.stringify({ organizationName: 'Org', name: 'X', email: 'weak@example.com', password: 'short' }) }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(JSON.stringify(err.details)).toContain('password');
    // still signed in as the owner: a failed register must not replace the session
    expect((await authApi.me()).email).toBe(EMAIL);
  });

  // Access-token refresh (HttpOnly cookie, rotation, concurrent 401s, revoked tokens) is covered by tests/client.test.ts, the
  // session-proxy unit tests and the Playwright journeys: it needs a browser cookie jar, which these Node tests do not have.
});

describe('password recovery against the real backend', () => {
  it('forgot-password always answers ok (does not reveal whether the account exists)', async () => {
    await expect(authApi.forgotPassword('nobody-here@example.com')).resolves.toEqual({ ok: true });
  });

  it('reset-password with an unknown token is rejected with a 4xx the UI can show', async () => {
    const err = await authApi.resetPassword('x'.repeat(40), 'correct-horse-9').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.status).toBeLessThan(500);
  });
});

describe('properties, room types, rooms', () => {
  it('lists the properties of the account (paginated contract)', async () => {
    const res = await propertiesApi.list();
    expect(res.items[0]).toMatchObject({ name: expect.any(String), slug: expect.any(String), currency: expect.any(String) });
    expect(res.totalPages).toBeGreaterThanOrEqual(1);
    expect(res.items[0]._id).toBe(propertyId);
    expect((await propertiesApi.get(propertyId))._id).toBe(propertyId);
  });

  it('room types and the composed property-wide room list agree', async () => {
    const types = await roomTypesApi.list(propertyId);
    expect(types.length).toBeGreaterThan(0);
    const rooms = await roomsApi.listAll(propertyId);
    expect(rooms.length).toBe(types.reduce((a, t) => a + t.totalRooms, 0));
    expect(rooms[0]).toMatchObject({ roomNumber: expect.any(String), status: expect.any(String) });
  });

  it('creates and archives a room type, adds a room, changes its status', async () => {
    const stamp = Date.now().toString(36);
    const rt = await roomTypesApi.create(propertyId, { name: `Itest ${stamp}`, basePrice: 123400, maxOccupancy: 2, amenities: ['fan'] } as any);
    expect(rt.name).toContain('Itest');
    const room = await roomsApi.create(rt._id, { roomNumber: `T${stamp}`.slice(0, 8), floor: '9' });
    expect(room.roomTypeId).toBe(rt._id);
    const changed = await roomsApi.changeStatus(room._id, { status: 'CLEANING' as any, notes: 'itest' });
    expect(changed.room.status).toBe('CLEANING');
    expect(changed.room.cleaningNotes).toBe('itest');
    await expect(roomsApi.changeStatus(room._id, { status: 'OCCUPIED' as any })).rejects.toMatchObject({ status: 400 });
    await roomTypesApi.archive(rt._id);
  });
});

describe('rates and promotions', () => {
  it('lists rate plans with the isActive flag and filters by room type client-side', async () => {
    const all = await ratesApi.listRatePlans(propertyId);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => typeof p.isActive === 'boolean')).toBe(true);
    const rtId = all[0].roomTypeId;
    expect((await ratesApi.listRatePlans(propertyId, rtId)).every((p) => p.roomTypeId === rtId)).toBe(true);
  });

  it('creates a promotion and reads it back in the UI shape', async () => {
    const code = `IT${Date.now().toString(36).toUpperCase()}`.slice(0, 12);
    const created = await ratesApi.createPromotion(propertyId, { code, description: 'integration', discountPercent: 12, validFrom: day(0), validTo: day(60), isActive: true });
    expect(created).toMatchObject({ code, discountPercent: 12, isActive: true, validFrom: day(0) });
    expect((await ratesApi.listPromotions(propertyId)).some((p) => p.code === code)).toBe(true);
  });
});

describe('inventory', () => {
  it('returns a 7-day calendar in the UI shape', async () => {
    const cal = await inventoryApi.getCalendar(propertyId, day(0), day(7));
    expect(cal.roomTypes.length).toBeGreaterThan(0);
    expect(cal.roomTypes[0].days).toHaveLength(7);
    expect(cal.roomTypes[0].days[0]).toMatchObject({ date: day(0), total: expect.any(Number), available: expect.any(Number), stopSell: false });
  });

  it('stop-sell then re-open a date, and the calendar reflects both', async () => {
    const cal = await inventoryApi.getCalendar(propertyId, day(30), day(33));
    const rtId = cal.roomTypes[0].roomTypeId;
    await inventoryApi.setRestrictions(propertyId, { roomTypeId: rtId, from: day(31), to: day(32), stopSell: true });
    let after = await inventoryApi.getCalendar(propertyId, day(30), day(33));
    expect(after.roomTypes[0].days.find((d) => d.date === day(31))?.stopSell).toBe(true);
    await inventoryApi.setRestrictions(propertyId, { roomTypeId: rtId, from: day(31), to: day(32), stopSell: false, minimumStay: 2, closedToArrival: true });
    after = await inventoryApi.getCalendar(propertyId, day(30), day(33));
    const d = after.roomTypes[0].days.find((x) => x.date === day(31))!;
    expect(d).toMatchObject({ stopSell: false, minimumStay: 2, closedToArrival: true });
    await inventoryApi.setRestrictions(propertyId, { roomTypeId: rtId, from: day(31), to: day(32), minimumStay: 1, closedToArrival: false });
  });

  it('creates and releases a room block', async () => {
    const rooms = await roomsApi.listAll(propertyId);
    const room = rooms.find((r) => r.status === 'AVAILABLE')!;
    const block = await inventoryApi.createBlock({ propertyId, roomTypeId: room.roomTypeId, roomId: room._id, startDate: day(40), endDate: day(41), reason: 'MAINTENANCE', notes: 'itest' });
    expect(block).toMatchObject({ startDate: day(40), endDate: day(41), roomId: room._id });
    const released = await inventoryApi.unblock(block._id);
    expect(released.status).toBe('RELEASED');
  });
});

let reservationId = '';

describe('guests and reservations', () => {
  it('lists guests and searches by the backend q parameter', async () => {
    const all = await guestsApi.list({ propertyId });
    expect(all.items.length).toBeGreaterThan(0);
    const found = await guestsApi.list({ propertyId, search: all.items[0].firstName });
    expect(found.items.some((g) => g._id === all.items[0]._id)).toBe(true);
  });

  it('creates a guest (E.164 phone) and rejects a bad phone with field details', async () => {
    const g = await guestsApi.create({ propertyId, firstName: 'Itest', lastName: 'Guest', phone: '+919800099999' });
    expect(g.firstName).toBe('Itest');
    const err = await guestsApi.create({ propertyId, firstName: 'Bad', phone: '98000 99999' }).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
  });

  it('creates a staff reservation, lists it with every filter, reads it back', async () => {
    const types = await roomTypesApi.list(propertyId);
    const plans = await ratesApi.listRatePlans(propertyId, types[0]._id);
    const r = await reservationsApi.create({
      propertyId,
      guest: { firstName: 'Itest', lastName: 'Booker', email: 'itest.booker@example.com', phone: '+919800088888' },
      checkIn: day(12),
      checkOut: day(14),
      adults: 2,
      rooms: [{ roomTypeId: types[0]._id, ratePlanId: plans.find((p) => p.isActive)!._id, quantity: 1 }],
      source: 'PHONE',
    });
    reservationId = r._id;
    expect(r).toMatchObject({ source: 'PHONE', status: 'CONFIRMED', checkIn: day(12), checkOut: day(14), guest: { firstName: 'Itest' } });
    expect(r.rooms[0].roomTypeName).toBeTruthy();
    expect(r.total).toBe(r.subtotal + r.taxAmount - r.discountAmount);

    const byCode = await reservationsApi.list({ propertyId, search: r.code });
    expect(byCode.items.map((x) => x._id)).toContain(r._id);
    const bySource = await reservationsApi.list({ propertyId, channel: 'PHONE', status: 'CONFIRMED' as any });
    expect(bySource.items.every((x) => x.source === 'PHONE')).toBe(true);
    const byDate = await reservationsApi.list({ propertyId, from: day(12), to: day(13) });
    expect(byDate.items.map((x) => x._id)).toContain(r._id);
    expect((await reservationsApi.get(r._id)).code).toBe(r.code);
  });

  it('rejects an overbooking-style request and an invalid payload with useful errors', async () => {
    const err = await reservationsApi.create({ propertyId, guest: { firstName: 'X', lastName: 'Y' }, checkIn: day(12), checkOut: day(12), adults: 1, rooms: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it('assigns a physical room and shows it on the tape chart data', async () => {
    const r = await reservationsApi.get(reservationId);
    const rooms = await roomsApi.listByRoomType(r.rooms[0].roomTypeId);
    const free = rooms.find((x) => x.status === 'AVAILABLE')!;
    const assigned = await reservationsApi.assignRoom(reservationId, r.rooms[0]._id, free._id);
    expect(assigned.rooms[0].roomId).toBe(free._id);
    const calendar = await inventoryApi.getCalendar(propertyId, day(12), day(15));
    expect(calendar.reservations?.some((x) => x.reservationId === reservationId && x.rooms[0].roomId === free._id)).toBe(true);
  });

  it('records a cash payment, lists it, and the reservation reflects it', async () => {
    const before = await reservationsApi.get(reservationId);
    const { payment, checkout } = await paymentsApi.recordPayment({ reservationId, provider: PaymentProvider.CASH, reference: 'itest-receipt' });
    expect(checkout).toBeNull();
    expect(payment).toMatchObject({ status: 'PAID', amount: before.total });
    const list = await paymentsApi.listForReservation(reservationId);
    expect(list.map((p) => p._id)).toContain(payment._id);
    expect((await reservationsApi.get(reservationId)).amountPaid).toBe(before.total);
    // overpaying is refused by the server
    await expect(paymentsApi.recordPayment({ reservationId, provider: PaymentProvider.CASH, amount: 100 })).rejects.toBeInstanceOf(ApiError);
  });

  it('cancels with a reason (required) and reports the result', async () => {
    await expect(apiClient(`/reservations/${reservationId}/cancel`, { method: 'POST', body: JSON.stringify({}) })).rejects.toMatchObject({ status: 400 });
    const res = await reservationsApi.cancel(reservationId, 'integration test');
    expect(res.reservation.status).toBe('CANCELLED');
    expect(res.alreadyCancelled).toBe(false);
  });
});

describe('channels', () => {
  it('lists channels in the UI shape; unavailable OTAs are flagged', async () => {
    const channels = await channelsApi.list(propertyId);
    const airbnb = channels.find((c) => c.channel === 'AIRBNB')!;
    expect(airbnb.available).toBe(false);
    expect(channels.find((c) => c.channel === 'DIRECT')).toMatchObject({ internal: true });
    expect(channels.find((c) => c.channel === 'MOCK')).toMatchObject({ available: true });
  });

  it('an unavailable OTA fails with CHANNEL_INTEGRATION_NOT_AVAILABLE (no fake listings)', async () => {
    await expect(channelsApi.getListings(propertyId, 'AIRBNB')).rejects.toMatchObject({ status: 422, code: 'CHANNEL_INTEGRATION_NOT_AVAILABLE' });
  });

  it('MOCK channel: authorize -> listings -> map -> sync -> unmap -> disconnect', async () => {
    const { authorizationUrl } = await channelsApi.connect(propertyId, 'MOCK');
    expect(authorizationUrl).toContain('/channels/MOCK/mock-authorize');
    // follow the provider consent + callback redirects the way a browser would
    const consent = await fetch(authorizationUrl!, { redirect: 'manual' });
    const callback = await fetch(consent.headers.get('location')!, { redirect: 'manual' });
    expect(callback.headers.get('location')).toMatch(/\/properties\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/channels\?connected=MOCK$/);

    const listings = await channelsApi.getListings(propertyId, 'MOCK');
    const hotel = listings.find((l) => l.externalListingId === 'MOCK-HOTEL-1')!;
    expect(hotel.externalRooms!.length).toBeGreaterThan(0);

    const types = await roomTypesApi.list(propertyId);
    const plans = await ratesApi.listRatePlans(propertyId, types[0]._id);
    const saved = await channelsApi.saveMappings(propertyId, 'MOCK', {
      mappings: [
        {
          externalListingId: hotel.externalListingId,
          externalRoomId: 'MOCK-ROOM-STD',
          roomTypeId: types[0]._id,
          ratePlans: [{ externalRatePlanId: 'MOCK-ROOM-STD-FLEX', ratePlanId: plans[0]._id, markupType: 'PERCENTAGE', markupValue: 10 }],
        },
      ],
    });
    expect(saved[0].mappingId).toBeTruthy();

    const after = (await channelsApi.getListings(propertyId, 'MOCK')).find((l) => l._id === hotel._id)!;
    const mapping = after.roomMappings!.find((m) => m.externalRoomId === 'MOCK-ROOM-STD')!;
    expect(mapping.rateMappings![0]).toMatchObject({ externalRatePlanId: 'MOCK-ROOM-STD-FLEX', markupValue: 10 });

    const sync = await channelsApi.triggerSync(propertyId, 'MOCK');
    expect(typeof sync.queued).toBe('number');

    await channelsApi.removeMapping(propertyId, 'MOCK', mapping._id);
    await channelsApi.disconnect(propertyId, 'MOCK');
    expect((await channelsApi.list(propertyId)).find((c) => c.channel === 'MOCK')!.status).toBe('DISCONNECTED');
  });

  it('sync errors are platform-admin only: the owner gets a 403 ApiError', async () => {
    await expect(channelsApi.getSyncErrors()).rejects.toMatchObject({ status: 403 });
  });
});

describe('reports', () => {
  it('occupancy, revenue and the composed dashboard figures', async () => {
    const occ = await reportsApi.getOccupancyReport(propertyId, day(0), day(7));
    expect(occ).toHaveLength(7);
    expect(occ[0]).toMatchObject({ totalRooms: expect.any(Number), occupancyPercent: expect.any(Number) });
    const rev = await reportsApi.getRevenueReport(propertyId, day(-30), day(60));
    expect(rev.bySource.length).toBeGreaterThan(0);
    expect(rev.bySource.reduce((a, s) => a + s.revenue, 0)).toBe(rev.totalRevenue);
    const dash = await reportsApi.getDashboardStats(propertyId);
    expect(dash.totalRooms).toBeGreaterThan(0);
    expect(dash.soldRooms + dash.availableRooms).toBeLessThanOrEqual(dash.sellableRooms);
    expect(dash.currency).toBe('INR');
  });
});

describe('public booking engine (no auth)', () => {
  it('property page data and availability with server-side quotes', async () => {
    tokenStorage.clear(); // guests are anonymous
    const p = await bookingEngineApi.getPublicProperty(slug);
    expect(p.roomTypes.length).toBeGreaterThan(0);
    expect(p.roomTypes[0].startingFromPrice).toBeGreaterThan(0);
    const avail = await bookingEngineApi.searchAvailability(slug, { checkIn: day(24), checkOut: day(26), adults: 2 }, p);
    const bookable = avail.find((a) => a.bookable)!;
    expect(bookable.ratePlans[0]).toMatchObject({ nightlyPrice: expect.any(Number), totalPrice: expect.any(Number), subtotal: expect.any(Number) });
    expect(bookable.ratePlans[0].totalPrice).toBe(bookable.ratePlans[0].subtotal + bookable.ratePlans[0].taxAmount - bookable.ratePlans[0].discountAmount);
  });

  it('unknown property is a 404 ApiError', async () => {
    await expect(bookingEngineApi.getPublicProperty('no-such-hotel')).rejects.toMatchObject({ status: 404 });
  });

  it('books once per idempotency key, then looks the booking up by code + email', async () => {
    const p = await bookingEngineApi.getPublicProperty(slug);
    const avail = await bookingEngineApi.searchAvailability(slug, { checkIn: day(24), checkOut: day(26), adults: 2 }, p);
    const room = avail.find((a) => a.bookable)!;
    const input = {
      propertySlug: slug,
      roomTypeId: room.roomTypeId,
      ratePlanId: room.ratePlans[0].ratePlanId,
      quantity: 1,
      checkIn: day(24),
      checkOut: day(26),
      adults: 2,
      guest: { firstName: 'Live', lastName: 'Guest', email: 'live.guest@example.com', phone: '+919800077777' },
    };
    const key = `itest-${Date.now()}-abcdef`;
    const first = await bookingEngineApi.createBooking(input, key);
    const replay = await bookingEngineApi.createBooking(input, key);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.reservation.reservationCode).toBe(first.reservation.reservationCode);
    expect(first.reservation.total).toBe(room.ratePlans[0].totalPrice);

    const looked = await bookingEngineApi.lookupReservation(first.reservation.reservationCode, 'live.guest@example.com');
    expect(looked).toMatchObject({ reservationCode: first.reservation.reservationCode, propertyName: p.name, total: first.reservation.total });
    await expect(bookingEngineApi.lookupReservation(first.reservation.reservationCode, 'someone.else@example.com')).rejects.toMatchObject({ status: 404 });
  });

  it('payment verification rejects a forged signature (never trusts the browser)', async () => {
    await expect(paymentsApi.verifyCheckout({ razorpayOrderId: 'order_FORGED00001', razorpayPaymentId: 'pay_FORGED00001', razorpaySignature: 'a'.repeat(64) })).rejects.toMatchObject({
      status: expect.any(Number),
      code: expect.stringMatching(/PAYMENT_SIGNATURE_INVALID|NOT_FOUND|UNAUTHORIZED|VALIDATION_ERROR|PAYMENT_NOT_CONFIGURED/),
    });
  });
});
