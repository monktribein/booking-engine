import { validateEnv } from './env.validation';

const good = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo:27017/?replicaSet=rs0',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  REDIS_URL: 'redis://redis:6379',
  CORS_ORIGINS: 'https://app.example.com',
  RAZORPAY_KEY_ID: 'rzp_test_x',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};
const errorsOf = (env: Record<string, unknown>) => {
  try {
    validateEnv(env);
    return [];
  } catch (e) {
    return (e as Error).message.split('\n - ').slice(1);
  }
};

describe('validateEnv (production fail-fast)', () => {
  it('accepts a complete production configuration', () => {
    expect(errorsOf(good)).toEqual([]);
  });

  it.each(['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY', 'REDIS_URL', 'CORS_ORIGINS', 'RAZORPAY_KEY_ID', 'RAZORPAY_WEBHOOK_SECRET'])('rejects production without %s', (key) => {
    const env: Record<string, unknown> = { ...good };
    delete env[key];
    if (key === 'RAZORPAY_KEY_ID') delete env.RAZORPAY_KEY_SECRET;
    expect(errorsOf(env).length).toBeGreaterThan(0);
  });

  it('rejects the inline queue, test backoff overrides, the mock channel and wildcard CORS in production', () => {
    expect(errorsOf({ ...good, QUEUE_DRIVER: 'inline' }).join()).toMatch(/inline/);
    expect(errorsOf({ ...good, QUEUE_BACKOFF_OVERRIDE_MS: '50' }).join()).toMatch(/tests only/);
    expect(errorsOf({ ...good, MOCK_CHANNEL_ENABLED: 'true' }).join()).toMatch(/MOCK_CHANNEL/);
    expect(errorsOf({ ...good, CORS_ORIGINS: '*' }).join()).toMatch(/not \*/);
  });

  it('refuses to confirm unpaid public bookings in production unless explicitly allowed', () => {
    expect(errorsOf({ ...good, BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' }).join()).toMatch(/ALLOW_PAY_AT_PROPERTY/);
    expect(errorsOf({ ...good, BOOKING_ENGINE_REQUIRE_PAYMENT: 'false', ALLOW_PAY_AT_PROPERTY: 'true' })).toEqual([]);
  });

  it('weak or identical secrets are rejected', () => {
    expect(errorsOf({ ...good, JWT_SECRET: 'short' }).join()).toMatch(/32 characters/);
    expect(errorsOf({ ...good, JWT_REFRESH_SECRET: good.JWT_SECRET }).join()).toMatch(/must differ/);
  });

  it('development is not subject to the production-only rules', () => {
    const dev = { ...good, NODE_ENV: 'development' } as Record<string, unknown>;
    delete dev.CORS_ORIGINS;
    expect(errorsOf({ ...dev, BOOKING_ENGINE_REQUIRE_PAYMENT: 'false' })).toEqual([]);
  });
});
