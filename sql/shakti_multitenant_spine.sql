-- shakti_multitenant_spine.sql
-- Completes the "tenant spine": per-client integration IDs on the tenants table,
-- so onboarding a client = one row holding all of their channel keys + CRM team.
-- Run AFTER shakti_setup.sql. Idempotent (safe to re-run).

alter table tenants
  add column if not exists espo_team_id  text,                 -- EspoCRM Team ID for this client's leads/tasks
  add column if not exists wa_provider    text default 'meta',  -- 'meta' | '360dialog' | 'wati' | ...
  add column if not exists wa_api_key      text,                -- BSP API key (used when wa_provider != 'meta')
  add column if not exists fb_page_id       text,                -- Facebook Page ID (Messenger inbound routing)
  add column if not exists fb_page_token   text,                -- Facebook Page access token (send side)
  add column if not exists ig_user_id       text;                -- Instagram account ID (inbound routing)

-- Per-client branding for the subdomain-aware portal/admin (name lives in tenants.name)
alter table tenants add column if not exists branding jsonb;

-- Make the lead/contact aggregation multi-tenant (leads/contacts predate the tenant model)
alter table contacts add column if not exists tenant_id uuid references tenants(id);
alter table leads    add column if not exists tenant_id uuid references tenants(id);
create index if not exists idx_contacts_tenant on contacts(tenant_id);
create index if not exists idx_leads_tenant    on leads(tenant_id);

-- Point Shakti at its EspoCRM team (created in the admin UI) + its brand
update tenants
   set espo_team_id = '6a9551e9399faa32a',
       branding = jsonb_build_object(
         'primary',  '#16264B',
         'accent',   '#EC6B2D',
         'brand_2',  '#1E3A6E',
         'logo_mark','S',
         'tagline',  'Where Athletes become Champions'
       )
 where slug = 'shakti';
