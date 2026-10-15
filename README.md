# Tirvona backend

Tirvona is a PMS, booking engine and channel manager. This repository is its backend: a NestJS modular monolith on MongoDB (Mongoose), with Redis/BullMQ for background jobs, a REST API and Swagger docs.

- **Data model and database decisions:** [docs/DATABASE.md](docs/DATABASE.md)
- **API docs:** run the app and open `http://localhost:3000/docs` (OpenAPI JSON at `/docs/openapi.json`)

## Quick start

```bash
npm install
npm test                          # 104 tests; starts its own MongoDB replica set, no Redis needed

cp .env.example .env              # fill in JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY, Razorpay keys
docker compose up --build         # api + worker + redis + mongo (single-node replica set)
docker compose run --rm api node dist/scripts/setup-db.js   # indexes + server-side validators
```

### Frontend (Next.js) and the local sandbox

```bash
npm run build && npm run sandbox  # in-memory MongoDB replica set + seeded Radha Ashram demo + the API on :3000 (your .env database is NOT used)
                                  # owner login: owner@tirvona.demo / SandboxPass-123
npm run frontend:dev              # http://localhost:3001 (see frontend/README.md)
npm run frontend:test             # frontend unit + component tests
npm run frontend:test:live        # real pages + API modules against the running sandbox
```

Documents: [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md) (integration audit), [docs/OPERATIONS.md](docs/OPERATIONS.md) (queues, logging, alerts, backups), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Docker, CI, rollback), [docs/PRODUCTION_AUDIT.md](docs/PRODUCTION_AUDIT.md) (final audit and go/no-go).

Real-Redis tests: `REDIS_SERVER_BIN=/path/to/redis-server npm run test:bullmq` (or `TEST_REDIS_URL=redis://127.0.0.1:6390`). Browser tests: `cd frontend && npm run test:e2e`. Restore drill: `npm run drill:restore`.

Without Docker you can run `npm run start:dev` against any MongoDB replica set (Atlas works).

- Set `QUEUE_DRIVER=inline` to run without Redis. This is for development only; production refuses it.
- Transactions need a replica set, so a standalone `mongod` will not work.

## Layout

```
src/
  main.ts / worker.ts        HTTP API process / queue-worker + scheduler process (same code, same image)
  app.module.ts              module wiring, global guards (throttle → JWT → org role → property access)
  config/                    typed configuration + fail-fast env validation
  common/                    RBAC (permissions, @PropertyAccess guard), response envelope, error mapping,
                             Swagger helpers, NoSQL-injection sanitizer, Redis throttler storage
  database/                  schemas, indexes, validators; inventory / reservation / availability /
                             channel-mapping / sync-job / webhook services (all transactional logic)
  jobs/                      queue names & retry policy, BullMQ producer + processors, inline driver,
                             transactional-outbox dispatcher, scheduler
  modules/
    auth users organizations properties room-types rooms rates inventory guests reservations
    payments (providers/razorpay)  booking-engine (public API)  channels (interfaces, airbnb,
    booking-com, agoda, mock)  webhooks  sync  notifications  reports  audit  admin
test/                        e2e suites (real AppModule, real MongoDB transactions)
scripts/                     setup-db, seed (Radha Ashram demo), verify (data-layer checks)
```

Modules talk to each other only through services and the job queues. None of them opens its own database connection. Each module can later be extracted into its own service by swapping in-process calls for the queue or HTTP.

## How the important parts work

### Booking without double-selling

`POST /reservations` and `POST /public/reservations` both go to `ReservationService.createReservation`:

1. Validate the dates, room types, rate plans, occupancy and booking horizon.
2. Price every night on the server. Prices are frozen on the reservation.
3. In **one MongoDB transaction**, for each room type, run
   `updateMany({ nights in stay, stopSell: false, available: { $gte: qty } }, { $inc: { available: -qty, sold: qty } })`
   and require `modifiedCount === nights`. If any night fails, the whole transaction aborts and nothing is decremented.
4. Insert the reservation, plus outbox rows (`sync_jobs`, `notifications`) and an audit log entry, in the same transaction.
5. Commit, then hand the outbox rows to BullMQ. Channel sync runs asynchronously.

Two concurrent transactions on the same night hit a WriteConflict. The driver retries the loser, which then fails the `available ≥ qty` condition and gets **409 `ROOM_NOT_AVAILABLE`**. A MongoDB `$jsonSchema`/`$expr` validator also rejects any write that would make `available < 0`.

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
- **Input validation:** a DTO whitelist rejects unknown fields, `$`/dotted keys are stripped from bodies, and Mongoose runs with `strictQuery: 'throw'`.
- **Webhooks:** signatures are verified with HMAC and constant-time comparison.
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
- `GET /public/reservations/:code`
- channel mapping delete
- mock simulation
- `/notifications`
- `/properties/:id/reports/{occupancy,revenue}`
- `/properties/:id/users` (staff and invitations)
- `/properties/:id/audit-logs`
- admin retry endpoints
- `/health`

## Known limitations

- **No Redis on the build machine.** Every business flow is tested end to end through the inline queue driver. The BullMQ driver was only checked at startup: it boots, the processors register, and `/health` reports the queues as down when Redis is missing. Run the suite once against real Redis before going live.
- **Senders only log.** Email, SMS and WhatsApp messages are logged, not delivered. Bind real providers (SES/SMTP, an SMS gateway, the WhatsApp Business Platform) behind `NotificationSender`.
- **Flat pricing.** Prices are the rate plan's flat nightly price, and tax is a single `taxPercent`. A per-date rate calendar and slab-based tax rules are the next pricing features.
- **Mock channel state is in memory.** The mock OTA's "remote" state lives in the process, so run API and worker in one process when demoing it.
