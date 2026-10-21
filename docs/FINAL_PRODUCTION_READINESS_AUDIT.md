# Final production readiness audit

Date of evidence: **2026-10-19**. Scope: the whole repository (`backend/`, `frontend/`, `sdk/`, `docs/`, CI and compose files) at `main` (`bead3cc`) plus the changes made in this audit (uncommitted: nothing was committed, pushed, deployed or migrated).

Every result in this document comes from a command that was run on this machine (Windows 11, Node 24.20, embedded PostgreSQL 17, Chrome through Playwright). Anything that could not be run is marked **BLOCKED** or **REQUIRES AUTHORIZATION** instead of passed. Status words used throughout:

| Word | Meaning |
| --- | --- |
| IMPLEMENTED | code exists |
| VERIFIED | an automated test or command that was run here proves it, in the stated environment |
| BLOCKED BY EXTERNAL ACCESS | needs an account, credential, approval or service not available here |
| REQUIRES AUTHORIZATION | touches production or something irreversible; not done |
| NOT IMPLEMENTED | does not exist |
| FAILED | was run and failed |

## 0. Verdict

**Not labelled CORE PRODUCTION READY.** The application code is complete and well tested locally, and this audit fixed the defects it found, but the acceptance list (section 14) still has items that can only be closed outside this machine: a real Supabase project with migrations `0002` and `0003` applied and backups verified, a real Razorpay test-mode payment, real Redis for BullMQ, built Docker images, SMTP, and the first CI run result. None of those is a code defect. Airbnb, Booking.com and Agoda are **not connected** (partner approval needed) and the product never claims otherwise.

### Where the brief and the repository differ

The brief mentions `Newbackend/database/migrations/0009_model_changes.sql`, "five partner tables", "model registrations" and a page at `/admin/developer-api`. **None of these exist in this repository** (no `Newbackend/` folder, no file named `0009*`, no route `developer-api`, no Mongo models: MongoDB was removed on 2026-10-15). The equivalents here are:

| Brief | This repository |
| --- | --- |
| partner migration `0009` | `backend/src/database/migrations/0002_partner_platform.sql` (adds `api_key_usage`, `integration_requests`, key/org/property columns) and `0003_channel_providers.sql` (7 new tables + FKs) |
| "five partner tables" | `api_key_usage`, `integration_requests` (0002); `channel_providers`, `channel_provider_versions`, `channel_connection_secrets`, `reconciliation_runs`, `reconciliation_issues`, `channel_provider_tests`, `ical_export_feeds` (0003) |
| `/admin/developer-api` | partner-side: Settings → Developers (`/dashboard/developers`: keys, webhooks, deliveries); platform-side: `/admin/partners`, `/admin/integrations`, `/admin/providers`, `/admin/marketplace`, `/admin/operations`, `/admin/audit` |

If a different checkout (with `Newbackend/`) exists, it was not audited.

## 0b. Round 2 (2026-10-19, later the same day): the previously missing internal features, UI/accessibility, dependency, runbooks

**Architecture, restated and checked in the code:** PostgreSQL (Supabase as hosted Postgres) is the only database, through Kysely 0.28 + `pg`, hand-written forward-only SQL migrations (`backend/src/database/migrations`, `npm run db:migrate`). There is no MongoDB, Mongoose, `Newbackend` or `0009` anywhere; nothing in this round introduced any. Every database change below is a new migration, `0004_pricing_retirement_retention.sql`, written in the same conventions (CHECK constraints, partial indexes, RLS on with no policies, `anon`/`authenticated` revoked, `set_updated_at` triggers). **It has not been applied to any hosted database** (runbook: [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md)).

| Item | Status | Evidence |
| --- | --- | --- |
| Date-level, seasonal, weekday and rate-plan rate rules with documented precedence and conflict refusal | IMPLEMENTED, VERIFIED locally | 10 unit tests (`pricing.spec.ts`), pricing e2e (precedence per date through `/rate-calendar`, `RATE_RULE_CONFLICT`, concurrency-safe via advisory lock); UI Rates -> "Seasonal & date rates" |
| Occupancy / extra-guest charges (per room type, adults and children) | IMPLEMENTED, VERIFIED locally | quote = reservation = payment order amount asserted; party change re-prices extras; refused while a payment is pending |
| Promotion limits: total uses, per guest, minimum value, clear reasons, concurrent safety, use returned on cancel / hold expiry | IMPLEMENTED, VERIFIED locally | 6 parallel bookings with limit 2 give exactly 2; **mutation check: removing the row lock fails that test 3 of 3 runs**. Per guest = e-mail address (documented limit) |
| Server-side price guard (`expectedTotal` -> `409 PRICE_CHANGED`), history preserved when rules change, channel pushes use the same per-night prices | IMPLEMENTED, VERIFIED locally | pricing e2e; `docs/openapi-v1.json` regenerated (additive only) and `openapi:check` passes |
| Physical room retirement / reinstatement (history kept, future bookings protected and listed, inventory capacity moves in the same transaction, numbers reusable, idempotent, race-safe, owner/manager only) | IMPLEMENTED, VERIFIED locally | 6 e2e tests incl. retire-vs-assign race (4 rounds, never both); UI: retire dialog asks the server first, retired rooms listed separately |
| Personal-data retention framework (guest anonymisation, notification blanking, inbound OTA payload blanking; dry run; owner approval gate; scheduler off by default; counts-only run log) | IMPLEMENTED, VERIFIED locally. **Periods: REQUIRES APPROVAL by the product owner; none is set** | 9 e2e tests; [DATA_RETENTION.md](DATA_RETENTION.md) inventories every place personal data lives. A defect found by the tests: `notifications.recipient` cannot be NULL, so a reserved undeliverable address stands in |
| Responsive and accessibility audit, 21 pages x phone/tablet/desktop in Chrome | VERIFIED (automated) for: no sideways scroll, no script errors, no serious/critical axe-core WCAG 2.0/2.1 A+AA violations; plus keyboard tests. **Not claimed:** full WCAG compliance, screen-reader testing, visual design review by a person | first scan found: low-contrast text (`text-slate-400`, `emerald-600`, tab labels, landing footer; about 100 occurrences), unlabeled rate-plan radio buttons, dialogs and drawers without focus management / trap / return focus / names. All fixed; final run 0 blocking violations on all 63 page-viewport scans. No horizontal overflow and no console errors were found |
| `js-yaml` advisory (2 moderate) | **FIXED, VERIFIED** | `@nestjs/swagger@11.4.7` pins `js-yaml@5.3.0` (vulnerable range 5.0.0-5.4.0) and uses it only to **dump** our own OpenAPI object (never to parse input), so the flaw was not reachable. A scoped npm override (`@nestjs/swagger` -> `js-yaml@5.5.0`, the patched release) clears it without the breaking `@nestjs/swagger@12` upgrade (which needs NestJS 12). `npm audit --omit=dev`: 0 vulnerabilities; contract unchanged |
| Read-only database check `npm run db:check` (TLS, role, RLS, migration state; prints no secrets) | IMPLEMENTED; verified against a throwaway local PostgreSQL (empty and migrated). **Supabase connectivity: NOT VERIFIED** (no connection string in this session; `backend/.env` deliberately not read; the user opened it, I did not use it) | |
| Migration runbook, backup and forward-recovery procedure | IMPLEMENTED (document) | [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) |
| Redis / BullMQ real run | **BLOCKED**: no Redis, Docker or WSL on this machine (checked) | `npm run test:bullmq` unchanged and unrun |
| Docker / compose | **BLOCKED** at runtime. Static check of `docker-compose.yml` (parsed: 6 services, Dockerfiles exist, `depends_on` targets exist, volumes declared, `BFF_SHARED_SECRET` wired) passes | |
| SMTP, Razorpay sandbox, GitHub CI | **BLOCKED BY EXTERNAL ACCESS** (no credentials / no CI visibility); nothing simulated as real | |
| Dashboard and revenue (round 1) re-inspected | unchanged and consistent. Revenue still counts no-shows (your decision kept); unpaid `PENDING` holds are excluded; the dashboard and Channel Manager share `getChannelHealth` | |

**Complete run, same day, after all changes (real results):** backend typecheck pass, build pass; `npm test` **42 suites passed, 3 skipped (need Redis); 495 tests passed, 10 skipped, 0 failed**; `db:verify` pass; `drill:restore` pass; `check:secrets` clean; `npm audit --omit=dev` backend 0, frontend 0. Frontend typecheck pass, lint pass, unit tests **277 passed** (one test I wrote was timing-flaky under load; made deterministic and re-run: 277/277), production build pass. Playwright, all specs in one run: **98 passed, 0 failed** (includes 66 responsive/accessibility scans, the keyboard tests, the SEO and dashboard specs). Live-API suites against a throwaway sandbox: **44 passed**. SDK `npm test` exit 0. `openapi:check`: first run FAILED because the public contract gained optional fields; reviewed (additive), regenerated, now passes.

**Still open after round 2:** Supabase connection and migrations `0002`-`0004` (REQUIRES APPROVAL); real Razorpay, Redis/BullMQ, Docker, SMTP, CI (BLOCKED); retention periods (REQUIRES APPROVAL); Airbnb / Booking.com / Agoda (BLOCKED BY EXTERNAL ACCESS); no screen-reader testing; per-guest promo limits cannot stop one person using several e-mail addresses; `0004` upgrade over a populated `0003` database verified by inspection only; the rest of the browser-local "today" usages (section 3, item 12). Nothing was committed, pushed, deployed or migrated.

## 0c. Round 3 (2026-10-21): re-verification before commit

Nothing was committed, pushed, deployed or migrated; no `.env` file was read. `git status`: branch `main`, nothing staged, 80 modified + 28 untracked paths. Ignored and therefore not committable: `backend/.env`, `frontend/.env.local`, `dist/`, `.next/`, `.next-e2e/`, `node_modules/`, `test-results/`, `*.tsbuildinfo`, `next-env.d.ts`.

Note on the four "new" specs: `pricing`, `retention`, `room-retirement` and `dashboard` are backend Jest e2e specs (`backend/test/*.e2e-spec.ts`), not Playwright. The new Playwright specs are `responsive-a11y.spec.ts` and `seo.spec.ts`.

| Command (run from the folder shown) | Result |
| --- | --- |
| backend `npm run check:secrets` | exit 0, "No secrets detected (working tree)" |
| backend `npm run typecheck`, `npm run build` | exit 0 |
| backend `npm test` | 42 suites passed, 3 skipped; **495 passed, 10 skipped, 0 failed** (the skipped ones are the three `queues-bullmq*` suites) |
| backend `npx jest test/pricing.e2e-spec.ts` / `retention` / `room-retirement` / `dashboard` | 12 / 9 / 6 / 4 passed, 0 failed |
| backend `npm run db:verify` | all checks passed |
| backend `npm run drill:restore` | all steps passed (isolated embedded PostgreSQL) |
| backend `npm run openapi:check` | "OpenAPI contract is up to date" |
| frontend `npm run typecheck`, `npm run lint` | exit 0, no output |
| frontend `npm test` | 16 files, **277 passed** |
| frontend `NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=http://localhost:3100 npm run build` | exit 0 (the default `.next` folder was deliberately not rebuilt) |
| frontend `npx playwright test` (ports 3100/3101, one pass) | **98 passed, 0 failed, 0 skipped** (5.0 min) |
| frontend `LIVE_API_URL=http://localhost:3100 npm run test:live` (sandbox started with `API_URL=http://localhost:3100`) | 2 files, **44 passed** |
| backend `npm run test:bullmq` | **BLOCKED**: no `redis-server` on PATH, `REDIS_SERVER_BIN` and `TEST_REDIS_URL` unset |
| sdk `npm test`, `npm audit` | **not re-run in Round 3** (Round 2 results above stand) |
| `docker compose`, Razorpay, SMTP, hosted Supabase, CI | **BLOCKED / REQUIRES AUTHORIZATION**, unchanged (section 12) |

Review findings (code read, not only tests): pricing is computed by one shared module and the booking is refused if the shown total differs; promotion redemption locks the promotion row `FOR UPDATE` inside the booking transaction; retention is dry-run unless the policy is enabled and approved, never touches unsettled notifications or guests with open or recent reservations, and stores counts only; room retirement changes the room-number unique to a partial index and `rooms_status_check` to a wider list. Migrations `0002`, `0003`, `0004` drop only constraints/one index, add nothing destructive, apply in numeric order (0001 is a prerequisite of 0002; 0003 needs 0002's columns; 0004 needs 0003), and the order, pre-checks, backup step and deploy order are in `docs/MIGRATION_RUNBOOK.md`. The 0004 upgrade over a populated 0003 database is still inspection-only (no dedicated test). No debug output, live keys, `.only` or destructive SQL were added in application code. Git reports LF to CRLF conversion warnings on commit (Windows `core.autocrlf`); this is line-ending noise, not a content change.

## 0d. Round 4 (2026-10-21): payment and payout visibility for channel bookings

Scope: read-only visibility. No payment collection, transfer or payout was added; no hosted database was touched; nothing was committed, pushed or deployed. Details: [PAYMENT_VISIBILITY.md](PAYMENT_VISIBILITY.md).

**What changed.** The boolean `paymentCollectedByChannel` is replaced by `NormalizedReservationEvent.payment` (nullable collection model + its source, and provider-reported status/payout/commission/net, each optional). iCal blocks, the mock channel, the calendar-block sync and CSV imports no longer claim anything about money (they are stored as `UNKNOWN`). Migration `0005` adds the columns and turns historical `CHANNEL_COLLECTED` rows into `UNKNOWN`. Cancellation never records or implies an OTA refund. The dashboard (Payments page and reservation drawer) separates guest payment, channel collection, property collection, payout state, refund and Unavailable. Direct Razorpay behaviour is untouched.

**Not changed, still true.** Airbnb, Booking.com and Agoda adapters are unavailable placeholders; no field of theirs is read or assumed. The real Razorpay flow is still NOT verified (only the fake gateway). The BullMQ suites are still BLOCKED (no Redis). Migrations `0002` to `0005` are not applied to any hosted database.

| Command | Result |
| --- | --- |
| backend `npm run typecheck`, `npm run build` | exit 0 |
| backend `npm test` | 45 suites passed, 3 skipped (BullMQ, need Redis); **523 passed, 10 skipped, 0 failed** |
| new/changed backend specs | `payment-info.spec` (6), `provider-definition.spec` (+2), `test/payment-visibility` (11), `test/migration-0005` (5, a populated 0004 database upgraded in embedded PostgreSQL), conformance (+3), `ical`, `webhooks`, `csv-import`, `database` (enum drift) updated |
| backend `db:verify`, `drill:restore`, `openapi:check`, `check:secrets` | all pass (`db:verify`/`drill:restore` ran after the code change and before the last test-only edit) |
| frontend `typecheck`, `lint` | exit 0 |
| frontend `npm test` | 17 files, **298 passed** (`payment-visibility.test.tsx`: 21, including the Payments page; a mutation that made unreported data read "Collected by channel" failed 10 of them, then was reverted) |
| frontend build (`NEXT_DIST_DIR=.next-e2e`) | exit 0 |
| Playwright, full suite, one pass | **98 passed, 0 failed, 0 skipped** |
| frontend `test:live` against a throwaway sandbox on :3100 | **44 passed** |
| sdk `npm test` | 14 passed; `npm audit --omit=dev`: 0 vulnerabilities in backend, frontend and sdk |
| `test:bullmq` | **BLOCKED**: no Redis |

**A defect found by the new upgrade test, fixed before any hosted run:** the first version of the CHECK "`CHANNEL_COLLECTED` needs `collection_model = 'CHANNEL'`" evaluated to NULL (and therefore passed) when `collection_model` was NULL; it now uses `coalesce(..., false)`.

**Migration `0005` risks.**
* **Data change that only a backup reverses:** every `payment_status = 'CHANNEL_COLLECTED'` row becomes `UNKNOWN`. Some of those rows may have been genuine channel-collected bookings; there is no provenance to tell. Record the count before migrating.
* **The previous release is not safe against this schema:** it writes `CHANNEL_COLLECTED` without a collection model and the new CHECK rejects it, so old-release channel imports fail. Deploy API and worker together; roll forward rather than back.
* Replacing the `payment_status` CHECK and validating the new one scans `reservations` (brief `ACCESS EXCLUSIVE` lock on that table; short at launch scale). The ten new columns are nullable (no table rewrite).
* The upgrade was tested only on embedded PostgreSQL, not on the hosted database.
* Any external consumer that treated `paymentStatus = CHANNEL_COLLECTED` as "paid" will now see `UNKNOWN` for old rows and, for new rows, `CHANNEL_COLLECTED` with the meaning "the channel is responsible for collection".

**Remaining integration blockers for payment visibility.** (1) Partner approval and official documentation for Airbnb, Booking.com and Agoda before any adapter can report their payment, payout, commission or net-amount fields. (2) Tirvona.com has no API contract. (3) A configured provider only reports what its operator mapped from the provider's documentation. (4) Payout figures are displayed, not reconciled against anything.

## 1. Architecture discovered

NestJS 11 modular monolith (`backend/`) + Next.js 16 / React 19 app (`frontend/`) + TypeScript SDK (`sdk/`). PostgreSQL only (Supabase as hosted Postgres), Kysely + `pg`, hand-written forward-only SQL migrations (`schema_migrations` table with checksums, advisory lock). Redis + BullMQ for queues, driven from a transactional outbox (`sync_jobs`, `notifications`, `webhook_deliveries`). Razorpay for payments, SMTP (nodemailer) for e-mail. Own JWT auth; the web app signs in through its own server (`/api/session/*`, "BFF") so the refresh token lives in an HttpOnly cookie.

Backend modules (`backend/src/modules`): `auth`, `users`, `organizations`, `properties` (+ visibility/marketplace), `room-types`, `rooms`, `inventory`, `rates` (pricing, promotions), `reservations` (+ CSV import), `guests`, `payments` (Razorpay provider), `booking-engine` (public search/booking), `channels` (built-in adapters, provider framework: generic REST, iCal, CSV, reconciliation), `sync`, `webhooks` (inbound), `public-api` (API keys, `/v1`, outbound signed webhooks), `reports`, `notifications`, `audit`, `admin` (partner platform). Domain logic that must be transactional lives in `backend/src/database/services` (`reservation`, `inventory`, `availability`, `sync-job`, `webhook`, `channel-mapping`, `client-event`).

Dependency map (arrow = depends on):

```
frontend pages ─► lib/api/* ─► (BFF /api/session) ─► REST API (controllers)
controllers ─► module services ─► database/services (reservation, inventory, availability) ─► Postgres (transactions, row locks, CHECKs)
reservation / inventory writes ─► outbox rows (sync_jobs, notifications, webhook_deliveries) ─► OutboxDispatcher ─► BullMQ ─► workers
sync worker ─► ChannelAdapterRegistry ─► code adapters (Airbnb/Booking.com/Agoda: scaffolds, unavailable) | GenericRestAdapter | IcalAdapter | Mock
client-event service ─► webhook_deliveries ─► signed HTTP delivery (SSRF-safe) ─► partner endpoint
payments ─► Razorpay (orders, signature verification, webhooks, refunds) ─► reservation confirmation
scheduler (worker process) ─► hold expiry (60 s), purge of expired rows, polling, reconciliation
```

Frontend: `app/dashboard/*` (PMS), `app/admin/*` (platform console), `app/stays/*` and `app/booking/*` (public booking engine), `app/(auth)` (sign-in pages), `app/api/{health,session}`, `lib/api/*` (typed API client; no fallbacks), `lib/fixtures/demo-data.ts` (unused demo fixtures, test-enforced to be imported by nothing).

## 2. Module status (actual, after this audit)

Environment for every VERIFIED below: embedded PostgreSQL 17, inline queue driver, fake Razorpay gateway, local SMTP test server, Chrome. "Real" services were not available.

| Module | Status | Evidence / limits |
| --- | --- | --- |
| Authentication, sessions, password reset/change | VERIFIED | `auth`, `authorization`, `change-password` e2e; Playwright auth journeys (expiry, logout, protected routes) |
| Authorization and tenant isolation (property/org scoping) | VERIFIED | `authorization`, `tenant-isolation`, `partner-platform` e2e |
| Properties, room types | VERIFIED | archive refused while future stays exist; unit/e2e |
| Rooms | VERIFIED, one gap | duplicate numbers rejected, type move refused with upcoming stays. **Round 2: retirement and reinstatement implemented and verified (section 0b)** |
| Inventory, availability, double-booking safety | VERIFIED | `inventory-concurrency`, `db:verify` (25 concurrent bookings of the last room give exactly one) |
| Rates, plans, taxes, promotions | IMPLEMENTED, VERIFIED (round 2) | date-level/seasonal rules, extra-guest charges, promotion limits, price guard: see section 0b and [PRICING.md](PRICING.md). **NOT IMPLEMENTED:** slab tax, length-of-stay pricing, child age bands |
| Calendar | VERIFIED (jsdom) | 17 PmsCalendar tests; not driven in a real browser; no responsive/visual review |
| Reservation lifecycle (create, assign, check-in/out, modify, cancel, refund rows, release) | VERIFIED | `reservations`, `booking-payment-reliability`, `guest-cancellation` e2e; invalid transitions rejected with `INVALID_STATE_TRANSITION` |
| Guests | VERIFIED (authz) | **Round 2: retention framework implemented and verified; the periods themselves REQUIRE product-owner approval** (section 0b, [DATA_RETENTION.md](DATA_RETENTION.md)) |
| Payments (Razorpay) | IMPLEMENTED; VERIFIED against a faithful **fake** gateway only | signature verification (constant time), webhook idempotency, late payment after expiry refunded, forged signatures. **BLOCKED BY EXTERNAL ACCESS:** a real `rzp_test_*` payment, real webhooks, real refund |
| Dashboard | **FIXED and VERIFIED** (section 4) | new snapshot endpoint + tests |
| Reports (revenue, occupancy) | **FIXED and VERIFIED** (section 4) | revenue now excludes unpaid holds; property-timezone window |
| Settings | VERIFIED (jsdom against live API) | not browser-driven |
| Public booking engine | VERIFIED with fake gateway | Playwright journeys (search, hold, pay, decline, dismiss/retry, double submit, lookup, cancel); SEO files **added** |
| Channel Manager, built-in channels | VERIFIED honest states | Direct and Tirvona marketplace are built in. Airbnb/Booking.com/Agoda adapters are scaffolds that answer `CHANNEL_INTEGRATION_NOT_AVAILABLE`. **BLOCKED BY EXTERNAL ACCESS** (partner approval) |
| Universal provider framework (generic REST, iCal, CSV, reconciliation) | IMPLEMENTED; VERIFIED locally against a fake provider | flag `CHANNEL_PROVIDERS_ENABLED` defaults OFF. Never run against any real third-party API. XML/SOAP and OAuth-code flows for configured providers are NOT IMPLEMENTED |
| Partner API (`/v1`), keys, outbound webhooks | VERIFIED (inline queue) | hashed keys, scopes, rotation, rate limits, SSRF-safe delivery, delivery statuses only become `DELIVERED` after an HTTP 2xx. **BLOCKED:** real-Redis BullMQ suites (`npm run test:bullmq`): no Redis binary here |
| Notifications | IMPLEMENTED; SMTP verified against a local test server only | without `SMTP_URL`, e-mails are logged, not sent (explicit production warning). SMS/WhatsApp are log-only (NOT IMPLEMENTED as real providers) |
| Docker images, compose, CI | **BLOCKED** | Docker not installed here; the CI workflow's last result is not visible from this machine (`gh` is not installed). Recent commits are CI fixes |
| Supabase (hosted) | **BLOCKED / REQUIRES AUTHORIZATION** | never connected from this work; migration state of the hosted database is unknown |

## 3. Bugs and gaps found and what was done

Found by reading the code and running the suites. Items 1 to 8 were fixed; 9 onward are recorded for decision.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | **Revenue counted unpaid holds.** The revenue report excluded only `CANCELLED`, so a public booking sitting in `PENDING` (20-minute payment hold) was reported as revenue until it expired. The dashboard "Arrivals Revenue" inherited it. | High (misleading financials) | `REVENUE_STATUSES` = CONFIRMED, CHECKED_IN, CHECKED_OUT, NO_SHOW. Regression test; mutation-checked (re-adding `PENDING` fails the test). NO_SHOW is still counted as before (no no-show-fee model); that is a business rule to confirm |
| 2 | **Dashboard "today" was the browser's date**, and arrivals/departures counted only the first 100 reservations client-side. | High (wrong day across time zones; silent truncation) | New `GET /properties/:id/reports/dashboard?date=`: one server-side snapshot in the **property's** time zone, exact SQL counts, optional date picker on the page |
| 3 | **Dashboard showed a green "Active" for any channel with status CONNECTED**, including one that never synchronised. | High (violates "never show synced without evidence") | Shared `getChannelHealth()` used by dashboard and Channel Manager. Green "Synced" requires status CONNECTED + recorded successful sync + no standing error. States: Built in, Built in (marketplace), Synced, Connected-never-synced, Error, Credentials expired, Awaiting authorization, Partner access needed, Not connected. Last successful sync time and the last error are shown |
| 4 | Dashboard had no alerts. | Medium | Alerts computed from stored data: channel errors/expired credentials, permanently failed sync jobs (24 h), arrivals without a room, guests still checked in after their check-out date |
| 5 | **Reports page window used the browser date.** | Medium | Uses the property's time zone (`todayInTimeZone`, tested across zones) |
| 6 | **`BFF_SHARED_SECRET` was documented only in a backend comment**: absent from `frontend/.env.example`, compose and the deployment guide. Without it every web login reaches the API from the web server's address, so all users share one login rate limit and audit logs show a single IP. | High for deployment | Documented in `frontend/.env.example` and `docs/DEPLOYMENT.md`, wired through `docker-compose.yml`, and the API now logs a production warning at boot when it is unset. Deliberately not made fatal (API-only deployments exist) |
| 7 | **No `robots.txt`, no `sitemap.xml`; private areas not marked noindex.** | Medium (SEO/privacy) | `app/robots.ts` (disallows dashboard, admin, booking flow, API, sign-in pages), `app/sitemap.ts` (static pages + one URL per public property from the live API; on API failure it lists only static pages, never invented ones), `noindex` on dashboard and admin layouts. Browser-tested |
| 8 | Stale tests encoded old behaviour (24-hex MongoDB id regex in the live OAuth test; "Always on" label; old stat card titles). | Low | Updated. Found while running the live suite: that suite follows server-provided absolute URLs, so a sandbox started on a non-default port needs `API_URL` set to that port (otherwise the OAuth redirect points at whatever listens on :3000). Recorded in section 9 |
| 9 | Pricing is flat (see module table). | Product gap | **Resolved in round 2** (section 0b) |
| 10 | Guest PII has no retention policy. | Compliance gap | **Framework built in round 2; periods REQUIRE APPROVAL** |
| 11 | A physical room cannot be retired. | Product gap | **Resolved in round 2** |
| 12 | Browser-local "today" is still used by the inventory page, PMS calendar "Today" button, new-reservation defaults and guest search `min` date (`toISOString` is UTC). | Low (staff in the property's own zone are unaffected; the server rejects past dates with a clear error) | Not changed; use `todayInTimeZone` there next |
| 13 | `app/stays/[propertySlug]` canonical URL falls back to `https://tirvona.example` when `NEXT_PUBLIC_APP_URL` is unset. | Low | Set `NEXT_PUBLIC_APP_URL` at build time in production (documented as a build argument) |
| 14 | Dependency advisories: backend 2 moderate in `js-yaml` via `@nestjs/swagger` . | Low | **Fixed in round 2** by a scoped override to the patched `js-yaml@5.5.0`; the flaw was not reachable (dump only) |

Previously known and still true (from `docs/PRODUCTION_AUDIT.md`, not re-verified here): the CSP keeps `'unsafe-inline'` scripts (Next.js needs nonces for strict CSP). The earlier claim that the refresh token lives in `localStorage` is **stale**: the web app now uses the HttpOnly-cookie BFF and removes legacy `localStorage` tokens (`frontend/lib/api/client.ts`).

## 4. The dashboard, card by card

`GET /properties/:id/reports/dashboard?date=YYYY-MM-DD` (requires `reports:view` on the property; date defaults to today in the property's time zone). All figures are queries over stored rows.

| Card / field | Definition |
| --- | --- |
| Rooms (`sellableRooms`) | sum of inventory `total` minus `blocked` for the date. Subtitle: sold, awaiting payment, available, out of service |
| `soldRooms` | inventory `sold` for the date: confirmed, in-house and **unpaid-hold** rooms (a hold really takes the room off sale) |
| `heldRooms` | part of `soldRooms` that is a `PENDING` reservation spanning the night; shown separately so holds are never mistaken for guests |
| `availableRooms` | `sellable - sold`, never below zero (overbooked OTA stays show 0, not a negative) |
| Occupancy | `sold / sellable`, one decimal; 0 when nothing is sellable. Same definition as the occupancy report |
| Arrivals / `arrivalsPending` | reservations with `check_in = date` in CONFIRMED, CHECKED_IN, CHECKED_OUT / those still CONFIRMED |
| Departures / `departuresPending` | `check_out = date` in CHECKED_IN, CHECKED_OUT / those still CHECKED_IN |
| Arrivals Revenue | room revenue (`subtotal - discount`, excluding tax, minor units) of CONFIRMED / CHECKED_IN / CHECKED_OUT / NO_SHOW stays **arriving** that day. It is arrival-date revenue, not accrual by night, and not gross booking value; it is labelled that way |
| Channel list | `getChannelHealth` over `GET /properties/:id/channels` (section 3, item 3) |
| Alerts | section 3, item 4 |
| Recent reservations | `GET /reservations?limit=5` |

Cancelled and expired reservations are `CANCELLED` and are excluded everywhere above; their inventory is released in the same transaction. Refunds are separate rows and do not alter these definitions.

Known limit: the occupancy report and dashboard count inventory `sold`, which includes unpaid holds for at most their 20-minute window (the dashboard says so). Revenue per available room night (RevPAR) divides arrival-date revenue by capacity nights in the window, so it is an approximation for stays that span the window edge.

## 5. Mock data and fake fallbacks

Re-audited: no `MOCK_*` identifiers in `frontend/app`, `components` or `lib` (only `lib/fixtures/demo-data.ts`, imported by nothing, excluded from typecheck/lint, test-enforced). `frontend/tests/no-fallbacks.test.ts` (106 tests) asserts every API method rejects on HTTP 500 and on a dead network; it passed. Demo mode only pre-fills the login e-mail and fails a production build. The sandbox Razorpay shim loads only through `npm run sandbox` and throws under `NODE_ENV=production`. The backend mock OTA exists only with `MOCK_CHANNEL_ENABLED`, which production start-up refuses. The one deliberate catch in new code is the sitemap's partial-on-API-failure behaviour (section 3, item 7). A Playwright test (`search.spec.ts`) asserts the landing page links to the real search rather than to a hard-coded property.

## 6. Database and migration risks

Migrations: `0001_init.sql` (31 tables), `0002_partner_platform.sql`, `0003_channel_providers.sql`. Runner: `npm run db:migrate` (compiled; `db:migrate:dev` for tsx), one transaction per file, `pg_advisory_lock`, checksums in `schema_migrations`; forward-only; an edited applied file fails its checksum.

Reviewed:

* **0002**: additive columns with constant defaults (no table rewrite on PostgreSQL 11+), widened CHECK constraints (drop and re-add: brief table scan, tables are small), two `UPDATE`s that preserve existing behaviour (`approved_at`, `direct_booking_enabled = true` for ACTIVE properties, so existing public pages keep working), two new tables with RLS enabled and no policies, `anon`/`authenticated` privileges revoked when those roles exist.
* **0003**: 7 new tables with RLS; FK from every channel column to `channel_providers(code)`; replaces unique indexes with connection-scoped ones (`external_scope`, zero-UUID default = historic global scope); drops and recreates `reservations_external_key` (non-concurrent index build, brief write lock on `reservations`; run in a quiet window). Seeds 9 built-in provider rows. Pre-checks that must return no rows are in `docs/CHANNEL_FRAMEWORK.md` section 8.
* Verified here, in an isolated embedded PostgreSQL: migrations apply from scratch and re-apply idempotently, checksum protection, RLS on every table, append-only audit trigger, CHECK/enum drift test, upgrade of a populated `0002` database to `0003` (`provider-migration` e2e), `db:verify` (all checks pass, including index use via EXPLAIN), `drill:restore` (backup, destroy, restore, invariants).
* **Not verified**: anything against the real Supabase database (pooler modes, SSL with Supabase's CA, connection limits, its backups). The hosted database's current migration level is unknown to this audit; earlier notes say `0002` and `0003` had not been applied.
* **Rollback**: there is no down-migration. Recovery for a failed or unwanted migration is restore from the pre-migration backup/PITR. Because the application never migrates on start-up and every change is additive, the previous application release keeps working against the new schema, so an application rollback does not need a database rollback (`docs/DEPLOYMENT.md`).

### Exact production migration procedure (REQUIRES AUTHORIZATION; not run)

1. Prerequisites: Supabase project; a **direct** or **session-pooler** connection string (not the transaction pooler on 6543, because migrations hold a session advisory lock); `DATABASE_SSL=verify-full` with `DATABASE_CA_CERT` (Supabase CA) or at least `require`.
2. Backup first: Supabase dashboard, Database, Backups, create an on-demand backup (or confirm PITR is enabled), and optionally `pg_dump --format=custom "<direct url>" -f pre-migration.dump`.
3. Read-only pre-check of the current level: `select name, applied_at from schema_migrations order by name;` and, if `0003` is pending, the zero-row pre-checks in `docs/CHANNEL_FRAMEWORK.md` section 8.
4. Apply from `backend/`: `npm ci && npm run build && DATABASE_URL=<url> DATABASE_SSL=verify-full DATABASE_CA_CERT=<pem or path> npm run db:migrate`. Expected output: `migrations: N applied, M already up to date`.
5. Verify: `select name from schema_migrations order by name;` lists `0001`, `0002`, `0003`, `0004`; `select count(*) from channel_providers where built_in;` returns 9; `select count(*) from organizations where status <> 'ACTIVE';` is 0 for pre-existing data; deploy the backend with `CHANNEL_PROVIDERS_ENABLED=false`, check `/health`, one booking, one channel sync.
6. Recovery: restore from the step 2 backup/PITR (this loses bookings made after the backup, so do it only if the migration itself is faulty).

## 7. Security review

Verified by tests that ran: server-side authorization on every protected route (route-level `@PropertyAccess` with entity ownership checks; cross-tenant access answers 404/403), hashed scoped API keys (secret shown once), signed outbound webhooks with SSRF-safe delivery and no redirects, no secrets in logs (redaction tests), production start-up refuses weak/missing secrets, wildcard CORS, inline queues, mock channel, unsafe webhook targets, and unpaid auto-confirm unless explicitly allowed. `npm run check:secrets`: no secrets in the working tree. `npm audit --omit=dev`: frontend 0, backend 2 moderate (item 14). Payment signature comparison is constant-time and length-safe.

Open items: CSP keeps `'unsafe-inline'` scripts; rate limiting fails open if Redis is down (alert defined in `docs/OPERATIONS.md`); `BFF_SHARED_SECRET` unset gives a single shared login limit (now warned about); `backend/.env` (git-ignored) may contain real credentials and was never read or touched by this audit; rotate them if the folder was ever shared.

## 8. API contract

`npm run openapi:check` passes: `docs/openapi-v1.json` (the partner contract) is unchanged. The new dashboard route is part of the internal dashboard API (Swagger at `/docs`, DTO documented with field definitions). Frontend types, API module, page and tests were changed together; the live suite (44 tests) exercises the real endpoint through the real page.

## 9. Commands actually executed and their real results

| Command | Result |
| --- | --- |
| baseline (before any change) `backend: npm run typecheck`, `npm test` | pass; 37 suites passed, 3 skipped (BullMQ-only); 454 tests passed, 10 skipped |
| baseline `frontend: tsc --noEmit`, `npm run lint`, `npm test` | pass; 14 files, 262 tests |
| `backend: npm run typecheck` | pass |
| `backend: npm run build` | pass |
| `backend: npm test` (inline queue) | Round 1 (historical): 38 suites, 458 passed. **Latest (Round 3, 2026-10-21): 42 suites passed, 3 skipped; 495 passed, 10 skipped, 0 failed** |
| `backend: npm run db:verify` | all checks passed |
| `backend: npm run drill:restore` | all restore-drill steps passed |
| `backend: npm run openapi:check` | contract up to date |
| `backend: npm run check:secrets` | no secrets detected |
| `backend: npm audit --omit=dev` | Round 1 (historical): 2 moderate (`js-yaml` via `@nestjs/swagger`). **Latest (Round 3 follow-up, 2026-10-21): 0 vulnerabilities** |
| `frontend: npx tsc --noEmit` | pass |
| `frontend: npm run lint` | pass (exit 0) |
| `frontend: npm test` | Round 1 (historical): 15 files, 270 passed. **Latest (Round 3): 16 files, 277 passed** |
| `frontend: npm audit --omit=dev` | 0 vulnerabilities (re-run 2026-10-21: 0) |
| `frontend: npm run build` (`NEXT_DIST_DIR=.next-e2e`, API `:3100`) | pass; routes include `/robots.txt` and `/sitemap.xml` |
| Playwright full suite (real Chrome, throw-away sandbox on `:3100`/`:3101`) | **Latest (Round 3, single pass): 98 passed, 0 failed, 0 skipped.** Round 1 (historical): first run 27 passed, **2 failed** (the dashboard specs still expected the old card titles and endpoint); after updating the specs and fixing a lost-regex typo, **29/29 passed**. `seo.spec.ts` (3 new) plus `dashboard.spec.ts` (6) re-run: **9/9 passed**. The complete 32-test suite was not re-run in a single pass after adding `seo.spec.ts` |
| `frontend: vitest --config vitest.live.config.ts` against a fresh sandbox | first run **2 failed** (stale `{24}`-hex MongoDB id regex and "Always on" label; plus a harness mistake: the sandbox had no `API_URL`, so the OAuth redirect hit the owner's own server on :3000, which rejected the unknown state and wrote nothing); after fixing tests and harness, **44/44 passed** |
| Mutation check: put `PENDING` back into `REVENUE_STATUSES` | the new dashboard test **failed** as intended; file restored |
| `sdk: npm test`, `sdk: npm audit --omit=dev` | Round 1: not run. **Round 3 follow-up (2026-10-21): 14 tests passed, 0 failed; audit 0 vulnerabilities** |
| `npm run test:bullmq`, `docker build`, `docker compose` | **not run** (no Redis binary; no Docker) |
| full dev-dependency `npm audit` | not re-run (earlier audit recorded dev-only advisories in the test runner and lint chain) |

Local servers: the owner's own API/web servers on `:3000`/`:3001` were left running and untouched; verification used `:3100`/`:3101` and `.next-e2e`, and both ports were confirmed free afterwards. `backend/dist` was rebuilt, so the owner's running API (an older build) needs a restart to get the new endpoint.

## 10. End-to-end workflows

Verified locally (fake gateway, embedded PostgreSQL): admin/owner sign-in, property and room setup, rate and inventory setup, public search, successful booking, persistence, inventory reduction, duplicate-booking prevention (idempotency key, 20 concurrent requests for one room), payment success/failure/dismiss/forged-signature, cancellation and inventory release, dashboard reconciliation with stored rows (new), partner API authentication and scopes, webhook queueing and delivery logs (inline driver), channel connection validation against a fake provider, unauthorized cross-tenant denial, public versus protected routes, reload and session expiry.

**BLOCKED:** real Razorpay payment and webhook; real SMTP delivery; BullMQ workers on a real Redis (worker/queue/retry/shutdown suites exist but were not run here); Supabase; Docker; any real OTA.

## 11. External dependencies not tested, and why

| Item | Why not tested | What is needed |
| --- | --- | --- |
| Razorpay real gateway | no keys, no account access | `rzp_test_*` key id/secret, webhook secret, public webhook URL; run one pay/fail/refund |
| Supabase | no project/connection string | project, connection string, CA cert, backups/PITR |
| Redis + BullMQ | no Redis binary on this machine | `TEST_REDIS_URL` or `REDIS_SERVER_BIN`, then `npm run test:bullmq` (also CI job `backend-bullmq`) |
| SMTP | no provider | `SMTP_URL`, `SMTP_FROM`, SPF/DKIM |
| Docker / compose | not installed | install Docker; `docker compose up --build` |
| GitHub CI | result not visible here | open the Actions tab, confirm the latest run is green |
| Airbnb, Booking.com, Agoda | partner approval and credentials | each platform's connectivity-partner programme; then either a configured provider (if its contract fits the generic connector) or a code adapter. Not scraped, not faked |
| Tirvona.com as an external system | no API contract in the repo | `docs/TIRVONA_INTEGRATION.md` |

## 12. Deployment blockers, and commands that need your authorization

Blockers (none is a code defect): hosted database not connected and its migration level unknown; real payment test not done; Redis worker path unverified; images unbuilt; no mail provider; monitoring/alerts not wired; `BFF_SHARED_SECRET` to be generated and set on both services; `NEXT_PUBLIC_APP_URL` to be set at build time.

Require your explicit authorization (none was run): applying migrations to Supabase (section 6); creating or restoring backups; any live Razorpay payment; DNS or TLS changes; deploying images; `git commit`/`git push` (this audit left all changes uncommitted); creating real OTA connections or sending real e-mail.

Deployment checklist: (1) generate secrets (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `BFF_SHARED_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) and keep them out of Git; (2) backup, then migrate (section 6); (3) build both images with the public build args; (4) start `api`, `worker` (scheduler lives there), `frontend`; (5) check `/health`, `/api/health?deep=1`; (6) one test booking with a Razorpay test payment; (7) wire alerts from `docs/OPERATIONS.md`. Rollback: redeploy the previous image tags (API and worker together); the schema stays additive; database restore only for a faulty migration.

## 13. Remaining issues

Section 3 items 9 to 14, plus: Airbnb/Booking.com/Agoda; real SMS/WhatsApp; guest-data retention; the dashboard page and Channel Manager were verified in jsdom and the dashboard also in Chrome, but **visual layout, keyboard order, contrast and tablet/mobile behaviour were not inspected** in this audit; there is no cross-property guest history endpoint; payments have no automated gateway-vs-database reconciliation job (manual procedure in `docs/OPERATIONS.md`).

## 14. Final acceptance checklist

| Criterion | State |
| --- | --- |
| Existing architecture preserved | VERIFIED (no rebuild; changes are additive) |
| Backend and frontend builds succeed | VERIFIED |
| TypeScript checks and lint pass | VERIFIED |
| Relevant automated tests pass | VERIFIED locally (Round 4, latest: backend 523 + 10 skipped, frontend 298, live 44, SDK 14, Playwright 98; BullMQ suites BLOCKED; Round 3 was 495 / 277) |
| Critical booking workflows end to end | VERIFIED with the fake gateway; real gateway BLOCKED |
| Availability/inventory concurrency-safe | VERIFIED |
| Pricing and tax correct | VERIFIED for the implemented model; richer pricing NOT IMPLEMENTED |
| Authentication/permissions enforced server-side | VERIFIED |
| Cross-tenant tests pass | VERIFIED |
| No silent mock fallback in production | VERIFIED |
| Dashboard matches stored data | VERIFIED (new tests) |
| Payments never falsely report success | VERIFIED against the fake gateway |
| Partner keys and secrets protected | VERIFIED |
| Webhook statuses truthful | VERIFIED (inline driver); real Redis BLOCKED |
| Migrations reviewed and verified in isolation | VERIFIED locally; hosted database REQUIRES AUTHORIZATION |
| Background workers operational | BLOCKED (real Redis) |
| Environment variables documented | VERIFIED (gap fixed: `BFF_SHARED_SECRET`, `API_INTERNAL_URL`) |
| Deployment and recovery instructions | IMPLEMENTED (`DEPLOYMENT.md`, `OPERATIONS.md`, section 6 above); never executed |
| No undisclosed critical defect | the known gaps are listed above |
| Missing external credentials documented | section 11 |
| OTAs not represented as live | VERIFIED (UI and API say "Partner access needed") |

## 15. Files changed in this audit

| File | Why |
| --- | --- |
| `backend/src/modules/reports/reports.module.ts` | revenue excludes unpaid holds; new dashboard snapshot endpoint, DTOs, alerts |
| `backend/test/dashboard.e2e-spec.ts` (new) | 4 tests: empty property, holds/cancellations/revenue, assignment and check-in flow, bad dates and cross-tenant |
| `backend/src/main.ts` | production warning when `BFF_SHARED_SECRET` is unset |
| `frontend/lib/api/reports.ts`, `frontend/types/index.ts` | call the snapshot endpoint; new `DashboardStats` |
| `frontend/lib/utils/formatters.ts` | `getChannelHealth` |
| `frontend/lib/utils/dates.ts` | `todayInTimeZone` |
| `frontend/app/dashboard/page.tsx` | server snapshot, date picker, definitions in subtitles, alerts, truthful channel states |
| `frontend/app/dashboard/channels/page.tsx` | uses the shared channel health |
| `frontend/app/dashboard/reports/page.tsx` | property-timezone window |
| `frontend/app/robots.ts`, `frontend/app/sitemap.ts` (new), `app/dashboard/layout.tsx`, `app/admin/layout.tsx` | crawler files and noindex |
| `frontend/tests/channel-health.test.ts` (new), `tests/no-fallbacks.test.ts`, `tests/live/*`, `e2e/dashboard.spec.ts`, `e2e/seo.spec.ts` (new) | tests for the above; stale expectations updated |
| `docker-compose.yml`, `frontend/.env.example`, `docs/DEPLOYMENT.md`, `docs/FRONTEND_INTEGRATION.md` | `BFF_SHARED_SECRET` / `API_INTERNAL_URL` documented and wired; dashboard endpoint documented |
| `docs/FINAL_PRODUCTION_READINESS_AUDIT.md` (this file) | the audit |

No migration was added or changed, no data was touched, `backend/.env` was not read, and nothing was committed or pushed.
