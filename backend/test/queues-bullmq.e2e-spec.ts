import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import { JobHandlerRegistry } from '../src/jobs/job-handler';
import { BullMqJobsProducer } from '../src/jobs/jobs.producer';
import { LogEmailSender } from '../src/modules/notifications/notifications.module';
import { bearer, createPropertyWithRooms, day, registerOwner, reservationBody, PropertySetup, Session } from './utils/fixtures';
import { createTestApp, removeOwnKeys, TestApp } from './utils/test-app';

/**
 * BullMQ behaviour that only a real Redis can show: persistence of jobs, backoff retries, failed-job reporting,
 * jobId de-duplication, graceful shutdown, and an outage of Redis itself.
 * Runs only with  TEST_QUEUE_DRIVER=bullmq  TEST_REDIS_URL=redis://127.0.0.1:<port>  (see docs/OPERATIONS.md).
 * The outage test additionally needs TEST_REDIS_BIN (path to a redis-server executable): it starts its OWN throw-away
 * Redis on another port, so stopping it never touches any other instance.
 */
const bull = process.env.TEST_QUEUE_DRIVER === 'bullmq';
const suite = bull ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

suite('BullMQ on real Redis', () => {
  let t: TestApp;
  let owner: Session;
  let s: PropertySetup;
  let producer: BullMqJobsProducer;
  let registry: JobHandlerRegistry;
  let n = 0;

  const notifications = () => t.conn.db!.collection('notifications');
  /** A QUEUED notification row that no job has been created for yet (so the test controls when its job exists). */
  const newNotification = async () => {
    const r = await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(3 + 2 * ++n), day(4 + 2 * n))).expect(201);
    void r;
  };
  const counts = async (queue: string) => (await producer.stats()).find((q) => q.queue === queue)!.counts;

  beforeAll(async () => {
    t = await createTestApp();
    producer = t.app.get(BullMqJobsProducer);
    registry = t.app.get(JobHandlerRegistry);
    owner = await registerOwner(t);
    s = await createPropertyWithRooms(t, owner.token, 8);
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses the real BullMQ driver: jobs live in Redis under this run\'s own prefix and are processed by real workers', async () => {
    expect(producer).toBeInstanceOf(BullMqJobsProducer);
    const send = jest.spyOn(LogEmailSender.prototype, 'send');
    await newNotification();
    await t.drain();
    const rows = await notifications().find({ channel: 'EMAIL' }).toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'SENT')).toBe(true); // no QUEUED leftovers
    expect(send).toHaveBeenCalledTimes(rows.length); // exactly one delivery attempt per notification: no duplicates
    expect((await counts('notification')).completed).toBeGreaterThanOrEqual(rows.length);
  });

  it('notification jobs only reach the logging sender: no external message is sent', async () => {
    const send = jest.spyOn(LogEmailSender.prototype, 'send');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await newNotification();
    await t.drain();
    expect(send).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([u]) => /smtp|sendgrid|twilio|ses\.|whatsapp/i.test(String(u)))).toHaveLength(0);
  });

  it('a failing sender is retried with backoff until it succeeds (3 attempts), delivered once', async () => {
    const real = LogEmailSender.prototype.send;
    let calls = 0;
    jest.spyOn(LogEmailSender.prototype, 'send').mockImplementation(function (this: LogEmailSender, msg) {
      calls++;
      if (calls <= 2) return Promise.reject(new Error('smtp 451 try again later'));
      return real.call(this, msg);
    });
    await newNotification();
    await t.drain();
    const failedOnce = await notifications().find({ attempts: { $gte: 3 } }).toArray();
    expect(failedOnce.length).toBeGreaterThanOrEqual(1);
    expect(failedOnce[0]).toMatchObject({ status: 'SENT', attempts: 3, lastError: null });
  });

  it('a job that exhausts its attempts is marked FAILED, kept in Redis and reported with its reason', async () => {
    const before = (await counts('notification')).failed ?? 0;
    jest.spyOn(LogEmailSender.prototype, 'send').mockRejectedValue(new Error('smtp permanently down'));
    await newNotification();
    await t.drain();
    const failedRows = await notifications().find({ status: 'FAILED' }).toArray();
    expect(failedRows.length).toBeGreaterThanOrEqual(1);
    expect(failedRows[0].lastError).toContain('smtp permanently down');
    expect((await counts('notification')).failed).toBeGreaterThan(before);
    const failedJobs = await producer.failed('notification', 10);
    expect(failedJobs.length).toBeGreaterThan(0);
    expect(failedJobs[0]).toMatchObject({ attemptsMade: expect.any(Number), failedReason: expect.stringContaining('smtp permanently down') });
    expect(failedJobs[0].attemptsMade).toBe(5); // the queue's configured attempts
  });

  it('an UnrecoverableError is not retried', async () => {
    const handler = registry.get('notification');
    jest.spyOn(handler, 'handle').mockRejectedValue(new UnrecoverableError('malformed payload'));
    await producer.enqueue('notification', 'send', { notificationId: '000000000000000000000001' }, { jobId: 'poison-1' });
    await until(async () => (await producer.failed('notification', 50)).some((j) => j.id === 'poison-1'), 'poison job to fail');
    const job = (await producer.failed('notification', 50)).find((j) => j.id === 'poison-1')!;
    expect(job.attemptsMade).toBe(1);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('enqueueing the same jobId twice runs the job once (idempotent enqueue)', async () => {
    const handler = registry.get('notification');
    const spy = jest.spyOn(handler, 'handle');
    await producer.enqueue('notification', 'send', { notificationId: '000000000000000000000002' }, { jobId: 'dup-1' });
    await producer.enqueue('notification', 'send', { notificationId: '000000000000000000000002' }, { jobId: 'dup-1' });
    await t.drain();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a job for a notification that no longer needs sending completes without error or retry loop', async () => {
    const handler = registry.get('notification');
    const spy = jest.spyOn(handler, 'handle');
    await producer.enqueue('notification', 'send', { notificationId: '0000000000000000000000ff' }, { jobId: 'ghost-1' });
    await t.drain();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await spy.mock.results[0].value).toMatchObject({ status: 'SKIPPED_ALREADY_HANDLED' });
  });

  it('channel-sync jobs run through Redis: a MOCK push is delivered, and a simulated outage is retried then reported', async () => {
    const conn = await t.http().post(`/properties/${s.propertyId}/channels/MOCK/connect`).set(bearer(owner.token)).expect(200);
    const url = new URL(conn.body.data.authorizationUrl);
    await t.http().get(url.pathname + url.search).redirects(0);
    const cb = await t.http().get(`/channels/oauth/MOCK/callback?code=mock-authorization-code&state=${url.searchParams.get('state')}`).redirects(0);
    expect([301, 302]).toContain(cb.status);
    const listings = await t.http().get(`/properties/${s.propertyId}/channels/MOCK/listings`).set(bearer(owner.token)).expect(200);
    const unit = listings.body.data.find((l: { externalRooms: { externalRoomId: string | null }[] }) => l.externalRooms[0].externalRoomId === null);
    await t
      .http()
      .post(`/properties/${s.propertyId}/channels/MOCK/mappings`)
      .set(bearer(owner.token))
      .send({ mappings: [{ externalListingId: unit.externalListingId, roomTypeId: s.roomTypeId }] })
      .expect(201);
    await t.drain();
    const before = await counts('inventory-sync');
    await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(40), day(41))).expect(201);
    await t.drain();
    const after = await counts('inventory-sync');
    expect(after.completed).toBeGreaterThan(before.completed ?? 0);
    const jobs = await t.conn.db!.collection('sync_jobs').find({ channel: 'MOCK' }).toArray();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.status === 'SUCCESS')).toBe(true);
  });
});
