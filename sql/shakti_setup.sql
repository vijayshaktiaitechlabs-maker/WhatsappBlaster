-- ============================================================
--  SHAKTI SPORTS CLUB — data foundation
--  Run this in Supabase → SQL Editor (one time).
--  Adds the tables the club's requirements need, plus the
--  multi-tenant routing table so Shakti is "tenant #1".
-- ============================================================

-- ---------- 1. TENANTS (multi-client routing) ----------
-- One row per client. phone_number_id is how an inbound WhatsApp
-- message is matched to the right client + bot config + send token.
create table if not exists tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,               -- 'shakti', 'orena'
  name              text not null,
  wa_phone_number_id text unique,                       -- WhatsApp Cloud API Phone Number ID
  wa_waba_id        text,                               -- WhatsApp Business Account ID
  wa_token          text,                               -- send token (move to a secret store later)
  bot_config        jsonb,                              -- this client's menu/services/faq/events copy
  active            boolean default true,
  created_at        timestamptz default now()
);

-- ---------- 2. MEMBERS (for #4 broadcasting + #1 portal) ----------
create table if not exists members (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  full_name     text,
  phone         text,                                   -- E.164, e.g. 918866948999
  email         text,
  membership_no text,
  membership_tier text,                                 -- e.g. 'Gold', 'Silver'
  status        text default 'active',                  -- active / expired / guest
  wa_opt_in     boolean default false,                  -- consented to broadcasts (WhatsApp policy)
  maintenance_paid_till date,                           -- 'maintenance records' in the brief
  guest_passes_remaining int default 0,                 -- 'guest passes' in the brief
  created_at    timestamptz default now(),
  unique (tenant_id, phone)
);

-- ---------- 3. EVENTS (for #3 event/tournament/workshop registration) ----------
create table if not exists events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete cascade,
  title        text not null,
  kind         text,                                    -- 'tournament' | 'workshop' | 'event'
  description  text,
  starts_at    timestamptz,
  venue        text,
  capacity     int,
  fee          numeric,
  is_open      boolean default true,
  created_at   timestamptz default now()
);

-- ---------- 4. EVENT REGISTRATIONS (bot writes these) ----------
create table if not exists event_registrations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete cascade,
  event_id     uuid references events(id) on delete cascade,
  member_id    uuid references members(id) on delete set null,
  name         text,
  phone        text,
  status       text default 'registered',               -- registered / waitlist / cancelled
  source       text default 'whatsapp',
  created_at   timestamptz default now()
);

-- ---------- 5. BROADCASTS (for #4 — a log + queue of bulk sends) ----------
create table if not exists broadcasts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  title         text,
  template_name text,                                    -- approved WhatsApp template
  body          text,                                    -- rendered/preview text
  audience      text default 'all',                      -- 'all' | tier | segment query
  status        text default 'draft',                    -- draft / sending / sent
  sent_count    int default 0,
  created_at    timestamptz default now(),
  sent_at       timestamptz
);

-- ---------- 6. Seed Shakti as tenant #1 (bot_config filled by the app step) ----------
insert into tenants (slug, name, wa_phone_number_id, active)
values ('shakti', 'Shakti Sports Club', null, true)
on conflict (slug) do nothing;

-- helpful indexes
create index if not exists idx_members_tenant on members(tenant_id);
create index if not exists idx_events_tenant_open on events(tenant_id, is_open);
create index if not exists idx_registrations_event on event_registrations(event_id);
