import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { POOL_TOKEN } from '../src/database/kysely';
import { migrate, migrationsDir } from '../src/database/migrate';
import { createTestApp, type TestApp } from './utils/test-app';

/**
 * Upgrade test for migration 0005 (channel payment visibility): builds a database at 0004 with reservations in it, applies 0005, and
 * proves that an importer's old "channel collected" assumption does not survive as a fact, that every other row is untouched and that
 * the new guarantees hold. This is a real upgrade of a populated database (embedded PostgreSQL), not a hosted one.
 */
describe('migration 0005: channel payment visibility', () => {
  let t: TestApp;
  let admin: Pool;
  let pool: Pool;
  const dbName = `tirvona_test_mig5${Date.now().toString(36)}`;
  let dir: string;
  const PROP = 'bbbbbbbb-0000-0000-0000-000000000001';

  const insertReservation = (code: string, source: string, status: string, paid: number, ext: string | null) =>
    pool.query(
      `insert into reservations (property_id, guest_id, source, external_reservation_id, reservation_code, check_in, check_out, nights, adults, guest, subtotal, tax, total, currency, payment_status, amount_paid)
       values ($1, (select id from guests where property_id = $1 limit 1), $2, $3, $4, '2027-01-01', '2027-01-02', 1, 1, '{"firstName":"G","lastName":"H"}', 100, 0, 100, 'INR', $5, $6)`,
      [PROP, source, ext, code, status, paid],
    );

  beforeAll(async () => {
    t = await createTestApp();
    admin = t.app.get<Pool>(POOL_TOKEN);
    await admin.query(`create database ${dbName} template template0 encoding 'UTF8'`);
    const base = (admin as unknown as { options: { connectionString?: string } }).options.connectionString;
    if (!base) throw new Error('pool has no connection string');
    const u = new URL(base);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 2 });

    // Stage 1: 0001..0004 only (what the code before this change runs).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirvona-mig5-'));
    for (const f of fs.readdirSync(migrationsDir()).filter((x) => /^000[1-4]_.*\.sql$/.test(x))) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
    await migrate(pool, () => undefined, dir);

    await pool.query(`insert into organizations (id, name, slug) values ('11111111-1111-1111-1111-111111111111', 'Org A', 'org-a')`);
    await pool.query(`insert into users (id, organization_id, name, email, password_hash, role, status) values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A', 'a@example.com', 'scrypt$x', 'PROPERTY_OWNER', 'ACTIVE')`);
    await pool.query(`insert into properties (id, organization_id, owner_id, name, slug, address, city, state, country, postal_code, timezone, currency) values ($1,'11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','P','prop-a','a','c','s','IN','1','Asia/Kolkata','INR')`, [PROP]);
    await pool.query(`insert into guests (property_id, first_name) values ($1, 'G')`, [PROP]);
    await insertReservation('TRV-OLDCHAN1', 'AIRBNB', 'CHANNEL_COLLECTED', 0, 'ABB-1'); // the importer's assumption
    await insertReservation('TRV-OLDPAID1', 'DIRECT', 'PAID', 100, null); // a real Tirvona payment
    await insertReservation('TRV-OLDUNPD1', 'MOCK', 'UNPAID', 0, 'M-1');
    await insertReservation('TRV-OLDPART1', 'TIRVONA', 'PARTIALLY_PAID', 40, null);

    const res = await migrate(pool, () => undefined);
    expect(res.applied.some((n) => n.includes('0005'))).toBe(true);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    await t.close();
  });

  const row = async (code: string) => (await pool.query(`select * from reservations where reservation_code = $1`, [code])).rows[0];

  it('a historical CHANNEL_COLLECTED row becomes UNKNOWN: an importer assumption is not kept as a fact', async () => {
    const r = await row('TRV-OLDCHAN1');
    expect(r.payment_status).toBe('UNKNOWN');
    expect(r.collection_model).toBeNull();
    expect(r.collection_source).toBeNull();
    expect(Number(r.amount_paid)).toBe(0);
  });

  it('every other historical row keeps its status and amounts (a real direct payment stays PAID)', async () => {
    expect(await row('TRV-OLDPAID1')).toMatchObject({ payment_status: 'PAID', amount_paid: 100 });
    expect(await row('TRV-OLDUNPD1')).toMatchObject({ payment_status: 'UNPAID', amount_paid: 0 });
    expect(await row('TRV-OLDPART1')).toMatchObject({ payment_status: 'PARTIALLY_PAID', amount_paid: 40 });
  });

  it('all new fields are NULL on historical rows: nothing was reported, nothing is invented', async () => {
    for (const code of ['TRV-OLDCHAN1', 'TRV-OLDPAID1', 'TRV-OLDUNPD1', 'TRV-OLDPART1']) {
      const r = await row(code);
      for (const col of ['collection_model', 'collection_source', 'provider_payment_status_raw', 'provider_payment_status', 'payout_status_raw', 'payout_status', 'payout_date', 'commission_amount', 'net_amount', 'payment_info_updated_at']) {
        expect([code, col, r[col]]).toEqual([code, col, null]);
      }
    }
  });

  it('the new rules are enforced by the database', async () => {
    // CHANNEL_COLLECTED needs a CHANNEL collection model behind it
    await expect(pool.query(`update reservations set payment_status = 'CHANNEL_COLLECTED' where reservation_code = 'TRV-OLDUNPD1'`)).rejects.toMatchObject({ code: '23514' });
    // a collection model needs its source, and the reverse
    await expect(pool.query(`update reservations set collection_model = 'CHANNEL' where reservation_code = 'TRV-OLDUNPD1'`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`update reservations set collection_source = 'PROVIDER' where reservation_code = 'TRV-OLDUNPD1'`)).rejects.toMatchObject({ code: '23514' });
    // values outside the lists, negative money
    await expect(pool.query(`update reservations set provider_payment_status = 'SETTLED' where reservation_code = 'TRV-OLDUNPD1'`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`update reservations set commission_amount = -1 where reservation_code = 'TRV-OLDUNPD1'`)).rejects.toMatchObject({ code: '23514' });
    // a consistent declaration is accepted
    await pool.query(`update reservations set collection_model = 'CHANNEL', collection_source = 'OPERATOR_CONFIG', payment_status = 'CHANNEL_COLLECTED' where reservation_code = 'TRV-OLDUNPD1'`);
    expect(await row('TRV-OLDUNPD1')).toMatchObject({ payment_status: 'CHANNEL_COLLECTED', collection_model: 'CHANNEL', collection_source: 'OPERATOR_CONFIG' });
  });

  it('re-running the migrations is a no-op', async () => {
    const again = await migrate(pool, () => undefined);
    expect(again.applied).toEqual([]);
  });
});
