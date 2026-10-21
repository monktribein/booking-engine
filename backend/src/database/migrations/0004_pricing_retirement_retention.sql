-- 0004: date-level pricing, occupancy pricing, promotion redemption limits, room retirement, personal-data retention
--
-- Additive and forward-only. Nothing is dropped except two constraints that are re-created in a wider form:
--   * rooms_status_check (adds 'RETIRED')
--   * rooms_property_id_room_number_key (becomes a partial unique index so a retired room's number can be reused)
-- Existing behaviour is preserved:
--   * no rate_rules rows       -> every night costs the rate plan's base price, exactly as before
--   * base_occupancy NULL      -> no extra-guest charge, exactly as before
--   * promotion limit columns  -> NULL / 0 = unlimited / no minimum, exactly as before
--   * no retention policy row  -> nothing is ever anonymised
-- Recovery: restore the pre-migration backup (there is no down migration). The previous application release keeps working
-- against this schema, so an application rollback needs no database rollback.

-- ====================================================================== date-level and seasonal rates

create table rate_rules (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  -- NULL = applies to every rate plan of the room type; set = only that plan (more specific, so it wins ties).
  rate_plan_id uuid references rate_plans(id),
  name text not null check (char_length(name) between 1 and 120),
  -- Half-open [start_date, end_date), like stays and blocks.
  start_date date not null,
  end_date date not null,
  -- 0 = Sunday .. 6 = Saturday; NULL = every day of the week.
  days_of_week smallint[] check (days_of_week is null or (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[0,1,2,3,4,5,6]::smallint[])),
  -- FIXED: amount is the nightly price (minor units). PERCENT: percent is added to the base price (-90 .. +500).
  adjustment text not null check (adjustment in ('FIXED','PERCENT')),
  amount bigint check (amount >= 0),
  percent numeric(7,2) check (percent between -90 and 500),
  -- Higher wins. Ties: rate-plan-specific over room-type-wide, then day-of-week-specific, then the shorter range, then newest.
  priority integer not null default 0 check (priority between 0 and 1000),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check (end_date - start_date <= 1100),
  constraint rate_rules_adjustment_shape check (
    (adjustment = 'FIXED' and amount is not null and percent is null) or
    (adjustment = 'PERCENT' and percent is not null and amount is null)
  )
);
create index rate_rules_lookup_idx on rate_rules (room_type_id, start_date, end_date) where status = 'ACTIVE';
create index rate_rules_property_idx on rate_rules (property_id);
create trigger rate_rules_set_updated_at before update on rate_rules for each row execute function set_updated_at();

-- ====================================================================== occupancy pricing

alter table room_types
  -- Guests included in the nightly price per room. NULL = the price covers max_occupancy (no extra-guest charges).
  add column base_occupancy integer check (base_occupancy between 1 and 50),
  add column extra_adult_charge bigint not null default 0 check (extra_adult_charge >= 0),
  add column extra_child_charge bigint not null default 0 check (extra_child_charge >= 0),
  add constraint room_types_base_occupancy_max check (base_occupancy is null or base_occupancy <= max_occupancy);

-- ====================================================================== promotion limits and redemptions

alter table promotions
  add column max_redemptions integer check (max_redemptions >= 1),
  add column max_per_guest integer check (max_per_guest >= 1),
  -- Minimum eligible booking total (after tax, before the discount), minor units.
  add column min_booking_value bigint not null default 0 check (min_booking_value >= 0);

create table promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions(id),
  reservation_id uuid not null references reservations(id),
  guest_id uuid not null references guests(id),
  amount bigint not null check (amount >= 0),
  -- ACTIVE counts against the limits. RELEASED = the reservation was cancelled or its payment hold expired.
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RELEASED')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  -- One redemption per reservation: a retried request cannot redeem twice.
  constraint promotion_redemptions_reservation_key unique (reservation_id)
);
create index promotion_redemptions_active_idx on promotion_redemptions (promotion_id) where status = 'ACTIVE';
create index promotion_redemptions_guest_idx on promotion_redemptions (promotion_id, guest_id) where status = 'ACTIVE';

-- ====================================================================== room retirement

alter table rooms drop constraint rooms_status_check;
alter table rooms add constraint rooms_status_check
  check (status in ('AVAILABLE','OCCUPIED','CLEANING','MAINTENANCE','BLOCKED','RETIRED'));
alter table rooms
  add column retired_at timestamptz,
  add column retired_reason text check (char_length(retired_reason) <= 500),
  add column retired_by uuid references users(id),
  add constraint rooms_retired_shape check ((status = 'RETIRED') = (retired_at is not null));
-- A retired room keeps its row (reservations, reports and the audit trail reference it) but frees its number.
alter table rooms drop constraint rooms_property_id_room_number_key;
create unique index rooms_property_number_key on rooms (property_id, room_number) where status <> 'RETIRED';

-- ====================================================================== personal-data retention

-- One policy per organization. Nothing runs until `enabled` AND `approved_at` are set by an owner: the periods are a
-- business/legal decision, so there is deliberately no default.
create table data_retention_policies (
  organization_id uuid primary key references organizations(id),
  -- Anonymise guests whose every stay ended (or was cancelled) at least this long ago. NULL = never.
  guest_anonymize_after_days integer check (guest_anonymize_after_days between 30 and 3650),
  -- Blank the recipient/subject/body of delivered or failed notifications older than this. NULL = never.
  notification_redact_after_days integer check (notification_redact_after_days between 7 and 3650),
  -- Replace the raw payload of processed inbound channel events (an OTA's booking notification carries the guest's name and
  -- contact details) with a marker after this many days. The event row, its id and status stay, so replays are still recognised.
  inbound_payload_redact_after_days integer check (inbound_payload_redact_after_days between 7 and 3650),
  enabled boolean not null default false,
  approved_by uuid references users(id),
  approved_at timestamptz,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_retention_enabled_needs_approval check (not enabled or approved_at is not null)
);
create trigger data_retention_policies_set_updated_at before update on data_retention_policies for each row execute function set_updated_at();

create table data_retention_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  dry_run boolean not null,
  triggered_by text not null check (char_length(triggered_by) <= 80),
  -- Counts only, never personal data: { guests, reservations, notifications }
  summary jsonb not null,
  created_at timestamptz not null default now()
);
create index data_retention_runs_org_idx on data_retention_runs (organization_id, created_at desc);

alter table guests add column anonymized_at timestamptz;
alter table notifications add column redacted_at timestamptz;
alter table webhook_events add column payload_redacted_at timestamptz;
create index webhook_events_retention_idx on webhook_events (updated_at) where payload_redacted_at is null and status in ('PROCESSED','IGNORED','FAILED') and property_id is not null;
-- Candidates for the retention job (partial indexes stay tiny).
create index guests_retention_idx on guests (property_id) where anonymized_at is null;
create index notifications_retention_idx on notifications (created_at) where redacted_at is null and status in ('SENT','DELIVERED','FAILED','READ');

-- ====================================================================== security for the new tables

alter table rate_rules enable row level security;
alter table promotion_redemptions enable row level security;
alter table data_retention_policies enable row level security;
alter table data_retention_runs enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on rate_rules, promotion_redemptions, data_retention_policies, data_retention_runs from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on rate_rules, promotion_redemptions, data_retention_policies, data_retention_runs from authenticated';
  end if;
end $$;
