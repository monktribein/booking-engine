import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { bookingEngineApi } from '@/lib/api/booking-engine';
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
import { fail, mockFetch } from './helpers';

const ROOT = path.resolve(__dirname, '..');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', '.next', 'tests'].includes(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

describe('static guard: no mock data on the normal code path', () => {
  const files = ['app', 'components', 'lib'].flatMap((d) => walk(path.join(ROOT, d)));

  it('nothing outside lib/fixtures imports the demo fixtures', () => {
    const offenders = files.filter((f) => !f.includes(`${path.sep}fixtures${path.sep}`)).filter((f) => /fixtures\/demo-data|mock-data/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('no MOCK_* identifier, fake token or demo token outside the fixtures', () => {
    const offenders = files
      .filter((f) => !f.includes(`${path.sep}fixtures${path.sep}`))
      .filter((f) => /\bMOCK_[A-Z_]+\b|mock_jwt|mock_refresh|demo_token/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('API modules contain no catch block that swallows an error into a value', () => {
    const apiFiles = files.filter((f) => f.includes(`${path.sep}lib${path.sep}api${path.sep}`));
    const bad: string[] = [];
    for (const f of apiFiles) {
      const src = fs.readFileSync(f, 'utf8');
      // `catch {` / `catch (e) {` followed by a return is a fallback; the client's own error translation is allowed.
      for (const m of src.matchAll(/catch\s*(\([^)]*\))?\s*\{([^}]*)\}/g)) {
        if (/\breturn\b/.test(m[2]) && !f.endsWith('client.ts')) bad.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no hard-coded property ids remain in the UI', () => {
    const offenders = files.filter((f) => !f.includes('fixtures')).filter((f) => /prop_radha_ashram/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('every API call rejects with an ApiError when the backend fails (no fabricated success)', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['properties.list', () => propertiesApi.list()],
    ['properties.get', () => propertiesApi.get('p')],
    ['properties.create', () => propertiesApi.create({ name: 'x' })],
    ['properties.update', () => propertiesApi.update('p', { name: 'x' })],
    ['roomTypes.list', () => roomTypesApi.list('p')],
    ['roomTypes.create', () => roomTypesApi.create('p', { name: 'x' })],
    ['roomTypes.update', () => roomTypesApi.update('rt', { name: 'x' })],
    ['roomTypes.archive', () => roomTypesApi.archive('rt')],
    ['rooms.listAll', () => roomsApi.listAll('p')],
    ['rooms.listByRoomType', () => roomsApi.listByRoomType('rt')],
    ['rooms.create', () => roomsApi.create('rt', { roomNumber: '1' })],
    ['rooms.changeStatus', () => roomsApi.changeStatus('r', { status: 'CLEANING' as never })],
    ['inventory.getCalendar', () => inventoryApi.getCalendar('p', '2026-01-01', '2026-01-08')],
    ['inventory.setRestrictions', () => inventoryApi.setRestrictions('p', { roomTypeId: 'rt', from: '2026-01-01', to: '2026-01-02', stopSell: true })],
    ['inventory.createBlock', () => inventoryApi.createBlock({ propertyId: 'p', roomTypeId: 'rt', startDate: '2026-01-01', endDate: '2026-01-02', reason: 'MAINTENANCE' })],
    ['inventory.unblock', () => inventoryApi.unblock('b')],
    ['rates.listRatePlans', () => ratesApi.listRatePlans('p')],
    ['rates.createRatePlan', () => ratesApi.createRatePlan('p', { name: 'x' })],
    ['rates.updateRatePlan', () => ratesApi.updateRatePlan('rp', { name: 'x' })],
    ['rates.listPromotions', () => ratesApi.listPromotions('p')],
    ['rates.createPromotion', () => ratesApi.createPromotion('p', { code: 'X' })],
    ['guests.list', () => guestsApi.list({ propertyId: 'p' })],
    ['guests.get', () => guestsApi.get('g')],
    ['guests.create', () => guestsApi.create({ propertyId: 'p', firstName: 'x' })],
    ['reservations.list', () => reservationsApi.list({ propertyId: 'p' })],
    ['reservations.get', () => reservationsApi.get('r')],
    ['reservations.create', () => reservationsApi.create({ propertyId: 'p', guest: { firstName: 'x', lastName: 'y' }, checkIn: '2026-01-01', checkOut: '2026-01-02', adults: 1, rooms: [] })],
    ['reservations.cancel', () => reservationsApi.cancel('r', 'why')],
    ['reservations.checkIn', () => reservationsApi.checkIn('r')],
    ['reservations.checkOut', () => reservationsApi.checkOut('r')],
    ['reservations.noShow', () => reservationsApi.noShow('r')],
    ['reservations.assignRoom', () => reservationsApi.assignRoom('r', 'rr', 'room')],
    ['payments.listForReservation', () => paymentsApi.listForReservation('r')],
    ['payments.recordPayment', () => paymentsApi.recordPayment({ reservationId: 'r', provider: 'CASH' })],
    ['payments.refund', () => paymentsApi.refund('pay', { reason: 'x' })],
    ['payments.verifyCheckout', () => paymentsApi.verifyCheckout({ razorpayOrderId: 'order_123456', razorpayPaymentId: 'pay_123456', razorpaySignature: 'x'.repeat(64) })],
    ['channels.list', () => channelsApi.list('p')],
    ['channels.connect', () => channelsApi.connect('p', 'MOCK')],
    ['channels.disconnect', () => channelsApi.disconnect('p', 'MOCK')],
    ['channels.getListings', () => channelsApi.getListings('p', 'MOCK')],
    ['channels.saveMappings', () => channelsApi.saveMappings('p', 'MOCK', { mappings: [] })],
    ['channels.removeMapping', () => channelsApi.removeMapping('p', 'MOCK', 'm')],
    ['channels.triggerSync', () => channelsApi.triggerSync('p', 'MOCK')],
    ['channels.getSyncErrors', () => channelsApi.getSyncErrors()],
    ['reports.getRevenueReport', () => reportsApi.getRevenueReport('p', '2026-01-01', '2026-01-31')],
    ['reports.getOccupancyReport', () => reportsApi.getOccupancyReport('p', '2026-01-01', '2026-01-31')],
    ['reports.getDashboardStats', () => reportsApi.getDashboardStats('p')],
    ['bookingEngine.getPublicProperty', () => bookingEngineApi.getPublicProperty('slug')],
    ['bookingEngine.searchAvailability', () => bookingEngineApi.searchAvailability('slug', { checkIn: '2026-01-01', checkOut: '2026-01-02', adults: 1 })],
    [
      'bookingEngine.createBooking',
      () =>
        bookingEngineApi.createBooking(
          { propertySlug: 's', roomTypeId: 'rt', ratePlanId: 'rp', quantity: 1, checkIn: '2026-01-01', checkOut: '2026-01-02', adults: 1, guest: { firstName: 'a', lastName: 'b', email: 'a@b.co', phone: '+911234567890' } },
          'idem-key-12345'
        ),
    ],
    ['bookingEngine.lookupReservation', () => bookingEngineApi.lookupReservation('TRV-1', 'a@b.co')],
  ];

  it.each(calls)('%s: HTTP 500 -> ApiError(500)', async (_name, call) => {
    mockFetch(() => fail(500, 'INTERNAL_ERROR', 'boom'));
    const err = await call().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it.each(calls)('%s: backend unreachable -> ApiError(NETWORK_ERROR)', async (_name, call) => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await call().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
  });
});
