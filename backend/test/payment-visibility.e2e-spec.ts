import { ReservationSource } from '../src/database/enums';
import type { NormalizedReservationEvent } from '../src/database/services/webhook.service';
import { ReservationService } from '../src/database/services/reservation.service';
import { WebhookService } from '../src/database/services/webhook.service';
import { connectMock, mapMock } from './utils/channels';
import { createPropertyWithRooms, day, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * Read-only payment visibility for channel bookings. The one rule under test: information that was not reported is never turned
 * into "paid", "unpaid" or "collected by the channel".
 */
describe('channel payment visibility', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let events: WebhookService;
  let reservations: ReservationService;
  let n = 0;

  const event = (over: Partial<NormalizedReservationEvent> = {}): NormalizedReservationEvent => {
    n += 1;
    return {
      kind: 'RESERVATION_CREATED',
      channel: 'MOCK',
      externalListingId: 'MOCK-HOTEL-1',
      externalReservationId: `PV-${n}`,
      checkIn: day(4 + n * 3),
      checkOut: day(6 + n * 3),
      adults: 2,
      guest: { firstName: 'Ota', lastName: 'Guest', email: 'ota.guest@example.com' },
      rooms: [{ externalRoomId: 'MOCK-ROOM-DLX', externalRatePlanId: 'MOCK-ROOM-DLX-FLEX', quantity: 1, nightlyRates: [410000, 410000] }],
      currency: 'INR',
      ...over,
    };
  };
  const row = (externalReservationId: string) => t.db.selectFrom('reservations').selectAll().where('source', '=', 'MOCK').where('externalReservationId', '=', externalReservationId).executeTakeFirstOrThrow();
  const refundsOf = (id: string) => t.db.selectFrom('refunds').selectAll().where('reservationId', '=', id).execute();

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 10);
    await connectMock(t, owner.token, s);
    await mapMock(t, owner.token, s).expect(201);
    await t.drain();
    events = t.app.get(WebhookService);
    reservations = t.app.get(ReservationService);
  });
  afterAll(() => t.close());

  describe('nothing reported', () => {
    it('a channel booking with no payment information is UNKNOWN, with every payment field empty', async () => {
      const e = event();
      await events.applyReservationEvent(e);
      const r = await row(e.externalReservationId);
      expect(r).toMatchObject({
        paymentStatus: 'UNKNOWN',
        amountPaid: 0,
        amountRefunded: 0,
        collectionModel: null,
        collectionSource: null,
        providerPaymentStatusRaw: null,
        providerPaymentStatus: null,
        payoutStatusRaw: null,
        payoutStatus: null,
        payoutDate: null,
        commissionAmount: null,
        netAmount: null,
        paymentInfoUpdatedAt: null,
      });
      expect(r.paymentStatus).not.toBe('PAID');
      expect(r.paymentStatus).not.toBe('CHANNEL_COLLECTED');
    });

    it('a claim without a source is dropped: it cannot make a booking collected', async () => {
      const e = event({ payment: { collectedBy: 'CHANNEL' } });
      await events.applyReservationEvent(e);
      expect(await row(e.externalReservationId)).toMatchObject({ paymentStatus: 'UNKNOWN', collectionModel: null, collectionSource: null });
    });

    it('invalid values (unknown status words as normalised statuses, negative or fractional money) are dropped, not repaired', async () => {
      const e = event({
        payment: { providerStatus: 'SETTLED' as never, payoutStatus: 'SENT' as never, commissionAmount: -5, netAmount: 12.5, payoutDate: new Date('nonsense') },
      });
      await events.applyReservationEvent(e);
      expect(await row(e.externalReservationId)).toMatchObject({ paymentStatus: 'UNKNOWN', providerPaymentStatus: null, payoutStatus: null, commissionAmount: null, netAmount: null, payoutDate: null, paymentInfoUpdatedAt: null });
    });

    it('a booking that is not from a channel ignores channel payment information', async () => {
      const r = await reservations.createReservation({
        propertyId: s.propertyId,
        source: ReservationSource.PHONE,
        guest: { firstName: 'Walk', lastName: 'In' },
        checkIn: day(2),
        checkOut: day(3),
        adults: 1,
        rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }],
        payment: { collectedBy: 'CHANNEL', collectionSource: 'PROVIDER', providerStatusRaw: 'paid', providerStatus: 'PAID' },
      });
      expect(r.reservation).toMatchObject({ paymentStatus: 'UNPAID', collectionModel: null, collectionSource: null, providerPaymentStatus: null });
    });
  });

  describe('declared by the operator versus reported by the provider', () => {
    it('"the channel collects" declared by configuration is stored as a declaration and says nothing about the guest having paid', async () => {
      const e = event({ payment: { collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' } });
      await events.applyReservationEvent(e);
      expect(await row(e.externalReservationId)).toMatchObject({
        paymentStatus: 'CHANNEL_COLLECTED',
        collectionModel: 'CHANNEL',
        collectionSource: 'OPERATOR_CONFIG',
        providerPaymentStatus: null, // the provider reported no status: not "paid"
        providerPaymentStatusRaw: null,
        amountPaid: 0,
      });
    });

    it('"the property collects" is stored as such, with its source', async () => {
      const e = event({ payment: { collectedBy: 'PROPERTY', collectionSource: 'OPERATOR_CONFIG' } });
      await events.applyReservationEvent(e);
      expect(await row(e.externalReservationId)).toMatchObject({ paymentStatus: 'UNPAID', collectionModel: 'PROPERTY', collectionSource: 'OPERATOR_CONFIG', amountPaid: 0 });
    });

    it('provider-reported fields are stored verbatim; a word nobody mapped stays raw-only', async () => {
      const when = new Date('2027-03-05T00:00:00Z');
      const e = event({
        payment: {
          collectedBy: 'CHANNEL',
          collectionSource: 'PROVIDER',
          providerStatusRaw: 'settled-ish',
          payoutStatusRaw: 'scheduled',
          payoutStatus: 'PENDING',
          payoutDate: when,
          commissionAmount: 123400,
          netAmount: 698600,
        },
      });
      await events.applyReservationEvent(e);
      const r = await row(e.externalReservationId);
      expect(r).toMatchObject({
        paymentStatus: 'CHANNEL_COLLECTED',
        collectionSource: 'PROVIDER',
        providerPaymentStatusRaw: 'settled-ish',
        providerPaymentStatus: null, // not mapped: kept raw, never guessed
        payoutStatusRaw: 'scheduled',
        payoutStatus: 'PENDING',
        commissionAmount: 123400,
        netAmount: 698600,
        amountPaid: 0,
      });
      expect(r.payoutDate?.toISOString()).toBe(when.toISOString());
      expect(r.paymentInfoUpdatedAt).not.toBeNull();
    });
  });

  describe('later events', () => {
    it('a modification refreshes provider-reported fields but never touches amounts, status or an existing collection model', async () => {
      const e = event({ payment: { collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' } });
      await events.applyReservationEvent(e);
      const before = await row(e.externalReservationId);
      await events.applyReservationEvent({
        ...e,
        kind: 'RESERVATION_MODIFIED',
        payment: { collectedBy: 'PROPERTY', collectionSource: 'PROVIDER', providerStatusRaw: 'paid', providerStatus: 'PAID', payoutStatusRaw: 'paid_out', payoutStatus: 'COMPLETED', commissionAmount: 100, netAmount: 900 },
      });
      const after = await row(e.externalReservationId);
      expect(after).toMatchObject({ providerPaymentStatus: 'PAID', payoutStatus: 'COMPLETED', commissionAmount: 100, netAmount: 900 });
      expect(after.collectionModel).toBe('CHANNEL'); // never replaced
      expect(after.collectionSource).toBe('OPERATOR_CONFIG');
      expect(after.paymentStatus).toBe(before.paymentStatus);
      expect(after.amountPaid).toBe(before.amountPaid);
      expect(after.total).toBe(before.total);
    });

    it('a booking whose collection was unknown learns it when the provider later says so', async () => {
      const e = event();
      await events.applyReservationEvent(e);
      expect((await row(e.externalReservationId)).paymentStatus).toBe('UNKNOWN');
      await events.applyReservationEvent({ ...e, kind: 'RESERVATION_MODIFIED', payment: { collectedBy: 'CHANNEL', collectionSource: 'PROVIDER' } });
      expect(await row(e.externalReservationId)).toMatchObject({ paymentStatus: 'CHANNEL_COLLECTED', collectionModel: 'CHANNEL', collectionSource: 'PROVIDER' });
    });

    it('a later event that reports nothing does not erase what is known', async () => {
      const e = event({ payment: { collectedBy: 'CHANNEL', collectionSource: 'PROVIDER', providerStatusRaw: 'paid', providerStatus: 'PAID' } });
      await events.applyReservationEvent(e);
      await events.applyReservationEvent({ ...e, kind: 'RESERVATION_MODIFIED', payment: undefined });
      expect(await row(e.externalReservationId)).toMatchObject({ providerPaymentStatus: 'PAID', collectionModel: 'CHANNEL' });
    });
  });

  describe('cancellation and refunds', () => {
    it.each([
      ['unknown collection', undefined],
      ['channel collects (declared)', { collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' } as const],
    ])('cancelling a channel booking (%s) creates no refund and never marks it refunded', async (_label, payment) => {
      const e = event({ payment });
      await events.applyReservationEvent(e);
      await events.applyReservationEvent({ ...e, kind: 'RESERVATION_CANCELLED' });
      const r = await row(e.externalReservationId);
      expect(r.status).toBe('CANCELLED');
      expect(r.amountRefunded).toBe(0);
      expect(['REFUNDED', 'PARTIALLY_REFUNDED']).not.toContain(r.paymentStatus);
      expect(await refundsOf(r.id)).toEqual([]);
    });
  });
});
