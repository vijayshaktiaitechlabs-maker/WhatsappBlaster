-- =====================================================================
-- The club's own WhatsApp templates (Campaigns page)
-- Run ONCE in the Supabase SQL editor. Depends on admin_erp_backend.sql
-- (is_tenant_staff / tenant_role). Idempotent, additive only — touches
-- no existing table, row or policy.
--
-- Each row is one template the club writes itself: an opening, the
-- message, an optional sign-off and an optional poster image. It is
-- submitted to Meta through n8n for review; once Meta approves it, it
-- can be sent like the club's other approved templates. Nothing is added
-- around the text — members receive exactly what was approved.
--
-- Editing an approved template submits a new version; the approved one
-- keeps working in campaigns until Meta approves the update.
-- =====================================================================

create table if not exists public.wa_custom_templates (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,                   -- display name, e.g. "Court maintenance notice"
  opening         text,                            -- editable opening / header text
  body            text not null default '',        -- the main message
  signature       text,                            -- editable sign-off
  use_signature   boolean not null default true,   -- include the sign-off or not
  category        text not null default 'MARKETING',-- MARKETING | UTILITY (Meta may reclassify)
  vars            jsonb not null default '[]',     -- [{k,label,def,example}] for {{1}}, {{2}}…
  has_image       boolean not null default false,  -- poster image header
  image_url       text,                            -- example / default poster
  meta_status     text not null default 'DRAFT',   -- DRAFT | PENDING | APPROVED | REJECTED | PAUSED | DISABLED
  rejected_reason text,
  submitted_at    timestamptz,
  pending         jsonb,                           -- the version currently with Meta for review
  versions        jsonb not null default '[]',     -- approved versions, newest last (old campaigns keep resolving)
  status          text not null default 'active',  -- active | archived (hidden from the Campaigns page)
  source_tpl      text,                            -- approved club template it was copied from, if any
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, name)
);
-- upgrades for databases created from earlier drafts of this file
alter table public.wa_custom_templates add column if not exists opening         text;
alter table public.wa_custom_templates add column if not exists signature       text;
alter table public.wa_custom_templates add column if not exists use_signature   boolean not null default true;
alter table public.wa_custom_templates add column if not exists category        text not null default 'MARKETING';
alter table public.wa_custom_templates add column if not exists vars            jsonb not null default '[]';
alter table public.wa_custom_templates add column if not exists image_url       text;
alter table public.wa_custom_templates add column if not exists meta_status     text not null default 'DRAFT';
alter table public.wa_custom_templates add column if not exists rejected_reason text;
alter table public.wa_custom_templates add column if not exists submitted_at    timestamptz;
alter table public.wa_custom_templates add column if not exists pending         jsonb;
alter table public.wa_custom_templates add column if not exists versions        jsonb not null default '[]';
create index if not exists wa_ctpl_tenant_idx on public.wa_custom_templates(tenant_id, status, updated_at desc);

-- Removing a template (status 'archived') frees its name for a new template: the removed row is
-- renamed "<name> (removed <date time>)". Campaigns find their template by its Meta name, not this one.
create or replace function public.wa_ctpl_free_name() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'archived' and old.status is distinct from 'archived' and new.name = old.name then
    new.name := left(new.name, 150) || ' (removed ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') || ')';
  end if;
  return new;
end;
$$;
drop trigger if exists wa_ctpl_free_name on public.wa_custom_templates;
create trigger wa_ctpl_free_name before update of status on public.wa_custom_templates
  for each row execute function public.wa_ctpl_free_name();

-- Staff can read; only owners & managers (the roles allowed to broadcast)
-- can create, edit or archive. n8n/service_role bypasses RLS as usual.
alter table public.wa_custom_templates enable row level security;
drop policy if exists ctpl_read  on public.wa_custom_templates;
create policy ctpl_read  on public.wa_custom_templates for select
  using (public.is_tenant_staff(tenant_id));
drop policy if exists ctpl_write on public.wa_custom_templates;
create policy ctpl_write on public.wa_custom_templates for insert
  with check (public.tenant_role(tenant_id) in ('owner','manager'));
drop policy if exists ctpl_update on public.wa_custom_templates;
create policy ctpl_update on public.wa_custom_templates for update
  using (public.tenant_role(tenant_id) in ('owner','manager'));
drop policy if exists ctpl_delete on public.wa_custom_templates;
create policy ctpl_delete on public.wa_custom_templates for delete
  using (public.tenant_role(tenant_id) in ('owner','manager'));

-- Done. Refresh the admin panel — "+ New template" appears in Campaigns, Step 3.
