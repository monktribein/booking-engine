# @tirvona/sdk

TypeScript client and webhook verification for the [Tirvona public API (v1)](../docs/PUBLIC_API.md). Zero runtime
dependencies; Node 18+ (global `fetch`). **Server-side only**: an API key is a secret.

```ts
import { TirvonaClient, TirvonaError } from '@tirvona/sdk';

const tirvona = new TirvonaClient({ apiKey: process.env.TIRVONA_KEY!, baseUrl: 'https://api.example.com' });

const rooms = await tirvona.searchAvailability('radha-ashram', { checkIn: '2026-11-05', checkOut: '2026-11-07', adults: 2 });

try {
  const { reservation, payment, created } = await tirvona.createReservation(
    {
      propertySlug: 'radha-ashram', checkIn: '2026-11-05', checkOut: '2026-11-07', adults: 2,
      rooms: [{ roomTypeId: rooms[0].roomTypeId, ratePlanId: rooms[0].ratePlans[0].ratePlanId, quantity: 1 }],
      guest: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+919811111111' },
    },
    { idempotencyKey: myOrderId }, // store it with your order BEFORE calling; omit to let the SDK generate one
  );
  // payment = Razorpay Checkout parameters: open Checkout in the guest's browser, then POST /payments/verify
} catch (e) {
  if (e instanceof TirvonaError && e.code === 'ROOM_NOT_AVAILABLE') { /* offer other dates */ }
  else throw e;
}
```

* Methods: `listProperties`, `getProperty`, `searchAvailability`, `createReservation`, `getReservation`, `listReservations`, `cancelReservation`.
* Errors are `TirvonaError` with `status`, `code` (machine-readable), `details`, `retryAfter`. Transport failures have `status 0`, `code NETWORK_ERROR`.
* Retries (default 2) with backoff on network errors, `429` (honours `Retry-After`) and `5xx`, for `GET`, cancel, and reservation creation (always sent with an `Idempotency-Key`, so a retry can never book twice).

## Webhooks

```ts
import express from 'express';
import { constructWebhookEvent, WebhookSignatureError } from '@tirvona/sdk';

app.post('/tirvona/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = constructWebhookEvent(process.env.TIRVONA_WEBHOOK_SECRET!, req.get('tirvona-signature'), req.body);
    // Deduplicate on event.id (delivery is at-least-once), then do your work and answer fast.
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return res.sendStatus(400);
    throw e;
  }
});
```

Pass the **raw** body (`express.raw`), not re-serialized JSON. Signatures older than 5 minutes are rejected (`toleranceSeconds`).

## Develop

```bash
npm install
npm run typecheck && npm test && npm run build
```
