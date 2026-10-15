import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive a REAL browser against a REAL backend:
 *   - API on :3000 started by `npm run sandbox` (throw-away embedded PostgreSQL, seeded demo property, fake Razorpay gateway
 *     with fixed test credentials; nothing outside the process is touched)
 *   - the production Next.js standalone server on :3001 (scripts/start-standalone.cjs)
 * Prerequisites:  (cd backend && npm run build)  &&  NEXT_PUBLIC_API_URL=http://localhost:3000 npm run build  (in frontend/)
 * Browser: the installed Google Chrome by default. Override with PW_CHANNEL=msedge, or PW_CHANNEL= (empty) to use the
 * Chromium downloaded by `npx playwright install chromium`.
 */
// Ports are configurable so the suite can run next to a developer's own sandbox/dev server (E2E_API_PORT / E2E_WEB_PORT,
// plus E2E_API_URL for the test helpers and a frontend built with NEXT_PUBLIC_API_URL pointing at the same API).
const apiPort = process.env.E2E_API_PORT ?? '3000';
const webPort = process.env.E2E_WEB_PORT ?? '3001';
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
    baseURL: `http://localhost:${webPort}`,
    channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run sandbox',
      cwd: '../backend',
      env: { PORT: apiPort, CORS_ORIGINS: `http://localhost:${webPort}`, APP_URL: `http://localhost:${webPort}` },
      url: `http://localhost:${apiPort}/health`,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/start-standalone.cjs',
      env: { PORT: webPort, HOSTNAME: '127.0.0.1', ALLOW_INSECURE_API_URL: 'true' },
      url: `http://localhost:${webPort}/login`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
