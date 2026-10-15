# Tirvona Public API (v1)

A server-to-server API for hotel availability, booking and cancellation, with signed webhooks. It is for external
clients such as the Tirvona marketplace or a hotel's own website back end. It is separate from the dashboard API, which
uses user sessions.

* Interactive reference: `GET /docs/v1` (Swagger UI) and `GET /docs/v1/openapi.json` (the contract, `/v1` only).
  Swagger is on by default outside production (`SWAGGER_ENABLED`).
* TypeScript client and webhook verifier: [`sdk/`](../sdk/README.md).
* Code: `backend/src/modules/public-api/`. Tests: `backend/test/public-api.e2e-spec.ts`,
  `backend/src/modules/public-api/safe-http.spec.ts`, `sdk/test/sdk.test.ts`.

## 1. Concepts

| Term | Meaning |
| --- | --- |
| Organization | The tenant. Every property, reservation, API key and webhook endpoint belongs to one. |
| API key | `tvk_<8 chars>_<43 chars>`. Belongs to one organization, holds scopes, may be limited to some properties, may expire. |
| Property slug | The stable public identifier of a property (`radha-ashram`). |
| Money | Integers in minor units (paise for INR). Never floats. |
| Dates | `YYYY-MM-DD` (property-local calendar dates). Timestamps are ISO 8601 UTC. |

## 2. Authentication and scopes

Create keys in the dashboard: **Settings → Developers → API keys** (organization owners only), or
`POST /api-keys` with a user session. The full key is shown **once**; the server stores only its SHA-256 hash.

```
Authorization: Bearer tvk_ab12cd34_...        (or: X-API-Key: tvk_...)
```

| Scope | Allows |
| --- | --- |
| `properties:read` | `GET /v1/properties`, `GET /v1/properties/{slug}` |
| `availability:read` | `GET /v1/properties/{slug}/availability` |
| `reservations:read` | `GET /v1/reservations`, `GET /v1/reservations/{code}` |
| `reservations:write` | `POST /v1/reservations`, `POST /v1/reservations/{code}/cancel` |

* A key is an **organization** credential. It can only ever see that organization's properties. A resource of
  another tenant is reported as `404`, never `403`, so keys cannot probe for other tenants' data.
* Optionally restrict a key to specific properties (`propertyIds`).
* Revocation (`DELETE /api-keys/{id}`) and expiry take effect on the next request.
* **Keep keys on your server.** Browsers and mobile apps must call your back end, which calls Tirvona. CORS is not
  opened for API keys on purpose.
* Dashboard routes reject API keys (`401`) and `/v1` rejects user sessions (`401 API_KEY_INVALID`).

## 3. Responses and errors

```json
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "ROOM_NOT_AVAILABLE", "message": "…", "details": { } } }
```

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` | Invalid request; `details.fields` lists problems |
| 401 | `API_KEY_MISSING`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED` | Authentication failed |
| 403 | `API_SCOPE_MISSING` | The key lacks the scope the endpoint needs |
| 404 | `NOT_FOUND` | Not found **or** not visible to this key |
| 409 | `ROOM_NOT_AVAILABLE`, `RESTRICTION_VIOLATION`, `INVALID_STATE_TRANSITION` | Business conflict; do not retry unchanged |
| 422 | `IDEMPOTENCY_KEY_REUSED`, `PROMO_INVALID` | Semantically invalid |
| 429 | `RATE_LIMITED` | Slow down; honour `Retry-After` |
| 5xx | `INTERNAL_ERROR`, … | Safe to retry (see idempotency) |

Branch on `error.code`, not on `message`.

## 4. Booking flow

```
GET  /v1/properties/{slug}/availability?checkIn&checkOut&adults   → room types + rate plans with prices
POST /v1/reservations   (Idempotency-Key)                          → PENDING hold + Razorpay order (payment)
        guest pays in their browser with the Razorpay Checkout parameters from `payment`
POST /payments/verify   (public; signature-checked)                → confirms; webhook reservation.confirmed fires
GET  /v1/reservations/{code}                                       → current state
POST /v1/reservations/{code}/cancel                                → releases rooms, queues policy refund
```

* The booking **holds** the rooms atomically for 20 minutes (`holdExpiresAt`). If payment is not captured in time the
  hold is released. A late payment is refunded automatically.
* When the server runs with online payment disabled (`BOOKING_ENGINE_REQUIRE_PAYMENT=false` plus the explicit
  `ALLOW_PAY_AT_PROPERTY=true` in production) bookings are created `CONFIRMED` and `payment` is `null`.
* `source` is always `API` for these bookings.

### Idempotency

`Idempotency-Key` (8–100 chars of `[A-Za-z0-9_-]`) is **required** on `POST /v1/reservations`.

* Same key + same body → the original booking again (`200`, `created: false`, same payment order). Safe after timeouts.
* Same key + a different stay, guest e-mail or rooms → `422 IDEMPOTENCY_KEY_REUSED`.
* Keys are private per API key. Two clients can use the same string without interfering.
* Concurrent identical requests create exactly one booking.
* Generate a fresh UUID per booking attempt and store it with your order *before* calling.

Cancel is naturally idempotent (`alreadyCancelled: true`).

## 5. Rate limits

Per API key (default 300 requests/minute; `API_KEY_RATE_LIMIT`, `API_KEY_RATE_TTL_MS`). Counters are shared across
API instances through Redis. Every response has `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`;
`429` adds `Retry-After`. If Redis is unreachable the limiter fails open (a documented availability trade-off; see OPERATIONS.md).

## 6. Webhooks

Register endpoints in **Settings → Developers → Webhooks** or with `POST /webhook-endpoints` (owners only).
The signing secret (`whsec_…`) is shown once and stored encrypted (AES-256-GCM, `ENCRYPTION_KEY`).

### Events

| `type` | When | `data` |
| --- | --- | --- |
| `reservation.created` | A reservation is created (any source: direct, API, PMS, OTA) | `reservation` |
| `reservation.confirmed` | A hold is paid, or a booking is created already confirmed | `reservation` |
| `reservation.cancelled` | Cancelled by anyone | `reservation` |
| `payment.succeeded` | Money captured | `reservation`, `payment{amount,currency,totalPaid}` |
| `payment.failed` | Gateway reported a failure | `reservation`, `payment{amount,currency,reason}` |
| `ping` | You pressed **Send test** | `message` |

Subscribe per type (or `*`) and optionally per property. `reservation` has the same shape as `GET /v1/reservations/{code}`.

```json
{
  "id": "evt_6f1c…",
  "type": "reservation.confirmed",
  "apiVersion": "v1",
  "createdAt": "2026-10-15T08:12:44.120Z",
  "data": { "reservation": { "reservationCode": "TRV-7K3M9QXD", "status": "CONFIRMED", "…": "…" } }
}
```

### Request headers

| Header | Value |
| --- | --- |
| `Tirvona-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |
| `Tirvona-Event-Id` | Same as `id`. **Identical on every retry**: deduplicate on it |
| `Tirvona-Event-Type` | Same as `type` |
| `Tirvona-Delivery-Attempt` | 1, 2, 3, … |

### Verify the signature

`signature = HMAC_SHA256(secret, "<t>.<raw request body>")`, hex. Use the **raw bytes**, compare in constant time,
and reject timestamps older than 5 minutes.

```ts
import { constructWebhookEvent } from '@tirvona/sdk';
// Express: use express.raw({ type: 'application/json' }) for this route, NOT express.json().
app.post('/tirvona/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const event = constructWebhookEvent(process.env.TIRVONA_WEBHOOK_SECRET!, req.get('tirvona-signature'), req.body); // throws if invalid
  // …enqueue your own work keyed by event.id, then answer quickly:
  res.sendStatus(200);
});
```

```python
import hmac, hashlib, time
def verify(secret: str, header: str, raw_body: bytes, tolerance=300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts["t"])
    if abs(time.time() - t) > tolerance: return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

### Delivery guarantees

* **At least once.** Deduplicate on `Tirvona-Event-Id`. Events are recorded in the same database transaction as the
  change that caused them, so a committed change always has its event and a rolled-back one never does.
* A `2xx` within 10 s is success. Anything else (non-2xx, timeout, DNS/TLS error) is retried with exponential backoff
  (30 s, 1 m, 2 m, … ) for **12 attempts over about 17 hours**, with the same event id and body. Then the delivery is
  `FAILED`, an error is logged (`event=client_webhook_failed`), and you can **Redeliver** it from the dashboard
  (`POST /webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver`).
* Ordering is not guaranteed. Use `createdAt` and the reservation `status` to reconcile, or fetch the current state
  with `GET /v1/reservations/{code}`.
* Redirects are not followed. In production the URL must be `https`, must not contain credentials, and must not
  resolve to a loopback, private, link-local or cloud-metadata address (checked again at connect time, so DNS
  re-pointing cannot bypass it). `WEBHOOK_ALLOW_PRIVATE_TARGETS` exists for local development only and is refused in production.
* **Rotate** the secret with `POST /webhook-endpoints/{id}/rotate-secret`; the old secret stops working at once.
* Delivery history is kept 30 days.

## 7. Versioning and compatibility

* The major version is in the path (`/v1`) and in every response (`X-Tirvona-Api-Version: v1`); webhook bodies carry `apiVersion`.
* **Within v1 we only make backward-compatible changes**: new endpoints, optional request fields, new response
  fields, new enum values, new event types, new error codes. **Clients must ignore unknown fields** and tolerate new
  enum values and event types (answer `2xx` for events you do not handle).
* **Breaking changes** (removing or renaming a field, changing a type or meaning, tightening validation of previously
  accepted input) ship only as `/v2`. v1 keeps working for **at least 12 months after v2 is announced**, announced by
  e-mail to organization owners and a `Deprecation`/`Sunset` header on v1 responses.
* The OpenAPI document at `/docs/v1/openapi.json` is the contract. It is regenerated from the code, and a CI step
  (`npm run openapi:export` then `git diff --exit-code docs/openapi-v1.json`) makes an unintended contract change visible in review.

## 8. Quick start

```bash
curl -s https://api.example.com/v1/properties -H "Authorization: Bearer $TIRVONA_KEY"

curl -s -X POST https://api.example.com/v1/reservations \
  -H "Authorization: Bearer $TIRVONA_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"propertySlug":"radha-ashram","checkIn":"2026-11-05","checkOut":"2026-11-07","adults":2,
       "rooms":[{"roomTypeId":"…","ratePlanId":"…","quantity":1}],
       "guest":{"firstName":"Asha","lastName":"Rao","email":"asha@example.com","phone":"+919811111111"}}'
```

```ts
import { TirvonaClient } from '@tirvona/sdk';
const tirvona = new TirvonaClient({ apiKey: process.env.TIRVONA_KEY!, baseUrl: 'https://api.example.com' });
const [room] = await tirvona.searchAvailability('radha-ashram', { checkIn: '2026-11-05', checkOut: '2026-11-07', adults: 2 });
const { reservation, payment } = await tirvona.createReservation(
  { propertySlug: 'radha-ashram', checkIn: '2026-11-05', checkOut: '2026-11-07', adults: 2,
    rooms: [{ roomTypeId: room.roomTypeId, ratePlanId: room.ratePlans[0].ratePlanId, quantity: 1 }],
    guest: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+919811111111' } },
  { idempotencyKey: myOrderId },
);
```

## 9. What is deliberately not here

* No payment-provider abstraction exposed to clients: payment is Razorpay Checkout in the guest's browser, confirmed
  through `POST /payments/verify` or Razorpay's own webhook.
* No OTA (Airbnb, Booking.com, Agoda) integration is claimed. See [CHANNEL_ADAPTERS.md](CHANNEL_ADAPTERS.md).
* No browser/CORS access with API keys, no key-per-user model, no GraphQL.
