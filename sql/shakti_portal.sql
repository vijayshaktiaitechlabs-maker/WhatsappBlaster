-- ============================================================
--  SHAKTI SPORTS CLUB — Member Portal backend
--  Run in Supabase → SQL Editor (after shakti_setup.sql).
--  Adds bookings + links members to secure login + row-level
--  security so a member can ONLY ever see their own data.
-- ============================================================

-- ---------- Link members to secure auth accounts ----------
alter table members add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists idx_members_user on members(user_id);

-- ---------- Bookings (courts + cafe) ----------
create table if not exists bookings (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id) on delete cascade,
  member_id   uuid references members(id) on delete cascade,
  kind        text not null,                 -- 'court' | 'cafe'
  resource    text,                          -- e.g. 'Court 1', 'Cafe table'
  booking_date date not null,
  slot        text,                          -- e.g. '18:00-19:00'
  party_size  int,                           -- for cafe
  guests      int default 0,                 -- guest passes used
  status      text default 'confirmed',      -- confirmed / cancelled
  created_at  timestamptz default now()
);
create index if not exists idx_bookings_member on bookings(member_id);

-- ============================================================
--  ROW-LEVEL SECURITY  (a member sees only THEIR data)
--  n8n uses the service_role key, which BYPASSES RLS, so the
--  bot/pipeline keeps working. These policies govern the
--  browser (anon key) portal only.
-- ============================================================
alter table members            enable row level security;
alter table bookings           enable row level security;
alter table event_registrations enable row level security;
alter table events             enable row level security;

-- a member can read/update only their own member row
drop policy if exists "member reads own" on members;
create policy "member reads own" on members
  for select using (user_id = auth.uid());
drop policy if exists "member updates own" on members;
create policy "member updates own" on members
  for update using (user_id = auth.uid());

-- a member can see + create only their own bookings
drop policy if exists "own bookings read" on bookings;
create policy "own bookings read" on bookings
  for select using (member_id in (select id from members where user_id = auth.uid()));
drop policy if exists "own bookings insert" on bookings;
create policy "own bookings insert" on bookings
  for insert with check (member_id in (select id from members where user_id = auth.uid()));

-- a member can see + create only their own event registrations
drop policy if exists "own regs read" on event_registrations;
create policy "own regs read" on event_registrations
  for select using (member_id in (select id from members where user_id = auth.uid()));
drop policy if exists "own regs insert" on event_registrations;
create policy "own regs insert" on event_registrations
  for insert with check (member_id in (select id from members where user_id = auth.uid()));

-- everyone logged in can READ open events (to register)
drop policy if exists "read open events" on events;
create policy "read open events" on events
  for select using (is_open = true);

-- ---------- Seed a couple of demo events so the portal has content ----------
insert into events (tenant_id, title, kind, description, starts_at, venue, capacity, fee, is_open)
select t.id, 'Weekend Doubles Tournament', 'tournament', 'Open doubles knockout — members & guests welcome.', now() + interval '9 days', 'Shakti Sports Club', 32, 500, true
from tenants t where t.slug='shakti'
on conflict do nothing;
insert into events (tenant_id, title, kind, description, starts_at, venue, capacity, fee, is_open)
select t.id, 'Beginner Coaching Workshop', 'workshop', 'Two-hour coaching clinic for new players.', now() + interval '5 days', 'Court 2', 16, 0, true
from tenants t where t.slug='shakti'
on conflict do nothing;

-- ============================================================
--  AFTER you sign up your first member in the portal, link
--  that login to a member record (edit the email below):
--
--  update members set user_id = (select id from auth.users where email='member@example.com')
--  where phone = '919999999999';
--
--  Or seed a fresh demo member and link in one go:
--  insert into members (tenant_id, full_name, phone, membership_no, membership_tier,
--                       maintenance_paid_till, guest_passes_remaining, wa_opt_in, user_id)
--  select t.id, 'Demo Member', '919999999999', 'SSC-001', 'Gold',
--         current_date + 120, 3, true,
--         (select id from auth.users where email='member@example.com')
--  from tenants t where t.slug='shakti';
-- ============================================================
