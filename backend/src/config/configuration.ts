/**
 * Typed configuration. Everything secret comes from the environment (or a
 * secrets manager that populates it). Nothing secret has a default.
 * Access with ConfigService.get('jwt', { infer: true }) etc.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  appUrl: string;
  apiUrl: string;
  corsOrigins: string[];
  mongodb: { uri: string; dbName: string; maxPoolSize: number };
  redis: { url: string | null };
  smtp: { url: string | null; from: string | null };
  queue: { driver: 'bullmq' | 'inline'; workersEnabled: boolean; schedulerEnabled: boolean; prefix: string; backoffOverrideMs: number };
  jwt: { secret: string; refreshSecret: string; accessTtlSeconds: number; refreshTtlDays: number; issuer: string; audience: string };
  encryptionKey: string;
  razorpay: { keyId: string | null; keySecret: string | null; webhookSecret: string | null };
  mockChannel: { enabled: boolean; webhookSecret: string; failureRate: number };
  bookingEngine: { requirePayment: boolean };
  swagger: { enabled: boolean };
  throttle: { ttlMs: number; limit: number; authLimit: number };
  publicApi: { keyRateLimit: number; keyRateTtlMs: number; webhookAllowPrivateTargets: boolean; webhookTimeoutMs: number };
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, dflt: number) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));
const opt = (v: string | undefined) => (v === undefined || v === '' ? null : v);

export default function configuration(): AppConfig {
  const e = process.env;
  const env = (e.NODE_ENV ?? 'development') as AppConfig['env'];
  const port = int(e.PORT, 3000);
  return {
    env,
    port,
    appUrl: e.APP_URL ?? 'http://localhost:5173',
    apiUrl: e.API_URL ?? `http://localhost:${port}`,
    corsOrigins: (e.CORS_ORIGINS ?? e.APP_URL ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    mongodb: {
      // MONGODB_URI is canonical; DATABASE_URL is accepted for platforms that inject that name.
      uri: (e.MONGODB_URI || e.DATABASE_URL) as string,
      dbName: e.MONGODB_DB ?? 'tirvona',
      maxPoolSize: int(e.MONGODB_MAX_POOL_SIZE, 50),
    },
    redis: { url: opt(e.REDIS_URL) },
    // E-mail provider (any SMTP service). Unset = e-mails are only logged.
    smtp: { url: opt(e.SMTP_URL), from: opt(e.SMTP_FROM) },
    queue: {
      driver: (e.QUEUE_DRIVER ?? 'bullmq') as 'bullmq' | 'inline',
      workersEnabled: bool(e.WORKERS_ENABLED, true),
      schedulerEnabled: bool(e.SCHEDULER_ENABLED, true),
      // Redis key prefix of every queue. Tests use a unique one per run so they can never touch other keys.
      prefix: e.QUEUE_PREFIX ?? 'tirvona',
      // Test/dev only (rejected in production by validateEnv): replaces the retry backoff so retries do not take minutes.
      backoffOverrideMs: int(e.QUEUE_BACKOFF_OVERRIDE_MS, 0),
    },
    jwt: {
      secret: e.JWT_SECRET as string,
      refreshSecret: e.JWT_REFRESH_SECRET as string,
      accessTtlSeconds: int(e.JWT_ACCESS_TTL_SECONDS, 900),
      refreshTtlDays: int(e.JWT_REFRESH_TTL_DAYS, 30),
      issuer: 'tirvona',
      audience: 'tirvona-api',
    },
    encryptionKey: e.ENCRYPTION_KEY as string,
    razorpay: {
      keyId: opt(e.RAZORPAY_KEY_ID),
      keySecret: opt(e.RAZORPAY_KEY_SECRET),
      webhookSecret: opt(e.RAZORPAY_WEBHOOK_SECRET),
    },
    mockChannel: {
      enabled: bool(e.MOCK_CHANNEL_ENABLED, env !== 'production'),
      webhookSecret: e.MOCK_CHANNEL_WEBHOOK_SECRET ?? 'mock-channel-dev-secret',
      failureRate: Number(e.MOCK_CHANNEL_FAILURE_RATE ?? 0),
    },
    bookingEngine: { requirePayment: bool(e.BOOKING_ENGINE_REQUIRE_PAYMENT, true) },
    swagger: { enabled: bool(e.SWAGGER_ENABLED, env !== 'production') },
    throttle: {
      ttlMs: int(e.THROTTLE_TTL_MS, 60_000),
      limit: int(e.THROTTLE_LIMIT, 120),
      authLimit: int(e.THROTTLE_AUTH_LIMIT, 5),
    },
    publicApi: {
      // Per API key (shared across API instances when Redis is used).
      keyRateLimit: int(e.API_KEY_RATE_LIMIT, 300),
      keyRateTtlMs: int(e.API_KEY_RATE_TTL_MS, 60_000),
      // Outbound webhooks may target loopback/private addresses only in development (SSRF protection).
      webhookAllowPrivateTargets: bool(e.WEBHOOK_ALLOW_PRIVATE_TARGETS, env !== 'production'),
      webhookTimeoutMs: int(e.WEBHOOK_TIMEOUT_MS, 10_000),
    },
  };
}
