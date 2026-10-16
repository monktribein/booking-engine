import { Inject } from '@nestjs/common';
import { CamelCasePlugin, Kysely, PostgresDialect, Transaction } from 'kysely';
import fs from 'node:fs';
import { Pool, types } from 'pg';
import type { DB } from './db-types';

/** Either the shared connection pool or a transaction: every data-access function accepts both. */
export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export const DB_TOKEN = Symbol('TIRVONA_DB');
export const POOL_TOKEN = Symbol('TIRVONA_PG_POOL');

/** Inject the shared Kysely instance: `constructor(@InjectDb() private readonly db: Db)`. */
export const InjectDb = () => Inject(DB_TOKEN);

// ---------------------------------------------------------------------------- type parsing

let parsersInstalled = false;
/**
 * Process-wide pg type parsers (idempotent):
 *  - date (1082)     -> Date at 00:00:00Z, the calendar-date convention used by all date code (toDateOnly / formatDateOnly);
 *  - int8 (20), numeric (1700) -> number. Money is bigint in minor units (paise): far below 2^53, so Number is exact.
 */
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;
  types.setTypeParser(1082, (v: string) => new Date(`${v}T00:00:00Z`));
  types.setTypeParser(20, (v: string) => Number(v));
  types.setTypeParser(1700, (v: string) => Number(v));
}

/** jsonb parameters are sent as JSON text, so arrays are never mistaken for Postgres arrays by the driver. */
export const j = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------- connection

export interface DatabaseOptions {
  url: string;
  /** Maximum pooled connections. */
  poolMax?: number;
  /**
   * TLS mode. `disable` (local development), `require` (encrypted, server certificate NOT verified; Supabase's default
   * certificate chain is not in Node's trust store), `verify-full` (encrypted and verified against `caCert`).
   * Default: `disable` for loopback hosts, `require` otherwise.
   */
  ssl?: 'disable' | 'require' | 'verify-full';
  /** PEM CA certificate (the Supabase CA) used with verify-full. A path or the PEM text itself. */
  caCert?: string | null;
  applicationName?: string;
}

const isLoopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

export function createPool(opts: DatabaseOptions): Pool {
  installTypeParsers();
  const url = new URL(opts.url);
  const mode = opts.ssl ?? (isLoopback(url.hostname) ? 'disable' : 'require');
  // The URL's own sslmode query parameter would override the explicit ssl option below, so remove it.
  url.searchParams.delete('sslmode');
  let ssl: false | { rejectUnauthorized: boolean; ca?: string } = false;
  if (mode === 'require') ssl = { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    if (!opts.caCert) throw new Error('DATABASE_SSL=verify-full needs DATABASE_CA_CERT (PEM text or a file path)');
    ssl = { rejectUnauthorized: true, ca: opts.caCert.includes('BEGIN CERTIFICATE') ? opts.caCert : fs.readFileSync(opts.caCert, 'utf8') };
  }
  const pool = new Pool({
    connectionString: url.toString(),
    max: opts.poolMax ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName ?? 'tirvona-api',
    ssl,
  });
  // An idle connection can be cut by the server (restart, failover, shutdown). Without a listener Node treats that as an uncaught
  // 'error' event and kills the process; the pool simply drops the broken client and opens a new one on the next query.
  pool.on('error', (err) => console.warn(`database: idle connection error (${(err as Error).message}); the pool will reconnect`));
  return pool;
}

export function createDb(pool: Pool): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // Nested JSON keys are stored camelCase already; only column names are mapped.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}

// ---------------------------------------------------------------------------- transactions

/** Postgres error codes that mean "run the whole transaction again": serialization failure and deadlock. */
const RETRYABLE = new Set(['40001', '40P01']);
export const pgErrorCode = (err: unknown): string | undefined => (err as { code?: string })?.code;

/** Unique-violation (23505), optionally for one named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/**
 * Runs `fn` in a transaction at READ COMMITTED (the PostgreSQL default). Concurrency-sensitive writes use row locks
 * (SELECT ... FOR UPDATE) or conditional UPDATEs inside it. The whole callback is retried on serialization failures and
 * deadlocks, so it must be safe to run more than once:
 *  - use the `tx` it is given for every read and write;
 *  - never call an external API, send e-mail or publish events inside it. Write an outbox row (sync_jobs, notifications,
 *    webhook_deliveries) instead and let a worker act after commit.
 */
export async function runInTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute(fn);
    } catch (err) {
      const code = pgErrorCode(err);
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
        continue;
      }
      throw err;
    }
  }
}
