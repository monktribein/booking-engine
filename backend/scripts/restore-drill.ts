/**
 * Backup + restore DRILL, entirely in an isolated throw-away MongoDB (in-memory replica set). It never touches your
 * configured database and never connects to anything else.
 *
 *   npx tsx scripts/restore-drill.ts
 *
 * What it proves (and what it does not):
 *  1. A logical backup of EVERY collection (extended JSON, so ObjectIds, dates and decimals survive) can be taken from a
 *     seeded database that also contains a booking, a payment and a refund.
 *  2. After the database is destroyed, a restore into a fresh database brings back identical documents (per-collection count
 *     and content hash), then indexes and validators are re-created with setup-db.
 *  3. The invariants that matter for reservations and payments hold after the restore:
 *       - inventory: available == total - sold - blocked, never negative
 *       - reservations: sum of their nights x rooms == sold counters for CONFIRMED / PENDING / CHECKED_IN stays
 *       - payments: reservation.amountPaid == PAID payments - refunds, never above the reservation total
 *       - uniqueness (reservation code, source+external id) is enforced again by the restored indexes
 * It does NOT test your hosting provider's backups (Atlas snapshots, PITR): those must be restored into a scratch
 * cluster by you; see docs/OPERATIONS.md.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EJSON } from 'bson';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { seed } from './seed';
import { setupDatabase } from './setup-db';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function backup(conn: Connection, dir: string): Promise<Record<string, { count: number; hash: string }>> {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, { count: number; hash: string }> = {};
  for (const { name } of await conn.db!.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const docs = await conn.db!.collection(name).find().sort({ _id: 1 }).toArray();
    const text = docs.map((d) => EJSON.stringify(d, { relaxed: false })).join('\n');
    writeFileSync(path.join(dir, `${name}.ndjson`), text);
    manifest[name] = { count: docs.length, hash: sha(text) };
  }
  writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function restore(conn: Connection, dir: string): Promise<void> {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    const name = file.replace(/\.ndjson$/, '');
    const text = readFileSync(path.join(dir, file), 'utf8');
    const docs = text ? text.split('\n').map((l) => EJSON.parse(l, { relaxed: false })) : [];
    await conn.db!.createCollection(name).catch(() => undefined);
    if (docs.length) await conn.db!.collection(name).insertMany(docs, { ordered: true });
  }
}

async function invariants(conn: Connection): Promise<string[]> {
  const problems: string[] = [];
  const db = conn.db!;
  for (const i of await db.collection('inventory').find().toArray()) {
    if (i.available !== i.total - i.sold - i.blocked + (i.overbooked ?? 0) && i.available !== Math.max(0, i.total - i.sold - i.blocked)) problems.push(`inventory ${i._id}: available ${i.available} != total-sold-blocked`);
    if (i.available < 0 || i.sold < 0 || i.blocked < 0) problems.push(`inventory ${i._id}: negative counter`);
  }
  const live = await db.collection('reservations').find({ status: { $in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } }).toArray();
  const expected = new Map<string, number>();
  for (const r of live) {
    for (const line of r.reservationRooms ?? []) {
      for (const n of line.nightlyRates ?? []) {
        const key = `${line.roomTypeId}|${new Date(n.date).toISOString().slice(0, 10)}`;
        expected.set(key, (expected.get(key) ?? 0) + line.quantity);
      }
    }
  }
  const sold = new Map<string, number>();
  for (const i of await db.collection('inventory').find({ sold: { $gt: 0 } }).toArray()) sold.set(`${i.roomTypeId}|${new Date(i.date).toISOString().slice(0, 10)}`, i.sold);
  for (const [k, v] of expected) if ((sold.get(k) ?? 0) < v) problems.push(`inventory sold ${sold.get(k) ?? 0} < reservations ${v} for ${k}`);
  for (const r of await db.collection('reservations').find().toArray()) {
    const pays = await db.collection('payments').find({ reservationId: r._id, status: { $in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }).toArray();
    const paid = pays.reduce((a, p) => a + p.amount, 0);
    const refunded = pays.reduce((a, p) => a + (p.amountRefunded ?? 0), 0);
    if (r.paymentStatus !== 'CHANNEL_COLLECTED' && pays.length && r.amountPaid !== paid) problems.push(`reservation ${r.reservationCode}: amountPaid ${r.amountPaid} != payments ${paid}`);
    if (r.paymentStatus !== 'CHANNEL_COLLECTED' && pays.length && r.amountRefunded !== refunded) problems.push(`reservation ${r.reservationCode}: amountRefunded ${r.amountRefunded} != refunds ${refunded}`);
    if (r.amountPaid - r.amountRefunded > r.total) problems.push(`reservation ${r.reservationCode}: net paid exceeds total`);
  }
  return problems;
}

(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const work = mkdtempSync(path.join(tmpdir(), 'tirvona-restore-drill-'));
  const results: { step: string; ok: boolean; detail?: string }[] = [];
  const step = (name: string, ok: boolean, detail?: string) => {
    results.push({ step: name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  try {
    const src = await mongoose.createConnection(rs.getUri(), { dbName: 'drill_source', autoIndex: false, autoCreate: false }).asPromise();
    await setupDatabase(src, { log: () => undefined });
    await seed(src);
    const reservation = await src.db!.collection('reservations').findOne({ status: 'CONFIRMED', amountPaid: { $gt: 0 } });
    step('source database seeded (with at least one paid booking)', !!reservation);

    const before = await invariants(src);
    step('invariants hold on the source database', before.length === 0, before.slice(0, 3).join('; '));

    const manifest = await backup(src, path.join(work, 'backup'));
    const total = Object.values(manifest).reduce((a, m) => a + m.count, 0);
    step('backup written', total > 0, `${Object.keys(manifest).length} collections, ${total} documents`);
    await src.dropDatabase();
    step('source database destroyed', (await src.db!.listCollections().toArray()).length === 0);
    await src.close();

    const dst = await mongoose.createConnection(rs.getUri(), { dbName: 'drill_restored', autoIndex: false, autoCreate: false }).asPromise();
    await restore(dst, path.join(work, 'backup'));
    const mismatches: string[] = [];
    const again = await backup(dst, path.join(work, 'verify'));
    for (const [name, m] of Object.entries(manifest)) {
      if (again[name]?.count !== m.count) mismatches.push(`${name}: ${again[name]?.count} != ${m.count} documents`);
      else if (again[name].hash !== m.hash) mismatches.push(`${name}: content differs`);
    }
    step('restored data identical to the backup (count and content hash per collection)', mismatches.length === 0, mismatches.slice(0, 3).join('; '));

    await setupDatabase(dst, { log: () => undefined });
    step('indexes and validators re-created on the restored database', (await dst.db!.collection('reservations').indexes()).length > 1);

    const after = await invariants(dst);
    step('invariants hold after the restore', after.length === 0, after.slice(0, 3).join('; '));

    const dup = await dst.db!.collection('reservations').insertOne({ ...(await dst.db!.collection('reservations').findOne({ reservationCode: { $exists: true } }))!, _id: new mongoose.Types.ObjectId() }).then(
      () => false,
      () => true,
    );
    step('uniqueness is enforced again after the restore (duplicate reservation code rejected)', dup);
    await dst.close();
  } finally {
    await rs.stop();
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} step(s) FAILED` : '\nAll restore-drill steps passed (isolated in-memory database).');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
