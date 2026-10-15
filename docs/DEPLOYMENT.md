# Deployment, CI and local commands

Nothing here deploys anything. No DNS, registry, secret store or cloud account was touched.

## 1. Services

| Service | Image | Port | Health | Notes |
| --- | --- | --- | --- | --- |
| `frontend` | `frontend/Dockerfile` (Next.js 16 standalone, non-root `node`, tini) | 3000 in the container (compose: 3001) | `GET /api/health` (HEALTHCHECK) | no secrets, ever |
| `api` | root `Dockerfile` (NestJS, non-root, tini) | 3000 | `GET /health` (HEALTHCHECK) | `WORKERS_ENABLED=false` in compose: produces jobs only |
| `worker` | same image, `node dist/src/worker.js` | none | process exit on failure | consumes all queues + scheduler (hold expiry runs here) |
| `redis` | `redis:7-alpine` | 6379 | `redis-cli ping` | `noeviction`, AOF on |
| `mongo` | `mongo:8.0` single-node replica set | 27017 | rs status | local only; use Atlas in production |

## 2. Configuration

### Backend (`.env`, read at runtime, never baked into an image)
Required in production (the process refuses to start otherwise, see `src/config/env.validation.ts`, 13 unit tests): `MONGODB_URI`, `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ chars, different), `ENCRYPTION_KEY` (32 bytes base64), `REDIS_URL`, `CORS_ORIGINS` (explicit origins, no `*`), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` while online payment is on. Refused in production: `QUEUE_DRIVER=inline`, `MOCK_CHANNEL_ENABLED`, `QUEUE_BACKOFF_OVERRIDE_MS`, and `BOOKING_ENGINE_REQUIRE_PAYMENT=false` unless `ALLOW_PAY_AT_PROPERTY=true` (otherwise public bookings would be confirmed without payment). Optional: `SMTP_URL` + `SMTP_FROM`, `LOG_FORMAT`, `LOG_LEVEL`, `QUEUE_PREFIX`. Full list: `.env.example`.

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
cp .env.example .env                       # fill in the backend secrets
docker compose up --build                  # frontend :3001, api :3000, worker, redis, mongo
docker compose run --rm api node dist/scripts/setup-db.js   # indexes + validators (idempotent)

# images on their own
docker build -t tirvona-api .
docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t tirvona-frontend ./frontend
```
Compose reads `PUBLIC_API_URL` / `PUBLIC_APP_URL` for the frontend build arguments (default `http://localhost:3000` / `:3001`; for such an `http` local run set `ALLOW_INSECURE_API_URL=true`). The site's origin must be listed in the API's `CORS_ORIGINS`. In production run `frontend`, `api`, `worker` against Atlas and a managed Redis; drop `mongo`.

**Graceful shutdown:** both Node images run under tini so `SIGTERM` reaches Node; the API and worker call `enableShutdownHooks()`, and closing waits for the BullMQ job in progress (verified, see OPERATIONS.md). Use a stop grace period of at least 30 s.

## 4. Rollback considerations
* **Frontend:** tag every image with the git SHA; rollback = redeploy the previous tag. The bundle embeds the API URL, so a rollback also restores the previous URL.
* **API / worker:** roll both back together (same image). Startup runs no data migration; `setup-db` only adds indexes/validators and is idempotent, so a rollback does not need a database rollback. Do **not** roll the database back to undo an application release; restoring MongoDB loses bookings and payments made since (see the recovery checklist).
* A release that changes a validator or index: take an on-demand Atlas snapshot first.
* Queue payloads carry ids only, so old and new workers can drain each other's jobs; drain or pause queues for a release that changes a payload shape.
* Keep the previous image until the new one has run through a full booking + payment in the target environment.

## 5. CI (`.github/workflows/ci.yml`)
Independent jobs (none `needs` another, so one failure never hides the rest); `permissions: contents: read`; no secrets are read or needed; lockfiles + `npm ci`; concurrency cancels superseded runs; Node 22.

| Job | Runs |
| --- | --- |
| `secrets` | `scripts/check-secrets.cjs` |
| `backend` | `npm ci`, typecheck, `npm test` (inline queue, own MongoDB), `npm run build` |
| `backend-bullmq` | installs Redis from apt, `npm run test:bullmq` (the runner starts its own throw-away Redis) |
| `frontend` | `npm ci`, typecheck, lint, unit/component tests, production build |
| `e2e` | builds both, installs Chromium, Playwright against the sandbox API + standalone frontend |
| `docker` | builds both images, checks the backend refuses an empty production env, the frontend image becomes healthy and refuses an `http` API build, `docker compose config` |

**Status: the workflow file has never run** (the project is not in Git and nothing was pushed). Its commands were each run locally (section 6), except those needing Docker and `apt`. Actions are referenced by major version tag; pin them to commit SHAs before relying on this for releases.

## 6. Local commands (and their recorded results)

| Command | Result (this machine, 2026-10-14) |
| --- | --- |
| `node scripts/check-secrets.cjs` | no secrets detected |
| `npm run typecheck` / `npm run build` | pass |
| `npm test` | 17 suites, 139 pass, 10 skipped (BullMQ-only) |
| `npm run test:bullmq` | 20 suites, 149 pass |
| `npm run drill:restore` | 8/8 steps pass |
| `cd frontend && npm run typecheck && npm run lint` | pass; 0 errors, 7 warnings (unused imports in the landing page) |
| `cd frontend && npm test` | 7 files, 196 pass |
| `cd frontend && npm run build` | pass |
| `cd frontend && npm run test:e2e` (real Chrome, sandbox API, fake gateway) | 20 pass, run 3 times on cold start, no flakes |
| `npm run frontend:test:live` against `npm run sandbox` | 47 pass |
| standalone server (what the image runs): start, `/api/health`, `/login`, SSR from the API, security headers, refusal exit code 1 on unsafe config | pass |
| `docker build`, `docker compose up`, `docker compose config` | **not run: Docker is not installed on this machine** |

## 7. Git
The project directory is **not a Git repository** (no `.git`, no remote). Proposed initialisation, to be done by you: `git init -b main`, then `node scripts/check-secrets.cjs`, review `git status` (the root `.gitignore` excludes `.env*` except `*.example`, keys/certificates, `node_modules`, `dist`, `.next`, `test-results`, `playwright-report`), then `git add` and the first commit. `scripts/check-secrets.cjs --staged` can be used as a pre-commit check. Nothing was initialised, committed or pushed.
