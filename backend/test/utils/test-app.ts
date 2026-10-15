import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { Db } from '../../src/database/kysely';
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
  /** Typed query access to this app's private database (for assertions and arranging state). */
  db: Db;
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
  const dbName = `tirvona_test_${randomBytes(6).toString('hex')}`;
  const dbUrl = await createTestDatabase(dbName);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    DATABASE_SSL: 'disable',
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
  const { DB_TOKEN } = await import('../../src/database/kysely');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get<Db>(DB_TOKEN);
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
    db,
    jobs,
    http: () => request(app.getHttpServer()),
    drain,
    close: async () => {
      await drain();
      await app.close(); // stops workers (waits for in-flight jobs) and closes the Redis connections and the pool
      await dropTestDatabase(dbName);
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

/** Admin connection string: the maintenance database of the throwaway (or explicitly configured local) server. */
function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (jest globalSetup starts an embedded PostgreSQL)');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && process.env.TEST_DATABASE_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to run tests against non-local database host "${host}"`);
  }
  return url;
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Creates an empty database named tirvona_test_* and applies the migrations. Returns its connection string. */
async function createTestDatabase(name: string): Promise<string> {
  if (!/^tirvona_test_[a-z0-9]+$/.test(name)) throw new Error('unsafe test database name');
  await withAdmin((c) => c.query(`create database ${name} template template0 encoding 'UTF8'`));
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const { Pool } = await import('pg');
  const { migrate } = await import('../../src/database/migrate');
  const pool = new Pool({ connectionString: u.toString(), max: 1 });
  try {
    await migrate(pool, () => undefined);
  } finally {
    await pool.end();
  }
  return u.toString();
}

async function dropTestDatabase(name: string): Promise<void> {
  if (!/^tirvona_test_[a-z0-9]+$/.test(name)) return;
  await withAdmin((c) => c.query(`drop database if exists ${name} with (force)`)).catch(() => undefined);
}
