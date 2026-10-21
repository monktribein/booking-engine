# Migration runbook: 0002, 0003, 0004, 0005 on the hosted Supabase database

**Nothing in this document has been executed against any hosted database.** Applying migrations to production needs the
owner's explicit approval. Database: PostgreSQL (Supabase as hosted Postgres). Client: Kysely over `pg`. Tooling:
`npm run db:migrate` (`backend/src/database/migrate.ts`): one transaction per file, a session advisory lock, checksums in
`schema_migrations`, forward-only. There is **no down migration**; recovery is restore-from-backup (below).

## 1. Current status

Unknown to this work: no connection to the hosted database was available to the audit, and `backend/.env` was deliberately not
read. Earlier notes say `0001` is applied and `0002`/`0003` are not; `0004` and `0005` are newer and certainly not. Find out yourself, read-only, with the new check (it opens a
READ ONLY transaction, prints no password or connection string):

```
cd backend && npm ci && npm run build
DATABASE_URL=<direct or session-pooler URL> DATABASE_SSL=verify-full DATABASE_CA_CERT=<supabase ca> npm run db:check
```
It prints the TLS mode, server version, role, how many public tables have RLS, and each migration as `applied`, `PENDING` or
`CHANGED AFTER APPLY`. Exit code 1 means a problem or a pending migration. (Verified against a throwaway local PostgreSQL 17,
empty and fully migrated; not against Supabase.)

## 2. What each migration changes

| File | Changes | Existing data |
| --- | --- | --- |
| `0002_partner_platform.sql` | organization approval columns and status values, new user role values, property marketplace/visibility columns, API-key environment/rotation/usage, `api_key_usage` and `integration_requests` tables, reservation `api_key_id` + `partner_reference` (unique per property) | every existing organization stays `ACTIVE` (`approved_at` backfilled); every `ACTIVE` property gets `direct_booking_enabled = true`, so public pages keep working |
| `0003_channel_providers.sql` | `channel_providers` (9 built-in rows seeded) and 6 more provider/reconciliation/iCal tables; channel columns become foreign keys to `channel_providers(code)`; external ids become connection-scoped (`external_scope`, zero UUID = the historic global scope); `reservations_external_key` replaced by a scoped unique index | pre-checks below must return no rows. Drops/recreates one unique index on `reservations` (brief write lock) |
| `0004_pricing_retirement_retention.sql` | `rate_rules`; room type occupancy columns; promotion limit columns and `promotion_redemptions`; room `RETIRED` status + retirement columns, room-number uniqueness becomes a partial index; `data_retention_policies`, `data_retention_runs`, `guests.anonymized_at`, `notifications.redacted_at`, `webhook_events.payload_redacted_at` | all new columns are nullable or defaulted: no rule rows -> every night costs the base price; no `base_occupancy` -> no extra-guest charge; no limit -> unlimited; no policy -> nothing anonymised. Re-created constraints (`rooms_status_check`, the room-number unique) are widened, so existing rows satisfy them |
| `0005_channel_payment_visibility.sql` | `reservations.payment_status` accepts `UNKNOWN`; ten new NULLABLE columns (`collection_model`, `collection_source`, provider payment status raw/normalised, payout status raw/normalised and date, `commission_amount`, `net_amount`, `payment_info_updated_at`); three CHECK constraints | **Data change:** every row with `payment_status = 'CHANNEL_COLLECTED'` becomes `UNKNOWN` (an importer's assumption with no recorded provenance; amounts untouched). All other rows, including real Tirvona payments, are unchanged. The new columns are NULL on every row. See [PAYMENT_VISIBILITY.md](PAYMENT_VISIBILITY.md) |

Locking: DDL takes brief `ACCESS EXCLUSIVE` locks on the touched tables; the tables are small at launch scale (rooms, room types,
promotions, organizations, users, properties; `reservations` for the `0003` index and `0002` columns). Run in a quiet window and
expect seconds, not minutes, until reservations number in the hundreds of thousands. Constant-default `ADD COLUMN` needs no rewrite
on PostgreSQL 11+.

Every new table has row-level security enabled with **no policies** (the Supabase Data API sees nothing) and `anon` /
`authenticated` privileges revoked. The application role must own the tables or have `BYPASSRLS` (the default `postgres` role does);
`db:check` warns otherwise.

## 3. Verified locally (isolated embedded PostgreSQL 17)

Migrations apply from scratch and re-apply idempotently; checksum protection; RLS on all 45 tables; `0003` upgrade of a populated
`0002` database (`provider-migration` e2e); CHECK lists equal the code's enums (`database.e2e-spec`); `npm run db:verify`
(concurrency and integrity); `npm run drill:restore` (backup, destroy, restore, invariants). `0004` was applied from scratch by
every backend suite; its upgrade over a populated `0003` database is by inspection only (additive, see above), not by a dedicated test.
`0005` has a dedicated upgrade test (`migration-0005` e2e): a database at `0004` with channel-collected, direct-paid, unpaid and
partly paid reservations is upgraded; the importer-assumed row becomes `UNKNOWN`, every other row keeps its status and amounts, all new
columns are NULL, the new CHECKs reject inconsistent rows, and re-running is a no-op. That is an embedded-PostgreSQL upgrade, **not** a test against the hosted database.

## 4. Procedure (REQUIRES AUTHORIZATION; do not start without it)

1. **Backup.** Supabase dashboard -> Database -> Backups: confirm PITR is on or take an on-demand backup, and note its time.
   Optionally also `pg_dump --format=custom -f pre-migration.dump "<direct url>"`. Do not continue without a restorable backup.
2. **Pre-checks (read-only), if `0003` is pending** (all must return no rows):
   ```sql
   select distinct channel from channel_connections where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
   select distinct channel from channel_listings  where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
   select distinct channel from webhook_events    where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK','RAZORPAY');
   select distinct channel from sync_jobs         where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
   select distinct source  from reservations      where source !~ '^[A-Z][A-Z0-9_]{1,31}$';
   select id from reservations where source in ('AIRBNB','BOOKING_COM','AGODA','MOCK') and external_reservation_id is null;
   ```
   For `0002`: `select count(*) from organizations where status not in ('ACTIVE','SUSPENDED','ARCHIVED')` is 0 (old values only).
3. **Connection.** Direct (`db.<ref>.supabase.co:5432`) or session pooler (5432 on the pooler host). Never the transaction pooler
   (6543): migrations hold a session advisory lock.
4. **Apply** (from `backend/`): `DATABASE_URL=... DATABASE_SSL=verify-full DATABASE_CA_CERT=... npm run db:migrate`. Expected output:
   `applied 0002_...`, `applied 0003_...`, `applied 0004_...`, `applied 0005_...` then `migrations: 4 applied, 1 already up to date`.
5. **Verify.** `npm run db:check` -> `RESULT ok`; then
   `select count(*) from channel_providers where built_in;` -> 9; `select count(*) from rate_rules;` -> 0;
   `select count(*) from data_retention_policies;` -> 0; `select count(*) from reservations where payment_status = 'CHANNEL_COLLECTED';` -> 0 (the `0005` data change; record the count it had **before** the migration in your change log); deploy the backend with `CHANNEL_PROVIDERS_ENABLED=false`; check `/health`,
   one test booking, one channel sync, the dashboard.
6. **Deploy order.** Migrate first, then API + worker (same image), then web. **Exception for `0005`:** the previous release is NOT safe against this schema. It still writes `CHANNEL_COLLECTED` for new channel bookings without a collection model, which the new CHECK rejects, so channel imports from the old release would fail. Roll forward (fix and redeploy the new release); roll back only together with a database restore.

## 5. If it fails or must be undone

* A failing file rolls back its own transaction; earlier files stay applied. Fix the cause and run `db:migrate` again (it resumes).
* There is no `down`. To undo an applied migration: restore the backup/PITR to a **new** project or point in time, verify, and
  switch (`DATABASE_URL`). This loses bookings and payments made after the backup, so use it only for a faulty migration; reconcile
  Razorpay payments for the gap from the Razorpay dashboard (see OPERATIONS.md).
* Preferred alternative: **forward recovery**. Because every change is additive and defaulted, a problem in new behaviour can be
  switched off without schema changes (no rate rules, no retention policy, `CHANNEL_PROVIDERS_ENABLED=false`), and a bad migration is
  repaired with a new `0006` file, never by editing an applied one. The one exception is `0005`: its `CHANNEL_COLLECTED` to `UNKNOWN` update is a data change that only a backup restore reverses, so take the backup first and record the affected count.

## 6. Approval still required

Applying any migration to the hosted database; creating or restoring backups; changing `DATABASE_URL` / SSL settings; running
`retention --apply`. None was done.
