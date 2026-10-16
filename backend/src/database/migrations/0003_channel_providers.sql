-- 0003: database-backed channel providers (configuration-driven integrations)
--   * channel_providers / channel_provider_versions: provider registry with immutable published definitions
--   * channel_connection_secrets: per-connection encrypted credentials of any kind (API key, basic, header, signing secret...)
--   * channel_connections: pinned provider version, per-connection polling settings and cursor, webhook key
--   * the fixed channel CHECK lists become foreign keys to channel_providers(code), so a new provider is a row, not a migration
--   * external ids become connection-scoped through `external_scope` (zero uuid = the historic global scope), so two tenants
--     can use the same external listing / reservation / event id without colliding or leaking
-- Everything is additive and defaults reproduce the previous behaviour: existing rows get the zero scope, built-in providers are
-- seeded with the exact codes that were allowed before. Forward-only; see docs/CHANNEL_FRAMEWORK.md for verification and recovery.

-- ====================================================================== providers

create table channel_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('MARKETPLACE','DIRECT','OTA','PMS','PAYMENT','TEST')),
  protocol text not null default 'CODE' check (protocol in ('INTERNAL','CODE','REST_JSON','ICAL','CSV','XML','SOAP')),
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','DISABLED')),
  visibility text not null default 'PLATFORM' check (visibility in ('PLATFORM','PRIVATE')),
  owner_organization_id uuid references organizations(id),
  -- Registered TypeScript adapter that serves this provider (protocol CODE). Null for configuration-driven providers.
  adapter_key text check (adapter_key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  built_in boolean not null default false,
  current_version_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_providers_private_owner check (visibility = 'PLATFORM' or owner_organization_id is not null)
);
create index channel_providers_owner_idx on channel_providers (owner_organization_id) where owner_organization_id is not null;

create table channel_provider_versions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references channel_providers(id),
  version integer not null check (version >= 1),
  status text not null default 'DRAFT' check (status in ('DRAFT','VALIDATED','PUBLISHED','RETIRED')),
  definition jsonb not null,
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  validation jsonb,
  notes text check (char_length(notes) <= 1000),
  created_by uuid references users(id),
  published_by uuid references users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_id, version),
  constraint channel_provider_versions_published check (status not in ('PUBLISHED','RETIRED') or published_at is not null)
);
alter table channel_providers add constraint channel_providers_current_version_fk foreign key (current_version_id) references channel_provider_versions(id);

-- A published definition never changes (connections pin it); only its status may move to RETIRED.
create function channel_provider_versions_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('PUBLISHED','RETIRED') then raise exception 'published provider versions cannot be deleted'; end if;
    return old;
  end if;
  if old.status in ('PUBLISHED','RETIRED') then
    if new.definition is distinct from old.definition or new.definition_hash is distinct from old.definition_hash
       or new.version is distinct from old.version or new.provider_id is distinct from old.provider_id then
      raise exception 'published provider versions are immutable';
    end if;
    if old.status = 'RETIRED' and new.status <> 'RETIRED' then raise exception 'a retired provider version cannot be reactivated'; end if;
    if new.status not in ('PUBLISHED','RETIRED') then raise exception 'a published provider version cannot return to draft'; end if;
  end if;
  return new;
end $$;
create trigger channel_provider_versions_immutable before update or delete on channel_provider_versions
  for each row execute function channel_provider_versions_immutable();

-- Built-in providers: exactly the codes that the old CHECK constraints allowed (plus RAZORPAY for webhook_events).
insert into channel_providers (code, name, kind, protocol, status, adapter_key, built_in) values
  ('TIRVONA', 'Tirvona marketplace', 'MARKETPLACE', 'INTERNAL', 'ACTIVE', null, true),
  ('DIRECT', 'Direct booking engine', 'DIRECT', 'INTERNAL', 'ACTIVE', null, true),
  ('AIRBNB', 'Airbnb', 'OTA', 'CODE', 'ACTIVE', 'AIRBNB', true),
  ('BOOKING_COM', 'Booking.com', 'OTA', 'CODE', 'ACTIVE', 'BOOKING_COM', true),
  ('AGODA', 'Agoda', 'OTA', 'CODE', 'ACTIVE', 'AGODA', true),
  ('OTHER', 'Other', 'OTA', 'CODE', 'ACTIVE', null, true),
  ('MOCK', 'Mock OTA (tests only)', 'TEST', 'CODE', 'ACTIVE', 'MOCK', true),
  ('ICAL', 'iCal calendar feed', 'OTA', 'ICAL', 'ACTIVE', 'ICAL', true),
  ('RAZORPAY', 'Razorpay', 'PAYMENT', 'INTERNAL', 'ACTIVE', null, true);

-- ====================================================================== fixed channel lists -> provider references

do $$
declare r record;
begin
  -- Drop the column-level CHECKs that enumerate channel codes (names are system generated, so find them by definition).
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid::regclass::text in ('channels','channel_connections','channel_listings','channel_room_mappings','channel_rate_mappings','webhook_events','sync_jobs','sync_logs')
      and pg_get_constraintdef(c.oid) like '%''AIRBNB''%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
  -- reservations.source: any provider code is a valid source now; keep the shape check.
  for r in
    select c.conname from pg_constraint c
    where c.contype = 'c' and c.conrelid = 'reservations'::regclass
      and pg_get_constraintdef(c.oid) like '%''AIRBNB''%' and c.conname <> 'reservations_ota_external'
  loop
    execute format('alter table reservations drop constraint %I', r.conname);
  end loop;
end $$;

alter table channel_connections add constraint channel_connections_channel_fk foreign key (channel) references channel_providers(code);
alter table channel_listings add constraint channel_listings_channel_fk foreign key (channel) references channel_providers(code);
alter table channel_room_mappings add constraint channel_room_mappings_channel_fk foreign key (channel) references channel_providers(code);
alter table channel_rate_mappings add constraint channel_rate_mappings_channel_fk foreign key (channel) references channel_providers(code);
alter table webhook_events add constraint webhook_events_channel_fk foreign key (channel) references channel_providers(code);
alter table sync_jobs add constraint sync_jobs_channel_fk foreign key (channel) references channel_providers(code);
alter table sync_logs add constraint sync_logs_channel_fk foreign key (channel) references channel_providers(code);

alter table reservations add constraint reservations_source_shape check (source ~ '^[A-Z][A-Z0-9_]{1,31}$');
-- Same rule as before for the old OTAs, extended to every provider-originated source: staff/guest/API sources are exempt.
alter table reservations drop constraint reservations_ota_external;
alter table reservations add constraint reservations_ota_external
  check (source in ('TIRVONA','DIRECT','API','WALK_IN','PHONE','AGENT','OTHER') or external_reservation_id is not null);

-- ====================================================================== connection-scoped external ids

alter table channel_listings add column external_scope uuid not null default '00000000-0000-0000-0000-000000000000';
alter table channel_listings drop constraint channel_listings_channel_external_listing_id_key;
alter table channel_listings add constraint channel_listings_scoped_key unique (channel, external_scope, external_listing_id);

alter table webhook_events add column external_scope uuid not null default '00000000-0000-0000-0000-000000000000';
alter table webhook_events drop constraint webhook_events_channel_external_event_id_key;
alter table webhook_events add constraint webhook_events_scoped_key unique (channel, external_scope, external_event_id);

alter table reservations add column external_scope uuid not null default '00000000-0000-0000-0000-000000000000';
drop index reservations_external_key;
create unique index reservations_external_scoped_key on reservations (source, external_scope, external_reservation_id) where external_reservation_id is not null;

-- ====================================================================== connections

alter table channel_connections
  add column provider_id uuid references channel_providers(id),
  add column provider_version_id uuid references channel_provider_versions(id),
  add column account_label text check (char_length(account_label) <= 100),
  add column poll_interval_seconds integer check (poll_interval_seconds between 60 and 86400),
  add column poll_cursor jsonb,
  add column last_poll_at timestamptz,
  add column last_poll_error text check (char_length(last_poll_error) <= 2000),
  add column webhook_key text unique check (webhook_key ~ '^[A-Za-z0-9_-]{32,64}$');
update channel_connections c set provider_id = p.id from channel_providers p where p.code = c.channel;
create index channel_connections_provider_idx on channel_connections (provider_id);

-- Per-connection credentials of any kind, always an AES-256-GCM envelope (same format as the token columns).
create table channel_connection_secrets (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references channel_connections(id) on delete cascade,
  kind text not null check (kind in ('API_KEY','BASIC_USERNAME','BASIC_PASSWORD','BEARER_TOKEN','CUSTOM_HEADER','OAUTH_CLIENT_SECRET','WEBHOOK_SECRET','SIGNING_SECRET','FEED_URLS')),
  name text not null default '' check (char_length(name) <= 100),
  ciphertext text not null check (ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (connection_id, kind, name)
);

-- ====================================================================== reconciliation

create table reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references channel_connections(id),
  property_id uuid not null references properties(id),
  status text not null default 'RUNNING' check (status in ('RUNNING','COMPLETED','FAILED')),
  window_from date not null,
  window_to date not null,
  remote_count integer,
  local_count integer,
  issue_count integer not null default 0,
  error text check (char_length(error) <= 2000),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index reconciliation_runs_connection_idx on reconciliation_runs (connection_id, started_at desc);

create table reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references reconciliation_runs(id) on delete cascade,
  connection_id uuid not null references channel_connections(id),
  property_id uuid not null references properties(id),
  kind text not null check (kind in ('MISSING_LOCAL','MISSING_REMOTE','STATUS_MISMATCH','DATE_MISMATCH','UNMAPPED','INGEST_FAILED')),
  external_reservation_id text check (char_length(external_reservation_id) <= 100),
  reservation_id uuid references reservations(id),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','IGNORED')),
  resolution text check (char_length(resolution) <= 500),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index reconciliation_issues_open_idx on reconciliation_issues (property_id, status, created_at desc);
create unique index reconciliation_issues_dedupe on reconciliation_issues (connection_id, kind, coalesce(external_reservation_id, ''), coalesce(reservation_id, '00000000-0000-0000-0000-000000000000')) where status = 'OPEN';

-- Provider dry-run / conformance results (no secrets are ever stored here).
create table channel_provider_tests (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references channel_providers(id),
  version_id uuid references channel_provider_versions(id),
  environment text not null check (environment in ('SANDBOX','PRODUCTION','LOCAL_FAKE')),
  passed boolean not null,
  results jsonb not null default '[]'::jsonb,
  run_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Availability calendars Tirvona publishes for other platforms to import (iCal). The token is shown once; only its hash is stored.
create table ical_export_feeds (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  room_type_id uuid not null references room_types(id),
  label text check (char_length(label) <= 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz,
  revoked_at timestamptz
);
create index ical_export_feeds_property_idx on ical_export_feeds (property_id) where revoked_at is null;

-- RLS is enabled everywhere in this schema with no policies (Supabase exposes `public` through PostgREST).
alter table channel_providers enable row level security;
alter table channel_provider_versions enable row level security;
alter table channel_connection_secrets enable row level security;
alter table reconciliation_runs enable row level security;
alter table reconciliation_issues enable row level security;
alter table channel_provider_tests enable row level security;
alter table ical_export_feeds enable row level security;
