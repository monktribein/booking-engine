# Operations

What runs in production, how to see that it is healthy, what to alert on, and how to recover. Every statement is tagged **verified** (a command was run and its result recorded), **defined** (a rule or procedure written down but not wired to a tool or a real environment), or **not verified**.

## 1. Queues and Redis

### How the queue is chosen
`QUEUE_DRIVER` (default `bullmq`) selects the implementation in `src/jobs/jobs.module.ts`.

| Driver | Where jobs go | Use |
| --- | --- | --- |
| `bullmq` | Redis (`REDIS_URL`), processed by BullMQ workers in the `worker` process (or the API when `WORKERS_ENABLED=true`) | production, and the real-Redis test run |
| `inline` | in-process, same retry rules, no delay | unit/e2e tests and Redis-less local dev. **Production refuses it** (`validateEnv`). |

Business code only sees `JobsProducer` / `JobHandler`. Jobs carry ids only; workers re-read MongoDB. Writes that must not be lost use a **transactional outbox**: the reservation/notification/sync row is committed in MongoDB first and handed to the queue afterwards, so a Redis outage never loses a booking's side effects.

Retry policy (`src/jobs/queues.ts`, exponential backoff, failed jobs kept 14 days, completed 24 h):

| Queue | attempts | first backoff | concurrency |
| --- | --- | --- | --- |
| webhook-processing | 10 | 5 s | 5 |
| inventory-sync | 8 | 15 s | 10 |
| rate-sync | 8 | 15 s | 5 |
| reservation-sync | 8 | 30 s | 5 |
| notification | 5 | 30 s | 10 |
| payment | 6 | 20 s | 5 |

Redis for BullMQ needs `maxmemory-policy noeviction` (set in `docker-compose.yml`, plus AOF) and should be **6.2 or newer**.

### Running the backend suites on real Redis
```bash
# you started an isolated development Redis yourself:
TEST_REDIS_URL=redis://127.0.0.1:6390 npm run test:bullmq
# or let the runner start (and stop) its own throw-away Redis:
REDIS_SERVER_BIN=/usr/bin/redis-server npm run test:bullmq
npm run test:bullmq -- test/payments        # extra arguments go to jest
```
Safety built into the harness (`test/utils/test-app.ts`): only loopback hosts are accepted (`TEST_REDIS_ALLOW_REMOTE=1` overrides); every test app gets a unique key prefix (`QUEUE_PREFIX`, which also scopes the rate-limiter keys); it deletes **only** keys under its own prefix and fails if any remain; `FLUSHDB`/`FLUSHALL` are never issued; `QUEUE_BACKOFF_OVERRIDE_MS` (fixed 50 ms retry delay for tests) is rejected by `validateEnv` in production. Never point `TEST_REDIS_URL` at a shared or production Redis.

### What was verified on a real Redis (all pass)
Environment: Redis **5.0.14.1** (the only build obtainable here: an unofficial Windows port; Docker and WSL were not installed). BullMQ warns that 6.2+ is recommended; CI uses the distro Redis 6.2+/7. Redis was started on `127.0.0.1:6390`, empty, no persistence, and was empty again after every run.

| Check | Result |
| --- | --- |
| Whole backend suite with `TEST_QUEUE_DRIVER=bullmq` (real workers) | 20 suites, **149 tests pass** (inline run: 139 pass + 10 BullMQ-only skipped) |
| Job creation and processing; notification jobs reach only the logging sender (no external call) | pass |
| Retry with backoff: failing sender succeeds on attempt 3, delivered once | pass |
| Retries exhausted: notification `FAILED`, job kept in Redis, reported with reason and `attemptsMade = 5` | pass |
| `UnrecoverableError` is not retried | pass |
| Same `jobId` enqueued twice runs once; a ghost job completes without a retry loop | pass |
| Channel-sync jobs (MOCK OTA push, injected failure then retry/report) | pass |
| Graceful shutdown: closing the app waits for the job in progress, nothing left `active` or lost (repeated 4x) | pass |
| Redis stopped mid-run: `/health` becomes 503 `queues: down`; a booking still returns 201 in under 5 s; the outbox rows wait; after Redis returns they are delivered | pass |
| No key leaks between tests (Redis key count 0 after each full run) | pass |

Problems found and fixed while doing this:
* With Redis down every API request took about 10 s: the rate limiter's Redis commands waited in ioredis's offline queue before failing open. `RedisThrottlerStorage` now uses `enableOfflineQueue: false` and `commandTimeout: 500`, so failing open is immediate.
* Rate-limit keys (`throttle:*`) were outside any prefix and leaked between runs/environments. They now live under the queue prefix.
* `src/app.module.ts` reads configuration when first imported, so a second `createTestApp()` in the same test file silently reuses the first app's Redis URL and prefix. The scenarios that need their own app are therefore separate files.

Not verified: the `docker-compose` `redis:7-alpine` service (Docker unavailable here); multi-instance behaviour with several workers; Redis failover/cluster.

## 2. Logging and errors

* **Backend** (`src/common/json-logger.ts`): JSON lines on stdout/stderr by default when `NODE_ENV=production` (`LOG_FORMAT=json|text`, `LOG_LEVEL=debug` for debug lines). Applies to the API and the worker. Everything written is passed through redaction (bearer tokens, JWTs, database/Redis/SMTP URLs with credentials, `password/secret/token/signature` assignments, e-mail local parts, `+` phone numbers, booking codes). Structured events additionally mask sensitive keys.
* **Request log**: one line per request with `requestId`, `method`, the **route pattern** (`/public/reservations/:code`), `status`, `ms`. No query strings, ids, e-mails or tokens. `/health` is not logged when OK. `X-Request-Id` is accepted when it looks sane (8-64 `[A-Za-z0-9._-]`) else generated, and always echoed (exposed to browsers by CORS).
* **Events to alert on**: `queue_job_failed` (`queue`, `final`), `queue_worker_error`, `payment_failed`, `payment_webhook_failed`, `refund_failed`.
* **Frontend**: `instrumentation.ts` logs server-side request errors as JSON (no query, headers, cookies, body; booking codes stripped from the path; message truncated). Unsafe production configuration makes the process exit with code 1 and a `fatal` line.
* **Verified**: unit tests for redaction; an e2e test proves tokens, e-mails, booking codes, query strings, signatures and phone numbers never reach the log stream, that request ids behave as described, and that `payment_failed` is emitted without guest data.
* **Source maps**: `productionBrowserSourceMaps: false`; the built bundle contains 0 `.map` files (verified) and no secret strings (verified by grep of `.next`).
* **Error monitoring (Sentry or similar): not integrated.** There is no DSN or account in the project, and adding an SDK without one would be dead code. Hook points are ready: `AllExceptionsFilter` (backend 5xx) and `onRequestError` (frontend). If adopted: scrub `Authorization`, cookies, bodies and e-mail/phone fields in `beforeSend`, set `sendDefaultPii: false`, and upload source maps to the vendor only (never serve them publicly).

## 3. Health checks

| Endpoint | Meaning | Used by |
| --- | --- | --- |
| `GET /health` (API) | 200 only if MongoDB **and** the queue backend (Redis) answer within 2 s, else 503 with `details` | container HEALTHCHECK, load balancer |
| `GET /api/health` (web) | the Next.js server is up; never calls the API (a backend outage must not restart healthy web containers) | container HEALTHCHECK |
| `GET /api/health?deep=1` (web) | also reports whether the API is reachable (503 if not) | monitoring |
| `GET /admin/queues` (platform admin) | job counts per queue | dashboards |
| `GET /admin/sync-errors` (platform admin) | failed sync jobs, failed webhooks, failed queue jobs | on-call |

## 4. Alert definitions (defined, not wired to any tool)

No monitoring system is configured in this project. These are the rules to create in whichever platform ingests the JSON logs and health checks:

| Alert | Signal | Suggested threshold | Severity |
| --- | --- | --- | --- |
| API down | `/health` non-200 for 2 consecutive probes | 1 min | page |
| Elevated errors | `event=http_request AND status>=500` / all requests | > 2 % over 5 min | page |
| Failed queue jobs (money or bookings) | `event=queue_job_failed AND final=true AND queue IN (payment, webhook-processing)` | any | page |
| Failed queue jobs (other) | same, `inventory-sync, rate-sync, reservation-sync, notification` | > 5 in 15 min | ticket |
| Payment failures | `event=payment_failed` | > 10 per hour or 3x the weekly baseline | ticket |
| Refund / webhook failures | `event=refund_failed OR event=payment_webhook_failed` with `final=true` | any | page |
| Booking/payment 5xx | `http_request` with route `/public/reservations`, `/payments/verify`, `/payments/webhook` and status >= 500 | any | page |
| Holds not expiring (scheduler dead) | MongoDB: `reservations.countDocuments({status:'PENDING', holdExpiresAt:{$lt: now-10min}}) > 0` | 10 min | page |
| Redis down | `/health` 503 with `queues: down` | 1 min | page |
| Mail not configured | log line "E-mail delivery is NOT configured" at startup in production | any | ticket |
| Notifications failing | MongoDB: `notifications.countDocuments({status:'FAILED', updatedAt > now-1h})` | > 5 | ticket |
| Web start refused | `event=invalid_configuration level=fatal` or container restart loop | any | page |

## 5. Notifications

Providers sit behind `NotificationSender` (`src/modules/notifications`). E-mail is SMTP: set **`SMTP_URL`** (e.g. `smtps://USER:PASSWORD@smtp.example.com:465`, any provider with an SMTP interface: SES, Postmark, Mailgun, a relay) and **`SMTP_FROM`**. That is the minimum for booking confirmations. With `SMTP_URL` unset, e-mails are only logged (a production start logs a warning). SMS and WhatsApp remain logging stubs.

Delivery semantics (**verified** against a local in-process SMTP server, so no real message can be sent): one delivery per notification (lease + status check; a replayed job sends nothing), deterministic `Message-ID` `<ntf-<id>@<from-domain>>`, SMTP 4xx/network errors retried with backoff then `FAILED`, SMTP 5xx marked `FAILED` immediately (not retried), `attempts`, `lastError`, `sentAt` and `metadata.providerMessageId` recorded on the row. **Not verified:** a real provider (needs credentials and an approved sending domain with SPF/DKIM) and a real mailbox. Do not enable it for customers before sending a test to an address you own.

## 6. Backups and recovery

**Verified status: no backup was inspected or restored.** The repository's `.env` points at MongoDB Atlas (`mongodb+srv`) but its value is malformed (doubled `MONGODB_URI=` prefix, `<cluster>` placeholder), so the live database could not be reached and Atlas could not be examined. Do not assume backups exist until the checklist below is done.

What lives where: **MongoDB is the only source of truth** (reservations, payments, inventory, audit). Redis holds in-flight jobs only; they are rebuilt from outbox rows (`sync_jobs`, `notifications`, webhook events) so Redis may be lost without losing bookings. The Razorpay dashboard is an independent record of money movement.

Recommended strategy (a policy to confirm, not something configured):
* Atlas **Cloud Backup** with **continuous (point-in-time) backup** on a dedicated tier (shared/free tiers do not offer it), snapshot retention of roughly 7 daily / 4 weekly / 12 monthly, PITR window of at least 7 days. Backups in a second region if the business requires regional fault tolerance. Alert on a failed or missing snapshot.
* Before any risky operation (schema/validator change, bulk edit, data fix), take an on-demand snapshot.
* Quarterly restore drill into a **new, scratch** cluster. Restore into the live cluster in place only as a last resort.

**Restore drill (verified, isolated):** `npm run drill:restore` seeds a throw-away in-memory MongoDB (a paid booking included), writes a logical backup of all 27 collections (extended JSON), destroys the database, restores into a fresh one, and checks (all pass): per-collection count and content hash identical; indexes and validators re-created by `setup-db`; inventory counters consistent with reservations; `amountPaid`/`amountRefunded` equal the payments; uniqueness enforced again. This validates the data model's restorability and the procedure's shape. It does **not** validate Atlas snapshots, retention, or restore time.

### Recovery checklist
1. Declare the incident; stop writes if corruption is ongoing (scale API and worker to zero or set maintenance).
2. Pick the recovery point (latest snapshot, or PITR timestamp just before the damage). Note the time.
3. Restore into a **new** cluster. Never over the existing one. Do not delete anything yet.
4. Run `db:setup` against it (indexes + validators). Run the invariant checks from `scripts/restore-drill.ts` against it (adapt the URI; read-only).
5. Reconcile what happened after the recovery point:
   * **Payments:** export Razorpay payments/refunds for the gap from the Razorpay dashboard/API. Any captured payment with no matching `payments` row needs a manual `payments/create`-style record or a refund; replay missed webhooks from the Razorpay dashboard (handlers are idempotent).
   * **Bookings:** guest-facing bookings made in the gap exist only as customer e-mails and Razorpay orders; contact those guests. OTA reservations: trigger a reservation pull for each connected channel (idempotent on `(source, externalReservationId)`).
   * **Inventory:** run the invariant check; if `sold` and live reservations disagree, rebuild counters from reservations before reopening sales.
6. Point `MONGODB_URI` to the restored cluster, start the API and worker, watch `/health`, the alerts above, and `GET /admin/sync-errors`.
7. Keep the damaged cluster read-only until the post-mortem is complete.
8. Record RPO (data lost) and RTO (time to recover) and update this document.
