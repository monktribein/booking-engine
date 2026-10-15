import { bearer, createPropertyWithRooms, day, login, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Authorization: property isolation and RBAC', () => {
  let t: TestApp;
  let ownerA: Session;
  let ownerB: Session;
  let a: PropertySetup;
  let b: PropertySetup;
  let reservationA: string;

  beforeAll(async () => {
    t = await createTestApp();
    ownerA = await registerOwner(t, 'owner-a');
    ownerB = await registerOwner(t, 'owner-b');
    a = await createPropertyWithRooms(t, ownerA.token, 2);
    b = await createPropertyWithRooms(t, ownerB.token, 2);
    const r = await t.http().post('/reservations').set(bearer(ownerA.token)).send(reservationBody(a, day(2), day(3))).expect(201);
    reservationA = r.body.data._id;
  });
  afterAll(() => t.close());

  describe('cross-property isolation (owner B probing property A)', () => {
    const forbidden = (res: { status: number; body: { error?: { code: string } } }) => {
      expect(res.status).toBe(403);
      expect(res.body.error!.code).toBe('FORBIDDEN');
    };

    it('cannot read or edit the property', async () => {
      forbidden(await t.http().get(`/properties/${a.propertyId}`).set(bearer(ownerB.token)));
      forbidden(await t.http().patch(`/properties/${a.propertyId}`).set(bearer(ownerB.token)).send({ name: 'Hijacked' }));
      forbidden(await t.http().delete(`/properties/${a.propertyId}`).set(bearer(ownerB.token)));
    });

    it("does not see it in the property list", async () => {
      const list = await t.http().get('/properties').set(bearer(ownerB.token)).expect(200);
      expect(list.body.data.items.map((p: { _id: string }) => p._id)).toEqual([b.propertyId]);
    });

    it('cannot reach its data through child ids (room type, room, reservation)', async () => {
      forbidden(await t.http().patch(`/room-types/${a.roomTypeId}`).set(bearer(ownerB.token)).send({ name: 'x' }));
      forbidden(await t.http().post(`/room-types/${a.roomTypeId}/rooms`).set(bearer(ownerB.token)).send({ roomNumber: '999' }));
      forbidden(await t.http().patch(`/rooms/${a.roomIds[0]}`).set(bearer(ownerB.token)).send({ notes: 'x' }));
      forbidden(await t.http().get(`/reservations/${reservationA}`).set(bearer(ownerB.token)));
      forbidden(await t.http().post(`/reservations/${reservationA}/cancel`).set(bearer(ownerB.token)).send({ reason: 'x' }));
    });

    it('cannot list or create data by passing the other propertyId in query/body', async () => {
      forbidden(await t.http().get('/reservations').query({ propertyId: a.propertyId }).set(bearer(ownerB.token)));
      forbidden(await t.http().get('/guests').query({ propertyId: a.propertyId }).set(bearer(ownerB.token)));
      forbidden(await t.http().post('/reservations').set(bearer(ownerB.token)).send(reservationBody(a, day(4), day(5))));
      forbidden(await t.http().post('/inventory/block').set(bearer(ownerB.token)).send({ propertyId: a.propertyId, roomTypeId: a.roomTypeId, startDate: day(1), endDate: day(2), reason: 'OWNER_BLOCK' }));
      forbidden(await t.http().get(`/properties/${a.propertyId}/inventory`).query({ from: day(0), to: day(5) }).set(bearer(ownerB.token)));
      forbidden(await t.http().post(`/properties/${a.propertyId}/channels/MOCK/connect`).set(bearer(ownerB.token)));
    });

    it("cannot smuggle a foreign room type into their own property's booking", async () => {
      const res = await t
        .http()
        .post('/reservations')
        .set(bearer(ownerB.token))
        .send({ ...reservationBody(b, day(4), day(5)), rooms: [{ roomTypeId: a.roomTypeId, ratePlanId: a.ratePlanId, quantity: 1 }] });
      expect(res.status).toBe(404); // room type is not found *within* property B
    });

    it('rejects NoSQL operator injection instead of executing it', async () => {
      const res = await t.http().post('/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
      expect(res.status).toBe(400);
      const res2 = await t.http().get('/reservations').query({ propertyId: a.propertyId, 'status[$ne]': 'X' }).set(bearer(ownerA.token));
      expect(res2.status).toBe(400);
    });
  });

  describe('RBAC within a property', () => {
    let reception: Session;

    beforeAll(async () => {
      await t.http().post(`/properties/${a.propertyId}/users`).set(bearer(ownerA.token)).send({ email: 'desk@example.com', name: 'Front Desk', role: 'RECEPTION' }).expect(201);
      // The invite email carries a set-password link; use the reset flow to activate the account.
      await t.drain();
      const { decryptSecret } = await import('../src/database/common/crypto');
      const n = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', 'desk@example.com').where('type', '=', 'PASSWORD_RESET').executeTakeFirst();
      // Sent notifications have their link stripped; issue a fresh reset for the test.
      expect(n!.status).toBe('SENT');
      await t.http().post('/auth/forgot-password').send({ email: 'desk@example.com' }).expect(200);
      const fresh = await t.db.selectFrom('notifications').selectAll().where('recipient', '=', 'desk@example.com').where('type', '=', 'PASSWORD_RESET').where('status', '=', 'QUEUED').executeTakeFirst();
      const token = new URL(decryptSecret((fresh!.metadata as { encryptedLink: string }).encryptedLink)).searchParams.get('token')!;
      await t.http().post('/auth/reset-password').send({ token, newPassword: 'Rec3ption-pass' }).expect(200);
      reception = await login(t, 'desk@example.com', 'Rec3ption-pass');
    });

    it('reception can create reservations and read inventory', async () => {
      await t.http().post('/reservations').set(bearer(reception.token)).send(reservationBody(a, day(6), day(7))).expect(201);
      await t.http().get(`/properties/${a.propertyId}/inventory`).query({ from: day(0), to: day(7) }).set(bearer(reception.token)).expect(200);
    });

    it('reception cannot manage rooms, rates, channels, staff, or delete the property', async () => {
      const denied = [
        await t.http().post(`/properties/${a.propertyId}/room-types`).set(bearer(reception.token)).send({ name: 'Suite', maxOccupancy: 2, basePrice: 1000 }),
        await t.http().post(`/properties/${a.propertyId}/rate-plans`).set(bearer(reception.token)).send({ roomTypeId: a.roomTypeId, name: 'X', code: 'X', type: 'CUSTOM', basePrice: 1, cancellationPolicy: { refundable: true } }),
        await t.http().post(`/properties/${a.propertyId}/channels/MOCK/connect`).set(bearer(reception.token)),
        await t.http().post(`/properties/${a.propertyId}/users`).set(bearer(reception.token)).send({ email: 'x@example.com', name: 'X', role: 'STAFF' }),
        await t.http().delete(`/properties/${a.propertyId}`).set(bearer(reception.token)),
        await t.http().post('/inventory/block').set(bearer(reception.token)).send({ propertyId: a.propertyId, roomTypeId: a.roomTypeId, startDate: day(1), endDate: day(2), reason: 'OWNER_BLOCK' }),
      ];
      for (const res of denied) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('reception cannot override prices (rates:manage)', async () => {
      const res = await t.http().post('/reservations').set(bearer(reception.token)).send(reservationBody(a, day(8), day(9), { discount: 50000 }));
      expect(res.status).toBe(403);
    });

    it('reception cannot create properties (organization-level role)', async () => {
      const res = await t.http().post('/properties').set(bearer(reception.token)).send({
        name: 'Nope', address: 'x', city: 'x', state: 'x', country: 'IN', postalCode: '1', timezone: 'Asia/Kolkata', currency: 'INR',
      });
      expect(res.status).toBe(403);
    });

    it('owners are not SUPER_ADMIN', async () => {
      for (const path of ['/admin/properties', '/admin/reservations', '/admin/sync-errors', '/admin/channel-connections', '/admin/audit-logs']) {
        expect((await t.http().get(path).set(bearer(ownerA.token))).status).toBe(403);
      }
    });

    it('SUPER_ADMIN can use admin endpoints and reach any property', async () => {
      const { hashPassword } = await import('../src/database/common/crypto');
      await t.db
        .insertInto('users')
        .values({ organizationId: null, name: 'Platform Admin', email: 'root@tirvona.test', passwordHash: await hashPassword('R00t-password!'), role: 'SUPER_ADMIN', status: 'ACTIVE' })
        .execute();
      const admin = await login(t, 'root@tirvona.test', 'R00t-password!');
      const props = await t.http().get('/admin/properties').set(bearer(admin.token)).expect(200);
      expect(props.body.data.total).toBeGreaterThanOrEqual(2);
      await t.http().get(`/properties/${b.propertyId}`).set(bearer(admin.token)).expect(200);
      const audit = await t.http().get('/admin/audit-logs').query({ action: 'auth.login' }).set(bearer(admin.token)).expect(200);
      expect(audit.body.data.total).toBeGreaterThan(0);
      expect(JSON.stringify(audit.body)).not.toMatch(/password|Str0ng|R00t/i);
    });
  });
});
