# Integration guide

For developers connecting partner software to Tirvona. Reference: [PUBLIC_API.md](PUBLIC_API.md), OpenAPI at `docs/openapi-v1.json`
(and `/docs/v1` when `PUBLIC_API_DOCS_ENABLED=true`), SDK in `sdk/` (`@tirvona/sdk`).

## 1. Get credentials

1. The organization must be `ACTIVE` (see [PARTNER_ONBOARDING.md](PARTNER_ONBOARDING.md)).
2. Owner or developer: *Developers* page → **Create API key**. Choose the minimum scopes and, if useful, specific properties and an expiry. The full key is shown once.
3. Base URL: your API host + `/api/v1`-style paths as in the OpenAPI document (`/v1/...`). Auth: `Authorization: Bearer tvk_…`.
4. Use separate keys per environment and per system. Rotate with a grace period; revoke on leak.

## 2. First calls

```ts
import { TirvonaClient } from '@tirvona/sdk';
const tirvona = new TirvonaClient({ apiKey: process.env.TIRVONA_API_KEY!, baseUrl: process.env.TIRVONA_URL! });
const avail = await tirvona.searchAvailability('my-property', { checkIn: '2026-12-01', checkOut: '2026-12-03', adults: 2 });
const booking = await tirvona.createReservation({ /* … */ externalReference: 'MYPMS-10442' }, { idempotencyKey: 'MYPMS-10442' });
```

`curl -H "Authorization: Bearer $KEY" "$URL/v1/properties"` is the smallest smoke test.

## 3. Idempotency

* `POST /v1/reservations` requires an `Idempotency-Key` (the SDK sets one if you do not). Retrying with the same key and body returns the original booking and never creates a second one, including under concurrency.
* `externalReference` (your own id) is stored on the booking, is unique per organization and can be used to look it up: `GET /v1/reservations?externalReference=…`.
* Webhooks carry a stable event `id`; deduplicate on it. Deliveries are at-least-once.

## 4. Who owns a record (conflict rules)

| Origin (`source`) | Owner | Who may change/cancel it |
| --- | --- | --- |
| `DIRECT`, `TIRVONA` (guest on the public site / marketplace) | Tirvona + property | Staff in the dashboard, the guest (cancel), the API key of the same organization |
| `API` | The partner software that created it | That organization's keys and staff |
| `WALK_IN` / `PHONE` / `AGENT` / `OTHER` (entered by staff) | Property staff | Staff, keys with `reservations:write` |
| `AIRBNB`, `BOOKING_COM`, `AGODA` | The channel | Only the channel; Tirvona records and reconciles. API/staff changes → `409 CHANNEL_OWNED_RESERVATION` |

Reconciliation: your system of record should key on `reservationCode` and store `externalReference`; poll `GET /v1/reservations?checkInFrom=…&checkInTo=…` (or by `externalReference`) as a safety net and treat `reservation.*` webhooks as the fast path. On a mismatch, Tirvona's status is authoritative for availability; refresh your copy rather than pushing your version over it. Inventory is shared: a booking from any source decrements it atomically, so a concurrent overbooking returns `409 ROOM_NOT_AVAILABLE` for one of the two.

## 5. Webhooks

Events: `reservation.created|confirmed|cancelled|updated`, `payment.succeeded|failed`, `inventory.updated`, `ping`.
Verify `Tirvona-Signature` with `verifyWebhook` from the SDK (constant-time, timestamp tolerance). Respond `2xx` within 10 s; failures are retried with backoff and visible in *Developers → Webhooks → Delivery history*. Guest details are omitted unless the endpoint has *Include guest details* enabled.

## 6. Testing guide

1. Create a key on a **non-production** organization and property (the sandbox: `npm run sandbox` in `backend/`).
2. Use *Send test* on your webhook endpoint and confirm signature verification.
3. Checklist before going live: a repeated `POST` with the same `Idempotency-Key` returns the same code; a revoked key gets `401`; a key for org A gets `404` for org B's property; retry/429 handling honours `Retry-After`; your webhook handler is idempotent on `id`; unknown fields/events are ignored.
4. The repository's own suites that encode these guarantees: `backend/test/partner-api.e2e-spec.ts`, `tenant-isolation.e2e-spec.ts`, `sdk/test/sdk.test.ts`.

## 7. Errors and limits

Error body: `{ "success": false, "error": { "code", "message", "details?" } }`. Common codes: `API_KEY_INVALID`, `API_KEY_SCOPE_DENIED`, `ORGANIZATION_NOT_APPROVED`, `ROOM_NOT_AVAILABLE`, `CHANNEL_OWNED_RESERVATION`, `VALIDATION_ERROR`, `RATE_LIMITED` (429 + `Retry-After`).

## 8. Channel managers are a different contract

Partner software uses this public API. Channel managers/OTAs are reached by *adapters* inside Tirvona ([CHANNEL_ADAPTERS.md](CHANNEL_ADAPTERS.md)); do not try to emulate an OTA through `/v1`.
