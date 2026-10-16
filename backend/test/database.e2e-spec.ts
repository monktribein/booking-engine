import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import * as enums from '../src/database/enums';
import { POOL_TOKEN } from '../src/database/kysely';
import { migrate, migrationsDir } from '../src/database/migrate';
import { SchedulerService } from '../src/jobs/scheduler.module';
import { registerOwner } from './utils/fixtures';
import { createTestApp, type TestApp } from './utils/test-app';

describe('PostgreSQL schema', () => {
  let t: TestApp;
  let pool: Pool;

  beforeAll(async () => {
    t = await createTestApp();
    pool = t.app.get<Pool>(POOL_TOKEN);
  });
  afterAll(() => t.close());

  it('migrations are idempotent: a second run applies nothing', async () => {
    const again = await migrate(pool, () => undefined);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied.length).toBeGreaterThan(0);
  });

  it('refuses a migration whose file changed after it was applied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirvona-mig-'));
    try {
      for (const f of fs.readdirSync(migrationsDir()).filter((x) => x.endsWith('.sql'))) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
      fs.appendFileSync(path.join(dir, '0001_init.sql'), '\n-- edited after it was applied\n');
      await expect(migrate(pool, () => undefined, dir)).rejects.toThrow(/changed after it was applied/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('row level security is enabled on every table (Supabase Data API exposes nothing)', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('audit logs are append-only at the database level', async () => {
    const owner = await registerOwner(t, 'audit');
    expect(owner.userId).toBeTruthy();
    const row = await t.db.selectFrom('auditLogs').select('id').executeTakeFirst();
    expect(row).toBeTruthy();
    await expect(pool.query(`update audit_logs set action = 'tampered' where id = $1`, [row!.id])).rejects.toMatchObject({ code: expect.any(String) });
    await expect(pool.query(`delete from audit_logs where id = $1`, [row!.id])).rejects.toBeTruthy();
  });

  it('CHECK constraints in the migration match the enums in the code (no drift)', () => {
    const sqlText = fs
      .readdirSync(migrationsDir())
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(migrationsDir(), f), 'utf8'))
      .join('\n');
    // Every `check (col in ('A','B',...))` list whose members are all UPPER_SNAKE words must equal one of the code's enums.
    const sets = new Set<string>();
    for (const m of sqlText.matchAll(/\bin \(((?:\s*'[A-Z0-9_]+'\s*,?)+)\)/g)) {
      sets.add(
        [...m[1].matchAll(/'([A-Z0-9_]+)'/g)]
          .map((x) => x[1])
          .sort()
          .join(','),
      );
    }
    const codeSets = new Map<string, string>();
    for (const [name, e] of Object.entries(enums)) {
      if (typeof e === 'object' && e && !Array.isArray(e)) codeSets.set(Object.values(e as Record<string, string>).sort().join(','), name);
    }
    // A list may be a subset of one enum (for example the channels that can be connected, or the settled delivery
    // states in a partial index). webhook_events.channel also accepts the payment provider RAZORPAY next to the channels.
    const enumValueLists = [...codeSets.keys()].map((k) => k.split(','));
    const channelsPlusRazorpay = [...Object.values(enums.ChannelCode), 'RAZORPAY'];
    const covered = (set: string) => {
      const members = set.split(',');
      return enumValueLists.some((vals) => members.every((m) => vals.includes(m))) || members.every((m) => channelsPlusRazorpay.includes(m));
    };
    const unknownToCode = [...sets].filter((x) => !covered(x));
    expect(unknownToCode).toEqual([]);
    // And the reverse for persisted enums: each enum used as a column type shows up as a CHECK list.
    const persisted = ['UserRole', 'UserStatus', 'PropertyStatus', 'ReservationStatus', 'ReservationSource', 'PaymentStatus', 'PaymentProvider', 'RefundStatus', 'SyncJobStatus', 'WebhookEventStatus', 'WebhookDeliveryStatus', 'NotificationStatus', 'NotificationType', 'ApiKeyStatus', 'OrganizationStatus', 'MarketplaceStatus', 'IntegrationRequestStatus', 'ProviderKind', 'ProviderProtocol', 'ProviderStatus', 'ProviderVisibility', 'ProviderVersionStatus', 'ConnectionSecretKind', 'ReconciliationRunStatus', 'ReconciliationIssueKind', 'ReconciliationIssueStatus', 'ProviderTestEnvironment'];
    for (const name of persisted) {
      const values = Object.values((enums as Record<string, unknown>)[name] as Record<string, string>).sort().join(',');
      expect({ name, inMigration: sets.has(values) }).toEqual({ name, inMigration: true });
    }
  });

  it('the scheduler purges expired sessions, reset tokens, old logs and settled deliveries (replaces Mongo TTL indexes)', async () => {
    const owner = await registerOwner(t, 'purge');
    const old = new Date(Date.now() - 3 * 86_400_000);
    await t.db.insertInto('authSessions').values({ userId: owner.userId, familyId: owner.userId, refreshTokenHash: 'x'.repeat(64), expiresAt: old, lastUsedAt: old }).execute();
    await t.db.insertInto('passwordResetTokens').values({ userId: owner.userId, tokenHash: 'y'.repeat(64), expiresAt: old }).execute();
    const live = await t.db.selectFrom('authSessions').select((eb) => eb.fn.countAll<string>().as('n')).where('userId', '=', owner.userId).where('expiresAt', '>', new Date()).executeTakeFirstOrThrow();
    expect(Number(live.n)).toBeGreaterThan(0); // the login session is still alive

    const counts = await t.app.get(SchedulerService).purgeExpired();
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    expect(counts.resetTokens).toBeGreaterThanOrEqual(1);
    const left = await t.db.selectFrom('authSessions').select('id').where('userId', '=', owner.userId).where('expiresAt', '<', new Date()).execute();
    expect(left).toEqual([]);
    const still = await t.db.selectFrom('authSessions').select('id').where('userId', '=', owner.userId).where('expiresAt', '>', new Date()).execute();
    expect(still.length).toBeGreaterThan(0); // live sessions are never purged
  });
});
