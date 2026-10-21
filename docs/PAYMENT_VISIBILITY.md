# Payment and payout visibility for channel bookings

Scope: **read-only visibility**. Tirvona shows what is known about the money of a channel booking and where that knowledge came
from. It does not collect payments for channels, transfer money, or pay hotels, and this document adds none of that.

**Airbnb, Booking.com and Agoda remain unavailable.** Their adapters are placeholders that fail every call with
`CHANNEL_INTEGRATION_NOT_AVAILABLE` until Tirvona is accepted into each programme and an adapter is written against that
programme's official documentation (see [CHANNEL_ADAPTERS.md](CHANNEL_ADAPTERS.md)). Nothing in this change reads payment data from
any of them, and no field of theirs is assumed to exist. Payment and payout fields can today only arrive through (a) a configured
REST provider whose operator mapped them, or (b) the mock channel in tests.

## The rule

Absence is information. A value that was not reported is stored as `NULL` and shown as **Unavailable**. It is never defaulted to
paid, unpaid or collected. Before this change three importers (iCal calendar blocks, the mock channel, the calendar-block sync)
marked every booking `CHANNEL_COLLECTED` unconditionally, and cancellation then skipped refunds on the assumption that "the OTA
refunds its own guest". Both assumptions are gone.

## What is stored (`reservations`, migration `0005`)

| Column | Meaning | `NULL` means |
| --- | --- | --- |
| `payment_status` | gains the value `UNKNOWN`: a channel booking whose payment is not known | (never null) |
| `collection_model` | `CHANNEL` (the channel charges the guest) or `PROPERTY` (the guest pays the property) | not known |
| `collection_source` | `PROVIDER` (the channel reported it for this booking) or `OPERATOR_CONFIG` (an operator declared it for the whole provider; a declaration, not a fact about this booking) | not known |
| `provider_payment_status_raw` | the provider's payment status word, verbatim | not reported |
| `provider_payment_status` | its normalised reading (`UNPAID`, `PAID`, `PARTIALLY_PAID`, `REFUNDED`, `PARTIALLY_REFUNDED`, `FAILED`), only when the operator's mapping lists the word | not reported or not mapped |
| `payout_status_raw`, `payout_status` (`PENDING`, `COMPLETED`, `FAILED`), `payout_date` | the provider's payout information | not reported |
| `commission_amount`, `net_amount` | minor units, as reported | not reported (a reported `0` is stored as `0`) |
| `payment_info_updated_at` | when the provider-reported fields were last refreshed | never reported |

`collection_model` and `collection_source` are both set or both `NULL` (database CHECK), and `CHANNEL_COLLECTED` can only be stored
with `collection_model = 'CHANNEL'` (database CHECK). All provider-reported columns are written only from a provider's own response.

### How `payment_status` is chosen for a new channel booking

| Adapter supplied | `payment_status` |
| --- | --- |
| nothing, or a claim without a source | `UNKNOWN` |
| collection `CHANNEL` with a source | `CHANNEL_COLLECTED` ("the channel is responsible for collection"; **not** "the guest has paid" - the provider's status is stored separately) |
| collection `PROPERTY` with a source | `UNPAID` (the guest pays the property) |

Bookings that are not channel bookings (Tirvona sites, the public API, walk-in, phone, agent) ignore channel payment data and keep
their ledger behaviour: Razorpay and offline payments recorded in Tirvona set `PAID`, `PARTIALLY_PAID`, `REFUNDED` exactly as before.

## Adapter contract

`NormalizedReservationEvent.payment?: ChannelPaymentInfo` (`backend/src/database/common/payment-info.ts`) replaces the boolean
`paymentCollectedByChannel`. Omit it when nothing is known. `normalizePaymentInfo` drops anything that cannot be backed up: a
collection claim without a source, values outside the allowed lists, negative or fractional money, unparseable dates.

A later `RESERVATION_MODIFIED` event (or a repeated `CREATED`) refreshes only the provider-reported fields (`ReservationService.refreshChannelPaymentInfo`).
It never changes amounts paid, refunds or the booking status, never replaces a known collection model, and never erases a known value
because a later event reported nothing. A booking whose collection was `UNKNOWN` learns it when a provider later states it.

### Configured REST providers

`reservationMapping` accepts, all optional:

```jsonc
"paymentCollection": "CHANNEL",            // operator declaration for every booking of this provider; omit when the contract does not say
"paymentFields": {                         // paths into the provider's own booking response; a path that finds nothing reports nothing
  "statusPath": "$.payment.status",
  "statusMap": { "captured": "PAID" },     // unlisted words stay raw-only
  "payoutStatusPath": "$.payout.state", "payoutStatusMap": { "sent": "COMPLETED" },
  "payoutDatePath": "$.payout.date",
  "commissionPath": "$.fee", "netAmountPath": "$.net", "amountUnit": "MAJOR"   // amountUnit is required with a money path
}
```

The legacy boolean `paymentCollectedByChannel` is still accepted (true = `CHANNEL`, false = `PROPERTY`) and is read as an **operator
declaration**, so definitions saved earlier keep loading. It is no longer required: leaving the collection out means unknown.
The `paymentFields` paths are chosen by the operator from the provider's own documentation; Tirvona does not guess field names.

## Cancellation and refunds

Refund rows are created only from payments recorded in Tirvona. Cancelling a channel booking:

* `CHANNEL_COLLECTED`: no refund is created here (the channel is responsible for collection) and **nothing is recorded as refunded**.
* `UNKNOWN`: refunds come from recorded payments, which for a channel booking is normally none.

In both cases `amount_refunded` stays `0` and `payment_status` never becomes `REFUNDED` on the strength of the booking's origin.
The dashboard shows "Unavailable - whether the channel refunded the guest has not been reported" for a cancelled channel booking,
unless the provider reported a refund or a refund is recorded in Tirvona.

## Dashboard wording

`frontend/lib/utils/payment-visibility.ts` is the one place that words the state; the same panel is used on the Payments page and the
reservation drawer.

| State | Shown as |
| --- | --- |
| Guest paid (recorded in Tirvona, Razorpay or offline) | "Paid by guest" / "Partially paid" / "Unpaid" |
| Channel collects | "Collected by channel", with "Reported by X" or "Declared in the X provider configuration. X has not reported that the guest paid" |
| Property collects | "Property collects" / "Paid to property", with its source |
| Payout pending / completed / failed | "Payout pending", "Payout completed on <date>", "Payout failed" - only when the provider reported it |
| Refund | "Refunded <amount>" only when recorded or reported; otherwise "No refund" or Unavailable |
| Nothing reliable | "Unavailable" with the reason |

A provider status word nobody mapped is shown quoted and uninterpreted. Balance due is shown only when it can be known (a recorded
payment, or a collection model of `PROPERTY`); otherwise "Unavailable". Recording a payment is disabled for `CHANNEL_COLLECTED`
bookings (the server also refuses it).

## Existing data

Migration `0005` changes rows whose `payment_status` was `CHANNEL_COLLECTED` to `UNKNOWN`: that value was an importer's assumption
and no provenance was ever recorded, so it cannot be proven for any historical row. Amounts are untouched. Real Tirvona payments
(`PAID`, `PARTIALLY_PAID`, `REFUNDED`, ...) and `UNPAID` rows are not modified. See [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md).

## What is not implemented

* No OTA payment, payout, commission or net-amount field is read from Airbnb, Booking.com or Agoda, and none is assumed to exist.
* Reconciliation of provider-reported payment data against anything else; payouts are displayed, never verified or moved.
* The public partner API (`/v1`) does not expose the new fields; it may return `paymentStatus: "UNKNOWN"` for channel-owned reservations.
