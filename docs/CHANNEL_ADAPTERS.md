# Channel and OTA adapter architecture

How Tirvona talks to external channels (OTAs and similar) and how to add one. This is about **outbound sync and inbound
reservations**, not the public API clients use (see [PUBLIC_API.md](PUBLIC_API.md)).

## What is real today, and what is not

| Channel | Status | Meaning |
| --- | --- | --- |
| **Tirvona / DIRECT / API** | Real, built in | They read Tirvona inventory directly; no connection or adapter is needed. |
| **MOCK** | Test/dev only | A fake OTA used by tests and local development (`MOCK_CHANNEL_ENABLED`, refused in production). It is **not** an integration. |
| **Airbnb, Booking.com, Agoda** | **Not connected** | Adapters exist as `PartnerChannelAdapter` stubs. Every call fails with the non-retryable `CHANNEL_INTEGRATION_NOT_AVAILABLE`. These OTAs only grant connectivity APIs to approved partners under their own programmes (Airbnb Software Connectivity Partner, Booking.com Connectivity Partner Programme, Agoda connectivity partner programme). Nothing here uses undocumented or reverse-engineered APIs. |

Do not describe Airbnb, Agoda or Booking.com as connected until an adapter has been written against the partner
documentation **and** verified against that partner's certification/sandbox.

Seed data creates *mock-flagged* connections for the three OTAs so the channel-manager UI has something to show. A
connection with `metadata.mock = true` is skipped by the sync worker (`SKIPPED_MOCK_CONNECTION`), so demos do not produce
sync errors.

## Layers

```
dashboard / reservation changes
        │  (same DB transaction)
        ▼
 sync_jobs  (transactional outbox: date ranges, not values)      webhook_events (inbound inbox)
        │ outbox relay → queue                                          ▲
        ▼                                                               │ verified + deduplicated
 SyncService (worker) ──► ChannelAdapterRegistry ──► ChannelAdapter ◄───┘ POST /webhooks/channels/:channel
                                                        │
                                                        ▼
                                           the OTA's official API
```

* `src/modules/channels/interfaces/channel-adapter.interface.ts`: the contract (connect, import listings/rooms/rates,
  push availability/rates/restrictions, fetch/acknowledge reservations, verify and parse webhooks).
* `src/modules/channels/channel-registry.ts`: the **only** place that maps a channel code to an adapter.
* `src/modules/channels/interfaces/partner-channel.adapter.ts`: base class for partner-only OTAs; fills every method
  with `CHANNEL_INTEGRATION_NOT_AVAILABLE` and `verifyWebhook() → false`.
* `src/database/services/channel-mapping.service.ts` and `schemas/channel.schema.ts`: connections, listings, room and
  rate mappings. Credentials are encrypted at rest (AES-256-GCM).
* `src/modules/sync/sync.service.ts`: pushes *current* master data for the job's date range. Jobs carry ranges, so
  retries, duplicates and reordering are harmless. Failures retry with backoff and finally raise `CHANNEL_SYNC_FAILED`.
* `src/database/services/webhook.service.ts`: inbound events are stored first (unique `(channel, externalEventId)`),
  then processed by a worker; redelivery is a no-op. OTA reservations are created through the same
  `ReservationService.createReservation` used by every other source, so there is one path that can sell a room.

## Adding a real OTA adapter

1. Obtain partner access and the official documentation. Write down which API version and certification steps apply.
2. Add `<channel>/<name>.adapter.ts` implementing `ChannelAdapter` (extend nothing; `isAvailable()` returns true only
   when its configuration is present). Map the OTA's models to the normalized types in the interface file.
3. Verify inbound webhooks with the OTA's documented signature scheme in `verifyWebhook` (constant-time, raw body).
   Derive a stable `externalEventId` when the OTA sends none.
4. Register it in `ChannelAdapterRegistry`. Add config to `configuration.ts`/`env.validation.ts` and `.env.example`.
5. Add an e2e test in the style of `test/channels-sync.e2e-spec.ts`: push, retry on transient failure, permanent failure
   handling, webhook duplicate delivery, cancellation, overbooking handling.
6. Verify in the partner's sandbox, record the evidence, and only then update the table above.

## Test double

`MockChannelAdapter` simulates an OTA, including injectable failures (`MOCK_CHANNEL_FAILURE_RATE`) and signed webhooks.
Use it to test the platform; never present it as a customer-facing integration.

## Requests, approvals and connections are three different things

1. **Integration request** (`POST /integration-requests`, partner): "we want Airbnb for this property". Reviewed by the platform (`/admin/integrations`).
2. **Platform approval**: a record that the partner may proceed. Nothing is connected by it.
3. **Connection**: credentials + mappings stored by the partner under Channel Manager, usable only when an adapter for that channel is *available* and certified.

Until step 3 exists for a channel, the UI must say "not connected". Partners without ACTIVE status cannot file requests.

## Per-channel partner requirements (outside this repository)

| Channel | What Tirvona must obtain first | What each property owner provides | How it is verified |
| --- | --- | --- | --- |
| Airbnb | Acceptance into the Airbnb Software Connectivity Partner programme; API credentials and documentation | Authorizes Tirvona via Airbnb's OAuth for their listing | Airbnb's certification/sandbox checklist |
| Booking.com | Connectivity Partner Programme membership; machine credentials and certification | Grants the connectivity provider access to their hotel ID in the Extranet | Booking.com certification tests |
| Agoda | Agoda connectivity partner onboarding; API key and test environment | Agoda property ID and supplier approval | Agoda's integration test cases |

Until those exist, the adapters stay stubs. Record certification evidence (dates, test run ids) in the PR that enables an adapter.

## Record ownership and conflicts

* Channel-originated reservations are owned by the channel: they cannot be modified or cancelled through the public API (`409 CHANNEL_OWNED_RESERVATION`); staff changes that the channel must know about are pushed as adapter operations, never as silent local edits.
* Inbound events are idempotent on `(channel, externalEventId)`. Reordered or duplicated events converge because handlers act on current state.
* Overbooking: the first writer wins in the single inventory path; the loser is surfaced as a sync error for operations to resolve (Admin → Operations).
* The channel-manager adapter contract (`ChannelAdapter`) is internal and separate from `/v1`; partner software never implements it.

## Configuration-driven providers (new)

A platform with a compatible REST/JSON API no longer needs an adapter class: it is described as data, published by a super admin, and connected by property owners with
their own credentials. iCal calendars and CSV imports are built in. See [CHANNEL_FRAMEWORK.md](CHANNEL_FRAMEWORK.md). The code-adapter contract on this page is still the
right tool for platforms that need partner approval, OAuth consent, XML/SOAP or business rules that can not be written as data. Registration of code adapters is unchanged
(`channel-registry.ts`); `forProperty` / `forConnection` additionally resolve configured providers from the database when `CHANNEL_PROVIDERS_ENABLED` is on.
