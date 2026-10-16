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

suite('BullMQ: graceful shutdown', () => {
  it('closing the app waits for the job being processed; nothing is left active or lost', async () => {
    const t = await createTestApp();
    const producer = t.app.get(BullMqJobsProducer);
    const registry = t.app.get(JobHandlerRegistry);
    const handler = registry.get('notification');
    let finished = false;
    jest.spyOn(handler, 'handle').mockImplementation(async () => {
      await sleep(900);
      finished = true;
      return { status: 'SENT' };
    });
    const prefix = process.env.QUEUE_PREFIX!;
    await producer.enqueue('notification', 'send', { notificationId: '00000000-0000-4000-8000-000000000003' }, { jobId: 'slow-1' });
    await until(async () => ((await producer.stats()).find((q) => q.queue === 'notification')!.counts.active ?? 0) === 1, 'job to become active');
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      await t.app.close(); // SIGTERM equivalent: Nest shutdown hooks -> BullMQ worker.close() waits for in-flight jobs
      const closedAt = Date.now();
      expect(finished).toBe(true);
      const finishedOn = Number(await redis.hget(`${prefix}:notification:slow-1`, 'finishedOn'));
      // The completion record must already be persisted when close() returns (otherwise a SIGTERM would lose it).
      console.log(`shutdown timing: close() returned ${closedAt - finishedOn} ms after the job's finishedOn timestamp`);
      expect(await redis.llen(`${prefix}:notification:active`)).toBe(0);
      expect(await redis.zcard(`${prefix}:notification:completed`)).toBe(1);
      expect(await redis.zcard(`${prefix}:notification:failed`)).toBe(0);
    } finally {
      redis.disconnect();
      await removeOwnKeys(process.env.REDIS_URL!, prefix);
    }
  });
});
