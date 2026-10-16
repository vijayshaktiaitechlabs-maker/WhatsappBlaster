-- Bot Knowledge: files the club's staff taught the bot from (a notice, rule book, timetable, poster).
-- Safe to run again. Depends on rag_kb.sql (kb_chunks) and staff_hardening.sql (tenant_role).
-- The file itself is NOT stored: only the facts staff approved, as rows of kb_chunks that point at their file.
set local lock_timeout = '5s';

create table if not exists public.kb_files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  mime          text,
  size_bytes    integer,
  status        text not null default 'reading',   -- reading | review | learned | failed | removed
  summary       text,
  facts_found   integer not null default 0,
  facts_blocked integer not null default 0,         -- left out: a price, a number, payment or member data
  facts_saved   integer not null default 0,
  uploaded_by   text,
  created_at    timestamptz not null default now(), -- also counts toward the club's daily upload limit
  learned_at    timestamptz
);
create index if not exists kb_files_tenant_day_idx on public.kb_files (tenant_id, created_at desc);

alter table public.kb_chunks add column if not exists file_id uuid references public.kb_files(id) on delete cascade;
create index if not exists kb_chunks_file_idx on public.kb_chunks (file_id) where file_id is not null;

-- Staff of the club may READ the list and what the bot learned from each file. All writes go through the
-- "KB Files" workflow (service role), which checks the login, the role, the daily limit and the content.
alter table public.kb_files enable row level security;
drop policy if exists kb_files_staff_read on public.kb_files;
create policy kb_files_staff_read on public.kb_files for select to authenticated
  using (public.tenant_role(tenant_id) is not null);
drop policy if exists kb_chunks_file_staff_read on public.kb_chunks;
create policy kb_chunks_file_staff_read on public.kb_chunks for select to authenticated
  using (file_id is not null and public.tenant_role(tenant_id) is not null);
revoke insert, update, delete on public.kb_files from anon, authenticated;
