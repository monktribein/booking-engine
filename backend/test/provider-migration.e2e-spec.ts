import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { POOL_TOKEN } from '../src/database/kysely';
import { migrate, migrationsDir } from '../src/database/migrate';
import { createTestApp, type TestApp } from './utils/test-app';

const ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * Upgrade test for migration 0003 (channel providers + connection-scoped external ids): builds a database at 0002 with
 * channel data in it, applies 0003, and proves the old data survives and the new guarantees hold.
 */
describe('migration 0003: channel providers and connection-scoped external ids', () => {
  let t: TestApp;
  let admin: Pool;
  let pool: Pool;
  const dbName = `tirvona_test_mig${Date.now().toString(36)}`;
  let dir: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = t.app.get<Pool>(POOL_TOKEN);
    await admin.query(`create database ${dbName} template template0 encoding 'UTF8'`);
    const base = (admin as unknown as { options: { connectionString?: string } }).options.connectionString;
    if (!base) throw new Error('pool has no connection string');
    const u = new URL(base);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 2 });

    // Stage 1: only 0001 + 0002 (what production runs today).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirvona-mig3-'));
    for (const f of fs.readdirSync(migrationsDir()).filter((x) => /^000[12]_.*\.sql$/.test(x))) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
    await migrate(pool, () => undefined, dir);

    // Existing data: one org / property with a connection, a listing, a webhook event and an OTA reservation.
    await pool.query(`insert into organizations (id, name, slug) values ('11111111-1111-1111-1111-111111111111', 'Org A', 'org-a'), ('22222222-2222-2222-2222-222222222222', 'Org B', 'org-b')`);
    await pool.query(
      `insert into users (id, organization_id, name, email, password_hash, role, status) values
       ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A', 'a@example.com', 'scrypt$x', 'PROPERTY_OWNER', 'ACTIVE'),
       ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'B', 'b@example.com', 'scrypt$x', 'PROPERTY_OWNER', 'ACTIVE')`,
    );
    for (const [pid, org, owner, slug] of [
      ['bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'prop-a'],
      ['bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 'prop-b'],
    ]) {
      await pool.query(`insert into properties (id, organization_id, owner_id, name, slug, address, city, state, country, postal_code, timezone, currency) values ($1,$2,$3,$4,$4,'a','c','s','IN','1','Asia/Kolkata','INR')`, [pid, org, owner, slug]);
    }
    await pool.query(`insert into channel_connections (id, property_id, channel, status) values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'MOCK', 'CONNECTED')`);
    await pool.query(`insert into channel_listings (property_id, channel_connection_id, channel, external_listing_id, name) values ('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'MOCK', 'L-1', 'Old listing')`);
    await pool.query(`insert into webhook_events (channel, event_type, external_event_id, payload, signature_valid) values ('MOCK', 'x', 'E-1', '{}', true)`);

    // Stage 2: the real migration set.
    const res = await migrate(pool, () => undefined);
    expect(res.applied.some((n) => n.includes('0003'))).toBe(true);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    await t.close();
  });

  it('seeds the built-in providers and keeps existing connections, listings and events', async () => {
    const providers = await pool.query<{ code: string }>(`select code from channel_providers order by code`);
    expect(providers.rows.map((r) => r.code)).toEqual(['AGODA', 'AIRBNB', 'BOOKING_COM', 'DIRECT', 'ICAL', 'MOCK', 'OTHER', 'RAZORPAY', 'TIRVONA']);
    const conn = await pool.query(`select provider_id is not null as linked from channel_connections where id = 'cccccccc-0000-0000-0000-000000000001'`);
    expect(conn.rows[0].linked).toBe(true);
    const listing = await pool.query(`select external_scope, name from channel_listings where external_listing_id = 'L-1'`);
    expect(listing.rows[0]).toEqual({ external_scope: ZERO, name: 'Old listing' });
    const ev = await pool.query(`select external_scope from webhook_events where external_event_id = 'E-1'`);
    expect(ev.rows[0].external_scope).toBe(ZERO);
  });

  it('a built-in channel keeps its global uniqueness (same scope, same external id is refused)', async () => {
    await expect(
      pool.query(`insert into channel_listings (property_id, channel, external_listing_id, name) values ('bbbbbbbb-0000-0000-0000-000000000002', 'MOCK', 'L-1', 'Squatter')`),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a new provider is a row, and two tenants may use the same external ids under their own connection scope', async () => {
    await pool.query(`insert into channel_providers (code, name, kind, protocol, status) values ('ACME_PMS', 'Acme PMS', 'PMS', 'REST_JSON', 'ACTIVE')`);
    const connA = '33333333-0000-0000-0000-00000000000a';
    const connB = '33333333-0000-0000-0000-00000000000b';
    await pool.query(`insert into channel_connections (id, property_id, channel) values ($1, 'bbbbbbbb-0000-0000-0000-000000000001', 'ACME_PMS'), ($2, 'bbbbbbbb-0000-0000-0000-000000000002', 'ACME_PMS')`, [connA, connB]);
    for (const [conn, prop] of [[connA, 'bbbbbbbb-0000-0000-0000-000000000001'], [connB, 'bbbbbbbb-0000-0000-0000-000000000002']]) {
      await pool.query(`insert into channel_listings (property_id, channel_connection_id, channel, external_listing_id, external_scope, name) values ($1, $2, 'ACME_PMS', '101', $2, 'Room 101')`, [prop, conn]);
      await pool.query(`insert into webhook_events (channel, external_scope, event_type, external_event_id, payload, signature_valid) values ('ACME_PMS', $1, 'x', 'evt-1', '{}', true)`, [conn]);
      const g = await pool.query<{ id: string }>(`insert into guests (property_id, first_name) values ($1, 'G') returning id`, [prop]);
      await pool.query(
        `insert into reservations (property_id, guest_id, source, external_scope, external_reservation_id, reservation_code, check_in, check_out, nights, adults, guest, subtotal, tax, total, currency)
         values ($1, $2, 'ACME_PMS', $3, 'R-1', $4, '2027-01-01', '2027-01-02', 1, 1, '{"firstName":"G","lastName":"H"}', 100, 0, 100, 'INR')`,
        [prop, g.rows[0].id, conn, `TRV-${conn.slice(-1).toUpperCase()}AAAAAAA`],
      );
    }
    // same external reservation id again inside the SAME connection scope is a duplicate; across tenants it is not
    const gA = await pool.query<{ id: string }>(`select id from guests where property_id = 'bbbbbbbb-0000-0000-0000-000000000001' limit 1`);
    await expect(
      pool.query(
        `insert into reservations (property_id, guest_id, source, external_scope, external_reservation_id, reservation_code, check_in, check_out, nights, adults, guest, subtotal, tax, total, currency)
         values ('bbbbbbbb-0000-0000-0000-000000000001', $1, 'ACME_PMS', $2, 'R-1', 'TRV-DUPLICAT', '2027-01-01', '2027-01-02', 1, 1, '{"firstName":"G","lastName":"H"}', 100, 0, 100, 'INR')`,
        [gA.rows[0].id, connA],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const dup = pool.query(`insert into channel_listings (property_id, channel_connection_id, channel, external_listing_id, external_scope, name) values ('bbbbbbbb-0000-0000-0000-000000000001', $1, 'ACME_PMS', '101', $1, 'again')`, [connA]);
    await expect(dup).rejects.toMatchObject({ code: '23505' });
    const events = await pool.query(`select count(*)::int as n from webhook_events where channel = 'ACME_PMS' and external_event_id = 'evt-1'`);
    expect(events.rows[0].n).toBe(2);
  });

  it('an unknown channel code is refused by the foreign key', async () => {
    await expect(pool.query(`insert into channel_connections (property_id, channel) values ('bbbbbbbb-0000-0000-0000-000000000001', 'NOT_A_PROVIDER')`)).rejects.toMatchObject({ code: '23503' });
  });

  it('published provider versions are immutable and cannot be reactivated once retired', async () => {
    const p = await pool.query<{ id: string }>(`select id from channel_providers where code = 'ACME_PMS'`);
    const hash = 'a'.repeat(64);
    const v = await pool.query<{ id: string }>(`insert into channel_provider_versions (provider_id, version, status, definition, definition_hash, published_at) values ($1, 1, 'PUBLISHED', '{"a":1}', $2, now()) returning id`, [p.rows[0].id, hash]);
    await expect(pool.query(`update channel_provider_versions set definition = '{"a":2}' where id = $1`, [v.rows[0].id])).rejects.toThrow(/immutable/);
    await expect(pool.query(`delete from channel_provider_versions where id = $1`, [v.rows[0].id])).rejects.toThrow(/cannot be deleted/);
    await pool.query(`update channel_provider_versions set status = 'RETIRED' where id = $1`, [v.rows[0].id]);
    await expect(pool.query(`update channel_provider_versions set status = 'PUBLISHED' where id = $1`, [v.rows[0].id])).rejects.toThrow(/cannot be reactivated/);
  });

  it('connection secrets must be encrypted envelopes', async () => {
    await expect(pool.query(`insert into channel_connection_secrets (connection_id, kind, ciphertext) values ('33333333-0000-0000-0000-00000000000a', 'API_KEY', 'plaintext-key')`)).rejects.toMatchObject({ code: '23514' });
    await pool.query(`insert into channel_connection_secrets (connection_id, kind, ciphertext) values ('33333333-0000-0000-0000-00000000000a', 'API_KEY', 'v1:aaaa:bbbb:cccc')`);
  });

  it('RLS is enabled on every new table', async () => {
    const r = await pool.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname = any($1)`, [['channel_providers', 'channel_provider_versions', 'channel_connection_secrets', 'reconciliation_runs', 'reconciliation_issues', 'channel_provider_tests', 'ical_export_feeds']]);
    expect(r.rows).toHaveLength(7);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });
});
