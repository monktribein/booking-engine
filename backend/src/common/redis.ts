import type { ThrottlerStorage } from '@nestjs/throttler';
import { Redis, RedisOptions } from 'ioredis';

/** Parse REDIS_URL (redis:// or rediss://) into ioredis options that BullMQ can duplicate per queue and worker. */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ workers (blocking commands must not be retried by ioredis).
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

/**
 * Rate-limit counters in Redis, so every API instance shares one budget per
 * client. The in-memory default would give each instance its own.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly keyPrefix = 'tirvona',
  ) {
    // enableOfflineQueue:false + commandTimeout: while Redis is down a command fails at once instead of waiting in ioredis's offline
    // queue, so the fail-open path below costs microseconds, not seconds, on every request.
    this.redis = new Redis({ ...redisOptionsFromUrl(url), maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 500, lazyConnect: false });
    let lastLog = 0;
    this.redis.on('error', (err) => {
      // ioredis reconnects on its own; log at most once a minute.
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        console.error(`[throttler] redis error: ${err.message}`);
      }
    });
  }

  /** Fails open: if Redis is unreachable, requests are allowed rather than the whole API going down. */
  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    try {
      return await this.count(key, ttl, limit, blockDuration, throttlerName);
    } catch {
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  private async count(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const hitKey = `${this.keyPrefix}:throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    const blockedMs = await this.redis.pttl(blockKey);
    if (blockedMs > 0) {
      const s = Math.ceil(blockedMs / 1000);
      return { totalHits: limit + 1, timeToExpire: s, isBlocked: true, timeToBlockExpire: s };
    }
    const res = await this.redis.multi().incr(hitKey).pttl(hitKey).exec();
    const hits = Number(res?.[0]?.[1] ?? 1);
    let pttl = Number(res?.[1]?.[1] ?? -1);
    if (pttl < 0) {
      await this.redis.pexpire(hitKey, ttl);
      pttl = ttl;
    }
    const timeToExpire = Math.ceil(pttl / 1000);
    if (hits > limit) {
      await this.redis.set(blockKey, '1', 'PX', Math.max(blockDuration, 1));
      return { totalHits: hits, timeToExpire, isBlocked: true, timeToBlockExpire: Math.ceil(blockDuration / 1000) };
    }
    return { totalHits: hits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
