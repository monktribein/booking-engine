# Connecting Tirvona.com

**Status: BLOCKED. Not connected, and not claimed to be.** No document, specification, SDK, environment variable or source file in this repository describes an API
exposed by "Tirvona.com" as an external platform. The repository contains Tirvona's *own* booking engine (this application) and its public `/v1` API and SDK, which
point *into* the engine. I did not invent endpoints.

## What exists today (verified in code)

| Piece | What it is |
| --- | --- |
| `TIRVONA` channel | Internal. Marketplace search and bookings read the engine's inventory directly; there is no remote connection and none is needed. Bookings carry `source = TIRVONA` when a guest books from marketplace search (and the listing is approved). |
| Public `/v1` API + `@tirvona/sdk` | How *another* system reads availability/rates and creates reservations in this engine, with scoped, hashed API keys and signed webhooks. |
| Configuration-driven providers | How this engine talks to *another* system that has its own API. |

## Which of the three is Tirvona.com?

Decide this first; the answer changes the work:

1. **A website/app that sells through this engine** (guest-facing front end). Then it is a *client* of `/v1`: nothing to configure here. Create an API key (Developers page), give it the minimum scopes
   (`properties:read availability:read reservations:write …`), and use the SDK from its **server**. Direct bookings and the internal `TIRVONA` channel already work. See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md).
2. **A separate platform with its own API and its own inventory** that this engine should push to / pull from. Then it is a *provider*: write a provider definition from that API's documentation.
3. **Neither / no API yet.** Then the integration contract below must be agreed first.

## What is needed to connect it as a provider (case 2)

Provide, from the platform's own documentation:

* base URLs (production and sandbox) and the hosts they use;
* authentication scheme and how a customer gets credentials;
* endpoints and payloads for: health/ping, list properties, list room types, list rate plans, read reservations (with a "changed since" filter), read one reservation, set availability, set rates, restrictions, acknowledge a reservation;
* pagination, rate limits, idempotency support, error format;
* whether it sends webhooks, how they are signed, retry behaviour and event types;
* money units and currencies, date formats, reservation status vocabulary, who collects payment;
* a sandbox and test credentials, and any certification steps.

### Capability matrix (to be filled in from the documentation only)

| Capability | Documented? | Endpoint | Notes |
| --- | --- | --- | --- |
| healthCheck | ? | ? | required |
| listings | ? | ? | |
| roomTypes | ? | ? | |
| ratePlans | ? | ? | |
| pullReservations (incremental) | ? | ? | |
| getReservation | ? | ? | |
| pushAvailability | ? | ? | |
| pushRates | ? | ? | |
| pushRestrictions | ? | ? | |
| ackReservation | ? | ? | |
| webhooks (signed) | ? | ? | |

Every `?` stays `false` in the definition until it is answered.

## Steps once the contract exists

1. Write `TIRVONA_COM` (or the agreed code) as a provider definition, following [CHANNEL_FRAMEWORK.md](CHANNEL_FRAMEWORK.md). Do not add special cases to the engine; if something can not be expressed as data, say what, and a small reviewed code adapter is the next step.
2. Admin → Providers → save → **Test** against the sandbox → review the dry-run → **Publish**.
3. Run the conformance scenarios in `test/generic-rest-conformance.e2e-spec.ts` against a local fake of the documented API, and the end-to-end flow in `test/provider-framework.e2e-spec.ts`.
4. Connect one real property in the sandbox, map it, push availability, receive one reservation, reconcile.
5. Only then mark it connected in the status table of [CHANNEL_FRAMEWORK.md](CHANNEL_FRAMEWORK.md) and record the evidence (date, environment, test run).

Until then: the framework is proven against a local fake provider that speaks real HTTP; **no connection to Tirvona.com has been made or tested.**
