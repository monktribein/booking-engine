import { MockChannelStore } from '../src/modules/channels/mock/mock-channel.adapter';
import { connectMock, mapMock } from './utils/channels';
import { bearer, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

describe('Channel manager: connection, mapping and sync', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let store: MockChannelStore;
  const pushed = (listing: string, room: string | null, date: string) => store.availability.get(store.key(listing, room, date))?.available;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 10);
    store = t.app.get(MockChannelStore);
  });
  afterAll(() => t.close());

  it('connects through the authorization flow; owners never enter API keys; tokens encrypted at rest', async () => {
    const { start, finalRedirect } = await connectMock(t, owner.token, s);
    expect(start.status).toBe('CONNECTING');
    expect(finalRedirect).toBe(`http://app.test/properties/${s.propertyId}/channels?connected=MOCK`);

    const list = await t.http().get(`/properties/${s.propertyId}/channels`).set(bearer(owner.token)).expect(200);
    const mock = list.body.data.find((c: { channel: string }) => c.channel === 'MOCK');
    expect(mock).toMatchObject({ status: 'CONNECTED', listings: 2 });
    expect(list.body.data.find((c: { channel: string }) => c.channel === 'TIRVONA')).toMatchObject({ internal: true });
    expect(JSON.stringify(list.body)).not.toMatch(/mock-at-|mock-rt-|Encrypted/);

    const raw = await t.db.selectFrom('channelConnections').selectAll().where('channel', '=', 'MOCK').executeTakeFirst();
    expect(raw!.accessTokenEncrypted).toMatch(/^v1:/);
    expect(raw!.accessTokenEncrypted).not.toContain('mock-at-');
  });

  it('rejects a callback with a forged or replayed state', async () => {
    const res = await t.http().get('/channels/oauth/MOCK/callback').query({ state: 'forged', code: 'mock-authorization-code' }).expect(302);
    expect(res.headers.location).toMatch(/connect-error.*code=TOKEN_INVALID/);
  });

  it('partner OTAs without approved API access fail clearly instead of calling undocumented APIs', async () => {
    const res = await t.http().post(`/properties/${s.propertyId}/channels/AIRBNB/connect`).set(bearer(owner.token));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHANNEL_INTEGRATION_NOT_AVAILABLE');
  });

  it('lists external listings with their rooms and rate plans', async () => {
    const res = await t.http().get(`/properties/${s.propertyId}/channels/MOCK/listings`).set(bearer(owner.token)).expect(200);
    const hotel = res.body.data.find((l: { externalListingId: string }) => l.externalListingId === 'MOCK-HOTEL-1');
    expect(hotel.externalRooms.map((r: { externalRoomId: string }) => r.externalRoomId)).toEqual(['MOCK-ROOM-STD', 'MOCK-ROOM-DLX', 'MOCK-ROOM-FAM']);
    expect(hotel.roomMappings).toEqual([]);
  });

  it('maps listings to the room type (idempotent) and pushes full availability + rates', async () => {
    const res = await mapMock(t, owner.token, s).expect(201);
    expect(res.body.data.map((m: { created: boolean }) => m.created)).toEqual([true, true]);
    const again = await mapMock(t, owner.token, s).expect(201);
    expect(again.body.data.map((m: { created: boolean }) => m.created)).toEqual([false, false]);

    // Same external room to a different room type = conflict.
    const rt2 = await t.http().post(`/properties/${s.propertyId}/room-types`).set(bearer(owner.token)).send({ name: 'Standard', maxOccupancy: 2, basePrice: 200000 }).expect(201);
    const clash = await t
      .http()
      .post(`/properties/${s.propertyId}/channels/MOCK/mappings`)
      .set(bearer(owner.token))
      .send({ mappings: [{ externalListingId: 'MOCK-HOTEL-1', externalRoomId: 'MOCK-ROOM-DLX', roomTypeId: rt2.body.data._id }] });
    expect(clash.status).toBe(409);
    const unknownRoom = await t
      .http()
      .post(`/properties/${s.propertyId}/channels/MOCK/mappings`)
      .set(bearer(owner.token))
      .send({ mappings: [{ externalListingId: 'MOCK-HOTEL-1', externalRoomId: 'NOPE', roomTypeId: s.roomTypeId }] });
    expect(unknownRoom.status).toBe(400);

    await t.drain();
    expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(1))).toBe(10);
    expect(pushed('MOCK-LISTING-1', null, day(1))).toBe(10);
    const rate = store.rates.get(`${store.key('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(1))}|MOCK-ROOM-DLX-FLEX`);
    expect(rate).toEqual({ price: 385000, currency: 'INR' }); // ₹3,500 + 10% channel markup
  });

  it('a PMS booking pushes the new availability to every mapped listing (10 → 9)', async () => {
    await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(5), day(7))).expect(201);
    await t.drain();
    for (const d of [day(5), day(6)]) {
      expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', d)).toBe(9);
      expect(pushed('MOCK-LISTING-1', null, d)).toBe(9);
    }
    expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(7))).toBe(10);
  });

  it('stop sell and restrictions are pushed', async () => {
    await t.http().put(`/properties/${s.propertyId}/restrictions`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, from: day(9), to: day(10), stopSell: true, minimumStay: 2 }).expect(200);
    await t.drain();
    expect(store.availability.get(store.key('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(9)))).toMatchObject({ available: 0, stopSell: true });
    expect(store.restrictions.get(store.key('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(9)))).toMatchObject({ minimumStay: 2, closed: true });
  });

  it('transient channel failures are retried with the reservation untouched', async () => {
    store.failNextPushes(2);
    const r = await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(12), day(13))).expect(201);
    await t.drain();
    expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(12))).toBe(9);
    const failedLogs = Number((await t.db.selectFrom('syncLogs').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'FAILED').executeTakeFirstOrThrow()).n);
    expect(failedLogs).toBeGreaterThanOrEqual(2);
    expect((await t.http().get(`/reservations/${r.body.data._id}`).set(bearer(owner.token))).body.data.status).toBe('CONFIRMED');
  });

  it('a permanently failing channel: job FAILED, staff alerted, reservation still confirmed, manual resync recovers', async () => {
    store.failNextPushes(1000);
    const r = await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(15), day(16))).expect(201);
    await t.drain();
    expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(15))).toBe(10); // stale on the channel
    expect(Number((await t.db.selectFrom('syncJobs').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'FAILED').executeTakeFirstOrThrow()).n)).toBeGreaterThan(0);
    const inbox = await t.http().get('/notifications').set(bearer(owner.token)).expect(200);
    expect(inbox.body.data.items.some((n: { type: string }) => n.type === 'CHANNEL_SYNC_FAILED')).toBe(true);
    expect((await t.http().get(`/reservations/${r.body.data._id}`).set(bearer(owner.token))).body.data.status).toBe('CONFIRMED');

    store.failNextPushes(0);
    const sync = await t.http().post(`/properties/${s.propertyId}/channels/MOCK/sync`).set(bearer(owner.token)).expect(202);
    expect(sync.body.data.queued).toBeGreaterThan(0);
    await t.drain();
    expect(pushed('MOCK-HOTEL-1', 'MOCK-ROOM-DLX', day(15))).toBe(9);
    const audit = await t.db.selectFrom('auditLogs').selectAll().where('action', '=', 'channel.manual_sync').executeTakeFirst();
    expect(audit).toBeTruthy();
  });

  it('disconnect wipes credentials and stops syncing', async () => {
    await t.http().post(`/properties/${s.propertyId}/channels/MOCK/disconnect`).set(bearer(owner.token)).expect(200);
    const raw = await t.db.selectFrom('channelConnections').selectAll().where('channel', '=', 'MOCK').executeTakeFirst();
    expect(raw).toMatchObject({ status: 'DISCONNECTED' });
    expect(raw!.accessTokenEncrypted).toBeNull();
    const before = store.pushes.length;
    await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(18), day(19))).expect(201);
    await t.drain();
    expect(store.pushes.length).toBe(before);
  });
});
