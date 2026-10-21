import { REDACTED_RECIPIENT, runRetention } from '../src/database/services/retention';
import { bearer, createMember, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

const HUNDRED_DAYS = 100 * 86_400_000;

describe('Personal-data retention', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let s: PropertySetup;
  const http = () => t.http();
  const later = () => new Date(Date.now() + HUNDRED_DAYS); // "a hundred days from now": everything created by this test has aged

  const book = async (email: string, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) =>
    (
      await http()
        .post('/reservations')
        .set(bearer(owner.token))
        .send({ ...reservationBody(s, checkIn, checkOut, extra), guest: { firstName: 'Meera', lastName: 'Iyer', email, phone: '+919822222222' }, specialRequests: 'Ground floor, allergic to feathers' })
        .expect(201)
    ).body.data;
  const cancel = (id: string) => http().post(`/reservations/${id}/cancel`).set(bearer(owner.token)).send({ reason: 'test' }).expect(200);
  const guestRow = (id: string) => t.db.selectFrom('guests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const setPolicy = (days: { guest?: number | null; notif?: number | null; inbound?: number | null }) =>
    t.db
      .insertInto('dataRetentionPolicies')
      .values({ organizationId: orgId, guestAnonymizeAfterDays: days.guest ?? null, notificationRedactAfterDays: days.notif ?? null, inboundPayloadRedactAfterDays: days.inbound ?? null })
      .onConflict((oc) => oc.column('organizationId').doUpdateSet({ guestAnonymizeAfterDays: days.guest ?? null, notificationRedactAfterDays: days.notif ?? null, inboundPayloadRedactAfterDays: days.inbound ?? null, enabled: false, approvedAt: null, approvedBy: null }))
      .execute();
  const approve = () => t.db.updateTable('dataRetentionPolicies').set({ enabled: true, approvedAt: new Date(), approvedBy: owner.userId }).where('organizationId', '=', orgId).execute();

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    orgId = (await http().get('/organizations/me').set(bearer(owner.token)).expect(200)).body.data._id;
    s = await createPropertyWithRooms(t, owner.token, 6);
  });
  afterAll(() => t.close());

  describe('policy and API', () => {
    it('starts without a policy, takes periods within sane bounds, and needs an owner to approve', async () => {
      const none = (await http().get('/organizations/me/retention').set(bearer(owner.token)).expect(200)).body.data;
      expect(none.policy).toMatchObject({ guestAnonymizeAfterDays: null, notificationRedactAfterDays: null, enabled: false });

      expect((await http().put('/organizations/me/retention').set(bearer(owner.token)).send({ guestAnonymizeAfterDays: 5 })).status).toBe(400);
      expect((await http().put('/organizations/me/retention').set(bearer(owner.token)).send({ notificationRedactAfterDays: 1 })).status).toBe(400);
      expect((await http().post('/organizations/me/retention/approve').set(bearer(owner.token)).send({})).status).toBe(400); // nothing to approve

      const set = await http().put('/organizations/me/retention').set(bearer(owner.token)).send({ guestAnonymizeAfterDays: 730, notificationRedactAfterDays: 90 }).expect(200);
      expect(set.body.data.policy).toMatchObject({ guestAnonymizeAfterDays: 730, notificationRedactAfterDays: 90, enabled: false, awaitingApproval: true });

      // Nothing is applied before approval, but a dry run is always available.
      const early = await http().post('/organizations/me/retention/run').set(bearer(owner.token)).send({ confirm: 'ANONYMIZE' });
      expect(early.status).toBe(400);
      expect(early.body.error.message).toMatch(/approved/i);
      expect((await http().post('/organizations/me/retention/run').set(bearer(owner.token)).send({})).status).toBe(400); // confirmation phrase required
      const dry = await http().post('/organizations/me/retention/dry-run').set(bearer(owner.token)).send({}).expect(200);
      expect(dry.body.data).toMatchObject({ dryRun: true, applied: false });

      const approved = await http().post('/organizations/me/retention/approve').set(bearer(owner.token)).send({}).expect(200);
      expect(approved.body.data.policy).toMatchObject({ enabled: true, awaitingApproval: false });
      // Changing the numbers withdraws the approval.
      const changed = await http().put('/organizations/me/retention').set(bearer(owner.token)).send({ guestAnonymizeAfterDays: 365 }).expect(200);
      expect(changed.body.data.policy).toMatchObject({ guestAnonymizeAfterDays: 365, enabled: false, approvedAt: null });
      await http().post('/organizations/me/retention/disable').set(bearer(owner.token)).send({}).expect(200);
    });

    it('is for owners of this organization only', async () => {
      const manager = await createMember(t, owner, 'PROPERTY_MANAGER', s.propertyId);
      const other = await registerOwner(t, 'other');
      for (const token of [manager.token]) {
        expect((await http().get('/organizations/me/retention').set(bearer(token))).status).toBe(403);
        expect((await http().put('/organizations/me/retention').set(bearer(token)).send({ guestAnonymizeAfterDays: 100 })).status).toBe(403);
        expect((await http().post('/organizations/me/retention/dry-run').set(bearer(token)).send({})).status).toBe(403);
      }
      // Another organization's owner only ever sees (and changes) their own, empty, policy.
      const mine = (await http().get('/organizations/me/retention').set(bearer(other.token)).expect(200)).body.data;
      expect(mine.policy.guestAnonymizeAfterDays).toBeNull();
      expect((await http().get('/organizations/me/retention')).status).toBe(401);
    });
  });

  describe('anonymisation', () => {
    let aliceId: string;
    let bobId: string;
    let aliceRes: { _id: string; reservationCode: string; total: number; checkIn: string };
    let bobRes: { _id: string };

    beforeAll(async () => {
      aliceRes = await book('alice@example.com', day(5), day(7));
      await cancel(aliceRes._id);
      bobRes = await book('bob@example.com', day(5), day(7)); // stays CONFIRMED: an open booking
      aliceId = (await http().get(`/reservations/${aliceRes._id}`).set(bearer(owner.token)).expect(200)).body.data.guestId;
      bobId = (await http().get(`/reservations/${bobRes._id}`).set(bearer(owner.token)).expect(200)).body.data.guestId;
    });

    it('does nothing without a policy, and with a real clock does nothing to fresh data', async () => {
      await t.db.deleteFrom('dataRetentionPolicies').where('organizationId', '=', orgId).execute();
      const none = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(none).toMatchObject({ applied: false, summary: { guests: 0, reservations: 0, notifications: 0, inboundEvents: 0 } });
      await setPolicy({ guest: 30, notif: 7 });
      await approve();
      const fresh = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test' });
      expect(fresh.summary).toEqual({ guests: 0, reservations: 0, notifications: 0, inboundEvents: 0 });
      expect((await guestRow(aliceId)).email).toBe('alice@example.com');
    });

    it('a dry run counts but changes nothing, even before approval', async () => {
      await setPolicy({ guest: 30, notif: 7 }); // resets approval
      const dry = await runRetention(t.db, orgId, { dryRun: true, triggeredBy: 'test', now: later() });
      expect(dry).toMatchObject({ dryRun: true, applied: false });
      expect(dry.summary.guests).toBe(1); // alice; bob has a live booking
      expect(dry.summary.reservations).toBe(1);
      expect(dry.summary.notifications).toBeGreaterThan(0);
      const alice = await guestRow(aliceId);
      expect(alice).toMatchObject({ firstName: 'Meera', email: 'alice@example.com', anonymizedAt: null });
      const unapproved = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(unapproved).toMatchObject({ applied: false });
      expect(unapproved.reason).toMatch(/approved/i);
      expect((await guestRow(aliceId)).email).toBe('alice@example.com');
    });

    it('anonymises the finished guest only, keeps every financial and booking fact, and is idempotent', async () => {
      const revenueBefore = (await http().get(`/properties/${s.propertyId}/reports/revenue`).query({ from: day(0), to: day(30) }).set(bearer(owner.token)).expect(200)).body.data;
      const before = (await http().get(`/reservations/${aliceRes._id}`).set(bearer(owner.token)).expect(200)).body.data;
      await approve();

      const run = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(run).toMatchObject({ applied: true, moreGuests: false });
      expect(run.summary.guests).toBe(1);
      expect(run.summary.reservations).toBe(1);

      const alice = await guestRow(aliceId);
      expect(alice).toMatchObject({ firstName: 'Anonymized', lastName: 'Guest', email: null, phone: null, notes: null, documents: [] });
      expect(alice.anonymizedAt).toBeTruthy();
      const after = (await http().get(`/reservations/${aliceRes._id}`).set(bearer(owner.token)).expect(200)).body.data;
      expect(after.guest).toEqual({ firstName: 'Anonymized', lastName: 'Guest' });
      expect(after.specialRequests).toBeNull();
      // Everything that is not personal data is exactly as it was.
      for (const k of ['reservationCode', 'status', 'checkIn', 'checkOut', 'nights', 'adults', 'subtotal', 'tax', 'discount', 'total', 'currency', 'paymentStatus', 'amountPaid', 'cancelledAt', 'cancellationReason'] as const) {
        expect({ k, v: after[k] }).toEqual({ k, v: before[k] });
      }
      const notes = await t.db.selectFrom('notifications').select(['recipient', 'subject', 'message', 'redactedAt']).where('reservationId', '=', aliceRes._id).execute();
      expect(notes.length).toBeGreaterThan(0);
      notes.forEach((n) => expect(n).toMatchObject({ recipient: REDACTED_RECIPIENT, subject: null, message: '[redacted]' }));
      // Reports are unchanged.
      const revenueAfter = (await http().get(`/properties/${s.propertyId}/reports/revenue`).query({ from: day(0), to: day(30) }).set(bearer(owner.token)).expect(200)).body.data;
      expect(revenueAfter).toEqual(revenueBefore);
      // The guest with a live booking is untouched.
      expect(await guestRow(bobId)).toMatchObject({ firstName: 'Meera', email: 'bob@example.com', anonymizedAt: null });
      const bob = (await http().get(`/reservations/${bobRes._id}`).set(bearer(owner.token)).expect(200)).body.data;
      expect(bob.guest.email).toBe('bob@example.com');

      // Running again changes nothing.
      const again = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(again.summary.guests).toBe(0);
      expect(again.summary.reservations).toBe(0);
    });

    it('records counts only: the run log never contains personal data', async () => {
      const runs = await t.db.selectFrom('dataRetentionRuns').selectAll().where('organizationId', '=', orgId).execute();
      expect(runs.length).toBeGreaterThanOrEqual(3);
      const text = JSON.stringify(runs);
      for (const needle of ['alice', 'bob@', 'Meera', '+9198']) expect(text).not.toContain(needle);
      runs.forEach((r) => expect(Object.keys(r.summary).sort()).toEqual(['guests', 'inboundEvents', 'notifications', 'reservations']));
    });

    it('works in bounded batches and never crosses organizations', async () => {
      for (let i = 0; i < 3; i++) await cancel((await book(`batch${i}@example.com`, day(10 + i * 3), day(11 + i * 3)))._id);
      const first = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later(), batch: 2 });
      expect(first).toMatchObject({ applied: true, moreGuests: true });
      expect(first.summary.guests).toBe(2);
      const second = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later(), batch: 2 });
      expect(second).toMatchObject({ moreGuests: false });
      expect(second.summary.guests).toBe(1);

      // Another organization with its own approved policy cannot reach this organization's guests, and vice versa.
      const other = await registerOwner(t, 'other');
      const otherOrg = (await http().get('/organizations/me').set(bearer(other.token)).expect(200)).body.data._id;
      await t.db.insertInto('dataRetentionPolicies').values({ organizationId: otherOrg, guestAnonymizeAfterDays: 30, enabled: true, approvedAt: new Date(), approvedBy: other.userId }).execute();
      const theirs = await runRetention(t.db, otherOrg, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(theirs.summary.guests).toBe(0);
      expect((await guestRow(bobId)).anonymizedAt).toBeNull();
    });

    it('blanks the raw payload of processed inbound channel events but keeps the event row, and skips unprocessed or other-tenant events', async () => {
      const guestPii = { guest: { name: 'Kabir Rao', email: 'kabir@example.com', phone: '+919833333333' } };
      // A RECEIVED event would be picked up by the inbound worker within milliseconds; PROCESSING with a lease is stable.
      const mk = (id: string, status: string, propertyId: string | null) =>
        t.db
          .insertInto('webhookEvents')
          .values({ channel: 'MOCK', propertyId, eventType: 'reservation.created', externalEventId: id, payload: JSON.stringify(guestPii) as never, signatureValid: true, status, lockedUntil: status === 'PROCESSING' ? new Date(Date.now() + 86_400_000) : null })
          .returning('id')
          .executeTakeFirstOrThrow();
      const done = await mk('evt-done', 'PROCESSED', s.propertyId);
      const waiting = await mk('evt-waiting', 'PROCESSING', s.propertyId);
      const otherOrg = await registerOwner(t, 'inbound-other');
      const other = await createPropertyWithRooms(t, otherOrg.token, 1);
      const foreign = await mk('evt-foreign', 'PROCESSED', other.propertyId);
      await setPolicy({ inbound: 7 });
      const dry = await runRetention(t.db, orgId, { dryRun: true, triggeredBy: 'test', now: later() });
      expect(dry.summary.inboundEvents).toBe(1);
      expect((await t.db.selectFrom('webhookEvents').select('payload').where('id', '=', done.id).executeTakeFirstOrThrow()).payload).toEqual(guestPii);
      await approve();
      const run = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(run.summary.inboundEvents).toBe(1);
      const row = await t.db.selectFrom('webhookEvents').select(['payload', 'status', 'externalEventId', 'payloadRedactedAt']).where('id', '=', done.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ payload: { redacted: true }, status: 'PROCESSED', externalEventId: 'evt-done' });
      expect(row.payloadRedactedAt).toBeTruthy();
      expect((await t.db.selectFrom('webhookEvents').select('payload').where('id', '=', waiting.id).executeTakeFirstOrThrow()).payload).toEqual(guestPii); // not processed yet
      expect((await t.db.selectFrom('webhookEvents').select('payload').where('id', '=', foreign.id).executeTakeFirstOrThrow()).payload).toEqual(guestPii); // other organization
      expect((await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() })).summary.inboundEvents).toBe(0); // idempotent
    });

    it('blanks old delivered notifications by age but leaves queued ones', async () => {
      const property = s.propertyId;
      const sent = await t.db.insertInto('notifications').values({ propertyId: property, type: 'RESERVATION_CONFIRMED', channel: 'EMAIL', recipient: 'old@example.com', subject: 'Hello', message: 'Dear old guest', status: 'SENT' }).returning('id').executeTakeFirstOrThrow();
      const queued = await t.db.insertInto('notifications').values({ propertyId: property, type: 'RESERVATION_CONFIRMED', channel: 'EMAIL', recipient: 'queued@example.com', subject: 'Hello', message: 'Dear waiting guest', status: 'QUEUED' }).returning('id').executeTakeFirstOrThrow();
      await setPolicy({ notif: 7 });
      await approve();
      const run = await runRetention(t.db, orgId, { dryRun: false, triggeredBy: 'test', now: later() });
      expect(run.summary.notifications).toBeGreaterThanOrEqual(1);
      expect(await t.db.selectFrom('notifications').select(['recipient', 'message']).where('id', '=', sent.id).executeTakeFirstOrThrow()).toEqual({ recipient: REDACTED_RECIPIENT, message: '[redacted]' });
      expect(await t.db.selectFrom('notifications').select(['recipient', 'message']).where('id', '=', queued.id).executeTakeFirstOrThrow()).toEqual({ recipient: 'queued@example.com', message: 'Dear waiting guest' });
    });
  });
});
