-- 0005: read-only payment and payout visibility for channel bookings
--
-- Why: until now a booking that came from a channel was marked CHANNEL_COLLECTED whenever the importer said so, and three importers
-- (iCal calendar blocks, the mock channel, the calendar-block sync) said so unconditionally. Nothing a provider reported was stored.
-- This migration adds an explicit, NULLABLE record of what is known about who collects the money, where that knowledge came from, and
-- what the provider itself reported. NULL always means "not reported", never "paid" or "unpaid". No money is moved by anything here.
--
-- Changes:
--   * reservations.payment_status accepts 'UNKNOWN' (a channel booking whose collection is not known).
--   * rows that were CHANNEL_COLLECTED become UNKNOWN: that value was an assumption of the importer, not provider data, and the
--     original provenance was never recorded, so it cannot be proven for any historical row. DATA CHANGE; see the runbook.
--   * new nullable columns for collection model, provenance, provider status (raw and normalised), payout status/date, commission
--     and net amount.
-- Forward-only. Recovery: restore the pre-migration backup. The previous application release tolerates the new columns (it ignores
-- them) but does not know the 'UNKNOWN' value, so it must not run against a database where UNKNOWN rows exist.

alter table reservations drop constraint reservations_payment_status_check;
alter table reservations add constraint reservations_payment_status_check
  check (payment_status in ('UNPAID','PARTIALLY_PAID','PAID','CHANNEL_COLLECTED','PARTIALLY_REFUNDED','REFUNDED','UNKNOWN'));

alter table reservations
  -- Who collects the guest's money, if known: CHANNEL = the channel (OTA) charges the guest; PROPERTY = the guest pays the property.
  add column collection_model text check (collection_model in ('CHANNEL','PROPERTY')),
  -- Where that knowledge came from: PROVIDER = the channel reported it for this booking; OPERATOR_CONFIG = an operator declared it in
  -- the provider configuration (a declaration for every booking of that provider, not a per-booking fact). NULL = not known.
  add column collection_source text check (collection_source in ('PROVIDER','OPERATOR_CONFIG')),
  -- Everything below is PROVIDER-REPORTED by construction: the only code that writes it reads it from the provider's own response.
  -- The provider's payment status word verbatim, and its normalised reading (NULL when the operator's mapping does not list the word).
  add column provider_payment_status_raw text check (char_length(provider_payment_status_raw) <= 200),
  add column provider_payment_status text check (provider_payment_status in ('UNPAID','PAID','PARTIALLY_PAID','REFUNDED','PARTIALLY_REFUNDED','FAILED')),
  add column payout_status_raw text check (char_length(payout_status_raw) <= 200),
  add column payout_status text check (payout_status in ('PENDING','COMPLETED','FAILED')),
  add column payout_date timestamptz,
  add column commission_amount bigint check (commission_amount >= 0),
  add column net_amount bigint check (net_amount >= 0),
  -- When the provider-reported fields were last refreshed from the provider.
  add column payment_info_updated_at timestamptz;

-- A collection model without a recorded source (or the reverse) is impossible.
alter table reservations add constraint reservations_collection_has_source
  check ((collection_model is null) = (collection_source is null));

-- CHANNEL_COLLECTED is only ever stored together with the knowledge that backs it.
alter table reservations add constraint reservations_channel_collected_needs_model
  check (payment_status <> 'CHANNEL_COLLECTED' or coalesce(collection_model = 'CHANNEL', false)) not valid;

-- Historical rows: the old CHANNEL_COLLECTED was an importer assumption with no recorded provenance. Do not keep presenting it as a
-- fact. (amount_paid is untouched; channel-collected rows never carried ledger payments.)
update reservations set payment_status = 'UNKNOWN' where payment_status = 'CHANNEL_COLLECTED';

-- Now that no historical row can violate it, enforce the rule for every row.
alter table reservations validate constraint reservations_channel_collected_needs_model;
