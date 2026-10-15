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
