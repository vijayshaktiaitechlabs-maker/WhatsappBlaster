-- =====================================================================
-- WhatsApp message-status tracking (sent → delivered → read / failed)
-- Run ONCE in the Supabase SQL editor. Depends on admin_erp_backend.sql
-- (is_tenant_staff). Idempotent, additive only.
--
-- One row per outbound WhatsApp message (keyed by its WhatsApp id, "wamid").
-- n8n creates the row when the message is accepted, and applies every status
-- event Meta sends to the webhook afterwards. Events can arrive out of order
-- (a "read" before its "delivered"), so a status never moves backwards and
-- every event is kept in `history`.
--
-- wa_webhook_config holds the two secrets the webhook needs. It has RLS on
-- and NO policies: only n8n (service role) can read it, the browser cannot.
-- =====================================================================

create table if not exists public.wa_webhook_config (
  tenant_id    uuid primary key references public.tenants(id) on delete cascade,
  app_secret   text,          -- Meta app secret: verifies X-Hub-Signature-256 on every event
  verify_token text,          -- the string Meta echoes back when the webhook is first connected
  updated_at   timestamptz not null default now()
);
alter table public.wa_webhook_config enable row level security;

create table if not exists public.wa_message_status (
  wamid            text primary key,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  broadcast_id     uuid references public.broadcasts(id) on delete set null,   -- null for test sends
  phone            text,
  member_id        uuid references public.members(id) on delete set null,
  status           text not null default 'sent',        -- sent | delivered | read | failed
  sent_at          timestamptz,
  delivered_at     timestamptz,
  read_at          timestamptz,
  failed_at        timestamptz,
  error_code       int,
  error_title      text,
  error_detail     text,
  history          jsonb not null default '[]'::jsonb,   -- [{status, at, code?, title?, detail?}] in arrival order
  conversation_id  text,
  pricing_category text,                                 -- marketing | utility | … (from Meta's pricing block)
  billable         boolean,
  updated_at       timestamptz not null default now()
);
create index if not exists wa_status_broadcast_idx on public.wa_message_status(broadcast_id, status);
create index if not exists wa_status_tenant_idx    on public.wa_message_status(tenant_id, updated_at desc);
create index if not exists wa_status_phone_idx     on public.wa_message_status(tenant_id, phone);

-- Staff can read (the report); only n8n writes, through the function below.
alter table public.wa_message_status enable row level security;
drop policy if exists wa_status_read on public.wa_message_status;
create policy wa_status_read on public.wa_message_status for select
  using (public.is_tenant_staff(tenant_id));

-- Applies one event. p_create=true only from the send path: an event for a
-- message we never sent is ignored, so nobody can invent messages.
create or replace function public.wa_status_apply(
  p_wamid text, p_tenant uuid, p_status text, p_at timestamptz,
  p_broadcast uuid default null, p_phone text default null, p_member uuid default null,
  p_code int default null, p_title text default null, p_detail text default null,
  p_conv text default null, p_category text default null, p_billable boolean default null,
  p_create boolean default false
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz := coalesce(p_at, now());
  cur  public.wa_message_status%rowtype;
  newrank int; currank int; v_fail boolean;
begin
  select * into cur from public.wa_message_status where wamid = p_wamid;
  -- a status event only ever touches a message of the club it came in for
  if found and cur.tenant_id is distinct from p_tenant then return; end if;
  if not found then
    if not p_create then return; end if;
    insert into public.wa_message_status (wamid, tenant_id, broadcast_id, phone, member_id, status)
    values (p_wamid, p_tenant, p_broadcast, p_phone, p_member, 'sent');
    select * into cur from public.wa_message_status where wamid = p_wamid;
  end if;
  -- Meta retries webhooks: the exact same event twice changes nothing
  if cur.history @> jsonb_build_array(jsonb_build_object('status', p_status, 'at', v_at)) then return; end if;
  currank := case cur.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 9 else 0 end;
  -- "failed" only counts before delivery: a message that reached the phone cannot become failed
  v_fail  := p_status = 'failed' and currank < 2;
  newrank := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else case when v_fail then 9 else 0 end end;
  update public.wa_message_status s set
    broadcast_id     = coalesce(s.broadcast_id, p_broadcast),
    phone            = coalesce(s.phone, p_phone),
    member_id        = coalesce(s.member_id, p_member),
    history          = s.history || jsonb_strip_nulls(jsonb_build_object('status', p_status, 'at', v_at, 'code', p_code, 'title', p_title, 'detail', p_detail)),
    sent_at          = case when p_status = 'sent'      then coalesce(s.sent_at, v_at)      else s.sent_at      end,
    delivered_at     = case when p_status = 'delivered' then coalesce(s.delivered_at, v_at) else s.delivered_at end,
    read_at          = case when p_status = 'read'      then coalesce(s.read_at, v_at)      else s.read_at      end,
    failed_at        = case when v_fail                 then coalesce(s.failed_at, v_at)    else s.failed_at    end,
    error_code       = case when v_fail then coalesce(p_code, s.error_code)     else s.error_code   end,
    error_title      = case when v_fail then coalesce(p_title, s.error_title)   else s.error_title  end,
    error_detail     = case when v_fail then coalesce(p_detail, s.error_detail) else s.error_detail end,
    conversation_id  = coalesce(p_conv, s.conversation_id),
    pricing_category = coalesce(p_category, s.pricing_category),
    billable         = coalesce(p_billable, s.billable),
    status           = case when newrank > currank then p_status else s.status end,
    updated_at       = now()
  where s.wamid = p_wamid;
end;
$$;
-- only n8n (service key) may call it: on Supabase, "from public" alone leaves the anon and authenticated grants
revoke all on function public.wa_status_apply(text,uuid,text,timestamptz,uuid,text,uuid,int,text,text,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.wa_status_apply(text,uuid,text,timestamptz,uuid,text,uuid,int,text,text,text,text,boolean,boolean) to service_role;

-- Let the admin panel's open report refresh itself the moment a status lands.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'wa_message_status') then
    alter publication supabase_realtime add table public.wa_message_status;
  end if;
end $$;

-- Done. Point Meta's webhook at the n8n "WhatsApp Status" workflow (path wa-status, see
-- STAGING.md), store the app secret and verify token in wa_webhook_config, and the campaign
-- report fills in by itself.
