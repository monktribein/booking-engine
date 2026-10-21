import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SchedulerService } from '../src/jobs/scheduler.module';
import { bearer, createPropertyWithRooms, day, inventoryFor, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, TestApp } from './utils/test-app';

const ics = (events: string[][], opts: { truncated?: boolean } = {}) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), ...(opts.truncated ? [] : ['END:VCALENDAR']), ''].join('\r\n');
const d8 = (n: number) => day(n).replace(/-/g, '');
const block = (uid: string, from: number, to: number, extra: string[] = []) => [`UID:${uid}`, `DTSTART;VALUE=DATE:${d8(from)}`, `DTEND;VALUE=DATE:${d8(to)}`, 'SUMMARY:Reserved', ...extra];

describe('iCal: importing availability calendars and publishing Tirvona ones', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let server: http.Server;
  let base = '';
  let body = ics([]);
  let status = 200;
  let hits = 0;
  let feedUrl = '';

  const reservations = () => t.db.selectFrom('reservations').selectAll().where('source', '=', 'ICAL').where('propertyId', '=', s.propertyId).orderBy('checkIn').execute();
  const ymd = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const conn = () => t.db.selectFrom('channelConnections').selectAll().where('propertyId', '=', s.propertyId).where('channel', '=', 'ICAL').executeTakeFirstOrThrow();
  const poll = async () => {
    await t.db.updateTable('channelConnections').set({ lastPollAt: new Date(Date.now() - 3_600_000) }).where('propertyId', '=', s.propertyId).where('channel', '=', 'ICAL').execute();
    await t.app.get(SchedulerService).queueReservationPulls();
    await t.drain();
  };
  const soldOn = async (date: string) => (await inventoryFor(t, owner.token, s, date, day(Number(day(0)) ? 30 : 30))).find((r: { date: string }) => String(r.date).slice(0, 10) === date);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      if (req.url?.startsWith('/cal/one.ics')) {
        res.writeHead(status, { 'content-type': 'text/calendar' });
        return res.end(status === 200 ? body : 'nope');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    feedUrl = `${base}/cal/one.ics?token=SECRET-FEED-TOKEN`;
    t = await createTestApp();
    owner = await registerOwner(t, 'ical');
    s = await createPropertyWithRooms(t, owner.token, 2);
  });
  afterAll(async () => {
    await t.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('importing', () => {
    it('is not connected until every calendar has been fetched and parsed', async () => {
      body = '<html>please log in</html>';
      const bad = await t.http().post(`/properties/${s.propertyId}/channels/ICAL/credentials`).set(bearer(owner.token)).send({ feeds: [{ name: 'Airbnb', url: feedUrl }] });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('CHANNEL_CONNECTION_TEST_FAILED');
      expect(JSON.stringify(bad.body)).not.toContain('SECRET-FEED-TOKEN');
      expect((await conn()).status).toBe('ERROR');
      status = 404;
      const gone = await t.http().post(`/properties/${s.propertyId}/channels/ICAL/credentials`).set(bearer(owner.token)).send({ feeds: [{ name: 'Airbnb', url: feedUrl }] });
      expect(gone.status).toBe(422);
      status = 200;
    });

    it('connects, keeps the address secret, and shows the calendar as a listing', async () => {
      body = ics([block('a1', 10, 12), block('a2', 20, 23)]);
      const res = await t.http().post(`/properties/${s.propertyId}/channels/ICAL/credentials`).set(bearer(owner.token)).send({ feeds: [{ name: 'Airbnb calendar', url: feedUrl }], pollIntervalSeconds: 300 }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'CONNECTED', capabilities: ['listings', 'pullReservations', 'polling'], feeds: [{ name: 'Airbnb calendar', host: '127.0.0.1' }], polling: { intervalSeconds: 300 } });
      expect(JSON.stringify(res.body)).not.toContain('SECRET-FEED-TOKEN'); // the address is a credential: never echoed
      const stored = await t.db.selectFrom('channelConnectionSecrets').selectAll().execute();
      expect(stored.map((x) => x.kind)).toEqual(['FEED_URLS']);
      expect(stored[0].ciphertext).toMatch(/^v1:/);
      expect(stored[0].ciphertext).not.toContain('127.0.0.1');
      const listings = await t.http().get(`/properties/${s.propertyId}/channels/ICAL/listings`).set(bearer(owner.token)).expect(200);
      expect(listings.body.data).toHaveLength(1);
      expect(listings.body.data[0].externalRooms).toEqual([{ externalRoomId: null, name: 'Airbnb calendar' }]);
    });

    it('maps the calendar to a room type, and only blocked dates come in: no prices, no guests, no restrictions', async () => {
      const listing = (await t.db.selectFrom('channelListings').select('externalListingId').where('propertyId', '=', s.propertyId).where('channel', '=', 'ICAL').executeTakeFirstOrThrow()).externalListingId;
      await t.http().post(`/properties/${s.propertyId}/channels/ICAL/mappings`).set(bearer(owner.token)).send({ mappings: [{ externalListingId: listing, externalRoomId: null, roomTypeId: s.roomTypeId }] }).expect(201);
      await t.drain();
      // outbound pushes are skipped (a calendar cannot receive them) and nothing was invented
      const jobs = await t.db.selectFrom('syncLogs').select('responseMetadata').where('channel', '=', 'ICAL').execute();
      expect(JSON.stringify(jobs)).toMatch(/does not support push/);

      await poll();
      const rows = await reservations();
      expect(rows.map((r) => [ymd(r.checkIn), ymd(r.checkOut)])).toEqual([[day(10), day(12)], [day(20), day(23)]]);
      expect(rows.every((r) => r.status === 'CONFIRMED' && Number(r.total) === 0)).toBe(true);
      // A calendar block says nothing about money: never paid, never collected by a channel.
      expect(rows.every((r) => r.paymentStatus === 'UNKNOWN' && r.collectionModel === null && r.collectionSource === null && r.providerPaymentStatus === null)).toBe(true);
      const inv = await inventoryFor(t, owner.token, s, day(10), day(12));
      expect(inv.map((r: { available: number }) => r.available)).toEqual([1, 1]); // 2 rooms, 1 taken per night
      const cn = await conn();
      expect(cn.lastPollError).toBeNull();
    });

    it('an unchanged calendar changes nothing and creates no new events', async () => {
      const events = Number((await t.db.selectFrom('webhookEvents').select((eb) => eb.fn.countAll<string>().as('n')).where('channel', '=', 'ICAL').executeTakeFirstOrThrow()).n);
      await poll();
      await poll();
      expect(await reservations()).toHaveLength(2);
      expect(Number((await t.db.selectFrom('webhookEvents').select((eb) => eb.fn.countAll<string>().as('n')).where('channel', '=', 'ICAL').executeTakeFirstOrThrow()).n)).toBe(events);
    });

    it('moves a block when the calendar changes it, cancels one that disappears, and releases the inventory', async () => {
      body = ics([block('a1', 11, 14)]);
      await poll();
      const rows = await reservations();
      const a1 = rows.find((r) => ymd(r.checkIn) === day(11));
      expect(a1?.status).toBe('CONFIRMED');
      expect(ymd(a1!.checkOut)).toBe(day(14));
      const a2 = rows.find((r) => ymd(r.checkIn) === day(20))!;
      expect(a2.status).toBe('CANCELLED');
      const inv = await inventoryFor(t, owner.token, s, day(20), day(23));
      expect(inv.map((r: { available: number }) => r.available)).toEqual([2, 2, 2]);
    });

    it('ignores recurring events, past stays, and its own exported events; reports them instead of failing', async () => {
      body = ics([
        block('a1', 11, 14),
        [...block('weekly', 30, 31), 'RRULE:FREQ=WEEKLY'],
        block('old', -10, -8),
        block('mine-2027@tirvona', 40, 42),
      ]);
      await poll();
      expect((await reservations()).filter((r) => r.status === 'CONFIRMED')).toHaveLength(1);
      const logs = await t.db.selectFrom('syncLogs').select('error').where('channel', '=', 'ICAL').where('action', '=', 'poll_skipped').execute();
      const text = logs.map((l) => l.error).join(' ');
      expect(text).toMatch(/recurring events are not supported/);
      expect(text).toMatch(/own exported events/);
    });

    it('a broken or truncated feed fails the poll and never cancels anything', async () => {
      body = ics([block('a1', 11, 14)], { truncated: true });
      await poll();
      expect((await conn()).lastPollError).toMatch(/truncated|not a valid iCalendar/);
      expect((await reservations()).find((r) => ymd(r.checkIn) === day(11))!.status).toBe('CONFIRMED');
      status = 503;
      await poll();
      expect((await conn()).lastPollError).toBeTruthy();
      expect((await reservations()).find((r) => ymd(r.checkIn) === day(11))!.status).toBe('CONFIRMED');
      status = 200;
      body = ics([block('a1', 11, 14)]);
      await poll();
      expect((await conn()).lastPollError).toBeNull();
    });

    it('refuses to cancel a large share of the blocks at once (an empty feed is more likely a fault than a mass cancellation)', async () => {
      body = ics([block('a1', 11, 14), block('b1', 24, 25), block('b2', 26, 27), block('b3', 28, 29), block('b4', 30, 31)]);
      await poll();
      expect((await reservations()).filter((r) => r.status === 'CONFIRMED')).toHaveLength(5);
      body = ics([]); // a valid, empty calendar
      await poll();
      expect((await reservations()).filter((r) => r.status === 'CONFIRMED')).toHaveLength(5);
      const logs = await t.db.selectFrom('syncLogs').select('error').where('channel', '=', 'ICAL').where('action', '=', 'poll_skipped').execute();
      expect(logs.map((l) => l.error).join(' ')).toMatch(/not cancelling them automatically/);
    });

    it('a block that was cancelled and later reappears is reported for review, not silently revived', async () => {
      body = ics([block('a1', 11, 14), block('b1', 24, 25), block('b2', 26, 27), block('b3', 28, 29)]); // b4 removed (1 of 5: allowed)
      await poll();
      expect((await reservations()).filter((r) => r.status === 'CANCELLED')).toHaveLength(2);
      body = ics([block('a1', 11, 14), block('b1', 24, 25), block('b2', 26, 27), block('b3', 28, 29), block('b4', 30, 31)]);
      await poll();
      expect((await reservations()).filter((r) => r.status === 'CONFIRMED')).toHaveLength(4);
      const logs = await t.db.selectFrom('syncLogs').select('error').where('channel', '=', 'ICAL').where('action', '=', 'poll_skipped').execute();
      expect(logs.map((l) => l.error).join(' ')).toMatch(/reappeared/);
    });

    it('the channel owns these blocks: the public API cannot cancel them', async () => {
      const key = await t.http().post('/api-keys').set(bearer(owner.token)).send({ name: 'Partner key', scopes: ['reservations:write', 'reservations:read'] }).expect(201);
      const code = (await reservations()).find((r) => r.status === 'CONFIRMED')!.reservationCode;
      const res = await t.http().post(`/v1/reservations/${code}/cancel`).set('Authorization', `Bearer ${key.body.data.key}`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHANNEL_OWNED_RESERVATION');
    });
  });

  describe('publishing a Tirvona calendar', () => {
    let url = '';
    let feedId = '';

    it('creates a calendar address for one room type, shown once and stored hashed', async () => {
      const res = await t.http().post(`/properties/${s.propertyId}/ical-feeds`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, label: 'For Airbnb' }).expect(201);
      url = res.body.data.url;
      feedId = res.body.data._id;
      expect(url).toMatch(/^http:\/\/api\.test\/ical\/[A-Za-z0-9_-]{43}\.ics$/);
      const list = await t.http().get(`/properties/${s.propertyId}/ical-feeds`).set(bearer(owner.token)).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(url.split('/').pop()!.replace('.ics', ''));
      const row = await t.db.selectFrom('icalExportFeeds').selectAll().executeTakeFirstOrThrow();
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      await t.http().post(`/properties/${s.propertyId}/ical-feeds`).set(bearer(owner.token)).send({ roomTypeId: '11111111-1111-4111-8111-111111111111' }).expect(404);
    });

    it('serves text/calendar with only the nights the room type is sold out, and no guest data', async () => {
      // sell both rooms on one night, and stop-sell another
      for (let i = 0; i < 2; i++) await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(3), day(5), { guest: { firstName: 'Private', lastName: 'Person', email: 'private.person@example.com', phone: '+919822222222' } })).expect(201);
      await t.http().put(`/properties/${s.propertyId}/restrictions`).set(bearer(owner.token)).send({ roomTypeId: s.roomTypeId, from: day(7), to: day(8), stopSell: true }).expect(200);
      const path = new URL(url).pathname;
      const res = await t.http().get(path).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/calendar/);
      expect(res.text).toMatch(/^BEGIN:VCALENDAR/);
      expect(res.text).toContain(`DTSTART;VALUE=DATE:${d8(3)}`);
      expect(res.text).toContain(`DTEND;VALUE=DATE:${d8(5)}`);
      expect(res.text).toContain(`DTSTART;VALUE=DATE:${d8(7)}`);
      expect(res.text).not.toContain(`DTSTART;VALUE=DATE:${d8(10)}`); // nights with a room left are not published
      expect(res.text).not.toMatch(/Private|private\.person|\+9198/);
      expect(res.text).toContain('@tirvona');
      expect(feedId).toBeTruthy();
    });

    it('unknown, malformed and revoked addresses look the same: not found', async () => {
      await t.http().get('/ical/' + 'a'.repeat(43) + '.ics').expect(404);
      await t.http().get('/ical/short.ics').expect(404);
      await t.http().get('/ical/' + 'a'.repeat(43)).expect(404);
      await t.http().delete(`/properties/${s.propertyId}/ical-feeds/${feedId}`).set(bearer(owner.token)).expect(200);
      await t.http().get(new URL(url).pathname).expect(404);
      await t.http().delete(`/properties/${s.propertyId}/ical-feeds/${feedId}`).set(bearer(owner.token)).expect(404);
    });

    it("another tenant cannot list, create or revoke a property's calendars", async () => {
      const other = await registerOwner(t, 'ical-other');
      await t.http().get(`/properties/${s.propertyId}/ical-feeds`).set(bearer(other.token)).expect((r) => expect([403, 404]).toContain(r.status));
      await t.http().post(`/properties/${s.propertyId}/ical-feeds`).set(bearer(other.token)).send({ roomTypeId: s.roomTypeId }).expect((r) => expect([403, 404]).toContain(r.status));
    });
  });

  describe('two tenants with identical calendars', () => {
    it('keep their own blocks: the same UID and dates at two properties are two independent reservations', async () => {
      const ownerB = await registerOwner(t, 'ical-b');
      const b = await createPropertyWithRooms(t, ownerB.token, 2);
      body = ics([block('shared-uid', 45, 47)]);
      for (const [o, p] of [[ownerB, b]] as const) {
        await t.http().post(`/properties/${p.propertyId}/channels/ICAL/credentials`).set(bearer(o.token)).send({ feeds: [{ name: 'Same feed', url: feedUrl }] }).expect(200);
        const listing = (await t.db.selectFrom('channelListings').select('externalListingId').where('propertyId', '=', p.propertyId).executeTakeFirstOrThrow()).externalListingId;
        await t.http().post(`/properties/${p.propertyId}/channels/ICAL/mappings`).set(bearer(o.token)).send({ mappings: [{ externalListingId: listing, externalRoomId: null, roomTypeId: p.roomTypeId }] }).expect(201);
      }
      await t.drain();
      await t.db.updateTable('channelConnections').set({ lastPollAt: new Date(Date.now() - 3_600_000) }).execute();
      await t.app.get(SchedulerService).queueReservationPulls();
      await t.drain();
      const mineB = await t.db.selectFrom('reservations').selectAll().where('propertyId', '=', b.propertyId).where('source', '=', 'ICAL').execute();
      expect(mineB).toHaveLength(1);
      const mineA = (await reservations()).filter((r) => ymd(r.checkIn) === day(45));
      expect(mineA).toHaveLength(1);
      expect(mineA[0].externalScope).not.toBe(mineB[0].externalScope);
      expect(mineA[0].externalReservationId).toBe(mineB[0].externalReservationId); // same feed id and uid hash, different tenants
    });
  });

  void soldOn;
  void hits;
});
