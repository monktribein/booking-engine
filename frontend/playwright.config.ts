import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive a REAL browser against a REAL backend:
 *   - API on :3000 started by `npm run sandbox` (throw-away in-memory MongoDB, seeded demo property, fake Razorpay gateway
 *     with fixed test credentials; nothing outside the process is touched)
 *   - the production Next.js standalone server on :3001 (scripts/start-standalone.cjs)
 * Prerequisites (from the repo root):  npm run build  &&  NEXT_PUBLIC_API_URL=http://localhost:3000 npm --prefix frontend run build
 * Browser: the installed Google Chrome by default. Override with PW_CHANNEL=msedge, or PW_CHANNEL= (empty) to use the
 * Chromium downloaded by `npx playwright install chromium`.
 */
const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // the tests share one seeded database
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3001',
    channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run sandbox',
      cwd: '..',
      url: 'http://localhost:3000/health',
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/start-standalone.cjs',
      env: { PORT: '3001', HOSTNAME: '127.0.0.1', ALLOW_INSECURE_API_URL: 'true' },
      url: 'http://localhost:3001/login',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
