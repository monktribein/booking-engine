/**
 * Fail fast at boot on missing or weak configuration, rather than at the first
 * request that needs it.
 */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const env = raw as Record<string, string | undefined>;
  const errors: string[] = [];
  const isProd = env.NODE_ENV === 'production';

  if (!env.MONGODB_URI && !env.DATABASE_URL) errors.push('MONGODB_URI (or DATABASE_URL) is required');
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (!env[k]) errors.push(`${k} is required`);
    else if (env[k]!.length < 32) errors.push(`${k} must be at least 32 characters`);
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.JWT_REFRESH_SECRET) errors.push('JWT_SECRET and JWT_REFRESH_SECRET must differ');

  if (!env.ENCRYPTION_KEY) errors.push('ENCRYPTION_KEY is required (32 random bytes, base64)');
  else if (Buffer.from(env.ENCRYPTION_KEY, 'base64').length !== 32) errors.push('ENCRYPTION_KEY must decode to exactly 32 bytes');

  const driver = env.QUEUE_DRIVER ?? 'bullmq';
  if (!['bullmq', 'inline'].includes(driver)) errors.push('QUEUE_DRIVER must be bullmq or inline');
  if (driver === 'bullmq' && !env.REDIS_URL) errors.push('REDIS_URL is required when QUEUE_DRIVER=bullmq');
  if (isProd && env.QUEUE_BACKOFF_OVERRIDE_MS) errors.push('QUEUE_BACKOFF_OVERRIDE_MS is for tests only and must not be set in production');
  if (env.QUEUE_PREFIX && !/^[A-Za-z0-9_-]{1,64}$/.test(env.QUEUE_PREFIX)) errors.push('QUEUE_PREFIX must be 1-64 characters of [A-Za-z0-9_-]');
  if (isProd && driver !== 'bullmq') errors.push('QUEUE_DRIVER=inline is for tests/local only; production needs bullmq');

  if (env.SMTP_URL) {
    if (!/^smtps?:[/][/]/.test(env.SMTP_URL)) errors.push('SMTP_URL must start with smtp:// or smtps://');
    if (!env.SMTP_FROM) errors.push('SMTP_FROM (the sender address, e.g. "Radha Ashram <bookings@example.com>") is required when SMTP_URL is set');
  }

  const hasRzp = [env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET].filter(Boolean).length;
  if (hasRzp === 1) errors.push('Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or neither');
  if (isProd && env.RAZORPAY_KEY_ID && !env.RAZORPAY_WEBHOOK_SECRET) errors.push('RAZORPAY_WEBHOOK_SECRET is required in production');
  if (isProd && ['1', 'true'].includes((env.MOCK_CHANNEL_ENABLED ?? '').toLowerCase())) {
    errors.push('MOCK_CHANNEL_ENABLED must not be on in production');
  }

  for (const k of ['API_KEY_RATE_LIMIT', 'API_KEY_RATE_TTL_MS', 'WEBHOOK_TIMEOUT_MS'] as const) {
    if (env[k] !== undefined && env[k] !== '' && !/^[1-9]d*$/.test(env[k]!)) errors.push(`${k} must be a positive integer`);
  }
  if (isProd && ['1', 'true', 'yes'].includes((env.WEBHOOK_ALLOW_PRIVATE_TARGETS ?? '').toLowerCase())) {
    errors.push('WEBHOOK_ALLOW_PRIVATE_TARGETS must not be on in production (server-side request forgery protection)');
  }

  if (isProd) {
    // Browser-facing origins: the default (localhost:5173) is a development value and must never reach production.
    if (!env.CORS_ORIGINS && !env.APP_URL) errors.push('CORS_ORIGINS (or APP_URL) is required in production: the allowed browser origins');
    if ((env.CORS_ORIGINS ?? '').split(',').some((o) => o.trim() === '*')) errors.push('CORS_ORIGINS must list explicit origins, not *');
    const requirePayment = !['0', 'false'].includes((env.BOOKING_ENGINE_REQUIRE_PAYMENT ?? 'true').toLowerCase());
    if (requirePayment && !env.RAZORPAY_KEY_ID) errors.push('RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are required in production while BOOKING_ENGINE_REQUIRE_PAYMENT is on');
    if (!requirePayment && !['1', 'true'].includes((env.ALLOW_PAY_AT_PROPERTY ?? '').toLowerCase())) {
      errors.push('BOOKING_ENGINE_REQUIRE_PAYMENT=false would confirm public bookings without payment; set ALLOW_PAY_AT_PROPERTY=true to confirm that is intended');
    }
  }

  if (errors.length) throw new Error(`Invalid environment:\n - ${errors.join('\n - ')}`);
  return raw;
}
