-- ============================================================================
-- Broadcast backend upgrade — per-recipient delivery tracking (OPTIONAL)
-- Safe to run once; all ADD COLUMN / CREATE are IF NOT EXISTS.
-- Enables Delivered/Read/Failed in the campaign report once the WhatsApp
-- status webhook is wired. The campaign page already works without this.
-- Run in the Supabase SQL editor.
-- ============================================================================

-- 1) Richer columns on the campaign row -------------------------------------
alter table public.broadcasts add column if not exists scheduled_at   timestamptz;
alter table public.broadcasts add column if not exists audience_count  integer default 0;
alter table public.broadcasts add column if not exists delivered_count integer default 0;
alter table public.broadcasts add column if not exists read_count      integer default 0;
alter table public.broadcasts add column if not exists failed_count    integer default 0;
alter table public.broadcasts add column if not exists created_by      text;
alter table public.broadcasts add column if not exists config          jsonb default '{}'::jsonb;

-- 2) One row per recipient (the delivery ledger) ----------------------------
create table if not exists public.broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  broadcast_id  uuid not null references public.broadcasts(id) on delete cascade,
  member_id     uuid references public.members(id) on delete set null,
  phone         text,
  wamid         text,                    -- WhatsApp message id, from the send response
  status        text not null default 'pending',  -- pending|sent|delivered|read|failed
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists brc_broadcast_idx on public.broadcast_recipients(broadcast_id);
create index if not exists brc_wamid_idx     on public.broadcast_recipients(wamid);
create unique index if not exists brc_once_idx
  on public.broadcast_recipients(broadcast_id, member_id);  -- idempotency: one send per member per campaign

-- 3) RLS: recipients readable by the tenant's admins ------------------------
alter table public.broadcast_recipients enable row level security;

drop policy if exists brc_admin_read on public.broadcast_recipients;
create policy brc_admin_read on public.broadcast_recipients
  for select using (
    exists (select 1 from public.app_admins a
            where a.user_id = auth.uid() and a.tenant_id = broadcast_recipients.tenant_id)
  );
-- Writes are done by the n8n sender using the service_role key (bypasses RLS).

-- 4) Keep updated_at fresh ---------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists brc_touch on public.broadcast_recipients;
create trigger brc_touch before update on public.broadcast_recipients
  for each row execute function public.touch_updated_at();
