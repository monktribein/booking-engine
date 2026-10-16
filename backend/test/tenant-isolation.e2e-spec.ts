import { bearer, createMember, createPropertyWithRooms, day, publicBookingBody, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { connectMock, mapMock } from './utils/channels';
import { listRoutes } from './utils/routes';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * Partner A must never reach partner B's data by changing an id, a URL, a property id, an API key or a request body.
 *
 * The first test is a sweep: it takes EVERY authenticated route of the running app (read from the controllers' own metadata,
 * so a route added tomorrow is covered automatically), fills each `:param` with every id that belongs to B, and calls it as
 * users of A with several roles. The only acceptable answers are 400 / 401 / 403 / 404: never a 2xx (a leak), never a 5xx
 * (a crash), and never a 409 / 422 (which would reveal that the id exists). Afterwards B's data must be unchanged.
 */
describe('Tenant isolation', () => {
  let t: TestApp;
  let ownerA: Session;
  let ownerB: Session;
  let devA: Session;
  let receptionA: Session;
  let managerA: Session;
  let a: PropertySetup;
  let b: PropertySetup;
  const bIds: Record<string, string> = {};
  let bCode: string;
  let keyA: string;
  let keyB: string;

  beforeAll(async () => {
    t = await createTestApp({ BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' });
    ownerA = await registerOwner(t, 'tenant-a');
    ownerB = await registerOwner(t, 'tenant-b');
    a = await createPropertyWithRooms(t, ownerA.token, 3);
    b = await createPropertyWithRooms(t, ownerB.token, 3);
    devA = await createMember(t, ownerA, 'DEVELOPER');
    receptionA = await createMember(t, ownerA, 'RECEPTION', a.propertyId);
    managerA = await createMember(t, ownerA, 'PROPERTY_MANAGER', a.propertyId);

    // Everything B owns that has an id.
    const res = await t.http().post('/reservations').set(bearer(ownerB.token)).send(reservationBody(b, day(5), day(7))).expect(201);
    bIds.reservationId = res.body.data._id;
    bCode = res.body.data.reservationCode;
    bIds.reservationRoomId = res.body.data.reservationRooms[0]._id;
    bIds.guestId = res.body.data.guestId;
    const pay = await t.http().post('/payments/create').set(bearer(ownerB.token)).send({ reservationId: bIds.reservationId, provider: 'CASH', amount: 100000, reference: 'RCPT-B' }).expect(201);
    bIds.paymentId = pay.body.data.payment?._id ?? pay.body.data._id;
    Object.assign(bIds, { propertyId: b.propertyId, roomTypeId: b.roomTypeId, roomId: b.roomIds[0], ratePlanId: b.ratePlanId });
    await connectMock(t, ownerB.token, b);
    await mapMock(t, ownerB.token, b).expect(201);
    const keyRes = await t.http().post('/api-keys').set(bearer(ownerB.token)).send({ name: 'B key', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] }).expect(201);
    bIds.apiKeyId = keyRes.body.data._id;
    keyB = keyRes.body.data.key;
    keyA = (await t.http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'A key', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] }).expect(201)).body.data.key;
    const ep = await t.http().post('/webhook-endpoints').set(bearer(ownerB.token)).send({ url: 'http://127.0.0.1:9/b', events: ['*'] }).expect(201);
    bIds.endpointId = ep.body.data._id;
    await t.http().post(`/webhook-endpoints/${bIds.endpointId}/test`).set(bearer(ownerB.token)).expect(202);
    await t.drain();
    bIds.deliveryId = (await t.db.selectFrom('webhookDeliveries').select('id').where('endpointId', '=', bIds.endpointId).executeTakeFirstOrThrow()).id;
    const ir = await t.http().post('/integration-requests').set(bearer(ownerB.token)).send({ channel: 'AIRBNB', propertyId: b.propertyId }).expect(201);
    bIds.integrationRequestId = ir.body.data._id;
    const staffB = await createMember(t, ownerB, 'RECEPTION', b.propertyId);
    bIds.userId = staffB.userId;
    bIds.organizationId = (await t.db.selectFrom('users').select('organizationId').where('id', '=', ownerB.userId).executeTakeFirstOrThrow()).organizationId!;
    bIds.notificationId = (await t.db.selectFrom('notifications').select('id').where('propertyId', '=', b.propertyId).executeTakeFirstOrThrow()).id;
    const conn = await t.db.selectFrom('channelConnections').select('id').where('propertyId', '=', b.propertyId).executeTakeFirstOrThrow();
    bIds.connectionId = conn.id;
    const listing = await t.db.selectFrom('channelListings').select('id').where('propertyId', '=', b.propertyId).executeTakeFirstOrThrow();
    bIds.listingId = listing.id;
    const mapping = await t.db.selectFrom('channelRoomMappings').select('id').where('propertyId', '=', b.propertyId).executeTakeFirstOrThrow();
    bIds.mappingId = mapping.id;
    bIds.syncJobId = (await t.db.selectFrom('syncJobs').select('id').where('propertyId', '=', b.propertyId).executeTakeFirstOrThrow()).id;
    const promo = await t.db
      .insertInto('promotions')
      .values({ propertyId: b.propertyId, code: 'BSECRET', name: 'B promo', type: 'PERCENTAGE', value: 50, validFrom: day(0), validTo: day(300) })
      .returning('id')
      .executeTakeFirstOrThrow();
    bIds.promotionId = promo.id;
  });
  afterAll(() => t.close());

  const stateOfB = async () => ({
    reservations: (await t.http().get('/reservations').query({ propertyId: b.propertyId }).set(bearer(ownerB.token)).expect(200)).body.data.total,
    rooms: (await t.http().get(`/room-types/${b.roomTypeId}/rooms`).set(bearer(ownerB.token)).expect(200)).body.data.length ?? undefined,
    property: (await t.http().get(`/properties/${b.propertyId}`).set(bearer(ownerB.token)).expect(200)).body.data,
    keys: (await t.http().get('/api-keys').set(bearer(ownerB.token)).expect(200)).body.data.length,
    endpoints: (await t.http().get('/webhook-endpoints').set(bearer(ownerB.token)).expect(200)).body.data.length,
    integrationRequests: (await t.http().get('/integration-requests').set(bearer(ownerB.token)).expect(200)).body.data.length,
    inventory: JSON.stringify((await t.http().get(`/properties/${b.propertyId}/inventory`).query({ from: day(0), to: day(10) }).set(bearer(ownerB.token)).expect(200)).body.data),
    payments: (await t.http().get('/payments').query({ reservationId: bIds.reservationId }).set(bearer(ownerB.token)).expect(200)).body.data.length,
  });

  it('sweep: no authenticated route of the app reveals or changes B\'s data when called with B\'s ids by A\'s users', async () => {
    const routes = listRoutes(t.app).filter((r) => !r.isPublic && r.params.length > 0);
    expect(routes.length).toBeGreaterThan(60); // the sweep must actually be looking at the app
    const before = await stateOfB();

    const candidates = Object.values(bIds);
    const fixed: Record<string, string> = { channel: 'MOCK', code: bCode, slug: b.slug };
    const attackers: [string, Session][] = [['owner of A', ownerA], ['developer of A', devA], ['reception of A', receptionA], ['manager of A', managerA]];
    const bad: string[] = [];
    let calls = 0;
    for (const [who, session] of attackers) {
      for (const r of routes) {
        for (const id of candidates) {
          const path = r.path.replace(/:([A-Za-z]+)/g, (_, p: string) => fixed[p] ?? id);
          if (path.startsWith('/auth/')) continue; // own account only
          const req = t.http()[r.method](path).set(bearer(session.token));
          const res = r.method === 'get' || r.method === 'delete' ? await req : await req.send({});
          calls++;
          if (![400, 401, 403, 404].includes(res.status)) bad.push(`${who}: ${r.method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(1500);
    expect(bad).toEqual([]);
    expect(await stateOfB()).toEqual(before); // nothing of B was changed, by any method
  }, 600_000);

  it('sweep: the same routes need a login (no token, no data)', async () => {
    const routes = listRoutes(t.app).filter((r) => !r.isPublic && r.params.length > 0 && !r.path.startsWith('/v1'));
    const bad: string[] = [];
    for (const r of routes) {
      const path = r.path.replace(/:([A-Za-z]+)/g, (_, p: string) => (p === 'channel' ? 'MOCK' : bIds.propertyId));
      const res = r.method === 'get' || r.method === 'delete' ? await t.http()[r.method](path) : await t.http()[r.method](path).send({});
      if (res.status !== 401) bad.push(`${r.method.toUpperCase()} ${path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it("ids smuggled in a request body or query string do not reach B", async () => {
    const before = await stateOfB();
    const other = reservationBody(a, day(20), day(21));
    const denied = (res: { status: number }) => expect([400, 403, 404]).toContain(res.status);
    // A's property, B's room type / rate plan inside the body.
    denied(await t.http().post('/reservations').set(bearer(ownerA.token)).send({ ...other, rooms: [{ roomTypeId: b.roomTypeId, ratePlanId: b.ratePlanId, quantity: 1 }] }));
    denied(await t.http().post('/reservations').set(bearer(ownerA.token)).send({ ...other, rooms: [{ roomTypeId: a.roomTypeId, ratePlanId: b.ratePlanId, quantity: 1 }] }));
    // B's property in the body or query.
    denied(await t.http().post('/reservations').set(bearer(ownerA.token)).send(reservationBody(b, day(20), day(21))));
    denied(await t.http().get('/reservations').query({ propertyId: b.propertyId }).set(bearer(ownerA.token)));
    denied(await t.http().get('/guests').query({ propertyId: b.propertyId }).set(bearer(ownerA.token)));
    denied(await t.http().post('/guests').set(bearer(ownerA.token)).send({ propertyId: b.propertyId, firstName: 'X', lastName: 'Y' }));
    denied(await t.http().get('/payments').query({ reservationId: bIds.reservationId }).set(bearer(ownerA.token)));
    denied(await t.http().post('/payments/create').set(bearer(ownerA.token)).send({ reservationId: bIds.reservationId, provider: 'CASH', amount: 1 }));
    denied(await t.http().put(`/properties/${a.propertyId}/restrictions`).set(bearer(ownerA.token)).send({ roomTypeId: b.roomTypeId, from: day(30), to: day(31), stopSell: true }));
    denied(await t.http().post('/reservations').set(bearer(ownerA.token)).send({ ...other, guest: { guestId: bIds.guestId } }));
    // Credentials scoped to B's property or integrations for B's property.
    denied(await t.http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'sneaky key', scopes: ['properties:read'], propertyIds: [b.propertyId] }));
    denied(await t.http().post('/webhook-endpoints').set(bearer(ownerA.token)).send({ url: 'http://127.0.0.1:9/a', events: ['*'], propertyIds: [b.propertyId] }));
    denied(await t.http().post('/integration-requests').set(bearer(ownerA.token)).send({ channel: 'AIRBNB', propertyId: b.propertyId }));
    expect(await stateOfB()).toEqual(before);
  });

  it("another partner's API key and /v1 slugs, codes and idempotency keys never cross", async () => {
    const asA = { Authorization: `Bearer ${keyA}` };
    const asB = { Authorization: `Bearer ${keyB}` };
    expect((await t.http().get('/v1/properties').set(asA).expect(200)).body.data.map((p: { slug: string }) => p.slug)).toEqual([a.slug]);
    for (const [method, path] of [['get', `/v1/properties/${b.slug}`], ['get', `/v1/properties/${b.slug}/availability?checkIn=${day(5)}&checkOut=${day(6)}&adults=1`], ['get', `/v1/reservations/${bCode}`], ['post', `/v1/reservations/${bCode}/cancel`]] as const) {
      const res = await t.http()[method](path).set(asA);
      expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    }
    expect((await t.http().get('/v1/reservations').set(asA).expect(200)).body.data.items).toEqual([]); // B's booking is not listed for A
    const body = { propertySlug: b.slug, checkIn: day(40), checkOut: day(41), adults: 1, rooms: [{ roomTypeId: b.roomTypeId, ratePlanId: b.ratePlanId, quantity: 1 }], guest: { firstName: 'Mallory', lastName: 'Xu', email: 'm@example.com', phone: '+447700900123' } };
    const cross = await t.http().post('/v1/reservations').set(asA).set('Idempotency-Key', 'shared-key-0001').send(body);
    expect([cross.status, JSON.stringify(cross.body.error)]).toEqual([404, expect.anything()]);
    // The same Idempotency-Key used by both partners creates two separate bookings: keys are scoped per API key.
    const bodyA = { ...body, propertySlug: a.slug, rooms: [{ roomTypeId: a.roomTypeId, ratePlanId: a.ratePlanId, quantity: 1 }] };
    const bodyB = { ...body, rooms: [{ roomTypeId: b.roomTypeId, ratePlanId: b.ratePlanId, quantity: 1 }] };
    const ra = await t.http().post('/v1/reservations').set(asA).set('Idempotency-Key', 'shared-key-0002').send(bodyA).expect(201);
    const rb = await t.http().post('/v1/reservations').set(asB).set('Idempotency-Key', 'shared-key-0002').send(bodyB).expect(201);
    expect(ra.body.data.reservation.reservationCode).not.toBe(rb.body.data.reservation.reservationCode);
    expect(ra.body.data.reservation.propertySlug).toBe(a.slug);
    expect(rb.body.data.reservation.propertySlug).toBe(b.slug);
    // A key restricted to one property of its own organization cannot reach another property of that organization.
    const a2 = await createPropertyWithRooms(t, ownerA.token, 1);
    const restricted = (await t.http().post('/api-keys').set(bearer(ownerA.token)).send({ name: 'Only first', scopes: ['properties:read'], propertyIds: [a.propertyId] }).expect(201)).body.data.key as string;
    expect((await t.http().get(`/v1/properties/${a.slug}`).set({ Authorization: `Bearer ${restricted}` })).status).toBe(200);
    expect((await t.http().get(`/v1/properties/${a2.slug}`).set({ Authorization: `Bearer ${restricted}` })).status).toBe(404);
  });

  it("background work stays inside the tenant: B's booking is delivered only to B's webhook endpoints", async () => {
    const epA = (await t.http().post('/webhook-endpoints').set(bearer(ownerA.token)).send({ url: 'http://127.0.0.1:9/a-hook', events: ['*'] }).expect(201)).body.data;
    const countFor = async (endpointId: string) => Number((await t.db.selectFrom('webhookDeliveries').select((eb) => eb.fn.countAll<string>().as('n')).where('endpointId', '=', endpointId).where('eventType', '<>', 'ping').executeTakeFirstOrThrow()).n);
    const beforeA = await countFor(epA._id);
    const beforeB = await countFor(bIds.endpointId);
    await t.http().post('/public/reservations').send(publicBookingBody(b, day(50), day(51))).expect(201);
    await t.drain();
    expect(await countFor(epA._id)).toBe(beforeA); // nothing for A
    expect(await countFor(bIds.endpointId)).toBeGreaterThan(beforeB); // B gets its own event
    // The event bodies B received describe only B's property.
    const bodies = (await t.db.selectFrom('webhookDeliveries').select('body').where('endpointId', '=', bIds.endpointId).execute()).map((d) => d.body).join('');
    expect(bodies).not.toContain(a.propertyId);
    // And A's notifications are A's alone.
    const inboxA = JSON.stringify((await t.http().get('/notifications').set(bearer(ownerA.token)).expect(200)).body.data);
    expect(inboxA).not.toContain(b.propertyId);
  });
});
