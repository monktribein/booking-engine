-- Tirvona PostgreSQL schema, version 1.
--
-- Conventions
--   * snake_case tables and columns; the application maps them to camelCase.
--   * Primary keys are uuid (gen_random_uuid()). The HTTP API still exposes them as `_id`.
--   * Money is bigint in minor units (paise). Calendar dates are `date`; instants are timestamptz.
--   * Enumerations are text columns with CHECK constraints (add a value with a new migration).
--     src/database/schema.spec / test/schema-drift.e2e-spec.ts fails if these drift from src/database/enums.ts.
--   * Value objects that are always read and written with their parent stay JSONB (images, cancellation policy,
--     guest snapshot, status history, nightly rates, metadata).
--   * Invariants that Mongo kept in server-side validators are CHECK constraints here (inventory arithmetic,
--     reservation totals, money >= 0, audit_logs is append-only).
--   * Every table has row level security ENABLED with no policies. Supabase exposes the `public` schema through its
--     Data API (PostgREST); with RLS on and no policy the `anon` and `authenticated` roles can read and write nothing.
--     The API connects as the table owner (`postgres`), which bypasses RLS.

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ====================================================================== identity

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  password_hash text not null check (password_hash ~ '^(scrypt\$|\$2[aby]\$|\$argon2)'),
  role text not null check (role in ('SUPER_ADMIN','PROPERTY_OWNER','PROPERTY_MANAGER','STAFF','RECEPTION')),
  status text not null default 'INVITED' check (status in ('ACTIVE','INVITED','SUSPENDED','DISABLED')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_org_required check (role = 'SUPER_ADMIN' or organization_id is not null)
);
create unique index users_email_key on users (email);
create index users_org_role_idx on users (organization_id, role);

create table properties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  owner_id uuid not null references users(id),
  name text not null check (char_length(name) between 1 and 160),
  slug text not null check (char_length(slug) <= 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text check (char_length(description) <= 5000),
  address text not null,
  city text not null,
  state text not null,
  country text not null check (country ~ '^[A-Z]{2}$'),
  postal_code text not null,
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  check_in_time text not null default '14:00' check (check_in_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check_out_time text not null default '11:00' check (check_out_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  tax_percent numeric(6,3) not null default 0 check (tax_percent between 0 and 100),
  booking_horizon_days integer not null default 365 check (booking_horizon_days between 1 and 730),
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 50),
  amenities text[] not null default '{}' check (cardinality(amenities) <= 100),
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint properties_lat_lng_together check ((latitude is null) = (longitude is null)),
  -- Public direct-booking URLs resolve by slug, so it is unique platform-wide (which implies unique per organization).
  constraint properties_slug_key unique (slug)
);
create index properties_org_idx on properties (organization_id);
create index properties_owner_idx on properties (owner_id);
create index properties_status_idx on properties (status);

create table property_users (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('PROPERTY_OWNER','PROPERTY_MANAGER','STAFF','RECEPTION')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, user_id)
);
-- "Which properties can this user access?" runs on every authenticated request.
create index property_users_user_idx on property_users (user_id, property_id);

-- ====================================================================== catalogue

create table room_types (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  max_occupancy integer not null check (max_occupancy between 1 and 50),
  base_price bigint not null check (base_price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_rooms integer not null check (total_rooms between 0 and 5000),
  amenities text[] not null default '{}' check (cardinality(amenities) <= 100),
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 50),
  sort_order integer not null default 0,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, slug)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  room_number text not null check (char_length(room_number) between 1 and 20),
  floor text,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE','OCCUPIED','CLEANING','MAINTENANCE','BLOCKED')),
  notes text,
  -- Bumped by every room assignment / room-level block so concurrent assignments of one room serialize on this row.
  assignment_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, room_number)
);
create index rooms_type_status_idx on rooms (room_type_id, status);

create table rate_plans (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  name text not null check (char_length(name) between 1 and 120),
  code text not null check (code ~ '^[A-Z0-9_-]{1,40}$'),
  type text not null default 'STANDARD' check (type in ('STANDARD','NON_REFUNDABLE','BREAKFAST','CUSTOM')),
  base_price bigint not null check (base_price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  meal_plan text not null default 'ROOM_ONLY' check (meal_plan in ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD','ALL_INCLUSIVE')),
  cancellation_policy jsonb not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, room_type_id, code),
  constraint rate_plans_nonrefundable_policy check (type <> 'NON_REFUNDABLE' or (cancellation_policy->>'refundable') = 'false')
);

create table promotions (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  code text not null check (code ~ '^[A-Z0-9_-]{3,30}$'),
  name text not null check (char_length(name) between 1 and 120),
  type text not null check (type in ('PERCENTAGE','FIXED')),
  value numeric(14,2) not null check (value >= 0),
  valid_from date not null,
  valid_to date not null,
  min_nights integer not null default 1 check (min_nights >= 1),
  room_type_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, code),
  check (valid_to > valid_from),
  check (type <> 'PERCENTAGE' or value <= 100),
  check (type <> 'FIXED' or value = trunc(value))
);

-- ====================================================================== inventory

-- One row per (property, room type, night): the master inventory every channel sells from.
-- available + sold + blocked = total + overbooked, all counters >= 0 (the same rule the Mongo validator enforced).
create table inventory (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  date date not null,
  total integer not null check (total >= 0),
  sold integer not null default 0 check (sold >= 0),
  blocked integer not null default 0 check (blocked >= 0),
  available integer not null check (available >= 0),
  overbooked integer not null default 0 check (overbooked >= 0),
  stop_sell boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, room_type_id, date),
  constraint inventory_balance check (available + sold + blocked = total + overbooked)
);

create table inventory_blocks (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  room_id uuid references rooms(id),
  start_date date not null,
  end_date date not null,
  quantity integer not null check (quantity between 1 and 5000),
  reason text not null check (reason in ('MAINTENANCE','PRIVATE_EVENT','OWNER_BLOCK','MANUAL_BLOCK','OTHER')),
  notes text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RELEASED')),
  created_by uuid references users(id),
  released_at timestamptz,
  released_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check (room_id is null or quantity = 1)
);
create index inventory_blocks_window_idx on inventory_blocks (property_id, room_type_id, start_date, end_date);
create index inventory_blocks_room_idx on inventory_blocks (room_id, start_date) where room_id is not null;

create table restrictions (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  date date not null,
  minimum_stay integer check (minimum_stay between 1 and 365),
  maximum_stay integer check (maximum_stay between 1 and 365),
  closed boolean not null default false,
  closed_to_arrival boolean not null default false,
  closed_to_departure boolean not null default false,
  stop_sell boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, room_type_id, date),
  check (minimum_stay is null or maximum_stay is null or maximum_stay >= minimum_stay)
);

-- ====================================================================== guests and reservations

create table guests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null default '' check (char_length(last_name) <= 100),
  email text check (email = lower(email)),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  country text check (country ~ '^[A-Z]{2}$'),
  documents jsonb not null default '[]'::jsonb check (jsonb_typeof(documents) = 'array' and jsonb_array_length(documents) <= 10),
  notes text check (char_length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index guests_email_idx on guests (property_id, email) where email is not null;
create index guests_phone_idx on guests (property_id, phone) where phone is not null;

create table reservations (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  reservation_code text not null check (reservation_code ~ '^TRV-[0-9A-Z]{8}$'),
  source text not null check (source in ('TIRVONA','DIRECT','API','AIRBNB','BOOKING_COM','AGODA','WALK_IN','PHONE','AGENT','OTHER','MOCK')),
  external_reservation_id text check (char_length(external_reservation_id) <= 100),
  channel_listing_id uuid,
  idempotency_key text check (char_length(idempotency_key) <= 100),
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','CANCELLED','CHECKED_IN','CHECKED_OUT','NO_SHOW')),
  guest_id uuid not null references guests(id),
  -- Snapshot { firstName, lastName, email, phone } so history survives guest edits.
  guest jsonb not null,
  check_in date not null,
  check_out date not null,
  nights integer not null check (nights between 1 and 90),
  adults integer not null check (adults between 1 and 100),
  children integer not null default 0 check (children between 0 and 100),
  special_requests text check (char_length(special_requests) <= 2000),
  subtotal bigint not null check (subtotal >= 0),
  tax bigint not null check (tax >= 0),
  discount bigint not null default 0 check (discount >= 0),
  total bigint not null check (total >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_paid bigint not null default 0 check (amount_paid >= 0),
  amount_refunded bigint not null default 0 check (amount_refunded >= 0),
  payment_status text not null default 'UNPAID' check (payment_status in ('UNPAID','PARTIALLY_PAID','PAID','CHANNEL_COLLECTED','PARTIALLY_REFUNDED','REFUNDED')),
  -- Unpaid PENDING bookings release their inventory after this instant.
  hold_expires_at timestamptz,
  overbooked boolean not null default false,
  -- Nights on or after this date have been handed back to inventory (cancellation, no-show, early check-out).
  inventory_released_from date,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  status_history jsonb not null default '[]'::jsonb check (jsonb_typeof(status_history) = 'array'),
  cancelled_at timestamptz,
  cancellation_reason text check (char_length(cancellation_reason) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_code_key unique (reservation_code),
  constraint reservations_dates check (check_in < check_out),
  constraint reservations_nights check (nights = (check_out - check_in)),
  constraint reservations_total check (total = subtotal + tax - discount),
  constraint reservations_discount check (discount <= subtotal + tax),
  constraint reservations_refund check (amount_refunded <= amount_paid),
  constraint reservations_ota_external check (source not in ('AIRBNB','BOOKING_COM','AGODA','MOCK') or external_reservation_id is not null)
);
-- OTA idempotency: AIRBNB + ABC123 can exist exactly once.
create unique index reservations_external_key on reservations (source, external_reservation_id) where external_reservation_id is not null;
-- Direct-booking idempotency (client retries).
create unique index reservations_idempotency_key on reservations (property_id, idempotency_key) where idempotency_key is not null;
create index reservations_dates_idx on reservations (property_id, check_in, check_out);
create index reservations_status_idx on reservations (property_id, status, check_in);
create index reservations_guest_idx on reservations (guest_id, check_in desc);
create index reservations_created_idx on reservations (property_id, created_at desc);
-- Sweeper for expired unpaid holds.
create index reservations_hold_idx on reservations (hold_expires_at) where status = 'PENDING' and hold_expires_at is not null;
create index reservations_guest_email_idx on reservations ((guest->>'email'));

create table reservation_rooms (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  position integer not null,
  room_type_id uuid not null references room_types(id),
  room_type_name text not null,
  room_id uuid references rooms(id),
  room_number text,
  quantity integer not null check (quantity between 1 and 100),
  rate_plan_id uuid references rate_plans(id),
  rate_plan jsonb,
  -- [{ date: 'YYYY-MM-DD', amount }] one entry per night, frozen at booking time.
  nightly_rates jsonb not null,
  subtotal bigint not null check (subtotal >= 0),
  tax bigint not null check (tax >= 0),
  total bigint not null check (total >= 0),
  unique (reservation_id, position),
  check (total = subtotal + tax),
  check (room_id is null or quantity = 1)
);
create index reservation_rooms_room_idx on reservation_rooms (room_id) where room_id is not null;
create index reservation_rooms_type_idx on reservation_rooms (room_type_id);

-- ====================================================================== payments

create table payments (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  reservation_id uuid not null references reservations(id),
  provider text not null check (provider in ('RAZORPAY','CASH','BANK_TRANSFER','CHANNEL_COLLECTED','OTHER')),
  provider_payment_id text check (char_length(provider_payment_id) <= 100),
  provider_order_id text check (char_length(provider_order_id) <= 100),
  amount bigint not null check (amount >= 0),
  amount_refunded bigint not null default 0 check (amount_refunded >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'PENDING' check (status in ('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  paid_at timestamptz,
  failure_reason text check (char_length(failure_reason) <= 500),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_refunded <= amount),
  check (provider <> 'RAZORPAY' or provider_order_id is not null or provider_payment_id is not null)
);
create index payments_reservation_idx on payments (reservation_id);
create index payments_order_idx on payments (provider, provider_order_id) where provider_order_id is not null;
-- Gateway webhook idempotency: the same captured payment is recorded once.
create unique index payments_provider_payment_key on payments (provider, provider_payment_id) where provider_payment_id is not null;
create index payments_property_idx on payments (property_id, created_at desc);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  reservation_id uuid not null references reservations(id),
  payment_id uuid not null references payments(id),
  provider text not null check (provider in ('RAZORPAY','CASH','BANK_TRANSFER','CHANNEL_COLLECTED','OTHER')),
  provider_refund_id text check (char_length(provider_refund_id) <= 100),
  amount bigint not null check (amount >= 1),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','PROCESSED','FAILED')),
  reason text check (char_length(reason) <= 500),
  requested_by uuid references users(id),
  processed_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  enqueued_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refunds_reservation_idx on refunds (reservation_id);
create index refunds_payment_idx on refunds (payment_id);
create unique index refunds_provider_refund_key on refunds (provider, provider_refund_id) where provider_refund_id is not null;
create index refunds_queue_idx on refunds (status, created_at);

-- ====================================================================== channels

create table channels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  name text not null,
  kind text not null check (kind in ('MARKETPLACE','DIRECT','OTA')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table channel_connections (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  status text not null default 'DISCONNECTED' check (status in ('DISCONNECTED','CONNECTING','CONNECTED','ERROR','EXPIRED')),
  external_account_id text,
  -- AES-256-GCM envelopes (v1:...). Never plaintext.
  access_token_encrypted text check (access_token_encrypted ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  refresh_token_encrypted text check (refresh_token_encrypted ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  expires_at timestamptz,
  oauth_state_hash text,
  oauth_state_expires_at timestamptz,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, channel)
);
create index channel_connections_oauth_idx on channel_connections (oauth_state_hash) where oauth_state_hash is not null;

create table channel_listings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel_connection_id uuid references channel_connections(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  external_listing_id text not null check (char_length(external_listing_id) <= 100),
  name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE','ARCHIVED')),
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An external listing belongs to exactly one Tirvona property; inbound webhooks route by it.
  unique (channel, external_listing_id)
);
create index channel_listings_property_idx on channel_listings (property_id, channel);
alter table reservations add constraint reservations_listing_fk foreign key (channel_listing_id) references channel_listings(id);

create table channel_room_mappings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  channel_listing_id uuid not null references channel_listings(id),
  external_room_id text,
  room_type_id uuid not null references room_types(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','ARCHIVED')),
  sync_availability boolean not null default true,
  sync_rates boolean not null default true,
  sync_restrictions boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A null externalRoomId counts as a value (one mapping for a one-unit listing).
create unique index channel_room_mappings_key on channel_room_mappings (channel_listing_id, coalesce(external_room_id, ''));
create index channel_room_mappings_fanout_idx on channel_room_mappings (property_id, room_type_id, channel);

create table channel_rate_mappings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  channel_room_mapping_id uuid not null references channel_room_mappings(id) on delete cascade,
  external_rate_plan_id text not null,
  rate_plan_id uuid not null references rate_plans(id),
  markup_type text not null default 'NONE' check (markup_type in ('PERCENTAGE','FIXED','NONE')),
  markup_value numeric(14,2) not null default 0,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_room_mapping_id, external_rate_plan_id),
  check (markup_type <> 'NONE' or markup_value = 0),
  check (markup_type <> 'PERCENTAGE' or markup_value between -90 and 500),
  check (markup_type <> 'FIXED' or markup_value = trunc(markup_value))
);
create index channel_rate_mappings_rate_idx on channel_rate_mappings (property_id, rate_plan_id);

-- ====================================================================== queues, notifications, audit

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK','RAZORPAY')),
  property_id uuid references properties(id),
  event_type text not null check (char_length(event_type) <= 100),
  external_event_id text not null check (char_length(external_event_id) <= 200),
  payload jsonb not null,
  signature text check (char_length(signature) <= 1000),
  signature_valid boolean not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','PROCESSING','PROCESSED','FAILED','IGNORED')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_until timestamptz,
  enqueued_at timestamptz,
  processed_at timestamptz,
  error text check (char_length(error) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_event_id)
);
create index webhook_events_queue_idx on webhook_events (status, created_at);

create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  channel_listing_id uuid references channel_listings(id),
  room_type_id uuid references room_types(id),
  type text not null check (type in ('INVENTORY','RATES','RESTRICTIONS','RESERVATION','LISTING')),
  entity_type text not null check (entity_type in ('ROOM_TYPE','RATE_PLAN','RESERVATION','CHANNEL_LISTING','PROPERTY')),
  entity_id uuid not null,
  date_from date,
  date_to date,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','SUCCESS','FAILED','RETRYING')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  scheduled_at timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  enqueued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text check (char_length(last_error) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_jobs_queue_idx on sync_jobs (status, scheduled_at);
create index sync_jobs_history_idx on sync_jobs (property_id, channel, created_at desc);
create index sync_jobs_purge_idx on sync_jobs (completed_at) where status = 'SUCCESS';

create table sync_logs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  channel text not null check (channel in ('TIRVONA','DIRECT','AIRBNB','BOOKING_COM','AGODA','OTHER','MOCK')),
  sync_job_id uuid references sync_jobs(id) on delete set null,
  action text not null check (char_length(action) <= 100),
  status text not null check (status in ('SUCCESS','FAILED')),
  request_metadata jsonb not null default '{}'::jsonb,
  response_metadata jsonb not null default '{}'::jsonb,
  error text check (char_length(error) <= 4000),
  duration integer not null check (duration >= 0),
  created_at timestamptz not null default now()
);
create index sync_logs_history_idx on sync_logs (property_id, channel, created_at desc);
create index sync_logs_purge_idx on sync_logs (created_at);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  -- Null for account-level messages (password reset / invitation of a user who has no property yet).
  property_id uuid references properties(id),
  user_id uuid references users(id),
  reservation_id uuid references reservations(id),
  type text not null check (type in ('RESERVATION_CREATED','RESERVATION_CONFIRMED','RESERVATION_CANCELLED','CHECKIN_REMINDER','PAYMENT_SUCCESS','PAYMENT_FAILED','CHANNEL_SYNC_FAILED','OVERBOOKING_ALERT','PASSWORD_RESET','GENERAL')),
  channel text not null check (channel in ('EMAIL','SMS','WHATSAPP','IN_APP')),
  recipient text check (char_length(recipient) <= 254),
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','DELIVERED','FAILED','READ')),
  subject text check (char_length(subject) <= 300),
  message text not null check (char_length(message) <= 5000),
  metadata jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  dedupe_key text check (char_length(dedupe_key) <= 200),
  enqueued_at timestamptz,
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (channel <> 'IN_APP' or user_id is not null),
  check (channel = 'IN_APP' or recipient is not null)
);
create index notifications_queue_idx on notifications (status, created_at);
create unique index notifications_dedupe_key on notifications (dedupe_key) where dedupe_key is not null;
create index notifications_inbox_idx on notifications (user_id, created_at desc) where user_id is not null;
create index notifications_reservation_idx on notifications (reservation_id) where reservation_id is not null;

-- Append-only: the trigger rejects UPDATE and DELETE.
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  property_id uuid references properties(id),
  user_id uuid references users(id),
  action text not null check (char_length(action) <= 100),
  entity_type text not null check (char_length(entity_type) <= 60),
  entity_id uuid not null,
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_property_idx on audit_logs (property_id, created_at desc);
create index audit_logs_org_idx on audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);
create or replace function audit_logs_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_logs_no_update before update or delete on audit_logs for each row execute function audit_logs_append_only();

-- ====================================================================== sessions and tokens

-- One row per login (device). Only the SHA-256 of the refresh token is stored.
create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  family_id uuid not null,
  refresh_token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (char_length(revoked_reason) <= 100),
  rotated_at timestamptz,
  ip text check (char_length(ip) <= 64),
  user_agent text check (char_length(user_agent) <= 300),
  last_used_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index auth_sessions_user_idx on auth_sessions (user_id, revoked_at);
create index auth_sessions_family_idx on auth_sessions (family_id);
create index auth_sessions_expiry_idx on auth_sessions (expires_at);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id);
create index password_reset_tokens_expiry_idx on password_reset_tokens (expires_at);

-- ====================================================================== public API

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  property_ids uuid[] not null default '{}' check (cardinality(property_ids) <= 100),
  name text not null check (char_length(name) between 2 and 100),
  prefix text not null unique check (prefix ~ '^[a-z0-9]{8}$'),
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 20),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index api_keys_org_idx on api_keys (organization_id, status);

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  property_ids uuid[] not null default '{}' check (cardinality(property_ids) <= 100),
  url text not null check (char_length(url) <= 2000),
  description text check (char_length(description) <= 300),
  events text[] not null check (cardinality(events) between 1 and 30),
  secret_encrypted text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_endpoints_org_idx on webhook_endpoints (organization_id, status);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_id text not null check (char_length(event_id) <= 80),
  event_type text not null check (char_length(event_type) <= 60),
  body text not null check (char_length(body) <= 200000),
  status text not null default 'PENDING' check (status in ('PENDING','RETRYING','DELIVERED','FAILED')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 12 check (max_attempts between 1 and 50),
  locked_until timestamptz,
  enqueued_at timestamptz,
  last_status_code integer,
  last_error text check (char_length(last_error) <= 2000),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Event emission is idempotent only because of this constraint.
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_queue_idx on webhook_deliveries (status, enqueued_at);
create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_purge_idx on webhook_deliveries (updated_at) where status in ('DELIVERED','FAILED');

-- ====================================================================== triggers, security

do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    where c.table_schema = current_schema() and c.column_name = 'updated_at' and c.table_name <> 'schema_migrations'
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = current_schema() and tablename <> 'schema_migrations' loop
    execute format('alter table %I enable row level security', t);
  end loop;
  -- On Supabase these roles exist; revoke direct table access from the public Data API roles as a second layer.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on all tables in schema %I from anon', current_schema());
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on all tables in schema %I from authenticated', current_schema());
  end if;
end $$;
