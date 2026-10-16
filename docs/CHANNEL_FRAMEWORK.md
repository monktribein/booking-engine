# Configuration-driven channel framework

How Tirvona connects to outside systems **without a new TypeScript class per platform**. A compatible REST/JSON API is connected by
writing a *provider definition* (data), publishing it, and letting property owners connect with their own credentials. Calendar feeds
(iCal) and spreadsheet imports (CSV) are built in. Platforms that need partner approval or a different protocol still use code adapters.

> Read [CHANNEL_ADAPTERS.md](CHANNEL_ADAPTERS.md) for the code-adapter contract (Airbnb, Booking.com, Agoda stubs, the test mock) and for
> what is and is not connected today. Nothing in this document makes an OTA "connected"; that needs the OTA's own partner access.

## 1. What is implemented

| Capability | State | Evidence |
| --- | --- | --- |
| Provider registry in the database (`channel_providers`, immutable `channel_provider_versions`) | Implemented | migration `0003`, `test/provider-migration.e2e-spec.ts`, `test/provider-framework.e2e-spec.ts` |
| Strict definition validation (no scripting, closed vocabulary) | Implemented | `provider-definition.ts`, `provider-definition.spec.ts` (38 tests) |
| Generic REST/JSON adapter (auth, pagination, mapping both ways, batching, retries, rate limit, idempotency header) | Implemented | `generic-rest.adapter.ts`, `test/generic-rest-conformance.e2e-spec.ts` (29 tests, real HTTP) |
| Secure outbound HTTP (host allow-list, connect-time DNS check, no redirects, size/time caps) | Implemented | `secure-http.ts`, `provider-engine.spec.ts` |
| Connection-scoped external ids (two tenants may use identical ids) | Implemented | migration `0003` (`external_scope`), `provider-framework` and `ical` e2e |
| Per-connection webhook address and secret, signature + replay check | Implemented | `POST /webhooks/c/:key`, `provider-framework` e2e |
| Per-connection polling with a persisted cursor | Implemented | `sync.service.ts`, `scheduler.module.ts`, `provider-framework` e2e |
| Reconciliation (runs, issues, safe auto-import, never auto-cancel) | Implemented | `reconciliation.service.ts`, `provider-framework` e2e |
| iCal import (availability blocks) and publishing of Tirvona calendars | Implemented | `ical.ts`, `ical.adapter.ts`, `ical-export.ts`, `test/ical.e2e-spec.ts` |
| CSV booking import (preview, row errors, idempotent re-run) | Implemented | `csv-import.ts`, `test/csv-import.e2e-spec.ts` |
| Admin console for providers (draft, validate, dry-run, publish, roll back) and the partner connection wizard | Implemented | `frontend/components/admin/ProvidersPanel.tsx`, `frontend/components/channels/*`, `frontend/tests/providers.test.tsx` |
| XML / SOAP connectors | **Not implemented** | needs a dedicated adapter and a hardened XML parser |
| OAuth 2.0 authorization-code flows for configured providers | **Not implemented** | a provider that needs one uses a code adapter |
| Airbnb, Booking.com, Agoda | **Not connected** | stubs; need each platform's partner approval |
| Tirvona.com as an external provider | **Blocked** | no API contract available, see [TIRVONA_INTEGRATION.md](TIRVONA_INTEGRATION.md) |

Everything is behind `CHANNEL_PROVIDERS_ENABLED` (default **off**). With the flag off the system behaves exactly as before: only the built-in
adapters exist.

## 2. How it fits together

```
 platform admin                         property owner (tenant)
 ──────────────                         ───────────────────────
 create provider ─► draft version       choose provider from catalogue
 validate  ─► dry-run (read-only)       enter credentials ─► provider's own health call must succeed
 publish (super admin, immutable)       map listings/rooms/rates (same mapping tables as every channel)
        │                                          │
        ▼                                          ▼
 channel_providers ◄── pinned ── channel_connections ── channel_connection_secrets (AES-256-GCM)
        │                                          │
        └──────────────► ChannelAdapterRegistry.forConnection(connection)
                              built-in code adapter │ GenericRestAdapter(definition, secrets) │ IcalAdapter(feeds)
                                                    ▼
           sync engine (queues, retries, logs)  ·  webhook inbox (store → dedupe → worker)  ·  poller  ·  reconciliation
                                                    ▼
                     the one reservation / inventory transaction used by every booking source
```

* The sync engine, inbox, mappings and reservation transaction are **the same code** for built-in and configured providers.
* An adapter instance serves **one connection**. Its credentials and connection id are bound at construction, so one tenant's secret can
  never be used for another tenant's call.
* A booking from a configured provider has `source = <provider code>`; the pair `(source, external_scope = connection id, external id)` is unique.

## 3. Provider definition reference

A definition is a JSON document (at most 64 KB). It can name hosts, paths, headers, field paths and a fixed set of transforms. It can not run code.
Unknown keys anywhere are rejected. The complete working example is `backend/src/modules/channels/providers/example-definition.ts`.

```jsonc
{
  "schemaVersion": 1,
  "protocol": "REST_JSON",
  "environments": { "production": { "baseUrl": "https://api.partner.example/v2" }, "sandbox": { "baseUrl": "https://sandbox.partner.example/v2" } },
  "allowedHosts": ["api.partner.example", "sandbox.partner.example"],   // exact names; no wildcards, IPs, ports
  "auth": { "type": "API_KEY_HEADER", "header": "X-Api-Key" },         // NONE | API_KEY_HEADER | API_KEY_QUERY | BEARER | BASIC
  "signing": { "algorithm": "HMAC_SHA256", "header": "X-Signature", "payload": "TIMESTAMP.BODY", "timestampHeader": "X-Timestamp", "encoding": "hex" },  // optional
  "capabilities": { "listings": true, "pushAvailability": true, "pullReservations": true, "webhooks": true, "polling": true },
  "operations": { /* see below */ },
  "reservationMapping": { /* needed when reservations are pulled or received */ },
  "webhook": { /* needed when capabilities.webhooks */ },
  "rateLimit": { "requestsPerSecond": 10 },
  "retry": { "maxAttempts": 4, "baseDelayMs": 500, "maxDelayMs": 15000, "retryOnStatus": [429, 500, 502, 503, 504] },
  "limits": { "timeoutMs": 10000, "maxRequestBytes": 262144, "maxResponseBytes": 2097152 },
  "defaultPollIntervalSeconds": 300
}
```

### Capabilities and operations

A capability the provider does not have is `false` or absent. Calling an operation without its capability fails with the non-retryable
`CHANNEL_OPERATION_NOT_SUPPORTED`; the sync engine checks first and records the job as *skipped*, never as pushed.

| Capability | Operation | Placeholders available |
| --- | --- | --- |
| *(required)* | `healthCheck` (must be `GET`; it is how a connection is verified) | `environment` |
| `listings` | `listListings` | `cursor page pageSize externalAccountId` |
| `roomTypes` | `listRoomTypes` | `externalListingId` + above |
| `ratePlans` | `listRatePlans` | `externalListingId` + above |
| `pullReservations` | `listReservations` | `since sinceDate cursor page pageSize externalListingId externalAccountId` |
| `getReservation` | `getReservation` | `externalReservationId externalAccountId` |
| `pushAvailability` | `pushAvailability` | `externalListingId externalRoomId from to externalAccountId` |
| `pushRates` | `pushRates` | `… externalRatePlanId` |
| `pushRestrictions` | `pushRestrictions` | as availability |
| `ackReservation` | `ackReservation` | `externalReservationId externalAccountId` |

Each operation has `method` (`GET POST PUT PATCH`, never `DELETE`), `path` (a single `/…`, identifiers only as `{placeholders}`, URL-encoded and
refused if empty or `.`/`..`), optional `query`, `headers` (never `Host`, `Authorization`, `Content-Length`, `Cookie`, …), `body`, `items`
(where the list is in the response), `fields`, `pagination`, `batchSize`, `idempotencyHeader`, `acceptedPath`/`rejectedPath`.

### Placeholders, transforms, bodies

* `{name}` or `{name|transform}`; a body string that is *exactly one* placeholder keeps its type (number, boolean).
* Transforms (closed list): `minorToMajor`, `majorToMinor`, `upper`, `lower`, `int`, `string`, `dateCompact`, `boolInt`.
* Push bodies repeat an item with `{ "$each": "updates", "item": { … "{item.date}" … } }`. Item fields: availability `externalListingId externalRoomId date available stopSell`;
  rates `… externalRatePlanId price currency`; restrictions `… minimumStay maximumStay closedToArrival closedToDeparture closed`.
* Money inside Tirvona is integer minor units. The adapter assumes two decimals when it converts to or from major units.

### Reading responses

`items` and every field path use a restricted JSONPath: `$`, `.name`, `['name']`, `[0]`, `[*]`. Nothing else (no filters, recursion, expressions). A field is a path or
`{ "path": "...", "map": {…}, "default": …, "transform": "…" }`. Paths can not reach `__proto__`, `constructor` or `prototype`.

Pagination: `NONE`, `CURSOR` (`param` + `nextPath`), `PAGE`, `OFFSET`, with `pageSize` and `maxPages` (platform ceiling 100). If the ceiling is reached while more data
remains, the read **fails** (`CHANNEL_PAGINATION_LIMIT`) instead of silently returning part of it, so a cursor can never skip past unread data.

### Reservation mapping

`reservationMapping` states: where the status is and how each provider status maps to `RESERVATION_CREATED | RESERVATION_MODIFIED | RESERVATION_CANCELLED`
(unmapped statuses are reported, not guessed), how the price is given (`TOTAL` or `NIGHTLY`, `MINOR` or `MAJOR`), the date format, and **whether the channel collected the
payment**. The operation's `fields` must provide `externalReservationId externalListingId checkIn checkOut adults guestFirstName currency` (and may provide
`externalRoomId externalRatePlanId children guestLastName guestEmail guestPhone specialRequests updatedAt`). A total is split over the nights so the sum is exact.
Rows that cannot be mapped (bad date, stay outside 1–90 nights, missing field) are skipped and listed in the sync log.

### Webhooks

`webhook.signature` is mandatory (`HMAC_SHA256`; `hex`, `base64` or `t=…,v1=…`), over the raw body or `timestamp.raw body`, with a tolerance window. Events whose type is not in `typeMap`
are stored and ignored. The address is `POST /webhooks/c/<connection key>`; the key is random per connection and the secret is that connection's own.

### Platform ceilings

A definition can lower but never raise: timeout 30 s, request 1 MiB, response 5 MiB, 8 attempts, 50 requests/s, batch 1000, 100 pages, 10 hosts.

## 4. Lifecycle of a provider

1. **Create** (super admin): code (permanent, `[A-Z][A-Z0-9_]{1,31}`, not a built-in), name, kind.
2. **Draft a version**: invalid definitions are stored as `DRAFT` with their errors; valid ones become `VALIDATED`.
3. **Dry run** (super admin): read-only calls (health, listings, rooms, rates, recent reservations) with credentials supplied for that call only. Never writes, never stored.
4. **Publish** (super admin): re-validated at that moment. The previous published version becomes `RETIRED`. A database trigger makes published versions immutable.
5. **Roll back**: publishes a *copy* of an older version as a new version (history is never rewritten).
6. **Disable**: stops new connections and every use of the definition (webhooks answer 404, polls stop).
Operations admins can read, validate and compare; only super admins author or publish. Private (per-organization) providers exist in the schema but are not exposed: authoring is platform-only.

## 5. Connections

* **Connect** `POST /properties/:id/channels/:code/credentials` (owner/manager, organization must be `ACTIVE`). The provider's own `healthCheck` must succeed with the
  credentials, otherwise the connection is `ERROR`, never `CONNECTED`. iCal: every feed must be fetched and parsed as a calendar.
* **Credentials** are stored one row per kind in `channel_connection_secrets` as AES-256-GCM envelopes (same format and key as the OAuth token columns). The API returns *which* credentials exist, never a value.
  **Rotation** verifies the new credentials first and puts the old ones back if they fail.
* **Environment** `production` or `sandbox` per connection (only if the definition has a sandbox).
* **Polling**: each connection has `poll_interval_seconds` (≥ 60; null = webhooks only). The scheduler claims a due connection with one conditional `UPDATE`, so instances never double-poll.
  The cursor (`poll_cursor`) moves **only after** the events are stored; a 10-minute overlap re-reads recent changes and the inbox deduplicates them.
* **Idempotency**: inbox events are unique per `(provider, connection, event id)`; reservations per `(source, connection, external id)`; the same booking arriving under a new event id is still one reservation;
  outbound pushes are absolute values and carry a per-call idempotency header when the definition names one (stable across retries).
* **Skipped data is visible**: items that could not be imported (unmapped status, bad dates, outside the sellable horizon) are written to the sync log, not dropped.

### Who owns a record

A reservation whose source is a provider belongs to that provider: the public API can not change or cancel it (`409 CHANNEL_OWNED_RESERVATION`); the provider's own cancellations arrive as events and are applied automatically.

### Reconciliation

`POST /properties/:id/channels/:code/reconciliation` (and daily for every configured connection) compares the provider with Tirvona and stores a run plus issues:
`MISSING_LOCAL` (imported through the normal pipeline when its listing and room are mapped), `UNMAPPED`, `STATUS_MISMATCH`, `DATE_MISMATCH`, `MISSING_REMOTE`, `INGEST_FAILED`.
It **never cancels, moves or overwrites** a reservation. Staff resolve or ignore each issue (audited); an issue closes by itself when a later run no longer sees it.

## 6. iCal and CSV

**iCal import** reads availability calendars (ICS links). A calendar only says which dates are taken: each event becomes a zero-priced, channel-owned booking of the mapped room type, so the dates leave inventory
through the normal transaction. No prices, guests, payments or restrictions are read or sent, and every push operation is reported as unsupported. Safeguards: recurring events are skipped; past stays and
stays beyond the sellable horizon are skipped; Tirvona's own exported events (`@tirvona`) are ignored (no loops); a change in the feed moves the booking; a booking that vanishes is cancelled only when the whole
feed was read correctly **and** no more than max(2, half) of the held blocks disappear at once (otherwise it is reported and left alone); a block that was cancelled and later reappears is reported, not revived.
Calendar addresses are secrets (stored encrypted, never returned).

**iCal export** publishes `GET /ical/<token>.ics` per room type: the nights it is sold out or on stop-sell, nothing else (no names, prices or room counts). Tokens are random, shown once, stored hashed and revocable.
For a room type with several rooms the other platform sees it open until the last room is taken. This is a limit of the format.

**CSV import** (`POST /properties/:id/reservations/import`, needs `reservations:manage` and `rates:manage`): you map the columns, `dryRun: true` previews every row (dates, numbers, availability including earlier rows of the same file,
duplicates), `dryRun: false` books each valid row through the standard reservation transaction (source `CSV_IMPORT`). Your reference column makes re-running the same file safe.

## 7. Security model

| Threat | Control |
| --- | --- |
| SSRF to internal hosts | exact `allowedHosts`; https only; default port; no IP-literal hosts; no URL credentials; **the address a name resolves to is checked inside the socket's DNS lookup** (rebinding-proof); no redirects; loopback/private/link-local/metadata ranges blocked; private targets only when `WEBHOOK_ALLOW_PRIVATE_TARGETS` (refused in production) |
| Code execution through configuration | none exists: closed vocabulary, JSONPath subset, named transforms; unknown keys rejected; prototype-pollution keys rejected |
| Header / path / query injection | header names validated and engine-controlled ones forbidden; CR/LF refused; identifiers URL-encoded and `.`/`..`/empty refused; query built structurally |
| Resource exhaustion | request/response byte caps (streamed), total deadline (also against slow-drip), page/item/batch caps, per-connection rate limit and concurrency |
| Secret leakage | secrets only in `channel_connection_secrets` (envelope CHECK constraint); never in definitions, responses, logs or errors (redaction of bearer/basic/api-key shapes and the connection's own secret values) |
| Cross-tenant access | adapters bound to one connection; every route is property/organization checked; external ids scoped per connection; webhook secret per connection; tested with two tenants using identical ids |
| Forged or replayed webhooks | constant-time HMAC over the raw body; timestamp tolerance; unauthenticated deliveries store no payload; event ids unique per connection |
| Bad published definition | validated on publish **and again on load**; published versions immutable (DB trigger); disable switches a provider off everywhere |
| Pending/suspended partner | connect/rotate need an `ACTIVE` organization; suspended organizations lose access through the existing guard |

## 8. Rollout, verification and recovery

### Rolling out `0003`

1. Take a backup / confirm point-in-time recovery on the Supabase project. (`npm run drill:restore` rehearses a restore locally.)
2. Run the read-only pre-checks below. All must return no rows.
3. `npm run db:migrate` against the direct or session-pooler connection (never the transaction pooler). The migration is one transaction and additive.
4. Deploy the new backend with `CHANNEL_PROVIDERS_ENABLED=false`. Existing behaviour is unchanged; verify `/health`, a booking, a channel sync.
5. Enable the flag on a staging copy first (`CHANNEL_PROVIDERS_ENABLED=true`), create a provider, run the dry run, connect a test property.

Pre-checks (expect zero rows):

```sql
select distinct channel from channel_connections where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
select distinct channel from channel_listings  where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
select distinct channel from webhook_events    where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK','RAZORPAY');
select distinct channel from sync_jobs         where channel not in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK');
select distinct source  from reservations      where source !~ '^[A-Z][A-Z0-9_]{1,31}$';
select id from reservations where source in ('AIRBNB','BOOKING_COM','AGODA','MOCK') and external_reservation_id is null;
```

After migrating (expect the stated results):

```sql
select count(*) from channel_providers;                                   -- 9 built-ins
select count(*) from channel_connections where provider_id is null;       -- 0
select count(*) from channel_listings where external_scope <> '00000000-0000-0000-0000-000000000000';  -- 0 until configured providers are used
```

### Rollback and recovery

* **Switch off**: `CHANNEL_PROVIDERS_ENABLED=false` restores built-in-only behaviour without touching data. Configured connections stay in the database, inert.
* **A bad provider version**: disable the provider, or roll back to an earlier version (publishes a copy). Connections that pinned a retired version keep using it until reconnected.
* **Schema**: migrations are forward-only (checksummed). The migration is additive; the only constraints it replaces (`CHECK` lists → foreign keys, global → scoped uniqueness) are strictly more permissive for
  existing data. If it must be undone, restore the pre-migration backup/PITR, then redeploy the previous backend. Do **not** edit the applied file.
* **Leaked credential**: replace it (Rotate) or disconnect (deletes the stored secrets); for an iCal address, revoke it on the platform that issued it.

### Monitoring

Admin → Operations shows queue depth and failures. Per connection: `last_poll_at`, `last_poll_error`, `last_error`, the sync log, open reconciliation issues. `poll_skipped` entries in the sync log list what could not be imported and why.

## 9. Adding a provider without writing code

1. Read the platform's **official** API documentation. Note authentication, the endpoints for listings / availability / rates / reservations, pagination, rate limits, whether it has webhooks and how they are signed, and the sandbox. Anything you can not find documented is `false`.
2. Write the definition (start from the example), set every undocumented capability to `false`.
3. Admin → Providers → create → save the version (fix validation errors) → **Test** against the sandbox → **Publish**.
4. Tell the partner it is in their catalogue. They connect with their own credentials; the connection is verified before it shows as connected.
5. If the platform needs OAuth consent, XML/SOAP, request signing beyond HMAC, or business rules that cannot be written as data, use a [code adapter](CHANNEL_ADAPTERS.md#adding-a-real-ota-adapter) instead.
6. If the platform requires certification or partner approval, obtain it first and record the evidence; do not activate capabilities you have not been certified for.

## 10. Known limitations

* No XML/SOAP, no OAuth code flow, no `DELETE` operations, and money conversion assumes two decimals.
* One connection per property per provider (a second account of the same provider on one property is not supported yet).
* A multi-room reservation is read as one room line.
* iCal carries dates only; Tirvona's export can not express "n rooms left".
* Private (organization-owned) provider definitions are modelled in the schema but not exposed.
* BullMQ against a real Redis was not exercised here (the suites that need Redis are skipped without it).
