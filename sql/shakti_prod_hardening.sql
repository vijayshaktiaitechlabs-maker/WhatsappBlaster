-- ============================================================
--  SHAKTI SPORTS CLUB — Admin panel: production hardening
--  Run in Supabase → SQL Editor (after shakti_admin.sql).
--  Adds: Settings-tab write safety, staff management (invite flow),
--  and DB-level robustness guards that protect EVERY writer
--  (portal, bot, admin) — so no member-portal redeploy is needed.
--  Safe & additive. n8n/service_role bypasses RLS and is untouched.
-- ============================================================

-- ============================================================
--  1. SETTINGS TAB — let admins write bot_config safely
--  The tenants table currently has RLS OFF (anon can read/write it).
--  We enable RLS and lock WRITES to tenant admins, while keeping a
--  public SELECT so the live member portal's `select id from tenants`
--  keeps working with NO redeploy.
--  NOTE: public SELECT still exposes wa_token to the anon key (pre-
--  existing; wa_token is null today). Full read-hardening (safe view +
--  portal repoint) is deferred to the WhatsApp go-live milestone.
-- ============================================================
alter table tenants enable row level security;

drop policy if exists "tenants public read" on tenants;
create policy "tenants public read" on tenants
  for select using (true);

drop policy if exists "admin updates own tenant" on tenants;
create policy "admin updates own tenant" on tenants
  for update using (is_tenant_admin(id)) with check (is_tenant_admin(id));

-- ============================================================
--  2. STAFF MANAGEMENT — owners invite/remove other staff logins
--  Direct inserts into app_admins from the browser stay impossible.
--  Instead: an owner creates an INVITE (email + role); when that
--  person signs up in the admin panel, a trigger grants them admin.
--  A signup with no matching invite gets nothing → no escalation.
-- ============================================================

-- denormalised email so the Staff list can show who's who without
-- needing to read auth.users (which the anon key cannot).
alter table app_admins add column if not exists email text;
update app_admins a set email = u.email
  from auth.users u where a.user_id = u.id and a.email is null;

-- is the current user an OWNER of tenant t? (staff-management gate)
create or replace function public.is_tenant_owner(t uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from app_admins a
    where a.user_id = auth.uid() and a.tenant_id = t and a.role = 'owner'
  );
$$;

-- pending invites
create table if not exists app_admin_invites (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete cascade,
  email      text not null,
  role       text default 'staff',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  unique (tenant_id, email)
);
alter table app_admin_invites enable row level security;
drop policy if exists "owner manages invites" on app_admin_invites;
create policy "owner manages invites" on app_admin_invites
  for all using (is_tenant_owner(tenant_id))
          with check (is_tenant_owner(tenant_id));

-- app_admins roster visibility/removal for owners (member self-read stays)
drop policy if exists "owner reads roster" on app_admins;
create policy "owner reads roster" on app_admins
  for select using (is_tenant_owner(tenant_id));
drop policy if exists "owner removes staff" on app_admins;
create policy "owner removes staff" on app_admins
  for delete using (is_tenant_owner(tenant_id));
-- (no INSERT policy: new admins arrive only via the signup trigger below.)

-- ============================================================
--  3. SIGNUP TRIGGER — link members AND grant invited staff
--  Replaces the function from shakti_admin.sql (same trigger binding).
-- ============================================================
create or replace function public.link_member_on_signup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- (a) link a pre-created member record to this login by email
  update members
     set user_id = new.id
   where user_id is null
     and email is not null
     and lower(email) = lower(new.email);

  -- (b) if this email was invited as staff, grant admin + clear the invite
  insert into app_admins (user_id, tenant_id, role, email)
  select new.id, i.tenant_id, coalesce(i.role,'staff'), new.email
  from app_admin_invites i
  where lower(i.email) = lower(new.email)
  on conflict (user_id, tenant_id) do nothing;

  delete from app_admin_invites where lower(email) = lower(new.email);

  return new;
end;
$$;

-- ============================================================
--  4. ROBUSTNESS GUARDS (DB-level → protect portal + bot + admin)
-- ============================================================

-- (a) No double-booking the same court + date + slot (confirmed only).
--     A conflicting insert fails; clients already surface the error.
create unique index if not exists uq_court_slot
  on bookings (tenant_id, resource, booking_date, slot)
  where status = 'confirmed' and kind = 'court';

-- (b) Event capacity → auto-waitlist. When an event is full, new
--     registrations are flipped to 'waitlist' instead of 'registered'.
--     capacity NULL = unlimited. Cancellations free seats automatically.
create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare cap int; taken int;
begin
  select capacity into cap from events where id = new.event_id;
  if cap is null then return new; end if;
  select count(*) into taken from event_registrations
    where event_id = new.event_id and status = 'registered';
  if taken >= cap then
    new.status := 'waitlist';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_event_capacity on event_registrations;
create trigger trg_event_capacity
  before insert on event_registrations
  for each row execute function public.enforce_event_capacity();

-- ============================================================
--  DONE. The initial owner (granted in shakti_admin.sql) can now
--  use the Settings and Staff tabs. To invite the first extra staff
--  member: owner opens Staff → Invite → they sign up in the panel.
-- ============================================================
