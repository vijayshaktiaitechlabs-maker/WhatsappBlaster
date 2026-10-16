-- =====================================================================
-- Conversation memory + per-member chat history for the WhatsApp bot
-- Run ONCE in the Supabase SQL editor. Depends on admin_erp_backend.sql
-- (is_tenant_staff). Idempotent. Until it's run, the bot stays stateless
-- (no memory) but nothing breaks — reads/writes are best-effort.
--
-- Every inbound + outbound WhatsApp message is stored here, linked to the
-- member (by phone) when known. The bot reads the last ~8 messages per
-- number for context (so it stops re-greeting and understands follow-ups),
-- and staff can see each member's chat history.
-- =====================================================================

create table if not exists public.wa_messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  phone      text not null,                                   -- sender (WhatsApp id)
  member_id  uuid references public.members(id) on delete set null,  -- matched member, if any
  direction  text not null,                                   -- in | out
  body       text,
  msg_type   text default 'text',                             -- text | interactive | image
  intent     text,
  created_at timestamptz not null default now()
);
create index if not exists wa_msg_conv_idx   on public.wa_messages(tenant_id, phone, created_at desc);
create index if not exists wa_msg_member_idx on public.wa_messages(member_id, created_at desc);

-- Staff can read their tenant's conversations (for a per-member history view).
-- The bot reads/writes via the service_role key (bypasses RLS).
alter table public.wa_messages enable row level security;
drop policy if exists wa_msg_read on public.wa_messages;
create policy wa_msg_read on public.wa_messages for select using (public.is_tenant_staff(tenant_id));

-- Done. Refresh nothing else — the bot picks this up automatically.
