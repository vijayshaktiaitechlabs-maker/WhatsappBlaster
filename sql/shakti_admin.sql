-- ============================================================
--  SHAKTI SPORTS CLUB — Admin panel backend
--  Run in Supabase → SQL Editor (after shakti_setup.sql + shakti_portal.sql).
--
--  Gives club staff a secure, tenant-scoped admin login WITHOUT ever
--  putting the service_role key in the browser. Access is granted by
--  the database: only users listed in app_admins get elevated rights,
--  and only for THEIR tenant. The panel keeps using the public anon key.
--
--  Safe & additive: adds an admin roster + admin RLS policies that
--  OR together with the existing member policies. n8n keeps using the
--  service_role key, which bypasses RLS, so the bot/pipeline is untouched.
-- ============================================================

-- ---------- 1. ADMIN ROSTER ----------
-- One row per (staff login, club). We (Orena) provision these once per
-- client via SQL — the panel itself has NO admin self-signup, so a member
-- can never escalate themselves to admin.
create table if not exists app_admins (
  user_id    uuid references auth.users(id) on delete cascade,
  tenant_id  uuid references tenants(id) on delete cascade,
  role       text default 'admin',           -- 'admin' | 'owner' | 'staff'
  created_at timestamptz default now(),
  primary key (user_id, tenant_id)
);
alter table app_admins enable row level security;

-- an admin may read only their OWN roster rows (so the panel can discover
-- which tenant they manage). No insert/update/delete from the browser.
drop policy if exists "admin reads own roster" on app_admins;
create policy "admin reads own roster" on app_admins
  for select using (user_id = auth.uid());

-- ---------- 2. ADMIN GATE (SECURITY DEFINER — no RLS recursion) ----------
-- Runs as the function owner, so it can read app_admins regardless of the
-- caller's RLS. Returns true iff the current user is an admin for tenant t.
create or replace function public.is_tenant_admin(t uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from app_admins a
    where a.user_id = auth.uid() and a.tenant_id = t
  );
$$;

-- ---------- 3. ADMIN RLS POLICIES (OR with existing member policies) ----------

-- MEMBERS: admin has full CRUD across the whole tenant.
drop policy if exists "admin manages members" on members;
create policy "admin manages members" on members
  for all using (is_tenant_admin(tenant_id))
          with check (is_tenant_admin(tenant_id));

-- EVENTS: admin sees ALL events (incl. closed) and can create/edit/delete.
drop policy if exists "admin manages events" on events;
create policy "admin manages events" on events
  for all using (is_tenant_admin(tenant_id))
          with check (is_tenant_admin(tenant_id));

-- EVENT REGISTRATIONS: admin sees & manages every registration in the tenant.
drop policy if exists "admin manages registrations" on event_registrations;
create policy "admin manages registrations" on event_registrations
  for all using (is_tenant_admin(tenant_id))
          with check (is_tenant_admin(tenant_id));

-- BOOKINGS: admin sees & manages every court/cafe booking in the tenant.
drop policy if exists "admin manages bookings" on bookings;
create policy "admin manages bookings" on bookings
  for all using (is_tenant_admin(tenant_id))
          with check (is_tenant_admin(tenant_id));

-- BROADCASTS: enable RLS (was off) and give admins full control. No anon
-- access — the member portal never touches this table.
alter table broadcasts enable row level security;
drop policy if exists "admin manages broadcasts" on broadcasts;
create policy "admin manages broadcasts" on broadcasts
  for all using (is_tenant_admin(tenant_id))
          with check (is_tenant_admin(tenant_id));

-- ---------- 4. AUTO-LINK MEMBERS ON SIGNUP (hands-off) ----------
-- When a member signs up in the portal, match them to their pre-created
-- member record by email and link the login automatically. This removes
-- the manual "update members set user_id ..." step entirely: the admin
-- just adds a member with an email, the member signs up with that email,
-- and the link happens on its own.
create or replace function public.link_member_on_signup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update members
     set user_id = new.id
   where user_id is null
     and email is not null
     and lower(email) = lower(new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_link_member on auth.users;
create trigger on_auth_user_link_member
  after insert on auth.users
  for each row execute function public.link_member_on_signup();

-- ============================================================
--  PROVISION THE CLUB'S ADMIN LOGIN  (one time, per client)
--  1) Have the club owner create a login. Two easy ways:
--       a) let them sign up once in the member portal, OR
--       b) create the user in Supabase → Authentication → Users
--          → "Add user" → Auto Confirm User.
--  2) Grant them admin on the Shakti tenant (edit the email):
--
--     insert into app_admins (user_id, tenant_id, role)
--     select u.id, t.id, 'owner'
--     from auth.users u, tenants t
--     where u.email = 'owner@shaktisportsclub.com'   -- <-- change
--       and t.slug  = 'shakti'
--     on conflict (user_id, tenant_id) do nothing;
--
--  3) They log in at the /admin/ URL. Done.
-- ============================================================
