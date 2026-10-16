/**
 * Local integration sandbox: a throwaway PostgreSQL server (embedded-postgres), seeded with the Radha Ashram demo data,
 * and the built API on top of it. Nothing outside this process is touched (your .env database is NOT used).
 *
 *   npm run build && npx tsx scripts/dev-sandbox.ts
 *
 * Then run the frontend: npm run frontend:dev   (http://localhost:3001 -> API http://localhost:3000)
 * Sandbox owner login: owner@tirvona.demo / SandboxPass-123   (override with SEED_OWNER_PASSWORD)
 * Sandbox platform admin: admin@tirvona.demo / SandboxAdmin-123   (override with SEED_ADMIN_PASSWORD)
 * New registrations wait for approval like in production (approve them as the admin).
 * Razorpay is a local fake (scripts/sandbox-razorpay-shim.cjs) with fixed test credentials: no network call to the gateway.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { startEphemeralPg } from './embedded-pg';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The sandbox must never run in production');
  const pg = await startEphemeralPg();
  const databaseUrl = await pg.createDatabase('tirvona_sandbox');
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'disable',
    NODE_ENV: 'development',
    QUEUE_DRIVER: 'inline',
    // Throw-away secrets for this run only, so the sandbox also starts on a machine that has no .env (CI). Nothing persists.
    JWT_SECRET: process.env.JWT_SECRET ?? randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64'),
    PORT: process.env.PORT ?? '3000',
    CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:3001',
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    SEED_OWNER_PASSWORD: process.env.SEED_OWNER_PASSWORD ?? 'SandboxPass-123',
    // A platform administrator for trying the admin console (approvals, suspensions). Local sandbox only.
    SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL ?? 'admin@tirvona.demo',
    SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD ?? 'SandboxAdmin-123',
    THROTTLE_AUTH_LIMIT: process.env.THROTTLE_AUTH_LIMIT ?? '100',
    // Sandbox gateway (see sandbox-razorpay-shim.cjs): fixed test credentials, online payment required like production.
    RAZORPAY_KEY_ID: 'rzp_test_SANDBOXKEY',
    RAZORPAY_KEY_SECRET: 'sandbox_key_secret_value',
    RAZORPAY_WEBHOOK_SECRET: 'sandbox_webhook_secret_value',
    BOOKING_ENGINE_REQUIRE_PAYMENT: process.env.SANDBOX_REQUIRE_PAYMENT ?? 'true',
  };

  // Async on purpose: spawnSync would block this process's event loop, which also serves the embedded server's log pipes.
  for (const script of ['scripts/seed.ts']) {
    const code = await new Promise<number | null>((resolve) => {
      spawn(process.execPath, ['--import', 'tsx', script], { env, stdio: 'inherit' }).on('exit', resolve);
    });
    if (code !== 0) {
      await pg.stop();
      throw new Error(`${script} failed`);
    }
  }

  const api = spawn(process.execPath, ['--require', path.resolve(__dirname, 'sandbox-razorpay-shim.cjs'), 'dist/src/main.js'], { env, stdio: 'inherit' });
  const shutdown = async () => {
    api.kill();
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  api.on('exit', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
