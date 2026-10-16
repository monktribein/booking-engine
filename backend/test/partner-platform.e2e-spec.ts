import { bearer, createMember, createPlatformAdmin, createPropertyWithRooms, day, listOnMarketplace, publicBookingBody, registerOwner, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

/**
 * Partner onboarding (approval), suspension, and what the platform administrators may and may not do.
 * This suite turns the approval requirement ON, which is the production default.
 */
describe('Partner approval, suspension and platform administration', () => {
  let t: TestApp;
  let admin: Session; // SUPER_ADMIN
  let ops: Session; // OPERATIONS_ADMIN
  let owner: Session;
  let orgId: string;
  let s: PropertySetup;
  let ip = 0;

  const status = async (token: string) => (await t.http().get('/users/me').set(bearer(token)).expect(200)).body.data.organizationStatus as string;
  const publicPage = () => t.http().get(`/public/properties/${s.slug}`).set('X-Forwarded-For', `10.8.0.${++ip % 250}`);
  const createKey = (token: string, extra: Record<string, unknown> = {}) =>
    t.http().post('/api-keys').set(bearer(token)).send({ name: 'Integration', scopes: ['properties:read'], ...extra });

  beforeAll(async () => {
    t = await createTestApp({ PARTNER_APPROVAL_REQUIRED: 'true', BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' });
    admin = await createPlatformAdmin(t, 'SUPER_ADMIN', 'root');
    ops = await createPlatformAdmin(t, 'OPERATIONS_ADMIN', 'ops');
    owner = await registerOwner(t, 'partner');
    orgId = (await t.db.selectFrom('users').select('organizationId').where('id', '=', owner.userId).executeTakeFirstOrThrow()).organizationId!;
  });
  afterAll(() => t.close());

  it('registration creates a partner that waits for approval, and tells them so', async () => {
    expect(await status(owner.token)).toBe('PENDING_APPROVAL');
    const org = (await t.http().get('/organizations/me').set(bearer(owner.token)).expect(200)).body.data;
    expect(org).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  it('a pending partner can set up privately, but cannot go public, issue API keys, receive webhooks or ask for integrations', async () => {
    s = await createPropertyWithRooms(t, owner.token, 3, { publish: false }); // the PMS works
    const denied = async (res: Promise<{ status: number; body: { error: { code: string } } }>) => {
      const r = await res;
      expect([r.status, r.body.error.code]).toEqual([403, 'ORGANIZATION_NOT_APPROVED']);
    };
    await denied(createKey(owner.token));
    await denied(t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url: 'http://127.0.0.1:9/h', events: ['*'] }));
    await denied(t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: true }));
    await denied(t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send({ consent: true }));
    await denied(t.http().post('/integration-requests').set(bearer(owner.token)).send({ channel: 'AIRBNB' }));
    expect((await publicPage()).status).toBe(404);
  });

  it('only platform staff reach /admin; partners get 403 whatever they send', async () => {
    for (const path of ['/admin/partners', '/admin/properties', '/admin/integration-requests', '/admin/audit-logs']) {
      expect((await t.http().get(path).set(bearer(owner.token))).status).toBe(403);
    }
    expect((await t.http().post(`/admin/partners/${orgId}/approve`).set(bearer(owner.token)).send({})).status).toBe(403); // cannot approve itself
    expect((await t.http().get('/admin/partners')).status).toBe(401);
  });

  it('operations staff see the queue (pending first) and approve; a second decision is a conflict', async () => {
    const list = (await t.http().get('/admin/partners').query({ status: 'PENDING_APPROVAL' }).set(bearer(ops.token)).expect(200)).body.data;
    expect(list.items.map((i: { _id: string }) => i._id)).toContain(orgId);
    expect(list.items.find((i: { _id: string }) => i._id === orgId)).toMatchObject({ ownerEmail: owner.email, status: 'PENDING_APPROVAL', properties: 1 });
    await t.http().post(`/admin/partners/${orgId}/approve`).set(bearer(ops.token)).send({}).expect(200);
    expect(await status(owner.token)).toBe('ACTIVE');
    const again = await t.http().post(`/admin/partners/${orgId}/approve`).set(bearer(ops.token)).send({});
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
  });

  it('after approval the partner can use every feature', async () => {
    expect((await createKey(owner.token)).status).toBe(201);
    await t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: true }).expect(200);
    expect((await publicPage()).status).toBe(200);
  });

  it('a decision needs a reason where it matters, and rejection locks the partner out but lets them read why', async () => {
    const second = await registerOwner(t, 'rejected');
    const id = (await t.db.selectFrom('users').select('organizationId').where('id', '=', second.userId).executeTakeFirstOrThrow()).organizationId!;
    expect((await t.http().post(`/admin/partners/${id}/reject`).set(bearer(ops.token)).send({})).status).toBe(400);
    await t.http().post(`/admin/partners/${id}/reject`).set(bearer(ops.token)).send({ reason: 'Could not verify the business' }).expect(200);
    const locked = await t.http().get('/properties').set(bearer(second.token));
    expect([locked.status, locked.body.error.code]).toEqual([403, 'ORGANIZATION_DISABLED']);
    const me = (await t.http().get('/users/me').set(bearer(second.token)).expect(200)).body.data;
    expect(me.organizationStatus).toBe('REJECTED');
    expect((await t.http().get('/organizations/me').set(bearer(second.token)).expect(200)).body.data.statusReason).toBe('Could not verify the business');
    await t.http().post('/auth/logout').set(bearer(second.token)).expect(200); // can still sign out
    // A rejected partner can be approved later (for example after sending documents).
    await t.http().post(`/admin/partners/${id}/approve`).set(bearer(ops.token)).send({}).expect(200);
  });

  it('only a SUPER_ADMIN suspends; suspension stops the partner, its API keys, its public pages and its webhooks, and reactivation restores them', async () => {
    const key = (await createKey(owner.token, { name: 'Live key' })).body.data.key as string;
    expect((await t.http().get('/v1/properties').set({ Authorization: `Bearer ${key}` })).status).toBe(200);
    const endpoint = (await t.http().post('/webhook-endpoints').set(bearer(owner.token)).send({ url: 'http://127.0.0.1:9/hook', events: ['*'] }).expect(201)).body.data;
    // An event already waiting for delivery when the suspension happens.
    const delivery = await t.db
      .insertInto('webhookDeliveries')
      .values({ organizationId: orgId, endpointId: endpoint._id, eventId: 'evt_suspend_test', eventType: 'ping', body: '{"id":"evt_suspend_test"}' })
      .returning('id')
      .executeTakeFirstOrThrow();

    expect((await t.http().post(`/admin/partners/${orgId}/suspend`).set(bearer(ops.token)).send({ reason: 'x' })).status).toBe(403); // operations cannot suspend
    expect((await t.http().post(`/admin/partners/${orgId}/suspend`).set(bearer(admin.token)).send({})).status).toBe(400); // reason required
    await t.http().post(`/admin/partners/${orgId}/suspend`).set(bearer(admin.token)).send({ reason: 'Chargebacks under review' }).expect(200);

    const locked = await t.http().get('/properties').set(bearer(owner.token));
    expect([locked.status, locked.body.error.code]).toEqual([403, 'ORGANIZATION_DISABLED']);
    expect(await status(owner.token)).toBe('SUSPENDED');
    const viaKey = await t.http().get('/v1/properties').set({ Authorization: `Bearer ${key}` });
    expect([viaKey.status, viaKey.body.error.code]).toEqual([403, 'ORGANIZATION_NOT_ACTIVE']);
    expect((await publicPage()).status).toBe(404);
    expect((await t.http().post('/public/reservations').send(publicBookingBody(s, day(5), day(6)))).status).toBe(404);
    await t.drain();
    expect(await t.db.selectFrom('webhookDeliveries').select(['status', 'lastError']).where('id', '=', delivery.id).executeTakeFirst()).toMatchObject({ status: 'FAILED', lastError: 'Organization is not active' });

    await t.http().post(`/admin/partners/${orgId}/reactivate`).set(bearer(admin.token)).send({}).expect(200);
    expect((await t.http().get('/v1/properties').set({ Authorization: `Bearer ${key}` })).status).toBe(200);
    expect((await publicPage()).status).toBe(200);
    expect((await t.http().get('/properties').set(bearer(owner.token))).status).toBe(200);
  });

  it('every decision is in the audit trail, which only a SUPER_ADMIN can read', async () => {
    const logs = (await t.http().get('/admin/audit-logs').query({ limit: 100 }).set(bearer(admin.token)).expect(200)).body.data.items as { action: string; organizationId: string }[];
    const actions = logs.filter((l) => l.organizationId === orgId).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.partner_approve', 'admin.partner_suspend', 'admin.partner_reactivate']));
    expect((await t.http().get('/admin/audit-logs').set(bearer(ops.token))).status).toBe(403);
  });

  it('platform staff see bookings without guest contact details', async () => {
    await t.http().post('/public/reservations').send(publicBookingBody(s, day(7), day(8))).expect(201);
    const list = (await t.http().get('/admin/reservations').set(bearer(ops.token)).expect(200)).body.data.items as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/emma@example\.com|\+447700900123|Clarke/);
    expect(list[0]).toMatchObject({ guest: { firstName: 'Emma', lastInitial: 'C.' } });
    // The partner detail page lists people by e-mail (needed to contact them) but never bookings or guests.
    const detail = (await t.http().get(`/admin/partners/${orgId}`).set(bearer(ops.token)).expect(200)).body.data;
    expect(detail.users[0]).toHaveProperty('email');
    expect(JSON.stringify(detail)).not.toMatch(/emma@example\.com/);
  });

  it('operations staff cannot reach partner data through the property endpoints', async () => {
    for (const path of [`/properties/${s.propertyId}`, `/properties/${s.propertyId}/room-types`, `/reservations?propertyId=${s.propertyId}`]) {
      expect([403, 404]).toContain((await t.http().get(path).set(bearer(ops.token))).status);
    }
  });
});

describe('Property visibility, marketplace consent and suspension', () => {
  let t: TestApp;
  let admin: Session;
  let owner: Session;
  let s: PropertySetup;
  let ip = 0;

  const get = (path: string) => t.http().get(path).set('X-Forwarded-For', `10.9.0.${++ip % 250}`);
  const visibility = async () => (await t.http().get(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).expect(200)).body.data;
  const inSearch = async () => ((await get('/public/properties').expect(200)).body.data.items as { slug: string }[]).some((i) => i.slug === s.slug);
  const book = (extra: Record<string, unknown> = {}) => t.http().post('/public/reservations').send(publicBookingBody(s, day(10), day(11), extra));

  beforeAll(async () => {
    t = await createTestApp({ BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' });
    admin = await createPlatformAdmin(t);
    owner = await registerOwner(t, 'vis');
    s = await createPropertyWithRooms(t, owner.token, 5, { publish: false });
  });
  afterAll(() => t.close());

  it('a new property is private: the public cannot see or book it, the owner can still run it', async () => {
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(404);
    expect((await book()).status).toBe(404);
    expect(await inSearch()).toBe(false);
    expect(await visibility()).toMatchObject({ directBookingEnabled: false, publiclyBookable: false, listedOnMarketplace: false, marketplace: { status: 'NOT_LISTED' } });
    await t.http().post('/reservations').set(bearer(owner.token)).send({ propertyId: s.propertyId, source: 'PHONE', guest: { firstName: 'Walk', lastName: 'In' }, checkIn: day(3), checkOut: day(4), adults: 1, rooms: [{ roomTypeId: s.roomTypeId, ratePlanId: s.ratePlanId, quantity: 1 }] }).expect(201);
  });

  it("publishing the property's own page makes it bookable as a DIRECT booking, but not part of the marketplace", async () => {
    await t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: true }).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(200);
    const res = await book().expect(201);
    expect(res.body.data.reservation.reservationCode).toBeTruthy();
    expect(await t.db.selectFrom('reservations').select('source').where('reservationCode', '=', res.body.data.reservation.reservationCode).executeTakeFirstOrThrow()).toMatchObject({ source: 'DIRECT' });
    expect(await inSearch()).toBe(false);
  });

  it('a booking that claims to come from the marketplace is only attributed to it when the property is approved there', async () => {
    const res = await book({ source: 'TIRVONA' }).expect(201);
    expect(await t.db.selectFrom('reservations').select('source').where('reservationCode', '=', res.body.data.reservation.reservationCode).executeTakeFirstOrThrow()).toMatchObject({ source: 'DIRECT' });
  });

  it('the marketplace needs explicit consent and a complete listing', async () => {
    const req = (body: Record<string, unknown>) => t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send(body);
    expect((await req({})).status).toBe(400);
    expect((await req({ consent: false })).status).toBe(400);
    const incomplete = await req({ consent: true });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.details.missing).toEqual(expect.arrayContaining(['A description of at least 50 characters', 'At least one photo']));
    expect((await visibility()).eligibleForMarketplace).toBe(false);
  });

  it('a request is not a listing: it appears only after the platform approves', async () => {
    await t
      .http()
      .patch(`/properties/${s.propertyId}`)
      .set(bearer(owner.token))
      .send({ description: 'A quiet guest house near the temples with clean rooms, a vegetarian kitchen and friendly staff.', images: [{ url: 'https://images.example.com/a.jpg', sortOrder: 0 }] })
      .expect(200);
    expect((await visibility()).eligibleForMarketplace).toBe(true);
    await t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send({ consent: true }).expect(200);
    const v = await visibility();
    expect(v.marketplace).toMatchObject({ status: 'REQUESTED' });
    expect(v.marketplace.consentAt).toBeTruthy();
    expect(await inSearch()).toBe(false);
    expect((await t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send({ consent: true })).status).toBe(409); // already requested

    const queue = (await t.http().get('/admin/properties').query({ marketplaceStatus: 'REQUESTED' }).set(bearer(admin.token)).expect(200)).body.data.items as { _id: string }[];
    expect(queue.map((p) => p._id)).toContain(s.propertyId);
    expect((await t.http().post(`/admin/properties/${s.propertyId}/marketplace/reject`).set(bearer(admin.token)).send({})).status).toBe(400); // note required
    await t.http().post(`/admin/properties/${s.propertyId}/marketplace/reject`).set(bearer(admin.token)).send({ reason: 'Photos do not show the rooms' }).expect(200);
    expect((await visibility()).marketplace).toMatchObject({ status: 'REJECTED', note: 'Photos do not show the rooms' });
    expect(await inSearch()).toBe(false);

    // The owner fixes the listing and asks again.
    await t.http().post(`/properties/${s.propertyId}/marketplace/request`).set(bearer(owner.token)).send({ consent: true }).expect(200);
    await t.http().post(`/admin/properties/${s.propertyId}/marketplace/approve`).set(bearer(admin.token)).send({}).expect(200);
    expect(await inSearch()).toBe(true);
    expect(await visibility()).toMatchObject({ listedOnMarketplace: true, marketplace: { status: 'APPROVED' } });
  });

  it('once approved, a marketplace booking is recorded as TIRVONA', async () => {
    const res = await book({ source: 'TIRVONA' }).expect(201);
    expect(await t.db.selectFrom('reservations').select('source').where('reservationCode', '=', res.body.data.reservation.reservationCode).executeTakeFirstOrThrow()).toMatchObject({ source: 'TIRVONA' });
  });

  it('withdrawing leaves the marketplace and takes the consent back (the page stays up if the owner kept it on)', async () => {
    await t.http().post(`/properties/${s.propertyId}/marketplace/withdraw`).set(bearer(owner.token)).expect(200);
    expect(await inSearch()).toBe(false);
    const row = await t.db.selectFrom('properties').select(['marketplaceStatus', 'marketplaceConsentAt', 'marketplaceConsentBy']).where('id', '=', s.propertyId).executeTakeFirstOrThrow();
    expect(row).toEqual({ marketplaceStatus: 'NOT_LISTED', marketplaceConsentAt: null, marketplaceConsentBy: null });
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(200); // direct page still on
    await t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: false }).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(404);
    expect((await book()).status).toBe(404);
  });

  it('a platform suspension of the listing cannot be undone by the owner', async () => {
    await listOnMarketplace(t, owner, admin, s);
    expect(await inSearch()).toBe(true);
    expect((await t.http().post(`/admin/properties/${s.propertyId}/marketplace/suspend`).set(bearer(admin.token)).send({})).status).toBe(400);
    await t.http().post(`/admin/properties/${s.propertyId}/marketplace/suspend`).set(bearer(admin.token)).send({ reason: 'Guest complaints' }).expect(200);
    expect(await inSearch()).toBe(false);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(404); // not approved, direct page is off
    for (const path of ['marketplace/request', 'marketplace/withdraw']) {
      const r = await t.http().post(`/properties/${s.propertyId}/${path}`).set(bearer(owner.token)).send({ consent: true });
      expect([r.status, r.body.error.code]).toEqual([409, 'MARKETPLACE_SUSPENDED']);
    }
    await t.http().post(`/admin/properties/${s.propertyId}/marketplace/reinstate`).set(bearer(admin.token)).expect(200);
    expect(await inSearch()).toBe(true);
  });

  it('a suspended property cannot be booked by anyone but staff, and the owner cannot lift the suspension', async () => {
    await t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: true }).expect(200);
    const key = (await t.http().post('/api-keys').set(bearer(owner.token)).send({ name: 'Suspension test key', scopes: ['properties:read', 'reservations:write', 'availability:read'] }).expect(201)).body.data.key as string;
    const auth = { Authorization: `Bearer ${key}` };
    expect((await t.http().get(`/v1/properties/${s.slug}`).set(auth)).status).toBe(200);
    const guestBooking = (await book().expect(201)).body.data.reservation.reservationCode as string;

    await t.http().post(`/admin/properties/${s.propertyId}/suspend`).set(bearer(admin.token)).send({ reason: 'Safety inspection failed' }).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(404);
    expect((await book()).status).toBe(404);
    expect(await inSearch()).toBe(false);
    expect((await t.http().get(`/v1/properties/${s.slug}`).set(auth)).status).toBe(404);
    for (const body of [{ status: 'ACTIVE' }, { status: 'INACTIVE' }]) {
      const r = await t.http().patch(`/properties/${s.propertyId}`).set(bearer(owner.token)).send(body);
      expect([r.status, r.body.error.code]).toEqual([403, 'PROPERTY_SUSPENDED']);
    }
    expect((await t.http().patch(`/properties/${s.propertyId}/visibility`).set(bearer(owner.token)).send({ directBookingEnabled: true })).status).toBe(403);
    expect((await t.http().post(`/admin/properties/${s.propertyId}/suspend`).set(bearer(admin.token)).send({ reason: 'again' })).status).toBe(409);
    // Guests who already booked can still look their booking up.
    expect((await get(`/public/reservations/${guestBooking}`).query({ email: 'emma@example.com' })).status).toBe(200);

    await t.http().post(`/admin/properties/${s.propertyId}/reactivate`).set(bearer(admin.token)).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(200);
  });

  it('an INACTIVE or DRAFT property is not bookable publicly even when published', async () => {
    await t.http().patch(`/properties/${s.propertyId}`).set(bearer(owner.token)).send({ status: 'INACTIVE' }).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(404);
    expect(await inSearch()).toBe(false);
    await t.http().patch(`/properties/${s.propertyId}`).set(bearer(owner.token)).send({ status: 'ACTIVE' }).expect(200);
    expect((await get(`/public/properties/${s.slug}`)).status).toBe(200);
  });
});

describe('Roles: developer, manager, reception', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let developer: Session;
  let manager: Session;
  let reception: Session;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t, 'roles');
    s = await createPropertyWithRooms(t, owner.token, 3);
    developer = await createMember(t, owner, 'DEVELOPER');
    manager = await createMember(t, owner, 'PROPERTY_MANAGER', s.propertyId);
    reception = await createMember(t, owner, 'RECEPTION', s.propertyId);
  });
  afterAll(() => t.close());

  it('a developer manages API keys and webhooks and sees nothing about bookings, guests or properties', async () => {
    const key = await t.http().post('/api-keys').set(bearer(developer.token)).send({ name: 'CI key', scopes: ['properties:read'] });
    expect(key.status).toBe(201);
    expect((await t.http().get('/api-keys').set(bearer(developer.token)).expect(200)).body.data).toHaveLength(1);
    await t.http().post('/webhook-endpoints').set(bearer(developer.token)).send({ url: 'http://127.0.0.1:9/h', events: ['reservation.created'] }).expect(201);
    expect((await t.http().get('/properties').set(bearer(developer.token)).expect(200)).body.data.items).toEqual([]);
    for (const path of [`/properties/${s.propertyId}`, `/reservations?propertyId=${s.propertyId}`, `/guests?propertyId=${s.propertyId}`, `/properties/${s.propertyId}/inventory?from=${day(1)}&to=${day(3)}`]) {
      expect([403, 404]).toContain((await t.http().get(path).set(bearer(developer.token))).status);
    }
    for (const [method, path] of [['get', '/organizations/me/members'], ['post', '/integration-requests'], ['post', '/properties'], ['patch', '/organizations/me']] as const) {
      expect((await t.http()[method](path).set(bearer(developer.token)).send({})).status).toBe(403);
    }
  });

  it('the owner lists the team, invites a developer (no password yet) and removes access immediately', async () => {
    const members = (await t.http().get('/organizations/me/members').set(bearer(owner.token)).expect(200)).body.data as { role: string; email: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(['DEVELOPER', 'PROPERTY_MANAGER', 'PROPERTY_OWNER', 'RECEPTION']);
    expect(JSON.stringify(members)).not.toMatch(/passwordHash|scrypt/);
    const invited = (await t.http().post('/organizations/me/developers').set(bearer(owner.token)).send({ name: 'Dev Two', email: 'dev.two@example.com' }).expect(201)).body.data;
    expect(invited).toMatchObject({ role: 'DEVELOPER', status: 'INVITED' });
    expect((await t.http().post('/auth/login').send({ email: 'dev.two@example.com', password: 'anything-at-all-1A' })).status).toBe(401);
    expect((await t.http().post('/organizations/me/developers').set(bearer(owner.token)).send({ name: 'Dup', email: 'dev.two@example.com' })).status).toBe(409);

    expect((await t.http().get('/api-keys').set(bearer(developer.token))).status).toBe(200);
    await t.http().delete(`/organizations/me/developers/${developer.userId}`).set(bearer(owner.token)).expect(200);
    expect((await t.http().get('/api-keys').set(bearer(developer.token))).status).toBe(401); // sessions ended at once
    // Only developers can be removed this way.
    expect((await t.http().delete(`/organizations/me/developers/${manager.userId}`).set(bearer(owner.token))).status).toBe(404);
  });

  it('a manager runs the property but cannot publish it or consent to the marketplace; reception only works the front desk', async () => {
    expect((await t.http().patch(`/properties/${s.propertyId}`).set(bearer(manager.token)).send({ description: 'Updated by the manager' })).status).toBe(200);
    for (const [method, path, body] of [
      ['patch', `/properties/${s.propertyId}/visibility`, { directBookingEnabled: false }],
      ['post', `/properties/${s.propertyId}/marketplace/request`, { consent: true }],
      ['post', `/properties/${s.propertyId}/marketplace/withdraw`, {}],
    ] as const) {
      expect((await t.http()[method](path).set(bearer(manager.token)).send(body)).status).toBe(403);
      expect((await t.http()[method](path).set(bearer(reception.token)).send(body)).status).toBe(403);
    }
    // Neither manages API keys, integrations or the team: those are organization-owner functions.
    for (const token of [manager.token, reception.token]) {
      expect((await t.http().post('/api-keys').set(bearer(token)).send({ name: 'x', scopes: ['properties:read'] })).status).toBe(403);
      expect((await t.http().post('/integration-requests').set(bearer(token)).send({ channel: 'AIRBNB' })).status).toBe(403);
      expect((await t.http().get('/organizations/me/members').set(bearer(token))).status).toBe(403);
    }
    // Reception can read reservations (front desk) but cannot change rates.
    expect((await t.http().get(`/reservations?propertyId=${s.propertyId}`).set(bearer(reception.token))).status).toBe(200);
    expect((await t.http().patch(`/properties/${s.propertyId}`).set(bearer(reception.token)).send({ description: 'hack' })).status).toBe(403);
  });

  it('integration requests: the owner asks, one open request per channel, the platform decides, and approval connects nothing', async () => {
    const admin = await createPlatformAdmin(t);
    const created = await t.http().post('/integration-requests').set(bearer(owner.token)).send({ channel: 'BOOKING_COM', propertyId: s.propertyId, note: 'We have a Booking.com listing' }).expect(201);
    expect((await t.http().post('/integration-requests').set(bearer(owner.token)).send({ channel: 'BOOKING_COM', propertyId: s.propertyId })).status).toBe(409);
    expect((await t.http().post('/integration-requests').set(bearer(owner.token)).send({ channel: 'MOCK' })).status).toBe(400); // only real OTA names
    const queue = (await t.http().get('/admin/integration-requests').query({ status: 'REQUESTED' }).set(bearer(admin.token)).expect(200)).body.data.items as { _id: string }[];
    expect(queue.map((r) => r._id)).toContain(created.body.data._id);
    expect((await t.http().post(`/admin/integration-requests/${created.body.data._id}/decide`).set(bearer(admin.token)).send({ status: 'REJECTED' })).status).toBe(400);
    await t.http().post(`/admin/integration-requests/${created.body.data._id}/decide`).set(bearer(admin.token)).send({ status: 'APPROVED', note: 'Go ahead once you hold partner credentials' }).expect(200);
    expect((await t.http().post(`/admin/integration-requests/${created.body.data._id}/decide`).set(bearer(admin.token)).send({ status: 'APPROVED' })).status).toBe(409);
    const mine = (await t.http().get('/integration-requests').set(bearer(owner.token)).expect(200)).body.data;
    expect(mine[0]).toMatchObject({ status: 'APPROVED', decisionNote: 'Go ahead once you hold partner credentials' });
    // Approval is a record, not a connection: the channel list still shows Booking.com as not connected.
    const channels = (await t.http().get(`/properties/${s.propertyId}/channels`).set(bearer(owner.token)).expect(200)).body.data as { channel: string; status: string }[];
    expect(channels.find((c) => c.channel === 'BOOKING_COM')!.status).not.toBe('CONNECTED');
    // Another partner cannot see or withdraw this request, and cannot reference this property.
    const other = await registerOwner(t, 'other');
    expect((await t.http().get('/integration-requests').set(bearer(other.token)).expect(200)).body.data).toEqual([]);
    expect((await t.http().post(`/integration-requests/${created.body.data._id}/withdraw`).set(bearer(other.token))).status).toBe(404);
    expect((await t.http().post('/integration-requests').set(bearer(other.token)).send({ channel: 'AIRBNB', propertyId: s.propertyId })).status).toBe(404);
  });
});
