/**
 * Local integration sandbox: an in-memory MongoDB replica set, seeded with the Radha Ashram demo data,
 * and the built API on top of it. Nothing outside this process is touched (your .env database is NOT used).
 *
 *   npm run build && npx tsx scripts/dev-sandbox.ts
 *
 * Then run the frontend: npm run frontend:dev   (http://localhost:3001 -> API http://localhost:3000)
 * Sandbox owner login: owner@tirvona.demo / SandboxPass-123   (override with SEED_OWNER_PASSWORD)
 * Razorpay is a local fake (scripts/sandbox-razorpay-shim.cjs) with fixed test credentials: no network call to the gateway.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The sandbox must never run in production');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const env = {
    ...process.env,
    MONGODB_URI: rs.getUri(),
    MONGODB_DB: 'tirvona_sandbox',
    NODE_ENV: 'development',
    QUEUE_DRIVER: 'inline',
    PORT: process.env.PORT ?? '3000',
    CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:3001',
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    SEED_OWNER_PASSWORD: process.env.SEED_OWNER_PASSWORD ?? 'SandboxPass-123',
    THROTTLE_AUTH_LIMIT: process.env.THROTTLE_AUTH_LIMIT ?? '100',
    // Sandbox gateway (see sandbox-razorpay-shim.cjs): fixed test credentials, online payment required like production.
    RAZORPAY_KEY_ID: 'rzp_test_SANDBOXKEY',
    RAZORPAY_KEY_SECRET: 'sandbox_key_secret_value',
    RAZORPAY_WEBHOOK_SECRET: 'sandbox_webhook_secret_value',
    BOOKING_ENGINE_REQUIRE_PAYMENT: process.env.SANDBOX_REQUIRE_PAYMENT ?? 'true',
  };

  // Async on purpose: spawnSync would block this process's event loop, which is also what drains
  // mongod's piped log output, so mongod would freeze mid-index-build.
  for (const script of ['scripts/seed.ts']) {
    const code = await new Promise<number | null>((resolve) => {
      spawn(process.execPath, ['--import', 'tsx', script], { env, stdio: 'inherit' }).on('exit', resolve);
    });
    if (code !== 0) {
      await rs.stop();
      throw new Error(`${script} failed`);
    }
  }

  const api = spawn(process.execPath, ['--require', path.resolve(__dirname, 'sandbox-razorpay-shim.cjs'), 'dist/src/main.js'], { env, stdio: 'inherit' });
  const shutdown = async () => {
    api.kill();
    await rs.stop();
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
