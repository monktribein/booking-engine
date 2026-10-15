/*
 * NOTE: one createTestApp() per test file. src/app.module reads its configuration when it is first imported, so a second
 * app in the same file would silently reuse the first app's Redis URL and key prefix.
 */
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

const redisBin = process.env.TEST_REDIS_BIN;
(bull && redisBin ? describe : describe.skip)('BullMQ: Redis outage (own throw-away Redis on port 6391)', () => {
  const PORT = 6391;
  let proc: ChildProcess | null = null;
  const previousUrl = process.env.TEST_REDIS_URL;

  const startRedis = async () => {
    proc = spawn(redisBin!, ['--port', String(PORT), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--maxmemory-policy', 'noeviction'], {
      cwd: mkdtempSync(path.join(tmpdir(), 'tirvona-redis-')),
      stdio: 'ignore',
    });
    await until(async () => {
      const r = new Redis({ port: PORT, host: '127.0.0.1', lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
      try {
        await r.connect();
        await r.ping();
        return true;
      } catch {
        return false;
      } finally {
        r.disconnect();
      }
    }, 'redis to accept connections');
  };
  const stopRedis = async () => {
    proc?.kill();
    proc = null;
    await sleep(500);
  };

  let t: TestApp;
  beforeAll(async () => {
    await startRedis();
    process.env.TEST_REDIS_URL = `redis://127.0.0.1:${PORT}`;
    t = await createTestApp();
  });
  afterAll(async () => {
    process.env.TEST_REDIS_URL = previousUrl;
    if (!proc) await startRedis();
    await t.close();
    await stopRedis();
  });

  it('with Redis down: /health reports it, bookings still succeed (outbox), and the jobs are delivered after Redis returns', async () => {
    const owner = await registerOwner(t);
    const s = await createPropertyWithRooms(t, owner.token, 3);
    await t.drain();
    expect((await t.http().get('/health')).status).toBe(200);

    await stopRedis();
    let health = await t.http().get('/health');
    await until(async () => ((health = await t.http().get('/health')).status === 503), 'health to report the outage', 15_000);
    expect(health.body.error.details).toMatchObject({ mongo: 'up', queues: 'down' });

    const started = Date.now();
    const res = await t.http().post('/reservations').set(bearer(owner.token)).send(reservationBody(s, day(5), day(6)));
    expect(res.status).toBe(201); // the booking is committed in MongoDB; the queue is not on the request path
    expect(Date.now() - started).toBeLessThan(5_000);
    const pending = await t.conn.db!.collection('notifications').countDocuments({ status: 'QUEUED' });
    expect(pending).toBeGreaterThan(0); // waiting in the outbox, not lost

    await startRedis();
    await t.drain();
    expect(await t.conn.db!.collection('notifications').countDocuments({ status: 'QUEUED' })).toBe(0);
    expect(await t.conn.db!.collection('notifications').countDocuments({ status: 'SENT' })).toBeGreaterThan(0);
    expect((await t.http().get('/health')).status).toBe(200);
  });
});
