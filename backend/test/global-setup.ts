import { startEphemeralPg, type EphemeralPg } from '../scripts/embedded-pg';

/**
 * One throwaway PostgreSQL server for the whole run; every test app creates (and drops) its own database on it.
 * Set TEST_DATABASE_URL to use an existing local server instead (it needs a role that may CREATE DATABASE; only
 * databases named tirvona_test_* are ever created or dropped).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) return;
  const pg = await startEphemeralPg();
  (globalThis as unknown as { __PG__: EphemeralPg }).__PG__ = pg;
  process.env.TEST_DATABASE_URL = pg.url();
}
