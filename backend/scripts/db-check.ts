/**
 * Read-only check of the configured database: connectivity, TLS mode, role, row-level security and migration status.
 * Changes nothing (a READ ONLY transaction, SELECTs only) and prints no password or connection string.
 *
 *   npm run db:check            (compiled)   |   npm run db:check:dev
 *
 * Exit code 0 = reachable and up to date; 1 = unreachable, pending or tampered migrations, or a configuration warning that
 * would break the app (for example a role that would see no rows because RLS has no policies).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPool } from '../src/database/kysely';

const migrationsDir = fs.existsSync(path.join(__dirname, '../src/database/migrations')) ? path.join(__dirname, '../src/database/migrations') : path.join(__dirname, '../database/migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set in this environment: nothing to check.');
    process.exit(1);
  }
  const u = new URL(url);
  const ssl = (process.env.DATABASE_SSL as 'disable' | 'require' | 'verify-full' | undefined) ?? undefined;
  const problems: string[] = [];
  const notes: string[] = [];
  console.log(`target   host=${u.hostname} port=${u.port || '5432'} database=${u.pathname.slice(1)} user=${decodeURIComponent(u.username)} password=${u.password ? '(set, hidden)' : '(none)'}`);
  if (/pooler\.supabase\.com$/.test(u.hostname) && u.port === '6543') notes.push('transaction pooler (6543): fine for the app if DATABASE_POOL_MAX is small, but NOT for migrations (use the direct or session-pooler connection)');
  console.log(`ssl      mode=${ssl ?? '(default: require for remote hosts)'}${process.env.DATABASE_CA_CERT ? ' ca=provided' : ''}`);
  if (process.env.NODE_ENV === 'production' && ssl !== 'verify-full') notes.push('production should use DATABASE_SSL=verify-full with DATABASE_CA_CERT');

  const pool = createPool({ url, ssl, caCert: process.env.DATABASE_CA_CERT, poolMax: 1, applicationName: 'tirvona-db-check' });
  try {
    const c = await pool.connect();
    try {
      await c.query('begin read only');
      const v = (await c.query<{ v: string; u: string }>('select current_setting(\'server_version\') as v, current_user as u')).rows[0];
      console.log(`server   PostgreSQL ${v.v}, connected as ${v.u}`);
      const role = (await c.query<{ rolbypassrls: boolean; rolsuper: boolean }>('select rolbypassrls, rolsuper from pg_roles where rolname = current_user')).rows[0];
      const notOwned = Number((await c.query('select count(*)::int as n from pg_tables where schemaname = \'public\' and tableowner <> current_user and tablename not like \'pg_%\'')).rows[0].n);
      const rls = (await c.query<{ total: number; on: number }>('select count(*)::int as total, count(*) filter (where rowsecurity)::int as on from pg_tables where schemaname = \'public\'')).rows[0];
      console.log(`rls      ${rls.on}/${rls.total} public tables have row-level security; role bypassrls=${role?.rolbypassrls} superuser=${role?.rolsuper}; tables not owned by this role: ${notOwned}`);
      if (rls.total > 0 && rls.on < rls.total) problems.push('some public tables have RLS disabled: the Supabase Data API could expose them');
      if (rls.on > 0 && !role?.rolbypassrls && !role?.rolsuper && notOwned > 0) problems.push('this role neither owns the tables nor bypasses RLS: with no policies it would see no rows');

      const hasTable = (await c.query('select to_regclass(\'public.schema_migrations\') as t')).rows[0].t;
      const files = fs.readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
      const applied = new Map<string, string>();
      if (hasTable) for (const r of (await c.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows) applied.set(r.name, r.checksum);
      for (const f of files) {
        const sum = createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
        const state = !applied.has(f) ? 'PENDING' : applied.get(f) === sum ? 'applied' : 'CHANGED AFTER APPLY';
        console.log(`migrate  ${f}: ${state}`);
        if (state === 'PENDING') problems.push(`${f} is pending (see docs/MIGRATION_RUNBOOK.md before applying)`);
        if (state === 'CHANGED AFTER APPLY') problems.push(`${f} differs from what was applied`);
      }
      for (const n of applied.keys()) if (!files.includes(n)) problems.push(`database has ${n}, which this code does not know (newer release?)`);
      await c.query('rollback');
    } finally {
      c.release();
    }
  } catch (e) {
    problems.push(`cannot connect or query: ${(e as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '[connection string hidden]')}`);
  } finally {
    await pool.end();
  }
  notes.forEach((n) => console.log(`note     ${n}`));
  problems.forEach((p) => console.log(`PROBLEM  ${p}`));
  console.log(problems.length ? `RESULT   ${problems.length} problem(s)` : 'RESULT   ok');
  process.exit(problems.length ? 1 : 0);
}

void main();
