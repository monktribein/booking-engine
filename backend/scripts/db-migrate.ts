/**
 * Applies the SQL migrations in src/database/migrations to DATABASE_URL. Idempotent; run it before each deploy.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 *
 * On Supabase use the DIRECT connection (db.<ref>.supabase.co:5432) or the SESSION pooler (port 5432 on the pooler host)
 * for migrations, not the transaction pooler (port 6543): migrations take a session-level advisory lock.
 */
import 'dotenv/config';
import { createPool } from '../src/database/kysely';
import { migrate } from '../src/database/migrate';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool({
    url,
    ssl: process.env.DATABASE_SSL as 'disable' | 'require' | 'verify-full' | undefined,
    caCert: process.env.DATABASE_CA_CERT,
    poolMax: 2,
    applicationName: 'tirvona-migrate',
  });
  try {
    const r = await migrate(pool);
    console.log(`migrations: ${r.applied.length} applied, ${r.alreadyApplied.length} already up to date`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
