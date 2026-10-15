# Deployment, CI and local commands

Nothing here deploys anything. No DNS, registry, secret store or cloud account was touched.

## 1. Services

| Service | Image | Port | Health | Notes |
| --- | --- | --- | --- | --- |
| `frontend` | `frontend/Dockerfile` (Next.js 16 standalone, non-root `node`, tini) | 3000 in the container (compose: 3001) | `GET /api/health` (HEALTHCHECK) | no secrets, ever |
| `api` | `backend/Dockerfile` (NestJS, non-root, tini; build context `backend/`) | 3000 | `GET /health` (HEALTHCHECK) | `WORKERS_ENABLED=false` in compose: produces jobs only |
| `worker` | same image, `node dist/src/worker.js` | none | process exit on failure | consumes all queues + scheduler (hold expiry runs here) |
| `redis` | `redis:7-alpine` | 6379 | `redis-cli ping` | `noeviction`, AOF on |
| `migrate` | same image as `api`, `node dist/scripts/db-migrate.js` | none | exits 0 | one-shot: applies SQL migrations before `api` and `worker` start |
| `postgres` | `postgres:17-alpine`, compose profile `local-db` | 5432 (localhost only) | `pg_isready` | optional, local only; use Supabase in production |

## 2. Configuration

### Backend (`.env`, read at runtime, never baked into an image)
Required in production (the process refuses to start otherwise, see `backend/src/config/env.validation.ts`, unit-tested): `DATABASE_URL`, `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ chars, different), `ENCRYPTION_KEY` (32 bytes base64), `REDIS_URL`, `CORS_ORIGINS` (explicit origins, no `*`), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` while online payment is on. Refused in production: `DATABASE_SSL=disable`, `QUEUE_DRIVER=inline`, `MOCK_CHANNEL_ENABLED`, `QUEUE_BACKOFF_OVERRIDE_MS`, `WEBHOOK_ALLOW_PRIVATE_TARGETS`, and `BOOKING_ENGINE_REQUIRE_PAYMENT=false` unless `ALLOW_PAY_AT_PROPERTY=true` (otherwise public bookings would be confirmed without payment). Optional: `DATABASE_SSL` (`require` is the default for remote hosts; use `verify-full` + `DATABASE_CA_CERT` in production), `DATABASE_POOL_MAX`, `SMTP_URL` + `SMTP_FROM`, `LOG_FORMAT`, `LOG_LEVEL`, `QUEUE_PREFIX`, `API_KEY_RATE_LIMIT`, `API_KEY_RATE_TTL_MS`, `WEBHOOK_TIMEOUT_MS`. Full list with explanations: `backend/.env.example` (placeholders only; the real `backend/.env` is git-ignored and must never be committed).

### Frontend
| Variable | When | Visible to browsers | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | **build** argument | yes | API origin used by the browser. Required, must be `https` (an origin: no path). |
| `NEXT_PUBLIC_APP_URL` | build argument | yes | canonical site URL |
| `API_INTERNAL_URL` | runtime | no | private API address for server-side rendering (compose: `http://api:3000`) |
| `ALLOW_INSECURE_API_URL` | runtime | no | `true` only to run a production build against an `http` API locally |
| `NEXT_PUBLIC_DEMO_MODE` | build | yes | development only; a production build **and** startup fail if `true` |

Startup validation (`lib/config.ts`, `instrumentation.ts`) exits with code 1 and a JSON `fatal` line when: the API URL is missing/invalid/not https (without the explicit override) or has a path; demo mode is on; `API_INTERNAL_URL` is invalid; a `NEXT_PUBLIC_*` variable has a secret-looking name (`SECRET`, `PASSWORD`, `TOKEN`, `JWT`, `API_KEY`...). The browser-facing API URL is checked against the value compiled into the bundle. Mock data cannot be enabled in production: there is no code path that returns mock API data (guarded by tests), and demo mode only pre-fills an e-mail field.

**Build vs runtime secrets.** Image layers contain only the public build arguments. No JWT/Razorpay/database value is a build argument or `ENV` anywhere; compose passes the backend its secrets from `.env` at runtime only. The `.dockerignore` files exclude `.env*`.

## 3. Build and run

```bash
cp backend/.env.example backend/.env       # fill in the backend secrets (compose reads backend/.env at runtime)
docker compose up --build                  # frontend :3001, api :3000, worker, redis; `migrate` runs first
# fully local database instead of Supabase: docker compose --profile local-db up --build (see the header of docker-compose.yml)
# migrations on their own (idempotent): docker compose run --rm migrate

# images on their own
docker build -t tirvona-api ./backend
docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t tirvona-frontend ./frontend
```
Compose reads `PUBLIC_API_URL` / `PUBLIC_APP_URL` for the frontend build arguments (default `http://localhost:3000` / `:3001`; for such an `http` local run set `ALLOW_INSECURE_API_URL=true`). The site's origin must be listed in the API's `CORS_ORIGINS`. In production run `migrate` (as a pre-deploy step), `frontend`, `api`, `worker` against Supabase and a managed Redis; do not run the local `postgres` service.

**Graceful shutdown:** both Node images run under tini so `SIGTERM` reaches Node; the API and worker call `enableShutdownHooks()`, and closing waits for the BullMQ job in progress (verified, see OPERATIONS.md). Use a stop grace period of at least 30 s.

## 4. Rollback considerations
* **Frontend:** tag every image with the git SHA; rollback = redeploy the previous tag. The bundle embeds the API URL, so a rollback also restores the previous URL.
* **API / worker:** roll both back together (same image). The app does not migrate on startup; `npm run db:migrate` is a separate pre-deploy step, forward-only and idempotent. Write migrations so the **previous** release still works against the new schema (add columns/tables first, remove things in a later release), so an application rollback does not need a database rollback. Do **not** roll the database back to undo an application release; restoring PostgreSQL loses bookings and payments made since (see the recovery checklist).
* A release with a migration: take an on-demand backup first (and make sure the migration runs on the direct or session-pooler connection, not the transaction pooler).
* Queue payloads carry ids only, so old and new workers can drain each other's jobs; drain or pause queues for a release that changes a payload shape.
* Keep the previous image until the new one has run through a full booking + payment in the target environment.

## 5. CI (`.github/workflows/ci.yml`)
Independent jobs (none `needs` another, so one failure never hides the rest); `permissions: contents: read`; no secrets are read or needed; lockfiles + `npm ci`; concurrency cancels superseded runs; Node 22.

| Job | Runs |
| --- | --- |
| `secrets` | `backend/scripts/check-secrets.cjs` (scans the whole repository) |
| `backend` | in `backend/`: `npm ci`, typecheck, `npm test` (inline queue, own throw-away PostgreSQL 17), `npm run db:verify`, `npm run drill:restore`, `npm run build`, `npm run openapi:check` (the public `/v1` contract equals `docs/openapi-v1.json`) |
| `sdk` | in `sdk/`: `npm ci`, typecheck, tests, build |
| `backend-bullmq` | installs Redis from apt, `npm run test:bullmq` (the runner starts its own throw-away Redis) |
| `frontend` | `npm ci`, typecheck, lint, unit/component tests, production build |
| `e2e` | builds both, installs Chromium, Playwright against the sandbox API + standalone frontend |
| `docker` | builds both images, checks the backend refuses an empty production env, the frontend image becomes healthy and refuses an `http` API build, `docker compose config` |

**Status: the workflow file has never run** (the repository has a GitHub remote, but nothing has been pushed with this workflow yet). Its commands were each run locally (section 6), except those needing Docker and `apt`. Actions are referenced by major version tag; pin them to commit SHAs before relying on this for releases.


## 6. Local commands and their recorded results (2026-10-15, this machine, after the MongoDB → PostgreSQL migration)

| Command | Result |
| --- | --- |
| `node backend/scripts/check-secrets.cjs` (whole repository) | no secrets detected |
| `cd backend && npm run typecheck` / `npm run build` | pass |
| `cd backend && npm test` (inline queue, a real throw-away PostgreSQL 17 per test file) | 23 suites, **229 pass**, 10 skipped (BullMQ-only suites) |
| `cd backend && npm run db:verify` (concurrency and integrity checks on PostgreSQL) | **45/45 pass** |
| `cd backend && npm run test:bullmq` (real BullMQ + Redis) | **NOT RUN after the migration: no Redis binary on this machine.** It passed (232 tests) on the MongoDB version, which shares the queue code; CI runs it |
| `cd backend && npm run openapi:check` | contract equals `docs/openapi-v1.json` |
| `cd backend && npm run drill:restore` | 9/9 steps pass (isolated embedded PostgreSQL; 31 tables, logical backup and restore) |
| `cd sdk && npm run typecheck && npm test && npm run build` | pass, 11 tests |
| `cd frontend && npm run typecheck && npm run lint` | pass, 0 errors, 0 warnings |
| `cd frontend && npm test` | 11 files, **222 pass** |
| `cd frontend && npm run build` (production, with CSP) | pass |
| `cd frontend && npm run test:e2e` (real Chrome, sandbox API on embedded PostgreSQL, fake gateway; ports 3100/3101, `NEXT_DIST_DIR=.next-e2e`) | **26 pass** |
| `npm audit --omit=dev` | frontend 0, sdk 0, backend 2 moderate (`js-yaml` via `@nestjs/swagger`; the fix is a breaking major upgrade) |
| `docker build`, `docker compose up`, `docker compose config` | **not run: Docker is not installed on this machine** |
| GitHub Actions workflow | **never run** (paths were updated for `backend/`, `sdk/`; nothing pushed by this work) |

Caveats: the earlier real-Redis runs used an unofficial Redis 5.0.14 port; BullMQ recommends 6.2+, and CI installs a current Redis. `docker-compose.yml` was edited for PostgreSQL (`migrate` one-shot service, optional `postgres` profile) but never validated, because Docker is not installed here. Nothing was run against a real Supabase project.

## 7. Git
The repository (branch `main`, remote `origin`) was created by you; this work never initialised, committed or pushed anything. `backend/.env` is git-ignored and untracked (only `*.env.example` files are tracked). Run `node backend/scripts/check-secrets.cjs` before pushing; `--staged` checks only what is staged.
