import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Integration run: the real frontend API modules and pages against a RUNNING backend (e.g. `npx tsx scripts/dev-sandbox.ts`).
 *   LIVE_API_URL=http://localhost:3000 LIVE_OWNER_EMAIL=owner@tirvona.demo LIVE_OWNER_PASSWORD=... npm run test:live
 * Writes only to the sandbox database. Never point it at production data.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/live/setup.ts'],
    include: ['tests/live/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { NEXT_PUBLIC_API_URL: process.env.LIVE_API_URL ?? 'http://localhost:3000' },
  },
});
