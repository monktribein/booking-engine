# Pricing, rate rules, occupancy and promotions

Everything a guest or a channel is charged is calculated **on the server**, by one set of functions
(`backend/src/database/common/pricing.ts`, `services/promotion.ts`) that the quote, the booking transaction, a later
re-price and the channel rate push all share. The browser never sends a price; it can send the total it was *shown*, and the
server refuses the booking if it now calculates something else.

All amounts are integers in minor units (paise). Dates are the property's calendar days.

## Order of calculation

For one room and one night:

1. **base** the rate plan's `basePrice`
2. **rule** the winning *rate rule* for that night (if any) replaces the base (`FIXED`) or adjusts it (`PERCENT`)
3. **extra** the extra-guest charge for guests above the room type's base occupancy
4. night amount = rule price + extra

Per room: `subtotal` = sum of its night amounts; `tax` = property `taxPercent` of that room's subtotal, rounded half away from
zero; `total` = subtotal + tax. A reservation is the sum of its rooms. A **promotion** is taken off the post-tax total of the
eligible rooms (so it never changes the tax base), and `reservation.total = subtotal + tax - discount` is a database CHECK.
Staff-entered discounts and OTA-supplied nightly prices bypass steps 2 and 3 (they are taken as given) and cannot be combined
with a promotion code.

Rounding: percentages (tax, `PERCENT` rules, percentage promotions) round half away from zero to a whole minor unit, per room
line. A quote and the booking that follows round identically because they run the same code (verified by tests that compare
the quote, the stored reservation and the payment order amount).

## Rate rules (date-level and seasonal prices)

`GET/POST /properties/:id/rate-rules`, `PATCH/DELETE /rate-rules/:id`, `GET /properties/:id/rate-calendar` (the effective price
per date and the rule behind it). A rule has: a room type, optionally one rate plan, a date range `[start, end)`, optionally
weekdays (0 = Sunday .. 6 = Saturday), an adjustment (`FIXED` amount, or `PERCENT` -90 .. +500), a priority and a status.
UI: Rates → "Seasonal & date rates".

**Which rule wins** when several match a night: highest priority; then a rule for the rate plan over one for the whole room
type; then a weekday rule over an every-day rule; then the shorter date range; then the newest. Deterministic, and independent
of the order rows are read.

**Conflicts.** Two active rules with the same priority and the same rate-plan scope whose dates overlap and whose day filters
are both "every day" (or share a weekday) are a coin toss and are refused with `RATE_RULE_CONFLICT`. Layering a weekday rule
over a season is allowed and intended. The check runs under a per-room-type advisory lock, so two concurrent creations cannot
both pass. Deactivating a rule (`DELETE`) keeps it listed.

**History is never rewritten.** A reservation freezes each night's price (`rate`, `extra`, `amount`, and the `ruleId`). A later
rule or price change does not touch it. When a stay is extended or moved, nights that stay keep their sold price; only new
nights are priced with today's rules.

**Channels.** A rule change queues a `RATES` sync for its date range, and the channel push uses the same per-night prices.

## Occupancy and extra-guest charges

Room type fields: `baseOccupancy` (guests the nightly price covers per room; empty = the price covers `maxOccupancy`, no extra
charges), `extraAdultCharge`, `extraChildCharge` (per guest per night). Guests are seated deterministically over the rooms of a
booking (up to base occupancy first, adults before children, then up to the maximum), and extras are charged per night on every
night of the stay. A party larger than the combined maximum is refused. Changing the party of a confirmed stay re-prices the
extras (rates stay as sold); changing it while a payment is pending is refused, because the payment order is for the old total.
Children are a count; there are no age bands.

## Promotions and redemption limits

Fields: `type` (percentage), `value`, `validFrom`/`validTo` (check-in must fall in the window), `minNights`, `roomTypeIds`,
`active`, and the limits `maxRedemptions` (total uses), `maxPerGuest`, `minBookingValue` (eligible post-tax total before the
discount). Limits are optional; empty means unlimited.

* Redemptions are recorded **inside the booking transaction** (`promotion_redemptions`, one per reservation, unique), after the
  promotion row is locked `FOR UPDATE`, so concurrent bookings cannot exceed a limit (test: six parallel bookings, limit two,
  exactly two succeed; removing the lock makes that test fail).
* A cancelled booking, or an unpaid hold that expires, **gives its use back**. A no-show keeps it.
* "Per guest" is the guest record, which is matched by **e-mail address** (case-insensitive) within a property. A person with
  several e-mail addresses can use a once-per-guest code once per address; there is no stronger identity to count against.
* Rejections say why (`PROMO_INVALID`: unknown, no longer active, not valid for these dates, needs N nights, usage limit reached,
  already used, below the minimum value, does not apply to the selected rooms). The availability preview shows the reason per
  rate plan instead of a discount.
* A percentage promotion's discount is fixed when the booking is made; extending the stay later does not recompute it
  (the existing behaviour, unchanged).

## Price guard

`POST /public/reservations` accepts `expectedTotal`. If the server's total differs (a rule, a tax change, a promotion edit
between quote and click) the request fails with `409 PRICE_CHANGED` and nothing is held; the checkout page refreshes the quote
and asks the guest to confirm. Idempotent retries are unaffected: a replay returns the booking that was created.

## Not implemented

Minimum-stay-based or length-of-stay pricing, child age bands, per-person rates by meal plan, multi-currency pricing within a
property, slab-based tax, fees other than the single property tax percent, and promotion types other than percentage /
fixed-amount codes entered by the guest (the dashboard form creates percentage codes).
