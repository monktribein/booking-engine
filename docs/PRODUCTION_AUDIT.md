# Final production audit

Date of evidence: 2026-10-14. Scope: the Tirvona backend (NestJS, MongoDB, BullMQ), the Next.js frontend and the booking + Razorpay journey. No product features were added in this audit. Every result below is from a command that was run; where something could not be run the report says so.

Related documents: `docs/FRONTEND_INTEGRATION.md` (screen-to-endpoint map, fallback inventory), `docs/OPERATIONS.md` (queues, logging, alerts, backups), `docs/DEPLOYMENT.md` (Docker, CI, rollback).

## 1. Executive summary

**Recommendation: NO-GO for production today.** The application code is in good shape and well tested; what is missing is *verification in a real environment*:

| Blocker (each is a critical check that has not been done) |
| --- |
| No real Razorpay test-mode transaction. Payment was exercised against a faithful fake gateway only (HMAC scheme, orders, refunds), end to end in a real browser, but never against `api.razorpay.com` or the real Checkout window. |
| The configured database cannot be reached: `.env` has `MONGODB_URI=MONGODB_URI=mongodb+srv://…<cluster>…` (doubled prefix, placeholder). Backups, retention and restore of the real deployment are unverified. |
| Docker is not installed on this machine: neither image was built, `docker compose up` was never run, so the deployment configuration is written and partly simulated but unproven. |
| The CI workflow has never run (the project is not a Git repository, nothing was pushed). |
| No e-mail provider has been used (SMTP verified only against a local test server), so guests would receive no booking confirmation until `SMTP_URL` is configured and tested. |

If those five are closed (section 8, "Before go-live"), the recommendation becomes **CONDITIONAL GO** for a first, small production rollout with the monitoring in `docs/OPERATIONS.md` actually wired up. Nothing found in the code itself blocks that.

What is solid, with evidence: no fake authentication and no mock-as-success path (106 guard tests, a mutation check, and 20 real-browser tests); atomic, idempotent booking and payment handling under races (20+ regression tests, run on both queue drivers); BullMQ retry, failure reporting, idempotency, outage and graceful shutdown on a real Redis; structured, redacted logs; fail-fast production configuration on both services.

## 2. Verified against the 14 audit points

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Auth cannot fall back to fake users/tokens | **Verified** | `lib/api/auth.ts` has no fallback; `tests/auth.test.ts` (22): offline backend + "demo" e-mail, failed login/register, malformed success all leave no session; Playwright `auth.spec.ts` (7) in real Chrome: wrong password, demo e-mail with made-up password, backend unreachable, protected routes, expired and invalid tokens. Demo mode only pre-fills an e-mail and a production build/start fails if it is set. |
| 2 | API failures cannot become fabricated success | **Verified** | `tests/no-fallbacks.test.ts` (106): every API method rejects with `ApiError` on HTTP 500 and on a dead network; static scans find no `MOCK_*`, fake tokens or catch-and-return in `lib/api`; mutation check (re-adding a fallback) failed 3 tests; Playwright confirms error states instead of sample data. |
| 3 | Demo fixtures isolated and documented | **Verified** | `frontend/lib/fixtures/demo-data.ts` (780 lines): imported by nothing (test-enforced), excluded from typecheck and lint, header comment explains it. Real demo data = backend seed. The sandbox Razorpay shim (`scripts/sandbox-razorpay-shim.cjs`) is loaded only by `npm run sandbox` and throws if `NODE_ENV=production`. |
| 4 | Every dashboard and public screen has a verified endpoint mapping | **Verified (with a caveat)** | Matrix in section 5. All screens are exercised against the live API through the real page components in jsdom (`tests/live/screens.test.tsx`, 15 tests) and the API modules (`live-api.test.ts`, 32). Only the flows in section 6 are also driven in a real browser. |
| 5 | Loading / empty / error states | **Verified** | `QueryState` renders exactly one of skeleton, error (retry only when useful), empty, data; 19 state tests; 17 PmsCalendar tests; Playwright failure/retry tests. Visual layout and keyboard/responsive behaviour were **not** inspected. |
| 6 | Public booking + Razorpay sandbox flow against the real backend | **Partly verified** | Search -> hold -> Checkout -> server signature verification -> confirmation, including dismiss+retry, declined payment, forged signature, double submit: real Chrome + real NestJS + real MongoDB, 20/20 three times. The gateway is the local fake (`dev-sandbox.ts`) and Checkout is a stand-in script. **Not** done: a real Razorpay test-mode order and the real Checkout window. |
| 7 | Duplicate webhooks, concurrent reservations, inventory consistency covered | **Verified** | `inventory-concurrency` (1 room x 2 and x 20 requests), `booking-payment-reliability` (11: callback + 2 webhooks racing, 9 repeated callbacks, forged/replayed signatures, dismiss then expiry, failed then retried payment, late payment after expiry refunded and not re-sold, last room x 3 bookings, same Idempotency-Key x 5, confirmed booking immune to expiry, refund rules), `webhooks`, `payments`. All pass on both queue drivers. |
| 8 | MongoDB and real Redis tests run | **Verified (caveat)** | MongoDB 8.2 replica set (in-memory, transactions) for every backend run. Real Redis: **5.0.14.1**, an unofficial Windows port (the only one obtainable here; Docker/WSL absent); BullMQ recommends 6.2+. Atlas was not reachable. |
| 9 | Typechecks, suites, production builds recorded | **Verified** | Section 4. |
| 10 | CI, Docker, deployment docs consistent with the code | **Partly verified** | The workflow YAML parses and each of its commands was run locally except `docker`/`apt` ones; the Dockerfile's runtime layer was simulated (standalone build + static + public copied the way the image does, started, health checked, refusal paths exercised). The images were not built. |
| 11 | Secrets excluded from Git and browser variables | **Verified (with a caveat)** | There is no Git repo yet; `.gitignore` excludes `.env*` (except `*.example`), keys, certificates, builds, test artefacts. `scripts/check-secrets.cjs` finds nothing in the tree. Frontend startup rejects secret-looking `NEXT_PUBLIC_*` names (tested). The bundle was grepped for the sandbox secrets and connection strings: none. Caveat: `.env` in the folder holds real-looking Atlas credentials and must never be copied, zipped or committed. |
| 12 | Monitoring, backup, recovery documented, status clear | **Documented; not operational** | `docs/OPERATIONS.md` marks each item verified / defined / not verified. Alerts are written down but no monitoring system exists. Backups of the real database: unknown. A restore **drill** in an isolated database passes (8/8), which proves the procedure and data model, not Atlas. |
| 13 | Missing routes, incomplete adapters, external approvals documented | **Done** | Section 7. |
| 14 | Existing changes not discarded | **Mostly; one caveat** | The user's `.env` is untouched (still dated 2026-09-26). The old mock data was moved, not deleted. No Git history exists, so there is no way to recover the *previous version of the dashboard pages*: they were rewritten to call the real API (their old content was fake-data rendering). Nothing was committed, pushed, force-pushed or deleted from a database. Dependencies were upgraded (Next.js 16.3.6 -> 16.3.8 patch) and added (Playwright, Vitest, Testing Library, nodemailer; dev: smtp-server). |

## 3. Completed work and files (132 files created or changed on 2026-10-14)

**Backend (src, scripts, test)**
* Queue/Redis: `src/jobs/jobs.module.ts`, `jobs.producer.ts`, `bullmq.processors.ts` (configurable prefix and test-only fixed backoff; structured failure events), `src/common/redis.ts` (fail-fast, prefixed rate-limit keys), `src/config/configuration.ts`, `src/config/env.validation.ts` (+ `.spec.ts`: 13 tests; production rules for CORS, payment mode, SMTP, queue knobs), `src/app.module.ts`.
* Notifications: `src/modules/notifications/smtp-email.sender.ts` (new), `notifications.module.ts` (provider factory behind `NotificationSender`, deterministic Message-ID, production warning).
* Logging: `src/common/json-logger.ts` (+ spec), `src/common/app-setup.ts`, `src/main.ts`, `src/worker.ts`, `src/modules/payments/payments.service.ts` (alertable `payment_failed`, `payment_webhook_failed`, `refund_failed`).
* Tools: `scripts/dev-sandbox.ts`, `sandbox-razorpay-shim.cjs`, `test-bullmq.cjs`, `restore-drill.ts`, `check-secrets.cjs`.
* Tests added: `test/booking-payment-reliability.e2e-spec.ts`, `queues-bullmq.e2e-spec.ts`, `queues-bullmq-shutdown.e2e-spec.ts`, `queues-bullmq-outage.e2e-spec.ts`, `notifications-smtp.e2e-spec.ts`, `observability.e2e-spec.ts`; `test/utils/test-app.ts` (real-BullMQ mode with isolation and cleanup).
* Ops/config: `package.json`, `docker-compose.yml`, `.dockerignore`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `docs/*`.

**Frontend** (`frontend/`)
* Core: `lib/api/client.ts` (single-flight refresh, no fallbacks), all of `lib/api/*.ts`, `lib/api/mappers.ts`, `lib/config.ts`, `lib/startup.ts`, `instrumentation.ts`, `next.config.ts` (standalone output, security headers, no production source maps), `app/api/health/route.ts`, `lib/auth/*`, `lib/query-provider.tsx`, `lib/booking/session.ts`, `lib/payments/razorpay-checkout.ts`, `lib/utils/errors.ts`, `lib/hooks/use-debounced.ts`, `components/ui/query-state.tsx`, `types/index.ts`.
* Screens rewritten against the real API: dashboard, reservations, rooms, inventory, rates (+ promotions), guests, payments, reports, channels (list, detail, mapping modal, sync errors), settings, PMS calendar, reservation drawer/modal, login, register, forgot-password, **reset-password (new: the e-mailed link target did not exist)**, OAuth return route, public property page, booking, confirmation, lookup, booking summary/search/room card.
* Tests: `tests/*` (7 files, 196 tests), `tests/live/*` (2 files, 47 tests), `e2e/*` (20 browser tests), configs `vitest*.config.ts`, `playwright.config.ts`.
* Deployment: `Dockerfile`, `.dockerignore`, `.env.example`, `scripts/start-standalone.cjs`, `README.md`.

## 4. Commands and actual results

| Command | Result |
| --- | --- |
| `node scripts/check-secrets.cjs` | no secrets detected |
| `npm run typecheck` (backend) | pass |
| `npm run build` (backend) | pass |
| `npm test` (backend, inline queue) | 17 suites passed, 3 skipped (BullMQ-only); **139 tests pass**, 10 skipped |
| Baseline before any change | 12 suites, 93 tests pass |
| `npm run test:bullmq` (real BullMQ, Redis 5.0.14.1, loopback, empty before and after) | **20 suites, 149 tests pass** |
| `npm run drill:restore` | 8/8 steps pass |
| `frontend: tsc --noEmit` | pass |
| `frontend: eslint` | 0 errors, 7 warnings (unused imports, landing page `app/page.tsx`) |
| `frontend: vitest run` | 7 files, **196 tests pass** |
| `frontend: vitest --config vitest.live.config.ts` (against `npm run sandbox`) | 2 files, **47 tests pass** |
| `frontend: next build` | pass (also pass after upgrading Next.js to 16.3.8) |
| `NEXT_PUBLIC_DEMO_MODE=true next build` | fails as intended |
| `frontend: playwright test` (Chrome 1.64 runner, cold start of sandbox API + standalone server) | **20 passed**, three consecutive runs, no retries, no flaky tests |
| standalone server simulation of the image runtime | starts, `/api/health` ok, `?deep=1` sees the API, `/login` 200, SSR property page from the API, unknown slug 404, security headers present, 0 source maps; exit code 1 with a `fatal` JSON line on an unsafe config |
| `docker build` (both), `docker compose up/config` | **not run: Docker not installed** |
| `npm audit --omit=dev` | frontend **0** (after Next.js 16.3.6 -> 16.3.8 and `npm audit fix`); backend 2 moderate (`js-yaml` via `@nestjs/swagger`) |
| `npm audit` (dev deps, frontend) | 8: critical `tinypool`/`vitest` (test runner), high `eslint-config-next` chain; dev-only, but do not run the test runner on untrusted code |

Flaky or slow: no flaky tests observed. Slowest e2e tests: the "double click" (about 10 s on the first run, 2 s later) and "API down during search" (about 19 s on the first run, 2.5 s later). Jest prints "did not exit one second after the test run" (a leftover handle in the existing harness); the BullMQ runner uses `--forceExit`.

## 5. Frontend-to-backend endpoint matrix

Full table with per-screen status in `docs/FRONTEND_INTEGRATION.md`. Summary of what is verified where (J = jsdom page against live API, B = real browser, U = unit/component):

| Area | Endpoints | Verified |
| --- | --- | --- |
| Auth | `/auth/login`, `/register`, `/refresh`, `/me`, `/logout`, `/forgot-password`, `/reset-password` | U, J, B (login, protected, expiry, logout) |
| Dashboard / reports | `/properties/:id/reports/{occupancy,revenue}`, `/reservations`, `/properties/:id/channels` | J, B (load + failure/retry) |
| Reservations | `/reservations` (list, create, cancel, check-in/out, no-show, assign-room) | J, B (create + validation error), U |
| Rooms, inventory, rates, promotions | `/properties/:id/room-types`, `/room-types/:id/rooms`, `/rooms/:id/status`, `/properties/:id/{inventory,restrictions,rate-plans,promotions}`, `/inventory/block` | J, U (PmsCalendar 17) |
| Guests, payments, settings | `/guests`, `/payments*`, `/properties/:id/users`, `PATCH /properties/:id` | J |
| Channels | `/properties/:id/channels*`, `/admin/sync-errors` (403 for non-admins shown as such) | J |
| Public booking | `/public/properties/:slug`, `.../availability`, `POST /public/reservations`, `/payments/verify`, `/public/reservations/:code` | B (with fake gateway), U, J |

## 6. Mock-fallback inventory (final)

61 unsafe catch-and-fabricate blocks in `lib/api` removed, 4 fake-auth paths removed, 17 files that rendered `MOCK_*` directly rewritten, 12 hard-coded property ids removed, fabricated UI claims removed (details in `docs/FRONTEND_INTEGRATION.md` section 2). Remaining intentional fixtures: `lib/fixtures/demo-data.ts` (unused, excluded, guarded) and the sandbox-only Razorpay shim plus the Playwright Checkout stand-in (test tooling, not shipped). The landing page `app/page.tsx` still links to the seed slug `/stays/radha-ashram`.

## 7. Security and payment risks

Payment and booking correctness:
1. **Real gateway never exercised** (blocker). Webhook registration, key rotation, live-vs-test key mix-ups, Razorpay's real signature timing and `payment.authorized` vs `captured` flows are unproven.
2. Hold expiry runs every 60 s (`expire-pending-holds`), so a hold can outlive its 20 minutes by about a minute; a late payment is refunded automatically (tested) but the guest sees a failure. The scheduler must be running (worker process); a dead worker leaves rooms held. Alert defined in OPERATIONS.md.
3. Production refuses `BOOKING_ENGINE_REQUIRE_PAYMENT=false` without `ALLOW_PAY_AT_PROPERTY=true` (new). The current `.env` has it `false`.
4. Seed data maps the unavailable OTAs (Airbnb, Booking.com, Agoda). Every inventory change then produces `FAILED` sync jobs and error logs ("requires approved connectivity-partner API access"), which would trip the queue alerts. Map only channels that exist.

Security:
5. Refresh token is stored in `localStorage` (XSS-exposed) although the API also sets an httpOnly cookie that the frontend does not use. Decide and migrate (cookie + `credentials: 'include'` + CSRF protection).
6. No Content-Security-Policy yet (Razorpay Checkout needs `script-src`/`frame-src` allowances); basic headers (nosniff, frame deny, referrer, permissions) are set.
7. Dev-tooling advisories (vitest/tinypool critical) and 2 moderate backend advisories (js-yaml via swagger): not reachable in production runtime paths as far as audited, but should be updated.
8. `.env` with Atlas credentials sits in the project folder. Rotate the database password if the folder was ever shared.
9. Rate limiting fails open when Redis is down (by design, now fast); during an outage the login brute-force protection is effectively off until Redis returns. Acceptable only with the Redis-down alert.

## 8. Deployment blockers and remaining work

**Before go-live (must)**
1. Fix `.env` (`MONGODB_URI` single prefix, real host); confirm the Atlas tier has continuous backup + PITR; run one restore into a scratch cluster; record RPO/RTO.
2. Create a Razorpay test-mode account configuration (real `rzp_test_*` key, key secret, webhook secret, webhook URL) and complete one real Checkout payment, one failed payment, one refund; set `BOOKING_ENGINE_REQUIRE_PAYMENT=true`.
3. Install Docker, `docker compose up --build`, run the whole flow on the built images (CI `docker` job does the builds and startup checks once the repo is on GitHub).
4. `git init`, run `scripts/check-secrets.cjs`, commit, push, let CI run once; fix whatever it shows; pin Actions to SHAs.
5. Configure an SMTP provider and send a booking confirmation to an address you own; configure SPF/DKIM for the sending domain.
6. Wire the alerts in `docs/OPERATIONS.md` to a real monitoring/pager and ship stdout JSON logs to a log store.

**Soon (should)**
7. Real-browser pass on the remaining screens (rooms, rates, guests, channels, settings), keyboard navigation and mobile layout.
8. Decide on error tracking (Sentry or equivalent) with scrubbing; add CSP; move the refresh token to the httpOnly cookie.
9. Update Redis in CI/production to 7.x (BullMQ's recommended 6.2+); run `test:bullmq` there (the CI job does this).
10. Update `@nestjs/swagger` / `vitest` / `eslint-config-next` to clear dev and moderate advisories.
11. SMS/WhatsApp providers (currently log-only), if those channels are promised.

**Later (could)**
12. Real OTA adapters (Airbnb, Booking.com, Agoda) once partner access exists.
13. A property-wide payments list, per-guest history endpoint, dashboard summary endpoint (the UI composes these today; see FRONTEND_INTEGRATION.md).
14. Per-date rate calendar and slab-based tax (known limitation in README).

## 9. Missing backend routes and external dependencies
* No endpoint for: dashboard summary, all rooms of a property, all payments of a property, per-guest stays and lifetime value, reservation confirm (confirmation happens through payment), reservation room-type filter, export. The UI composes or omits these without inventing data.
* `GET /admin/sync-errors` and sync-job retry are platform-admin only: an owner sees "not allowed".
* Airbnb, Booking.com, Agoda: adapters are scaffolds; they need each platform's connectivity-partner approval. The UI reports "partner access needed".
* Razorpay account, SMTP/SMS/WhatsApp providers, Atlas backup configuration, a monitoring/pager service and a container registry/host are external dependencies not available to this audit.

## 10. Decision

**NO-GO today.** Critical verifications are missing (real payment gateway, real database and backups, built images, CI run, real e-mail delivery). **CONDITIONAL GO** for a limited first rollout once items 1 to 6 under "Before go-live" are done and pass; the code and tests give no reason to expect surprises there, but that is an expectation, not evidence.
