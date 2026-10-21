# Personal data and retention

**Status: framework implemented and tested; no retention period is set anywhere.** Which periods to use is a decision for the
product owner (and their legal / tax advisers). Nothing in this repository is legal advice and no period below is presented as a
legal requirement. Until an owner chooses periods, dry-runs and approves a policy, nothing is ever anonymised: the default is
"keep everything", as before.

## What personal data the system holds

| Where | What | Purpose | What retention does to it |
| --- | --- | --- | --- |
| `users` | name, e-mail, phone, password hash (staff, owners, developers) | sign-in, audit | **kept**: accounts are managed by removing the user (staff / developer removal ends their sessions); out of scope of the guest policy |
| `guests` | first/last name, e-mail, phone, country, ID `documents`, `notes` | the property's guest book, repeat bookings, check-in | **anonymised** after the guest-period (name -> "Anonymized Guest"; e-mail, phone, documents, notes removed; country kept as non-identifying) |
| `reservations.guest`, `reservations.special_requests` | name / e-mail / phone snapshot taken at booking; free-text requests | proof of who booked, front desk | **anonymised** with the guest (snapshot -> "Anonymized Guest", requests removed). Dates, code, amounts, status, payment fields stay |
| `notifications` | recipient address, subject, message body | delivery of confirmations / reminders | blanked after the notification-period for sent / delivered / failed / read messages (recipient becomes `redacted@redacted.invalid`, a reserved undeliverable address, because the column is required); also blanked immediately for an anonymised guest's stays. Messages still queued are never touched |
| `webhook_events.payload` | raw inbound notification from a channel (an OTA's booking notification contains the guest's details) | idempotent processing, support | payload replaced by `{"redacted":true}` after the inbound-period for processed / ignored / failed events of a property. The row, external id and status stay, so a replay is still recognised. Events with no property (payment-gateway events) are not attributed to an organization and are not covered |
| `webhook_deliveries.body` | outbound partner event; guest details only if the owner enabled "include guest details" | partner integration | already purged by the scheduler 30 days after delivery / final failure (`WEBHOOK_DELIVERY_RETENTION_DAYS`) |
| `reservations.cancellation_reason`, `status_history[].reason`, `rooms.notes`, `audit_logs` free text | text typed by staff | operations | **kept as written**. Staff can type personal data into free text; it is not scanned or redacted |
| `payments`, `refunds` | provider ids, amounts, status, provider metadata | accounting, refunds, disputes | **kept** (financial records). They hold no name or e-mail of their own; the payment gateway keeps its own copy of the payer's details, which is outside this system |
| `audit_logs` | who did what: user id, IP address, user agent, before / after values of changed fields | accountability | **kept**: the table is append-only by a database trigger, deliberately. Guest names are not written to it by the reservation / guest flows; staff IP addresses and user agents are |
| `auth_sessions`, `password_reset_tokens` | IP, user agent, token hashes | sign-in | deleted by the scheduler when expired |
| `sync_logs` | request / response metadata of channel calls | support | deleted by the scheduler after 90 days (`SYNC_LOG_RETENTION_DAYS`) |
| `api_key_usage` | per-day request counters | partner billing / support | counters only; `api_keys.last_used_ip` holds the last client address |
| Application logs | structured JSON; passwords, tokens, API keys, webhook secrets and card-like data are redacted | operations | kept by whatever log store you ship stdout to; **set its retention** (not managed here) |
| Database backups / PITR | everything above, as it was | recovery | **outside the application**. An anonymisation also exists in older backups until they age out; set backup retention accordingly |

## What the policy does

One policy per organization (`data_retention_policies`), edited by an owner in Settings -> Data retention (or
`PUT /organizations/me/retention`):

* `guestAnonymizeAfterDays` (30 to 3650, empty = never): a guest is eligible when **every** reservation they have is finished or
  cancelled more than that long ago, none is `PENDING`/`CONFIRMED`/`CHECKED_IN`, none was touched within the period, and no refund is
  still pending or processing. The guest record itself must also be older than the period.
* `notificationRedactAfterDays` (7 to 3650, empty = never).
* `inboundPayloadRedactAfterDays` (7 to 3650, empty = never).

Safety properties (each covered by `backend/test/retention.e2e-spec.ts`):

* **Approval gate.** A policy runs only when it is `enabled` and has an owner's approval. Saving *any* change withdraws the
  approval. A database CHECK forbids `enabled` without `approved_at`.
* **Dry run** (`POST .../retention/dry-run`, `npm run retention:dry-run`) counts what a run would touch and changes nothing; it
  works before approval.
* **Nothing is deleted.** Reservations, amounts, dates, payments, refunds, the audit trail and reports are unchanged (the test
  compares the revenue report and every non-personal reservation field before and after). Foreign keys are untouched.
* **Idempotent and bounded.** Anonymised guests are skipped (`guests.anonymized_at`); a run handles at most 500 guests and reports
  `moreGuests` so it can be repeated.
* **Tenant-safe.** Selection is by the organization of the property; another organization's approved policy cannot reach these
  guests.
* **No personal data in the record.** `data_retention_runs` stores counts only.
* **Scheduler.** Off unless the worker has `RETENTION_JOB_ENABLED=true`; then it runs daily and applies only approved policies.
  The API's "Run now" requires typing the confirmation `ANONYMIZE` (sent by the UI after a browser confirmation).

## Running it

```
# counts only (needs DATABASE_URL; run from backend/ after `npm run build`)
npm run retention:dry-run                       # every organization that has a policy
node dist/scripts/retention.js --org <uuid>     # one organization

# applying from the command line needs the approved policy AND two explicit flags
node dist/scripts/retention.js --org <uuid> --apply --confirm ANONYMIZE
```

**Do not run an apply against production** until the owner has set periods, read a dry run and approved the policy in the UI.
The migration that creates these tables (`0004`) has not been applied to any hosted database by this work.

## Decisions still needed from the product owner

1. The three periods (and whether to use each category at all).
2. Whether guests may ask for earlier erasure (there is no self-service request flow; an owner can lower the period and run, or
   contact support).
3. Log-store and backup retention (outside the app).
4. A policy for staff accounts and for audit-log IP addresses.
5. Whether payment-gateway event payloads (no property attached) should be covered by a separate rule.
