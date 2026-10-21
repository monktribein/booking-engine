# Frontend–backend integration audit

Scope: verify that every frontend screen works with the real NestJS API, remove mock fallbacks and fake authentication, make states honest, and make the public booking + Razorpay journey reliable. Results below come from commands that were actually run (see "Verification").

## 1. What was wrong

The UI looked finished but mostly did not talk to the backend.

| Finding | Detail |
| --- | --- |
| Silent mock fallbacks | 64 `catch` blocks in `frontend/lib/api/*.ts`: 61 returned fabricated `MOCK_*` data or invented success (fake reservations, fake payments, fake channel connections, fake tokens), 1 was a legitimate best-effort logout catch, 2 were error translation in the client. |
| Fake authentication | `login` accepted any e-mail containing "demo" or "admin" when the API failed and minted a token. `register` invented a session for any input. `me()` returned a mock user. `AuthProvider` injected `demo_token` and `MOCK_USER` on `/dashboard`. The login page offered "Sign in as Owner" buttons with a password (`password123`) the seed never used. |
| Pages never calling the API | 15 files imported `MOCK_*` directly (dashboard, reservations, rooms, inventory, rates, guests, payments, channels x3, calendar, three modals) and rendered it. Reports, settings staff list and the "channel markup" table were hard-coded numbers. |
| Hard-coded ids | 12 places used `prop_radha_ashram`, which is not a valid id for the real database: every mutation would have failed. |
| Wrong contract | Reservation, availability, calendar, report, channel, promotion and rate-plan shapes differed from the API (`code` vs `reservationCode`, `rooms` vs `reservationRooms`, `occupancyPercent` vs `occupancyPct`, `isActive` vs `status`, flat vs `rooms[]` public booking body, ...). Unsupported query params (`roomTypeId`, `search`, `channel`) are rejected by the API's whitelist. |
| Refresh-token race | Concurrent 401s each sent their own `/auth/refresh`. Refresh tokens rotate and are single-use, so the second use would revoke the whole session family. |
| Public booking | The page hard-coded dates, prices, tax (5%), policies, phone, postal code and "Starting from" price; it never opened Razorpay Checkout; the confirmation page printed "Booking Confirmed" from URL parameters. |
| Broken recovery | The reset e-mail links to `/reset-password?token=...`; no such page existed. |

## 2. Mock fallback inventory and resolution

| Group | Count | Class | Resolution |
| --- | --- | --- | --- |
| `lib/api/{properties,room-types,rooms,guests,inventory,rates,reports,channels,payments,reservations,booking-engine}.ts` catch blocks returning data | 57 | Unsafe production API fallback | Removed. Methods return typed data or throw `ApiError` (status, code, message, details preserved). |
| `lib/api/auth.ts` login/register/me/forgot fallbacks | 4 | Unsafe: fake authentication | Removed. No token or user is ever produced client-side. |
| `lib/api/auth.ts` logout catch | 1 | Legitimate | Kept: server revocation is best effort, local state is always cleared. |
| `lib/api/client.ts` | 2 | Error transformation | Kept and rewritten (network error -> `ApiError('NETWORK_ERROR', status 0)`). |
| `MOCK_*` imports in pages/components/contexts | 17 files | Unsafe | Replaced by React Query calls with loading / error / empty states. |
| `lib/api/mock-data.ts` | 780 lines | Demo fixture | Moved to `lib/fixtures/demo-data.ts`, excluded from typecheck/lint, imported by nothing. `tests/no-fallbacks.test.ts` fails if anything imports it. The real demo data is the backend seed (`npm run db:seed`). |
| Fake UI behaviour (`alert('Exporting CSV...')`, "Synced to Outbox", "Razorpay Live Checkout Active", invented channel markups, "Demo Owner") | ~10 | Unsafe | Removed. |

Guards: `tests/no-fallbacks.test.ts` (106 tests) scans the source for `MOCK_*`, fixture imports, fake tokens, hard-coded property ids and catch-and-return blocks in `lib/api`, and calls every API method with the backend returning HTTP 500 and with the network down, expecting an `ApiError`. A mutation check (re-adding a fallback to `guestsApi.get`) was caught by 3 of those tests.

## 3. Authentication behaviour

| | Before | After |
| --- | --- | --- |
| Backend down at login | demo-looking e-mail signs in with fake token | `ApiError NETWORK_ERROR`, no session |
| Wrong password | error (but demo e-mails still got in) | backend 401 message shown, no session, e-mail kept, password cleared |
| Register on any failure | fake session | rejected, no session |
| `/auth/me` fails | mock user | error; 401/403 clears tokens; other errors show "could not verify your session" without destroying the login |
| Concurrent 401s | N refresh calls | exactly one shared refresh, each request replayed once (a 401 is raised by the auth guard before any handler runs, so replaying POST/PATCH/DELETE cannot double-apply) |
| Refresh refused | request retried / user stuck | tokens cleared, `tirvona:session-expired` event, query cache cleared, redirect to `/login`; no loop |
| Refresh fails because of a network blip | session destroyed | session kept |
| Reload with expired access token | (`/auth/me` excluded from refresh) signed out | refreshed transparently |
| Logout | cleared only on success path | local state + query cache always cleared |
| Demo mode | implicit, everywhere | `NEXT_PUBLIC_DEMO_MODE=true` only pre-fills the seeded owner e-mail. A production `next build`/`next start` **fails** if it is set (`next.config.ts`), and `isDemoMode()` throws in production at runtime. |

No secrets are used in `NEXT_PUBLIC_*` (`frontend/.env.example` documents this). The dashboard layout renders only for a verified user and redirects to `/login` otherwise.

## 4. Screen to endpoint map

All endpoints below were exercised by `frontend/tests/live/*` against the seeded backend (the log is printed at the end of the live run). "Composed" means the backend has no single endpoint and the client combines existing ones (and fails as a whole if any part fails).

| Screen | Requests | Result |
| --- | --- | --- |
| Login | `POST /auth/login` | pass (wrong password 401, success 200) |
| Register | `POST /auth/register` | pass (weak password -> 400 with `details.fields`); success path covered by unit test (see limitations) |
| Forgot / reset password | `POST /auth/forgot-password`, `POST /auth/reset-password` | pass; reset page added (the e-mailed link target was missing) |
| Session boot | `GET /auth/me`, `POST /auth/refresh` | pass |
| Dashboard | `GET /properties/:id/reports/dashboard?date=` (one server-computed snapshot in the property's time zone), `GET /reservations`, `GET /properties/:id/channels` | pass (backend `test/dashboard.e2e-spec.ts`; browser `e2e/dashboard.spec.ts`) |
| Reports | `GET /properties/:id/reports/revenue`, `.../occupancy` | pass |
| Properties / settings | `GET /properties`, `GET/PATCH /properties/:id`, `GET/POST/DELETE /properties/:id/users` | pass (staff add/remove not exercised live) |
| Settings → Developers (owners only): API keys and webhooks | `GET/POST /api-keys`, `DELETE /api-keys/:id`, `GET/POST /webhook-endpoints`, `PATCH/DELETE /webhook-endpoints/:id`, `POST /webhook-endpoints/:id/{rotate-secret,test}`, `GET /webhook-endpoints/:id/deliveries`, `POST …/deliveries/:id/redeliver` | unit (9 component tests), real browser (Playwright `e2e/developer.spec.ts`: create key → call `/v1` → revoke; endpoint → test event → signature verified → delete) |
| Room types / rooms | `GET/POST /properties/:id/room-types`, `PATCH/DELETE /room-types/:id`, `GET/POST /room-types/:id/rooms`, `POST /rooms/:id/status` | pass |
| Inventory | `GET /properties/:id/inventory`, `PUT /properties/:id/restrictions` | pass |
| Calendar | inventory + rooms + `POST /inventory/block`, `DELETE /inventory/block/:id`, `GET /reservations/:id` | pass |
| Rates / promotions | `GET/POST /properties/:id/rate-plans`, `PATCH/DELETE /rate-plans/:id`, `GET/POST /properties/:id/promotions` | pass (rate-plan create/update not exercised live) |
| Guests | `GET/POST /guests`, `GET /reservations?q=` (history) | pass |
| Reservations | `GET/POST /reservations`, `POST /reservations/:id/{cancel,check-in,check-out,no-show,assign-room}` | pass (check-in/out/no-show not exercised live) |
| Payments | `GET /reservations`, `GET /payments?reservationId`, `POST /payments/create` (CASH/BANK_TRANSFER/OTHER), `POST /payments/:id/refund` | pass (create/list live; refund covered by backend e2e) |
| Channels | `GET /properties/:id/channels`, `POST .../:channel/{connect,disconnect,sync}`, `GET .../listings`, `POST/DELETE .../mappings` | pass with the MOCK channel; Airbnb / Booking.com / Agoda correctly report `CHANNEL_INTEGRATION_NOT_AVAILABLE` |
| Sync errors | `GET /admin/sync-errors`, `POST /admin/sync-jobs/:id/retry` | owner gets 403 and the UI says "Not allowed" (platform-admin endpoint); retry not exercised live |
| Public property + search | `GET /public/properties/:slug`, `GET .../availability` | pass (server-rendered, 404 for unknown slug) |
| Checkout | `GET .../availability` (quote), `POST /public/reservations` (Idempotency-Key), Razorpay Checkout, `POST /payments/verify` | pass up to Checkout; see section 6 |
| Confirmation / lookup | `GET /public/reservations/:code?email=` | pass |
| Guest search `/stays` (destination, dates, guests, price, amenities, sort, pages; the URL holds the search) | `GET /public/properties` | unit (8 component tests), backend e2e (12), real browser (`e2e/search.spec.ts`) |
| Booking lookup + "saved on this device" (opt-in, localStorage, per booking) | `GET /public/reservations/:code?email=` | unit (4), no server-side guest accounts or history exist |

### Backend gaps (no endpoint) and how the UI copes

| Missing | Handling | Smallest compatible backend change if wanted |
| --- | --- | --- |
| `GET /properties/:id/reports/dashboard` | **added 2026-10-19**; replaces the client-side composition | none |
| `GET /properties/:id/rooms` (all rooms) | composed from room types + `/room-types/:id/rooms` | optional list endpoint |
| `GET /properties/:id/payments` | Payments page lists reservations with paid / balance and opens a reservation's payments | list endpoint with pagination |
| Per-guest history and lifetime value | reservation search by first name, filtered to the guest id; "booked value" is computed from what was loaded | `GET /guests/:id/reservations` |
| Confirm a PENDING reservation | not offered; a PENDING booking confirms when payment is captured | none needed |
| Reservation room-type filter, CSV/PDF export, daily revenue series, room-type performance, reservation timeline, property phone/email | removed from the UI instead of faked | add when needed |
| Staff Razorpay payment links | desk payments are CASH / BANK_TRANSFER / OTHER only | needs a Checkout surface for staff |

## 5. UI states (Phase 5)

* `QueryState` renders exactly one of loading skeleton, error (with **Try again** only when retrying can help), empty, or data. An empty successful response and a failed request are never confused (tested).
* `describeError` separates network, auth (links to sign in), permission (no retry), validation (field message), conflict, not-found and server errors. Server error text is never shown for 5xx.
* React Query retries only transient failures (network, 5xx, 429), never 4xx, and never mutations.
* Forms keep their values after a recoverable failure; submit buttons disable while a request is in flight and the handlers also guard with a ref (double-click tested); inputs have labels, tables have `scope`, icon buttons have `aria-label`, errors use `role="alert"`, tab lists use `role="tab"`.
* Pages that need a property show a "no property" or error state instead of a placeholder.
* Update (phase 8): the main flows (sign-in, protected routes, expired sessions, dashboard failure/retry, reservation creation, public booking + payment states) are now also driven in a real Chrome by Playwright (frontend/e2e, 20 tests). Still not verified: visual layout, keyboard order and responsive behaviour; the other dashboard screens are covered in jsdom against the live API, not in a browser.

## 6. Booking and payment journey (Phase 6)

Flow as built: search -> server quote -> guest details -> `POST /public/reservations` creates a **PENDING hold** (rooms reserved atomically, `holdExpiresAt` = now + 20 min) and a Razorpay order -> official Razorpay Checkout opens with the server-created order -> the browser callback sends `razorpay_order_id/payment_id/signature` to `POST /payments/verify` -> the server recomputes the HMAC, captures with a conditional PENDING/AUTHORIZED/FAILED -> PAID transition and confirms the booking -> confirmation page reads the booking from `GET /public/reservations/:code` (never from URL parameters; it polls briefly while PENDING). The webhook performs the same capture, so either path (or both) confirms once.

Server side already did the right thing; 11 regression tests were added (`test/booking-payment-reliability.e2e-spec.ts`), all passing without backend changes:

* browser callback + two webhooks (different event ids) + repeated callbacks racing: one payment, `amountPaid == total`, one confirmation and one receipt notification, inventory sold once
* 3 sequential + 6 parallel repeated callbacks
* forged, tampered and cross-order replayed signatures rejected
* dismissed Checkout: hold and PENDING order unchanged, then expiry frees the rooms
* failed payment then successful retry on the same order
* **late payment after hold expiry**: booking stays cancelled, inventory not re-sold, the money is refunded through the gateway
* last room, 3 simultaneous public bookings: one 201, two 409 `ROOM_NOT_AVAILABLE`, one Razorpay order
* the same Idempotency-Key 5x concurrently: one reservation, one order
* a confirmed booking is untouched by hold expiry
* refund rules (unpaid order not refundable, never above paid, executed via the mocked gateway)

Frontend (11 tests in `tests/checkout.test.tsx`): one hold per submit with an Idempotency-Key (the key is derived from the payload, so a retry reuses it), only the three Razorpay values go to `/payments/verify`, no navigation to confirmation until the server confirms, verification retry does not create a second booking, dismissed window allows "Pay now" on the same order, failure messages, inventory conflict keeps typed details, hold countdown ends in an expired state with no pay button, immediate confirmation when the server does not require payment.

Expiry: enforced server side by the scheduler (`expire-pending-holds`, every 60 s, so a hold can outlive its 20 minutes by up to a minute; late payments are refunded automatically). The scheduler must run (worker process, or the API with `SCHEDULER_ENABLED`).

**Not verified, so payment is NOT declared production ready:** the repository `.env` has placeholder Razorpay secrets (`mock...`) and `BOOKING_ENGINE_REQUIRE_PAYMENT=false`, no real Razorpay test-mode order was created, and no real Checkout was completed in a browser. All gateway interaction was verified against the mocked Razorpay REST layer (real HMAC scheme, test secrets). Before go-live, run one end-to-end payment with real `rzp_test_*` keys, a registered webhook URL and `BOOKING_ENGINE_REQUIRE_PAYMENT=true`.

## 7. Verification (commands run)

| Command | Result |
| --- | --- |
| `npm run typecheck` (backend) | pass |
| `npm test` (backend, baseline before changes) | 12 suites, 93 tests pass |
| `npm test` (backend, after) | 13 suites, **104 tests pass** (+11) |
| `frontend: npx tsc --noEmit` | pass |
| `frontend: npx eslint app components lib tests` | 0 errors; 7 warnings (unused imports in the untouched landing page `app/page.tsx`) |
| `frontend: npx vitest run` | 6 files, **175 tests pass** |
| `npm run sandbox` + `frontend: npx vitest run --config vitest.live.config.ts` | 2 files, **47 tests pass** against the seeded backend: real `lib/api` modules and the real page components |
| `frontend: npx next build` | pass, 21 pages incl. `/reset-password` |
| `NEXT_PUBLIC_DEMO_MODE=true npx next build` | **fails** with the production demo error (intended) |
| `next start` smoke | `/login`, `/register`, `/forgot-password`, `/booking/lookup`, `/dashboard`, `/stays/radha-ashram` 200; `/stays/no-such-hotel` 404; `/stays/radha-ashram` HTML contains the backend property |
| CORS | preflight from `http://localhost:3001` allowed (Authorization, Content-Type, Idempotency-Key); an unlisted origin gets no `Access-Control-Allow-Origin` |

Bugs found by running things (not by reading): `/auth/me` was excluded from token refresh; `propertiesApi.list` lacked `totalPages`; the register password `pattern` lost a backslash and rejected valid passwords; double submit on login after success; reset-password page missing.

## 8. Remaining risks and blockers

1. **Your `.env` was written for MongoDB.** The backend now uses PostgreSQL: set `DATABASE_URL` (Supabase connection string, see `backend/.env.example`) and run `npm run db:migrate`. The audit never touched your `.env` or any real database; it used `npm run sandbox` (throw-away local PostgreSQL + seed).
2. Refresh token is stored in `localStorage` (the backend also sets an httpOnly cookie that the frontend does not use). XSS would expose it. Safer: use the cookie with `credentials: 'include'` and CSRF protection, a backend/frontend decision, deliberately not changed here.
3. Real-browser coverage is limited to the flows in frontend/e2e (see docs/PRODUCTION_AUDIT.md); payment readiness is unproven (section 6).
4. Airbnb / Booking.com / Agoda stay unavailable until partner access exists (the UI says so).
5. Successful register, check-in/out/no-show, rate-plan create/update, staff add/remove, refunds and sync-job retry through the **UI layer** are covered by unit tests or backend e2e, not by the live suite.
6. The landing page (`app/page.tsx`) still links to `/stays/radha-ashram`, a seed slug.
