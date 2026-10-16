-- ============================================================================
-- Admin ERP backend — Payments/dues, Attendance/check-in, Audit log, member notes
-- Powers the upgraded admin console (payments ledger, check-in, reports, RBAC audit).
-- Safe to run once; ADD COLUMN / CREATE ... IF NOT EXISTS throughout.
-- Run in the Supabase SQL editor. Until it's run, those admin features degrade
-- gracefully (show a "run the migration" note) — nothing else breaks.
-- ============================================================================

-- 0) Member columns: real dues + a freeform note + a flag + last check-in -----
alter table public.members add column if not exists dues_amount     numeric(12,2) default 0;
alter table public.members add column if not exists notes           text;
alter table public.members add column if not exists flag            text;          -- e.g. vip | risk | new
alter table public.members add column if not exists last_checkin_at timestamptz;

-- helper: is the current user an admin of this tenant (optionally in a role set)?
create or replace function public.is_tenant_staff(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins a
                 where a.user_id = auth.uid() and a.tenant_id = t);
$$;
create or replace function public.tenant_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select lower(a.role) from public.app_admins a
   where a.user_id = auth.uid() and a.tenant_id = t
   order by case lower(a.role) when 'owner' then 1 when 'manager' then 2
            when 'accounts' then 3 when 'front_desk' then 4 else 5 end
   limit 1;
$$;

-- 1) PAYMENTS ledger ---------------------------------------------------------
create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  member_id   uuid references public.members(id) on delete set null,
  amount      numeric(12,2) not null default 0,
  method      text default 'cash',        -- cash | card | upi | bank | other
  purpose     text default 'membership',  -- membership | dues | booking | cafe | event | other
  note        text,
  receipt_no  text,
  paid_at     timestamptz not null default now(),
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists pay_tenant_idx on public.payments(tenant_id, paid_at desc);
create index if not exists pay_member_idx on public.payments(member_id);

alter table public.payments enable row level security;
drop policy if exists pay_read  on public.payments;
drop policy if exists pay_write on public.payments;
-- read: any staff of the tenant
create policy pay_read on public.payments for select
  using (public.is_tenant_staff(tenant_id));
-- write: owner / manager / accounts only (front_desk cannot touch money)
create policy pay_write on public.payments for insert
  with check (public.tenant_role(tenant_id) in ('owner','manager','accounts'));
create policy pay_update on public.payments for update
  using (public.tenant_role(tenant_id) in ('owner','manager','accounts'));
create policy pay_delete on public.payments for delete
  using (public.tenant_role(tenant_id) in ('owner','manager'));

-- 2) ATTENDANCE / check-in ---------------------------------------------------
create table if not exists public.attendance (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  member_id    uuid references public.members(id) on delete set null,
  event_id     uuid references public.events(id) on delete set null,
  kind         text default 'visit',      -- visit | court | cafe | event
  checked_in_at timestamptz not null default now(),
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists att_tenant_idx on public.attendance(tenant_id, checked_in_at desc);
create index if not exists att_member_idx on public.attendance(member_id);

alter table public.attendance enable row level security;
drop policy if exists att_read  on public.attendance;
drop policy if exists att_write on public.attendance;
create policy att_read  on public.attendance for select using (public.is_tenant_staff(tenant_id));
create policy att_write on public.attendance for insert with check (public.is_tenant_staff(tenant_id));
create policy att_del   on public.attendance for delete using (public.tenant_role(tenant_id) in ('owner','manager'));

-- 3) AUDIT LOG (who did what) ------------------------------------------------
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  actor_email text,
  action      text,                        -- created | updated | deleted | sent | checked_in | paid ...
  entity      text,                        -- member | payment | booking | event | broadcast ...
  entity_id   text,
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_tenant_idx on public.audit_log(tenant_id, created_at desc);

alter table public.audit_log enable row level security;
drop policy if exists audit_read  on public.audit_log;
drop policy if exists audit_write on public.audit_log;
-- everyone on staff can write their own actions; only owner/manager can read the trail
create policy audit_write on public.audit_log for insert with check (public.is_tenant_staff(tenant_id));
create policy audit_read  on public.audit_log for select using (public.tenant_role(tenant_id) in ('owner','manager'));

-- 4) app_admins role check constraint (documents the 4 roles) ----------------
-- roles used by the console: owner, manager, accounts, front_desk (+ legacy 'staff'=front_desk)
-- (left unconstrained to avoid breaking existing rows; the app maps 'staff' -> front_desk)

-- Done. The console auto-detects these tables; run once and refresh the panel.
