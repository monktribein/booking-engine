-- 0002: partner platform
--   * organization approval lifecycle (PENDING_APPROVAL -> ACTIVE / REJECTED, SUSPENDED)
--   * platform roles OPERATIONS_ADMIN and org role DEVELOPER
--   * property marketplace visibility with explicit owner consent, platform review and platform suspension
--   * API key environment, rotation lineage and per-day usage counters
--   * reservation attribution to an API key and a partner's own reference (idempotent ingestion)
--   * integration requests (a partner asks the platform to enable a channel / integration)
-- Existing rows keep working: every existing organization is ACTIVE, every ACTIVE property was already reachable by its slug.

-- ====================================================================== organizations

alter table organizations drop constraint organizations_status_check;
alter table organizations add constraint organizations_status_check
  check (status in ('PENDING_APPROVAL','ACTIVE','REJECTED','SUSPENDED','ARCHIVED'));
alter table organizations
  add column status_reason text check (char_length(status_reason) <= 500),
  add column status_changed_at timestamptz,
  add column status_changed_by uuid references users(id),
  add column approved_at timestamptz;
update organizations set approved_at = created_at where status = 'ACTIVE';

-- ====================================================================== users

alter table users drop constraint users_role_check;
alter table users add constraint users_role_check
  check (role in ('SUPER_ADMIN','OPERATIONS_ADMIN','PROPERTY_OWNER','PROPERTY_MANAGER','STAFF','RECEPTION','DEVELOPER'));
alter table users drop constraint users_org_required;
alter table users add constraint users_org_required
  check (role in ('SUPER_ADMIN','OPERATIONS_ADMIN') or organization_id is not null);

-- ====================================================================== properties

alter table properties drop constraint properties_status_check;
alter table properties add constraint properties_status_check
  check (status in ('DRAFT','ACTIVE','INACTIVE','SUSPENDED','ARCHIVED'));
alter table properties
  -- The owner may publish the property's own booking page (/booking/<slug>) without joining the marketplace.
  add column direct_booking_enabled boolean not null default false,
  add column marketplace_status text not null default 'NOT_LISTED'
    check (marketplace_status in ('NOT_LISTED','REQUESTED','APPROVED','REJECTED','SUSPENDED')),
  add column marketplace_consent_at timestamptz,
  add column marketplace_consent_by uuid references users(id),
  add column marketplace_reviewed_at timestamptz,
  add column marketplace_reviewed_by uuid references users(id),
  add column marketplace_note text check (char_length(marketplace_note) <= 500),
  add column suspended_reason text check (char_length(suspended_reason) <= 500),
  add column suspended_at timestamptz,
  add constraint properties_marketplace_consent
    check (marketplace_status = 'NOT_LISTED' or (marketplace_consent_at is not null and marketplace_consent_by is not null));
-- Before this migration every ACTIVE property was bookable by its slug. Keep that; the marketplace stays opt-in.
update properties set direct_booking_enabled = true where status = 'ACTIVE';
create index properties_marketplace_idx on properties (marketplace_status) where marketplace_status <> 'NOT_LISTED';

-- ====================================================================== API keys

alter table api_keys
  -- The deployment environment the key was issued in (production, staging, development...). Shown in the portal.
  add column environment text not null default 'production' check (environment ~ '^[a-z]{3,20}$'),
  add column rotated_from uuid references api_keys(id) on delete set null,
  add column last_used_ip text check (char_length(last_used_ip) <= 64);

create table api_key_usage (
  api_key_id uuid not null references api_keys(id) on delete cascade,
  day date not null,
  requests integer not null default 0 check (requests >= 0),
  client_errors integer not null default 0 check (client_errors >= 0),
  server_errors integer not null default 0 check (server_errors >= 0),
  rate_limited integer not null default 0 check (rate_limited >= 0),
  primary key (api_key_id, day)
);

alter table webhook_endpoints
  -- Guest contact details (e-mail, phone, special requests) are in webhook payloads only when the owner turns this on.
  add column include_guest_details boolean not null default false;

-- ====================================================================== reservations

alter table reservations
  add column api_key_id uuid references api_keys(id) on delete set null,
  -- The partner software's own id for the booking. Unique per property: a retry with the same reference is the same booking.
  add column partner_reference text check (char_length(partner_reference) between 1 and 100);
create unique index reservations_partner_ref_key on reservations (property_id, partner_reference) where partner_reference is not null;

-- ====================================================================== integration requests

create table integration_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  property_id uuid references properties(id) on delete set null,
  channel text not null check (channel in ('AIRBNB','BOOKING_COM','AGODA','OTHER')),
  status text not null default 'REQUESTED' check (status in ('REQUESTED','IN_REVIEW','APPROVED','REJECTED','WITHDRAWN')),
  note text check (char_length(note) <= 1000),
  decision_note text check (char_length(decision_note) <= 1000),
  requested_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index integration_requests_org_idx on integration_requests (organization_id, created_at desc);
create index integration_requests_queue_idx on integration_requests (status, created_at);
-- At most one open request per property and channel.
create unique index integration_requests_open_key on integration_requests (coalesce(property_id, organization_id), channel) where status in ('REQUESTED','IN_REVIEW');

-- ====================================================================== triggers and security for the new tables

create trigger integration_requests_set_updated_at before update on integration_requests for each row execute function set_updated_at();

alter table api_key_usage enable row level security;
alter table integration_requests enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on api_key_usage, integration_requests from anon');
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on api_key_usage, integration_requests from authenticated');
  end if;
end $$;
