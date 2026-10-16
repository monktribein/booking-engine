# Tirvona

Tirvona is a PMS, booking engine and channel manager.

```
backend/    NestJS modular monolith on PostgreSQL (Supabase) with Redis/BullMQ, REST API, Swagger
frontend/   Next.js dashboard (property management) and the guest booking site
sdk/        TypeScript client + webhook verification for the public API (v1)
docs/       Database, operations, deployment, public API, channel adapters, audits
```

- **Public API for external clients (API keys, `/v1`, signed webhooks):** [docs/PUBLIC_API.md](docs/PUBLIC_API.md), reference at `/docs/v1`, contract in [docs/openapi-v1.json](docs/openapi-v1.json), client in [sdk/README.md](sdk/README.md)
- **Data model and database decisions:** [docs/DATABASE.md](docs/DATABASE.md)
- **Dashboard API docs:** run the backend and open `http://localhost:3000/docs` (OpenAPI JSON at `/docs/openapi.json`)
- **OTA / channel architecture (what is and is not connected):** [docs/CHANNEL_ADAPTERS.md](docs/CHANNEL_ADAPTERS.md)
- **Configuration-driven integrations (provider definitions, generic REST, iCal, CSV, reconciliation):** [docs/CHANNEL_FRAMEWORK.md](docs/CHANNEL_FRAMEWORK.md), and the state of the Tirvona.com connection: [docs/TIRVONA_INTEGRATION.md](docs/TIRVONA_INTEGRATION.md)

## Run it locally

You need Node 20+. No database, Redis or payment account is needed for the sandbox.

```bash
# Terminal 1: API on :3000 with a throw-away local PostgreSQL, seeded demo data and a fake Razorpay gateway
cd backend
npm install
npm run build
npm run sandbox                   # owner login: owner@tirvona.demo / SandboxPass-123

# Terminal 2: web app on http://localhost:3001
cd frontend
npm install
npm run dev
```

The sandbox ignores `backend/.env` (it starts its own PostgreSQL 17 in a temp folder and deletes it on exit).

**Run against Supabase (or any PostgreSQL) and Redis instead:**

1. In Supabase create a project, then Dashboard → **Connect** and copy the connection string (see the comments in
   `backend/.env.example` for which of the three to use).
2. `cp backend/.env.example backend/.env` and fill it in: `DATABASE_URL`, the JWT/encryption secrets, `REDIS_URL`.
3. `cd backend && npm run build && npm run db:migrate` creates the schema (idempotent; run it before every deploy).
4. Optional demo data: `npm run db:seed` (refuses if already seeded).
5. `npm start` (API) and `npm run start:worker` (jobs).

`QUEUE_DRIVER=inline` runs jobs in-process without Redis (development only; production refuses it).

## Test and verify

```bash
cd backend  && npm run typecheck && npm test         # unit + e2e on a throw-away PostgreSQL 17 (no Redis needed)
cd backend  && npm run db:verify && npm run drill:restore   # concurrency/integrity checks and the backup/restore drill
cd backend  && npm run test:bullmq                    # same suites on real BullMQ (needs REDIS_SERVER_BIN or TEST_REDIS_URL)
cd backend  && npm run openapi:check                  # the public /v1 contract matches docs/openapi-v1.json
cd frontend && npm run typecheck && npm run lint && npm test && npm run build
cd frontend && npm run test:live                      # real pages + API modules against a RUNNING sandbox
cd frontend && npm run test:e2e                       # real-browser (Playwright) journeys; starts the sandbox itself
cd sdk      && npm run typecheck && npm test && npm run build
node backend/scripts/check-secrets.cjs                # pattern-based secret scan of the whole repository
```

Operations: [docs/OPERATIONS.md](docs/OPERATIONS.md) (queues, logging, alerts, backups), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Docker, CI, rollback), [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md), [docs/PRODUCTION_AUDIT.md](docs/PRODUCTION_AUDIT.md). Docker: `cp backend/.env.example backend/.env`, fill it in, `docker compose up --build`.

## Backend layout (`backend/`)

```
src/
  main.ts / worker.ts        HTTP API process / queue-worker + scheduler process (same code, same image)
  app.module.ts              module wiring, global guards (throttle → JWT → org role → property access)
  config/                    typed configuration + fail-fast env validation
  common/                    RBAC (permissions, @PropertyAccess guard), response envelope, error mapping,
                             Swagger helpers, NoSQL-injection sanitizer, Redis throttler storage
  database/                  schemas, indexes, validators; inventory / reservation / availability /
                             channel-mapping / sync-job / webhook / client-event services (all transactional logic)
  jobs/                      queue names & retry policy, BullMQ producer + processors, inline driver,
                             transactional-outbox dispatcher, scheduler
  modules/
    auth users organizations properties room-types rooms rates inventory guests reservations
    payments (providers/razorpay)  booking-engine (guest website API)  public-api (/v1, API keys, webhooks)
    channels (interfaces, airbnb, booking-com, agoda, mock)  webhooks  sync  notifications  reports  audit  admin
test/                        e2e suites (real AppModule, real PostgreSQL transactions)
scripts/                     db-migrate, seed (Radha Ashram demo), verify, sandbox, openapi export, restore drill, secret scan
```

Modules talk to each other only through services and the job queues. None of them opens its own database connection. Each module can later be extracted into its own service by swapping in-process calls for the queue or HTTP.

## How the important parts work

### Booking without double-selling

`POST /reservations` and `POST /public/reservations` both go to `ReservationService.createReservation`:

1. Validate the dates, room types, rate plans, occupancy and booking horizon.
2. Price every night on the server. Prices are frozen on the reservation.
3. In **one PostgreSQL transaction**, for each room type, lock the night rows in date order (`SELECT … FOR UPDATE`), then run
   `UPDATE inventory SET available = available - qty, sold = sold + qty WHERE nights in stay AND NOT stop_sell AND available >= qty`
   and require the affected row count to equal the number of nights. If any night fails, the whole transaction rolls back and nothing is decremented.
4. Insert the reservation, plus outbox rows (`sync_jobs`, `notifications`) and an audit log entry, in the same transaction.
5. Commit, then hand the outbox rows to BullMQ. Channel sync runs asynchronously.

Two concurrent transactions on the same night queue on the row locks. The loser then fails the `available ≥ qty` condition and gets **409 `ROOM_NOT_AVAILABLE`**. A `CHECK` constraint in PostgreSQL also rejects any write that would make `available < 0` or unbalance the counters.

This is tested in `test/inventory-concurrency.e2e-spec.ts`: 1 room with 2 simultaneous requests, and 1 room with 20 simultaneous requests.

### Channel manager

- **`ChannelAdapter` interface** (`modules/channels/interfaces`): `connect`, `disconnect`, `getListings`, `getRoomTypes`, `getRates`, `getReservations`, `getReservation`, `updateAvailability`, `updateRates`, `updateRestrictions`, `acknowledgeReservation`, plus webhook verification and parsing. The core only sees channel-neutral data. Nothing OTA-specific lives outside an adapter folder.
- **Connecting a channel:** `POST …/channels/:channel/connect` returns the channel's authorization URL. The callback checks the anti-CSRF `state`, and tokens are stored AES-256-GCM encrypted. Owners never type API keys.
- **Mappings:** a listing (and the room inside it, for hotel-style channels) maps to a room type; external rate plans map to rate plans with an optional markup. Every channel sells from the same inventory rows.
- **Sync:** each inventory, rate or restriction change writes `sync_jobs` in its own transaction. Workers (`inventory-sync`, `rate-sync`, `reservation-sync`) re-read the master data and push **absolute** values (for example "Deluxe AC on 2026-10-05 = 9"), so retries and reordering are harmless.
  - Failures retry with exponential backoff.
  - After the last attempt the job is marked FAILED and staff get a `channel.sync.failed` alert. Reservations are never cancelled because a channel failed.
  - TIRVONA and DIRECT read the database directly.
- **Airbnb, Booking.com and Agoda** adapters are scaffolds on `PartnerChannelAdapter`. Their connectivity APIs are only available to approved partners, and **no undocumented API is implemented**. Until an adapter is written against the official partner documentation, every call fails with `CHANNEL_INTEGRATION_NOT_AVAILABLE` and their webhooks are rejected.
- **`MockChannelAdapter`** is a complete simulated OTA. It covers the OAuth-style consent flow, two listings (one single-unit, one hotel with 3 rooms), stored pushes, signed webhooks, reservation create/modify/cancel, failure injection (`POST …/channels/MOCK/simulate/failures`) and webhook simulation (`…/simulate/reservation`). It is disabled in production.

### Webhooks

`POST /webhooks/:channel` does five things:

1. Verifies the signature over the raw body.
2. Stores the raw event. Unique on `(channel, externalEventId)`; unsigned events can never occupy a real event id.
3. Enqueues `webhook-processing`.
4. Returns 200.
5. The worker then creates, modifies or cancels the reservation, acknowledges it to the channel, and syncs the other channels.

A booking is also unique on `(source, externalReservationId)`, so "Airbnb sends ABC123 twice" yields one reservation even under different event ids. Failed events are retried, then parked as FAILED. Admins can retry them.

### Payments (Razorpay)

- **Create:** `POST /payments/create` creates a Razorpay order, or records cash or bank transfer.
- **Verify:** `POST /payments/verify` checks the Checkout signature and captures.
- **Webhook:** `POST /payments/webhook` is signature-checked, deduplicated and processed on the `payment` queue.
- **Refund:** `POST /payments/:id/refund` handles full or partial refunds. They are idempotent at the gateway through a refund reference.

Capture is a conditional PENDING→PAID transition, so the browser callback and the webhook can race safely. Card data never touches Tirvona.

Public bookings are PENDING holds for 20 minutes. A captured payment confirms them; an expired hold releases the rooms everywhere.

### Queues (BullMQ)

The queues are `webhook-processing`, `inventory-sync`, `rate-sync`, `reservation-sync`, `notification` and `payment`. Each has its own attempts, exponential backoff and concurrency (`jobs/queues.ts`). Failed jobs are kept for 14 days.

Queue counts are at `GET /admin/queues`. Failures are at `GET /admin/sync-errors`, together with the persisted `sync_logs`.

Business code never depends on BullMQ directly: it uses `JobsProducer` and a `JobHandler` per queue. The inline driver implements the same interface for tests.

### Security checklist

- **Passwords and sessions:** passwords are hashed with scrypt. Access tokens are HS256 JWTs checked for issuer, audience and expiry, and the guard also checks the session on every request.
- **Refresh tokens:** they rotate on every use and are stored only as an HMAC. Reusing a token revokes its whole session family. Logout and password reset take effect immediately.
- **RBAC:** authorization is property-scoped. `@PropertyAccess` resolves the property from the id in the route, body or query, checks membership in `property_users`, then checks the permission for that role. Organization-level roles are enforced by `@Roles`. Cross-property isolation is tested.
- **Rate limiting:** limits are stored in Redis and shared across instances, with strict limits on credential endpoints. If Redis is down, rate limiting fails open rather than taking the API down.
- **HTTP hardening:** helmet headers, a CORS allow-list and body size limits are applied.
- **Input validation:** a DTO whitelist rejects unknown fields, every id is validated as a UUID, and all database access goes through parameterised queries (no string-built SQL).
- **Webhooks:** inbound signatures are verified with HMAC and constant-time comparison. Outbound customer webhooks are signed (HMAC-SHA256 over timestamp + raw body), retried with the same event id, and refuse private/loopback targets (SSRF) at connect time.
- **Public API keys:** only a SHA-256 hash is stored; keys are scoped, optionally property-restricted, expirable, revocable and rate-limited per key. A key sees only its own organization (other tenants' data is a 404).
- **Secrets at rest:** channel credentials and guest ID numbers are AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- **No secret leakage:** `passwordHash`, tokens and payment secrets are never returned. The response layer strips them as a second safety net, and logs and audit entries are redacted.
- **Audit log:** covers login/logout, property, inventory, reservation, payment, channel and mapping changes, manual sync and admin actions.

## Endpoints

All endpoints are listed in Swagger. Every response is either `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message" } }`.

The endpoint list from the brief is implemented as specified. The extras are:

- auth: `forgot-password`, `reset-password`, `me`
- `GET /room-types/:id`, `GET /rooms/:id`, `POST /rooms/:id/status` (maintenance/block/cleaning/available, with an optional inventory block)
- `PUT /properties/:id/restrictions`
- rate plans and promotions
- `POST /reservations/:id/assign-room`
- `POST /payments/verify`
- `GET /public/properties` (guest search: destination, dates, guests, price, amenities, sorting, pagination) and `GET /public/reservations/:code`
- channel mapping delete
- mock simulation
- `/notifications`
- `/properties/:id/reports/{occupancy,revenue}`
- `/properties/:id/users` (staff and invitations)
- `/properties/:id/audit-logs`
- admin retry endpoints
- `/health`
- public API (API-key authenticated): `/v1/properties`, `/v1/properties/:slug/availability`, `/v1/reservations` (create with `Idempotency-Key`, list, get, cancel); dashboard endpoints `/api-keys` and `/webhook-endpoints` ([docs/PUBLIC_API.md](docs/PUBLIC_API.md))

## Known limitations

- **Airbnb, Booking.com and Agoda are not connected.** Their adapters are scaffolds that fail with `CHANNEL_INTEGRATION_NOT_AVAILABLE` until Tirvona is an approved connectivity partner and an adapter is written against the official documentation (see [docs/CHANNEL_ADAPTERS.md](docs/CHANNEL_ADAPTERS.md)). The mock OTA is a test double only.
- **SMS and WhatsApp only log.** E-mail is sent through any SMTP provider (`SMTP_URL`); without it e-mails are also only logged. Bind real SMS/WhatsApp providers behind `NotificationSender`.
- **Razorpay has only been exercised against a faithful fake** (HMAC scheme, orders, refunds) until you run a real test-mode payment; see [docs/PRODUCTION_AUDIT.md](docs/PRODUCTION_AUDIT.md).
- **Flat pricing.** Prices are the rate plan's flat nightly price, and tax is a single `taxPercent`. A per-date rate calendar and slab-based tax rules are the next pricing features.
- **Mock channel state is in memory.** The mock OTA's "remote" state lives in the process, so run API and worker in one process when demoing it.
