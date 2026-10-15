import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/** Arbitrary constant: serialises concurrent migrators (two deploys starting at once) on one advisory lock. */
const MIGRATION_LOCK = 727_274_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function migrationsDir(): string {
  return path.join(__dirname, 'migrations');
}

/**
 * Applies the versioned SQL files in src/database/migrations (0001_init.sql, 0002_*.sql, ...) in order, each in its own
 * transaction, and records them in schema_migrations. Forward-only and idempotent: applied files are skipped, and a
 * file whose content changed after it was applied is refused (write a new migration instead of editing an old one).
 * Run it before starting a new release: `npm run db:migrate`.
 */
export async function migrate(pool: Pool, log: (m: string) => void = console.log, dir = migrationsDir()): Promise<MigrationResult> {
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    // Same hardening as every other table (Supabase exposes public tables through its Data API unless RLS is on).
    await client.query('alter table schema_migrations enable row level security');
    const done = new Map<string, string>((await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const known = done.get(file);
      if (known !== undefined) {
        if (known !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Never edit an applied migration; add a new one.`);
        result.alreadyApplied.push(file);
        continue;
      }
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      log(`applied ${file}`);
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
