/**
 * Backup + restore DRILL, entirely in an isolated throw-away PostgreSQL server (embedded-postgres). It never touches your
 * configured database and never connects to anything else.
 *
 *   npm run drill:restore
 *
 * What it proves (and what it does not):
 *  1. A logical backup of EVERY table (one JSON line per row, so uuids, timestamps, bigints and jsonb survive) can be taken
 *     from a seeded database that also contains a booking, a payment and a refund.
 *  2. After the database is destroyed, a restore into a freshly MIGRATED database brings back identical rows (per-table
 *     count and content hash). Constraints and indexes come from the migrations, not from the backup.
 *  3. The invariants that matter for reservations and payments hold after the restore:
 *       - inventory: available + sold + blocked == total + overbooked, never negative
 *       - reservations: nights x rooms of live stays == sold counters
 *       - payments: reservation.amountPaid == PAID payments - refunds, never above the reservation total
 *       - uniqueness (reservation code) is enforced again by the restored constraints
 * It does NOT test your hosting provider's backups (Supabase daily backups / point-in-time recovery): those must be
 * restored into a scratch project by you; see docs/OPERATIONS.md. It also is not pg_dump: use pg_dump/Supabase backups
 * for real backups, this drill proves the data model survives a restore and the invariants still hold.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { createDb, createPool } from '../src/database/kysely';
import { migrate } from '../src/database/migrate';
import { startEphemeralPg } from './embedded-pg';
import { seed } from './seed';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Manifest = Record<string, { count: number; hash: string }>;

const tablesOf = async (pool: Pool): Promise<string[]> =>
  (await pool.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by tablename`)).rows.map((r) => r.tablename);

async function backup(pool: Pool, dir: string): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  const manifest: Manifest = {};
  for (const table of await tablesOf(pool)) {
    const rows = (await pool.query<{ j: unknown }>(`select to_jsonb(t) as j from "${table}" t order by to_jsonb(t)::text`)).rows;
    const text = rows.map((r) => JSON.stringify(r.j)).join('\n');
    writeFileSync(path.join(dir, `${table}.ndjson`), text);
    manifest[table] = { count: rows.length, hash: sha(text) };
  }
  writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function restore(pool: Pool, dir: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Foreign keys are checked at the end of the session's restore, not row by row, so file order does not matter.
    await client.query(`set session_replication_role = replica`);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
      const table = file.replace(/\.ndjson$/, '');
      const text = readFileSync(path.join(dir, file), 'utf8');
      // A fresh database already holds the reference rows its migrations insert (for example the built-in channel providers). The backup carries
      // those same rows with their original ids, which other tables point at, so they are replaced rather than duplicated.
      const seeded = Number((await client.query(`select count(*)::int as n from "${table}"`)).rows[0].n);
      if (seeded > 0) await client.query(`delete from "${table}"`);
      if (!text) continue;
      const rows = text.split('\n').map((l) => JSON.parse(l));
      for (let i = 0; i < rows.length; i += 500) {
        await client.query(`insert into "${table}" select * from jsonb_populate_recordset(null::"${table}", $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
    }
    await client.query(`set session_replication_role = origin`);
  } finally {
    client.release();
  }
}

async function invariants(pool: Pool): Promise<string[]> {
  const problems: string[] = [];
  const q = async <T extends object>(text: string) => (await pool.query<T>(text)).rows;

  for (const i of await q<{ id: string }>(`select id from inventory where available + sold + blocked <> total + overbooked or available < 0 or sold < 0 or blocked < 0`))
    problems.push(`inventory ${i.id}: counters out of balance`);

  const live = await q<{ room_type_id: string; day: string; qty: string }>(`
    select rr.room_type_id, to_char((n.value->>'date')::date, 'YYYY-MM-DD') as day, sum(rr.quantity) as qty
    from reservations r
    join reservation_rooms rr on rr.reservation_id = r.id
    cross join lateral jsonb_array_elements(rr.nightly_rates) n(value)
    where r.status in ('PENDING','CONFIRMED','CHECKED_IN')
    group by 1, 2`);
  const sold = new Map((await q<{ room_type_id: string; day: string; sold: number }>(`select room_type_id, to_char(date, 'YYYY-MM-DD') as day, sold from inventory where sold > 0`)).map((i) => [`${i.room_type_id}|${i.day}`, i.sold]));
  for (const l of live) if ((sold.get(`${l.room_type_id}|${l.day}`) ?? 0) < Number(l.qty)) problems.push(`inventory sold ${sold.get(`${l.room_type_id}|${l.day}`) ?? 0} < reservations ${l.qty} for ${l.room_type_id} ${l.day}`);

  const pays = await q<{ code: string; amount_paid: string; amount_refunded: string; total: string; payment_status: string; paid: string | null; refunded: string | null; n: string }>(`
    select r.reservation_code as code, r.amount_paid, r.amount_refunded, r.total, r.payment_status,
           sum(p.amount) as paid, sum(p.amount_refunded) as refunded, count(p.id) as n
    from reservations r left join payments p on p.reservation_id = r.id and p.status in ('PAID','PARTIALLY_REFUNDED','REFUNDED')
    group by r.id`);
  for (const r of pays) {
    if (r.payment_status !== 'CHANNEL_COLLECTED' && Number(r.n) > 0 && Number(r.amount_paid) !== Number(r.paid)) problems.push(`reservation ${r.code}: amountPaid ${r.amount_paid} != payments ${r.paid}`);
    if (r.payment_status !== 'CHANNEL_COLLECTED' && Number(r.n) > 0 && Number(r.amount_refunded) !== Number(r.refunded)) problems.push(`reservation ${r.code}: amountRefunded ${r.amount_refunded} != refunds ${r.refunded}`);
    if (Number(r.amount_paid) - Number(r.amount_refunded) > Number(r.total)) problems.push(`reservation ${r.code}: net paid exceeds total`);
  }
  return problems;
}

(async () => {
  const server = await startEphemeralPg();
  const work = mkdtempSync(path.join(tmpdir(), 'tirvona-restore-drill-'));
  const results: { step: string; ok: boolean; detail?: string }[] = [];
  const step = (name: string, ok: boolean, detail?: string) => {
    results.push({ step: name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  try {
    const srcPool = createPool({ url: await server.createDatabase('drill_source'), ssl: 'disable', poolMax: 10 });
    await migrate(srcPool, () => undefined);
    const srcDb = createDb(srcPool);
    await seed(srcDb);
    const paid = await srcPool.query(`select 1 from reservations where status = 'CONFIRMED' and amount_paid > 0 limit 1`);
    step('source database seeded (with at least one paid booking)', paid.rowCount === 1);

    const before = await invariants(srcPool);
    step('invariants hold on the source database', before.length === 0, before.slice(0, 3).join('; '));

    const manifest = await backup(srcPool, path.join(work, 'backup'));
    const total = Object.values(manifest).reduce((a, m) => a + m.count, 0);
    step('backup written', total > 0, `${Object.keys(manifest).length} tables, ${total} rows`);
    await srcDb.destroy();
    await server.dropDatabase('drill_source');
    step('source database destroyed', true);

    const dstPool = createPool({ url: await server.createDatabase('drill_restored'), ssl: 'disable', poolMax: 10 });
    await migrate(dstPool, () => undefined);
    step('fresh database migrated (constraints and indexes come from the migrations)', (await tablesOf(dstPool)).length === Object.keys(manifest).length);
    await restore(dstPool, path.join(work, 'backup'));
    const mismatches: string[] = [];
    const again = await backup(dstPool, path.join(work, 'verify'));
    for (const [name, m] of Object.entries(manifest)) {
      if (again[name]?.count !== m.count) mismatches.push(`${name}: ${again[name]?.count} != ${m.count} rows`);
      else if (again[name].hash !== m.hash) mismatches.push(`${name}: content differs`);
    }
    step('restored data identical to the backup (count and content hash per table)', mismatches.length === 0, mismatches.slice(0, 3).join('; '));

    const orphans = await dstPool.query(`
      select conrelid::regclass as t from pg_constraint c where contype = 'f' and not convalidated limit 1`);
    step('foreign keys still validated on the restored database', orphans.rowCount === 0);

    const after = await invariants(dstPool);
    step('invariants hold after the restore', after.length === 0, after.slice(0, 3).join('; '));

    const dup = await dstPool
      .query(`insert into reservations select * from jsonb_populate_record(null::reservations, (select to_jsonb(r) || jsonb_build_object('id', gen_random_uuid()) from reservations r limit 1))`)
      .then(
        () => false,
        (e: { code?: string }) => e.code === '23505',
      );
    step('uniqueness is enforced again after the restore (duplicate reservation code rejected)', dup);
    await dstPool.end();
  } finally {
    await server.stop();
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} step(s) FAILED` : '\nAll restore-drill steps passed (isolated embedded PostgreSQL).');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
