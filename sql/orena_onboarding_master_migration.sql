-- ============================================================
-- orena_onboarding_master_migration.sql   (idempotent; re-runnable)
-- Reconciles all six onboarding subsystems into the tenant spine.
-- Run AFTER: shakti_setup / _portal / _admin / _prod_hardening /
--            _multitenant_spine .sql
-- Already present on tenants (NOT re-added): wa_phone_number_id (UNIQUE),
--   wa_waba_id, wa_token, wa_provider, wa_api_key, fb_page_id,
--   fb_page_token, ig_user_id, espo_team_id, branding, active(default true).
-- ============================================================

-- 1. TENANT COLUMNS (de-duplicated across all six subsystems) ----------
alter table tenants
  -- espo-provisioning
  add column if not exists espo_role_id         text,
  add column if not exists espo_owner_user_id   text,
  -- channel-connect  (wa_waba_id already exists -> omitted)
  add column if not exists meta_business_id     text,
  add column if not exists wa_token_expires_at  timestamptz,
  add column if not exists fb_token_expires_at  timestamptz,
  add column if not exists ig_token_expires_at  timestamptz,
  add column if not exists li_token             text,
  add column if not exists li_refresh_token     text,
  add column if not exists li_token_expires_at  timestamptz,
  add column if not exists li_account_urn       text,
  add column if not exists li_org_urn           text,
  add column if not exists li_last_poll_at      timestamptz,
  add column if not exists channel_status       jsonb default '{}'::jsonb,
  -- billing-subscription
  add column if not exists plan                 text,
  add column if not exists billing_provider     text default 'razorpay',
  add column if not exists subscription_id      text,
  add column if not exists customer_id          text,
  add column if not exists billing_status       text default 'none',
  add column if not exists billing_email        text,
  add column if not exists trial_ends_at        timestamptz,
  add column if not exists current_period_end   timestamptz,
  add column if not exists billing_updated_at   timestamptz,
  -- onboarding-orchestration (model of record)
  add column if not exists onboarding_stage     text  default 'signup',
  add column if not exists onboarding_status    text  default 'in_progress',
  add column if not exists onboarding_checklist jsonb default '{}'::jsonb,
  add column if not exists onboarding_owner      text,
  add column if not exists onboarding_notes      text,
  add column if not exists provisioned_at        timestamptz,
  add column if not exists went_live_at          timestamptz,
  add column if not exists onboarding_updated_at timestamptz default now();

alter table tenants drop constraint if exists chk_onboarding_stage;
alter table tenants add  constraint chk_onboarding_stage check
  (onboarding_stage in ('signup','config','espo','channels','data','billing','live'));
alter table tenants drop constraint if exists chk_onboarding_status;
alter table tenants add  constraint chk_onboarding_status check
  (onboarding_status in ('in_progress','blocked','paused','live','churned'));
alter table tenants drop constraint if exists chk_billing_status;
alter table tenants add  constraint chk_billing_status check
  (billing_status in ('none','created','authenticated','trialing','active',
                      'past_due','halted','paused','cancelled','completed'));

-- 2. ROUTING INTEGRITY -- inbound resolves tenant by these ids ---------
create unique index if not exists uq_tenants_fb_page      on tenants(fb_page_id)      where fb_page_id      is not null;
create unique index if not exists uq_tenants_ig_user      on tenants(ig_user_id)      where ig_user_id      is not null;
create unique index if not exists uq_tenants_li_account   on tenants(li_account_urn)  where li_account_urn  is not null;
create unique index if not exists uq_tenants_subscription on tenants(subscription_id) where subscription_id is not null;
create index        if not exists idx_tenants_billing     on tenants(billing_status);
create index        if not exists idx_tenants_onboarding  on tenants(onboarding_stage, onboarding_status);
create index        if not exists idx_tenants_li_active   on tenants(li_account_urn) where li_account_urn is not null and active;

-- 3. LEADS -- LinkedIn idempotency + consent capture (GDPR/DPDP) -------
alter table leads   add column if not exists li_lead_id     text;
create unique index if not exists uq_leads_li_lead_id on leads(li_lead_id) where li_lead_id is not null;
alter table leads   add column if not exists consent_source text;
alter table leads   add column if not exists consent_at     timestamptz;
alter table members add column if not exists consent_source text;
alter table members add column if not exists consent_at     timestamptz;

-- 4. BILLING EVENTS -- idempotency + audit ledger ---------------------
create table if not exists billing_events (
  event_id text primary key, provider text default 'razorpay',
  event_type text, subscription_id text,
  tenant_id uuid references tenants(id) on delete set null,
  payload jsonb, received_at timestamptz default now());
create index if not exists idx_billing_events_tenant on billing_events(tenant_id);
create index if not exists idx_billing_events_sub    on billing_events(subscription_id);
alter table billing_events enable row level security;   -- no public policy; service_role bypasses

-- 5. OPS ADMINS -- cross-tenant ops gate (browser dashboard) ----------
create table if not exists ops_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text, created_at timestamptz default now());
alter table ops_admins enable row level security;
drop policy if exists "ops self read" on ops_admins;
create policy "ops self read" on ops_admins for select using (user_id = auth.uid());
create or replace function public.is_ops() returns boolean
  language sql security definer stable set search_path=public as $$
  select exists (select 1 from ops_admins where user_id = auth.uid()); $$;

-- 6. ONBOARDING STATE MACHINE (checklist = model of record) -----------
create or replace function public.derive_onboarding_stage(cl jsonb)
returns text language sql immutable as $$
  select case
    when coalesce((cl->>'go_live_approved')::bool,false)        then 'live'
    when not coalesce((cl->>'intake_received')::bool,false)     then 'signup'
    when not coalesce((cl->>'config_provisioned')::bool,false)  then 'config'
    when not coalesce((cl->>'espo_team_created')::bool,false)   then 'espo'
    when not (coalesce((cl->>'wa_connected')::bool,false)
           or coalesce((cl->>'fb_connected')::bool,false)
           or coalesce((cl->>'ig_connected')::bool,false))      then 'channels'
    when not coalesce((cl->>'admin_login_created')::bool,false) then 'data'
    else 'billing' end; $$;

create or replace function public.tg_sync_onboarding()
returns trigger language plpgsql as $$
begin
  new.onboarding_checklist := coalesce(new.onboarding_checklist,'{}'::jsonb);
  -- billing_status is authoritative -> derive checklist.billing_active from it
  if new.billing_status in ('trialing','active','past_due') then
     new.onboarding_checklist := jsonb_set(new.onboarding_checklist,'{billing_active}','true'::jsonb);
  elsif new.billing_status in ('halted','cancelled','paused','completed') then
     new.onboarding_checklist := jsonb_set(new.onboarding_checklist,'{billing_active}','false'::jsonb);
  end if;
  new.onboarding_stage      := public.derive_onboarding_stage(new.onboarding_checklist);
  new.onboarding_updated_at := now();
  if coalesce((new.onboarding_checklist->>'config_provisioned')::bool,false)
     and new.provisioned_at is null then new.provisioned_at := now(); end if;
  if new.onboarding_stage = 'live' and new.went_live_at is null then
     new.went_live_at := now(); new.onboarding_status := 'live'; end if;
  return new;
end; $$;
drop trigger if exists trg_sync_onboarding on tenants;
create trigger trg_sync_onboarding
  before insert or update of onboarding_checklist, billing_status on tenants
  for each row execute function public.tg_sync_onboarding();

-- 7. PROTECT SYSTEM-OWNED COLUMNS from tenant-admin writes -------------
--    (gate on current_user so migrations/postgres are NOT frozen)
create or replace function public.protect_tenant_system_cols()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if current_user not in ('service_role','postgres','supabase_admin') then
    new.active:=old.active; new.billing_status:=old.billing_status;
    new.billing_provider:=old.billing_provider; new.subscription_id:=old.subscription_id;
    new.customer_id:=old.customer_id; new.plan:=old.plan;
    new.current_period_end:=old.current_period_end; new.trial_ends_at:=old.trial_ends_at;
    new.onboarding_stage:=old.onboarding_stage; new.onboarding_status:=old.onboarding_status;
    new.onboarding_checklist:=old.onboarding_checklist; new.went_live_at:=old.went_live_at;
    new.provisioned_at:=old.provisioned_at;
    -- secret channel columns: block tenant-admin edits (defense in depth)
    new.wa_token:=old.wa_token; new.wa_api_key:=old.wa_api_key;
    new.fb_page_token:=old.fb_page_token; new.li_token:=old.li_token;
    new.li_refresh_token:=old.li_refresh_token;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_tenant on tenants;   -- fires BEFORE trg_sync_ (p<s)
create trigger trg_protect_tenant before update on tenants
  for each row execute function public.protect_tenant_system_cols();

-- 8. READ MODELS + RLS READ-HARDENING ---------------------------------
create or replace view public.tenants_public as   -- portal/admin read this (NO secrets)
  select id, slug, name, branding, active, plan, billing_status,
         onboarding_status, wa_provider from tenants;
grant select on public.tenants_public to anon, authenticated;

create or replace view public.tenant_onboarding as  -- ops read model (service_role/RPC only; NOT granted to anon)
  select id as tenant_id, slug, name, onboarding_stage, onboarding_status,
         onboarding_checklist, onboarding_owner, onboarding_notes,
         provisioned_at, went_live_at, onboarding_updated_at,
         active, billing_status, plan, channel_status, espo_team_id from tenants;

-- 9. ONE-CALL OPS ROLLUP (dashboard) = model-of-record + live counts ---
create or replace function public.onboarding_rollup()
returns table (id uuid, slug text, name text, active boolean,
  onboarding_stage text, onboarding_status text, onboarding_checklist jsonb,
  billing_status text, plan text, went_live_at timestamptz, provisioned_at timestamptz,
  espo_team_id text, channel_status jsonb,
  has_wa boolean, has_fb boolean, has_ig boolean, has_li boolean,
  members_count bigint, leads_count bigint, last_lead_at timestamptz,
  events_count bigint, broadcasts_count bigint, created_at timestamptz)
language plpgsql security definer stable set search_path=public as $$
begin
  if not public.is_ops() then raise exception 'not authorized' using errcode='42501'; end if;
  return query select t.id,t.slug,t.name,t.active,
    t.onboarding_stage,t.onboarding_status,t.onboarding_checklist,
    t.billing_status,t.plan,t.went_live_at,t.provisioned_at,t.espo_team_id,t.channel_status,
    (t.wa_phone_number_id is not null and (case when coalesce(t.wa_provider,'meta')='meta'
        then t.wa_token else t.wa_api_key end) is not null),
    (t.fb_page_id is not null and t.fb_page_token is not null),
    (t.ig_user_id is not null),
    (t.li_account_urn is not null and t.li_token is not null),
    (select count(*) from members m where m.tenant_id=t.id),
    (select count(*) from leads   l where l.tenant_id=t.id),
    (select max(l.created_at) from leads l where l.tenant_id=t.id),
    (select count(*) from events  e where e.tenant_id=t.id),
    (select count(*) from broadcasts b where b.tenant_id=t.id),
    t.created_at
  from tenants t order by t.created_at desc;
end; $$;
revoke all on function public.onboarding_rollup() from public, anon;
grant execute on function public.onboarding_rollup() to authenticated;

-- 10. BACKFILL Shakti (tenant #1) to a truthful state -----------------
update tenants set onboarding_checklist = jsonb_build_object(
   'intake_received',true,'config_provisioned',true,
   'espo_team_created', espo_team_id is not null,'espo_role_assigned', espo_team_id is not null,
   'admin_login_created',true,'wa_connected', wa_token is not null,
   'members_imported', exists(select 1 from members m where m.tenant_id=tenants.id),
   'billing_active',false,'go_live_approved',false)
 where slug='shakti';
update tenants set active=true where slug='shakti';   -- live pilot, no subscription yet
insert into ops_admins (user_id,email)
  select id,email from auth.users where email='subscription@shakti.one'
  on conflict (user_id) do nothing;

-- 11. DANGER -- DO NOT run the next line until member-portal + admin-panel
--     are repointed to tenants_public AND verified loading (Build step T3).
--     Dropping it early strands the portals; running it late leaks wa_token.
-- drop policy if exists "tenants public read" on tenants;
