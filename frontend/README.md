# Tirvona frontend

Next.js app for the Tirvona PMS dashboard (`/dashboard/*`) and the public booking engine (`/stays/[slug]`, `/booking/*`).
It talks to the NestJS API in the repository root. It contains no business data of its own: when the API fails, the UI shows an error. It never substitutes sample data.

## Run it

```bash
# 1. a backend (pick one)
npm run sandbox                    # from the repo root: throw-away local PostgreSQL + seeded demo property (needs `npm run build` once)
#    owner login: owner@tirvona.demo / SandboxPass-123   (override with SEED_OWNER_PASSWORD)
#    or run the API against your own PostgreSQL / Supabase (see the root README)

# 2. the frontend
cp .env.example .env.local         # NEXT_PUBLIC_API_URL must point at the API
npm install
npm run dev                        # http://localhost:3001 (development server)
# production-mode run: NEXT_PUBLIC_API_URL=http://localhost:3000 npm run build && ALLOW_INSECURE_API_URL=true npm start
```

The API must allow the site's origin: `CORS_ORIGINS=http://localhost:3001` in the backend `.env`.

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | API base URL (public) |
| `NEXT_PUBLIC_APP_URL` | canonical site URL (public) |
| `NEXT_PUBLIC_DEMO_MODE` | development only. `true` pre-fills the seeded owner e-mail on the login form; it never authenticates anyone or fakes data. **A production build/start fails if it is `true`** (`next.config.ts`, `lib/config.ts`). |

`NEXT_PUBLIC_*` values are compiled into browser JavaScript. Never put secrets in them.

## Checks

```bash
npm run typecheck      # tsc --noEmit
npm run lint
npm test               # unit + component tests (vitest, jsdom): API client, auth, no-fallback guards, UI states, checkout
npm run test:live      # real pages + API modules against a RUNNING backend (e.g. `npm run sandbox`)
npm run build
```

`test:live` reads `LIVE_API_URL` (default `http://localhost:3000`), `LIVE_OWNER_EMAIL` and `LIVE_OWNER_PASSWORD`. It writes to the sandbox database only.

## Code map

| Path | What |
| --- | --- |
| `lib/api/client.ts` | the one HTTP client: envelope unwrapping, `ApiError`, single-flight 401 refresh |
| `lib/api/*.ts` | one module per backend area. They return typed data or throw `ApiError`. They never catch-and-fabricate. |
| `lib/api/mappers.ts` | backend DTO to UI view-model translation (pure functions) |
| `lib/auth/*` | session and active-property context (a property is never invented) |
| `components/ui/query-state.tsx` | loading / error / empty / data rendering with retry |
| `lib/utils/errors.ts` | maps `ApiError` to user-safe messages and kinds (auth, permission, validation, server...) |
| `lib/payments/razorpay-checkout.ts` | official Razorpay Checkout loader (public key + server-created order only) |
| `lib/fixtures/demo-data.ts` | unused legacy sample data, excluded from typecheck/lint; a test fails if anything imports it |

See `../docs/FRONTEND_INTEGRATION.md` for the screen-to-endpoint map and the audit results.
