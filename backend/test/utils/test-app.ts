import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { InlineJobsProducer } from '../../src/jobs/jobs.producer';
import Redis from 'ioredis';

export const TEST_SECRETS = {
  MOCK_CHANNEL_WEBHOOK_SECRET: 'test-mock-channel-secret',
  RAZORPAY_KEY_ID: 'rzp_test_TIRVONA',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret_value',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook_secret',
};

/**
 * Queue transport for the e2e suites.
 *   default                      inline driver (in-process jobs, no Redis)
 *   TEST_QUEUE_DRIVER=bullmq     real BullMQ on the Redis at TEST_REDIS_URL, with real workers
 * Real-Redis safety: only loopback hosts are accepted (TEST_REDIS_ALLOW_REMOTE=1 overrides), every app instance gets a
 * unique key prefix and removes ONLY the keys under it when it closes. FLUSHDB/FLUSHALL are never issued.
 */
const BULLMQ = process.env.TEST_QUEUE_DRIVER === 'bullmq';
function realRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_QUEUE_DRIVER=bullmq needs TEST_REDIS_URL (an isolated development Redis)');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && process.env.TEST_REDIS_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to run tests against non-local Redis host "${host}"`);
  }
  return url;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TestApp {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  conn: Connection;
  jobs: InlineJobsProducer;
  /** Wait for every queued job (and jobs they enqueue) to finish. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boots the real AppModule (all guards, pipes, filters, interceptors) on a
 * fresh database, with the inline queue driver so jobs run in-process and
 * tests can wait for them deterministically.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const queuePrefix = `tirvona_test_${randomBytes(4).toString('hex')}`;
  const redisUrl = BULLMQ ? realRedisUrl() : undefined;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DB: `tirvona_test_${randomBytes(4).toString('hex')}`,
    QUEUE_DRIVER: BULLMQ ? 'bullmq' : 'inline',
    ...(BULLMQ ? { REDIS_URL: redisUrl!, QUEUE_PREFIX: queuePrefix, QUEUE_BACKOFF_OVERRIDE_MS: '50' } : {}),
    WORKERS_ENABLED: BULLMQ ? 'true' : 'false',
    SCHEDULER_ENABLED: 'false',
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MOCK_CHANNEL_ENABLED: 'true',
    THROTTLE_LIMIT: '100000',
    THROTTLE_AUTH_LIMIT: '100000',
    API_URL: 'http://api.test',
    APP_URL: 'http://app.test',
    SWAGGER_ENABLED: 'false',
    BOOKING_ENGINE_REQUIRE_PAYMENT: 'true',
    ...TEST_SECRETS,
    ...env,
  });
  // Imported after the environment is set: AppModule reads configuration at import time.
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/common/app-setup');
  const { InlineJobsProducer, BullMqJobsProducer } = await import('../../src/jobs/jobs.producer');
  const { OutboxDispatcher } = await import('../../src/jobs/outbox.dispatcher');
  const { setupDatabase } = await import('../../scripts/setup-db');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const conn = app.get<Connection>(getConnectionToken());
  await setupDatabase(conn, { log: () => undefined });
  const jobs = (BULLMQ ? undefined : app.get(InlineJobsProducer)) as InlineJobsProducer;
  const bull = BULLMQ ? app.get(BullMqJobsProducer) : undefined;
  const outbox = app.get(OutboxDispatcher);
  // Outbox flushes are fire-and-forget in the app; tests hand everything to the queue, run it, repeat until quiet.
  const drain = async () => {
    if (!bull) {
      for (let i = 0; i < 6; i++) {
        await outbox.relay();
        await jobs.drain();
      }
      return;
    }
    // Real BullMQ: hand the outbox to Redis, then wait until no queue has waiting / active / delayed jobs for three
    // consecutive checks (jobs enqueue further jobs). Bounded, and it fails loudly instead of hanging.
    const deadline = Date.now() + 60_000;
    let quiet = 0;
    while (quiet < 3) {
      await outbox.relay();
      const stats = await bull.stats();
      const busy = stats.some((q) => (q.counts.waiting ?? 0) + (q.counts.active ?? 0) + (q.counts.delayed ?? 0) + (q.counts.prioritized ?? 0) > 0);
      quiet = busy ? 0 : quiet + 1;
      if (Date.now() > deadline) throw new Error(`queues did not drain: ${JSON.stringify(stats)}`);
      await sleep(busy ? 40 : 20);
    }
  };

  return {
    app,
    conn,
    jobs,
    http: () => request(app.getHttpServer()),
    drain,
    close: async () => {
      await drain();
      await conn.dropDatabase().catch(() => undefined);
      await app.close(); // stops workers (waits for in-flight jobs) and closes the Redis connections
      if (redisUrl) await removeOwnKeys(redisUrl, queuePrefix);
    },
  };
}

/** Deletes only keys under this app's unique prefix and proves nothing is left behind. */
export async function removeOwnKeys(url: string, prefix: string): Promise<void> {
  const redis = new Redis(url);
  try {
    let removed = 0;
    for (const pass of [1, 2]) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) removed += await redis.del(...keys);
      } while (cursor !== '0');
      void pass;
    }
    const [, left] = await redis.scan('0', 'MATCH', `${prefix}:*`, 'COUNT', 1000);
    if (left.length) throw new Error(`test queue keys leaked under ${prefix}: ${left.slice(0, 3).join(', ')}`);
    void removed;
  } finally {
    redis.disconnect();
  }
}
