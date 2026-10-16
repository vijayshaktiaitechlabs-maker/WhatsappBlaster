-- =====================================================================
-- Shared WhatsApp inbox: conversation state kept in the database
-- Run ONCE in the Supabase SQL editor, AFTER wa_memory.sql,
-- admin_erp_backend.sql and wa_message_status.sql. Idempotent and additive:
-- it only ADDS columns, tables, functions, indexes, triggers and policies.
-- No existing column, row or policy is changed or removed. Existing rows
-- only get the new phone_key column filled in.
--
-- What it adds
--  * wa_messages: the WhatsApp message id (wamid, unique), delivery status,
--    who sent it (member / bot / staff / campaign / system / note, and which
--    staff member), and a normalised phone key (phone_key) for grouping.
--  * wa_conversations: one row per club + WhatsApp number, shared by every
--    staff member and device: assignment to a staff member, open/resolved,
--    unread count, bot pause (with who/when), last lead posted by the bot.
--    A trigger keeps it up to date from wa_messages, and re-opens a resolved
--    conversation when the member writes again.
--  * Indexes so a conversation list and a thread can be paged newest-first
--    (no 1,000-row cut-off).
--  * Functions the admin panel calls (they record the acting staff member),
--    and ones the bot and n8n call (service role only).
--
-- Safety: the triggers never make a message insert fail. If one of them
-- hits an error, it logs a warning and the message is still stored.
-- Run at a quiet time: the backfill and the new indexes briefly lock
-- wa_messages (seconds for tens of thousands of rows).
-- If the file stops with "canceling statement due to lock timeout", the
-- messages table was busy: nothing was changed; run it again a minute later.
-- =====================================================================

-- Wait at most 5 seconds for a lock (e.g. on wa_messages while the bot is writing)
-- instead of queuing behind live traffic and making every new message wait too.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 1) One phone format for grouping. Digits only; a 10-digit number gets
--    the 91 country code, as does 0 + 10 digits (the rule the club's
--    tools already use when sending). Meta's "from" (e.g. 919999900001),
--    staff replies (91 + 10 digits) and member phones stored as 10 digits
--    all map to the same key.
-- ---------------------------------------------------------------------
create or replace function public.wa_phone_key(p text) returns text
language sql immutable parallel safe as $$
  select case
           when length(d) = 10 then '91' || d
           when length(d) = 11 and left(d, 1) = '0' then '91' || right(d, 10)
           else d
         end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s
$$;

-- Who sent a message, for rows written without a sender (older rows, and the
-- workflows running before this release): campaigns and staff replies are
-- recognised by the intent those workflows already write; other outgoing
-- rows stay unknown (the Inbox shows them as the bot's).
create or replace function public.wa_sender_kind_guess(p_direction text, p_intent text) returns text
language sql immutable parallel safe as $$
  select case
           when p_direction = 'in'   then 'member'
           when p_direction = 'note' then 'note'
           when p_direction = 'out' and coalesce(p_intent, '') ~* '^(broadcast|campaign)' then 'campaign'
           when p_direction = 'out' and coalesce(p_intent, '') ~* '^(staff_reply|template_reengagement)' then 'staff'
           else null
         end
$$;

-- ---------------------------------------------------------------------
-- 2) wa_messages: new columns (all optional, older rows keep null)
-- ---------------------------------------------------------------------
alter table public.wa_messages
  add column if not exists phone_key      text,          -- wa_phone_key(phone), filled by the trigger below
  add column if not exists wamid          text,          -- WhatsApp message id (in and out)
  add column if not exists status         text,          -- out: sent | delivered | read | failed
  add column if not exists status_at      timestamptz,
  add column if not exists error_code     int,
  add column if not exists error_title    text,
  add column if not exists sender_kind    text,          -- member | bot | staff | campaign | system | note
  add column if not exists sender_user_id uuid,          -- the staff member (staff replies, notes)
  add column if not exists sender_email   text,
  add column if not exists template_name  text,
  add column if not exists media_url      text;

-- existing rows: fill the phone key (and who sent it, where that is known) once
update public.wa_messages
   set phone_key   = public.wa_phone_key(phone),
       sender_kind = coalesce(sender_kind, public.wa_sender_kind_guess(direction, intent))
 where phone_key is null and phone is not null;

-- Meta retries webhooks: the same message can only be stored once
create unique index if not exists wa_msg_wamid_uq        on public.wa_messages (wamid) where wamid is not null;
-- A thread, newest first, paged by (created_at, id)
create index        if not exists wa_msg_key_time_idx    on public.wa_messages (tenant_id, phone_key, created_at desc, id desc);
-- Recent messages of a club (notifications, reports)
create index        if not exists wa_msg_tenant_time_idx on public.wa_messages (tenant_id, created_at desc);
-- Linking a conversation to a member by phone, whatever format the member's phone was typed in
create index        if not exists members_phone_key_idx  on public.members (tenant_id, public.wa_phone_key(phone));

-- ---------------------------------------------------------------------
-- 3) Conversations (one per club + number)
-- ---------------------------------------------------------------------
create table if not exists public.wa_conversations (
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  phone_key            text not null,
  phone                text not null,                 -- the number as the member's WhatsApp sends it (replies go here)
  member_id            uuid references public.members(id) on delete set null,
  last_message_at      timestamptz not null default now(),
  last_message_preview text,
  last_message_dir     text,                          -- in | out
  last_message_kind    text,                          -- member | bot | staff | campaign | system
  last_inbound_at      timestamptz,                   -- starts WhatsApp's 24-hour reply window
  unread_count         int not null default 0,        -- member messages since a staff member last opened it (shared by the team)
  last_read_at         timestamptz,
  last_read_by_email   text,
  status               text not null default 'open',  -- open | resolved
  resolved_at          timestamptz,
  resolved_by_email    text,
  reopened_at          timestamptz,
  assignee_user_id     uuid,
  assignee_email       text,
  assigned_at          timestamptz,
  assigned_by_email    text,
  bot_paused           boolean not null default false, -- paused until a staff member resumes it
  bot_paused_until     timestamptz,                    -- or paused until this time
  bot_paused_at        timestamptz,
  bot_paused_by_email  text,
  bot_pause_reason     text,                           -- manual | staff_reply
  bot_resumed_at       timestamptz,
  bot_resumed_by_email text,
  last_staff_reply_at  timestamptz,
  last_lead_at         timestamptz,                    -- the bot posts a lead at most once a day per topic
  last_lead_intent     text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, phone_key),
  constraint wa_conv_status_chk check (status in ('open', 'resolved'))
);
-- when the bot last posted a lead, per topic: {"membership_enquiry": "2026-09-30T10:00:00Z", ...}
alter table public.wa_conversations add column if not exists last_leads jsonb not null default '{}'::jsonb;
create index if not exists wa_conv_list_idx     on public.wa_conversations (tenant_id, status, last_message_at desc, phone_key desc);
create index if not exists wa_conv_all_idx      on public.wa_conversations (tenant_id, last_message_at desc, phone_key desc);
create index if not exists wa_conv_assignee_idx on public.wa_conversations (tenant_id, assignee_user_id, last_message_at desc);

alter table public.wa_conversations enable row level security;
drop policy if exists wa_conv_read on public.wa_conversations;
create policy wa_conv_read on public.wa_conversations for select
  using (public.is_tenant_staff(tenant_id));
-- No insert/update/delete policies: changes go through the functions below
-- (which record who did what) and through the wa_messages trigger.

-- ---------------------------------------------------------------------
-- 4) Triggers on wa_messages. They never make a message insert fail.
-- ---------------------------------------------------------------------
-- Before a message is stored: its phone key, its sender kind, its member,
-- and for an outgoing message with a WhatsApp id, its status row (so Meta's
-- delivered/read/failed events can be applied) or a status that already arrived.
create or replace function public.wa_msg_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; mid uuid;
begin
  begin
    new.phone_key := public.wa_phone_key(new.phone);
    if tg_op = 'INSERT' then
      if new.sender_kind is null then
        new.sender_kind := public.wa_sender_kind_guess(new.direction, new.intent);
      end if;
      if new.member_id is null and new.phone_key <> '' then
        select m.id into mid from public.members m
         where m.tenant_id = new.tenant_id and public.wa_phone_key(m.phone) = new.phone_key
         order by m.created_at limit 1;
        new.member_id := mid;
      end if;
      if new.direction = 'out' and new.wamid is not null then
        select status, updated_at, error_code, error_title, error_detail into s from public.wa_message_status where wamid = new.wamid;
        if found then
          if new.status is null or new.status = 'sent' then
            new.status := s.status; new.status_at := s.updated_at;
            if s.status = 'failed' then
              new.error_code := coalesce(new.error_code, s.error_code);
              new.error_title := coalesce(new.error_title, s.error_detail, s.error_title);
            end if;
          end if;
        elsif coalesce(new.status, 'sent') <> 'failed' then
          insert into public.wa_message_status (wamid, tenant_id, phone, member_id, status, sent_at, history)
          values (new.wamid, new.tenant_id, new.phone, new.member_id, 'sent', coalesce(new.created_at, now()),
                  jsonb_build_array(jsonb_build_object('status', 'sent', 'at', coalesce(new.created_at, now()))))
          on conflict (wamid) do nothing;
        end if;
        new.status := coalesce(new.status, 'sent');
        new.status_at := coalesce(new.status_at, new.created_at, now());
      end if;
    end if;
  exception when others then
    raise warning 'wa_msg_before_write: % (message stored anyway)', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists wa_msg_before_write on public.wa_messages;
create trigger wa_msg_before_write before insert or update of phone on public.wa_messages
  for each row execute function public.wa_msg_before_write();

-- After a message is stored: keep its conversation up to date.
create or replace function public.wa_conv_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k      text := coalesce(new.phone_key, public.wa_phone_key(new.phone));
  is_in  boolean := new.direction = 'in';
  kind   text := coalesce(new.sender_kind, case when new.direction = 'in' then 'member' end);
begin
  -- internal notes don't move the conversation, change unread or re-open it
  if k is null or k = '' or new.direction = 'note' then return null; end if;
  begin
    insert into public.wa_conversations as c
      (tenant_id, phone_key, phone, member_id, last_message_at, last_message_preview, last_message_dir,
       last_message_kind, last_inbound_at, unread_count, last_staff_reply_at, status)
    values
      (new.tenant_id, k, new.phone, new.member_id, new.created_at, left(coalesce(new.body, ''), 160), new.direction,
       kind, case when is_in then new.created_at end, case when is_in then 1 else 0 end,
       case when kind = 'staff' then new.created_at end,
       -- a campaign message on its own doesn't open a chat; the member's reply will
       case when kind = 'campaign' then 'resolved' else 'open' end)
    on conflict (tenant_id, phone_key) do update set
      -- replies go to the number exactly as the member's WhatsApp sends it
      phone                = case when is_in then new.phone else c.phone end,
      member_id            = coalesce(new.member_id, c.member_id),
      last_message_preview = case when new.created_at >= c.last_message_at then left(coalesce(new.body, ''), 160) else c.last_message_preview end,
      last_message_dir     = case when new.created_at >= c.last_message_at then new.direction else c.last_message_dir end,
      last_message_kind    = case when new.created_at >= c.last_message_at then kind else c.last_message_kind end,
      last_message_at      = greatest(c.last_message_at, new.created_at),
      last_inbound_at      = case when is_in then greatest(coalesce(c.last_inbound_at, new.created_at), new.created_at) else c.last_inbound_at end,
      -- a member message counts as unread; a staff reply means the team has seen the chat
      unread_count         = case when is_in then c.unread_count + 1 when kind = 'staff' then 0 else c.unread_count end,
      last_read_at         = case when kind = 'staff' then now() else c.last_read_at end,
      last_read_by_email   = case when kind = 'staff' then coalesce(new.sender_email, c.last_read_by_email) else c.last_read_by_email end,
      -- the member wrote again: a resolved conversation is open again
      status               = case when is_in and c.status = 'resolved' then 'open' else c.status end,
      reopened_at          = case when is_in and c.status = 'resolved' then now() else c.reopened_at end,
      last_staff_reply_at  = case when kind = 'staff' then greatest(coalesce(c.last_staff_reply_at, new.created_at), new.created_at) else c.last_staff_reply_at end,
      updated_at           = now();
  exception when others then
    raise warning 'wa_conv_on_message: % (message stored anyway)', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists wa_conv_on_message on public.wa_messages;
create trigger wa_conv_on_message after insert on public.wa_messages
  for each row execute function public.wa_conv_on_message();

-- Meta's status events land in wa_message_status (wa_status_apply); copy the
-- current status onto the message so the inbox shows delivered / read / FAILED.
create or replace function public.wa_msg_status_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    update public.wa_messages m set
      status      = new.status,
      status_at   = new.updated_at,
      error_code  = case when new.status = 'failed' then new.error_code else m.error_code end,
      error_title = case when new.status = 'failed' then coalesce(new.error_detail, new.error_title) else m.error_title end
    where m.wamid = new.wamid
      and m.status is distinct from new.status;
  exception when others then
    raise warning 'wa_msg_status_sync: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists wa_msg_status_sync on public.wa_message_status;
create trigger wa_msg_status_sync after insert or update of status on public.wa_message_status
  for each row execute function public.wa_msg_status_sync();

-- A member added (or given a phone number) after the chat exists, e.g. "Add as Member" from
-- the Inbox: link the conversation with that number to them at once. Never makes a member
-- save fail.
create or replace function public.wa_conv_link_member() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  begin
    k := public.wa_phone_key(new.phone);
    if k is not null and k <> '' then
      update public.wa_conversations set member_id = new.id, updated_at = now()
       where tenant_id = new.tenant_id and phone_key = k and member_id is null;
    end if;
  exception when others then
    raise warning 'wa_conv_link_member: % (member saved anyway)', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists wa_conv_link_member on public.members;
create trigger wa_conv_link_member after insert or update of phone on public.members
  for each row execute function public.wa_conv_link_member();

-- ---------------------------------------------------------------------
-- 5) Existing history: one conversation per number, nothing unread.
--    (Assignment and "resolved" were only kept in each browser before, so
--    every existing conversation with a member message starts open and
--    unassigned; numbers that only ever received campaigns start resolved.)
-- ---------------------------------------------------------------------
--    One pass over wa_messages, grouped by number (the earlier version ran three
--    look-ups per message and took minutes on 12,000 messages).
--    Per number: its latest message (not a note), the latest member seen on any of
--    its messages, and the time and number of the latest member message.
insert into public.wa_conversations
  (tenant_id, phone_key, phone, member_id, last_message_at, last_message_preview, last_message_dir,
   last_inbound_at, unread_count, last_read_at, status)
select g.tenant_id, g.phone_key,
       coalesce(g.in_phone, l.phone),
       coalesce(g.member_id,
                (select m.id from public.members m where m.tenant_id = g.tenant_id and public.wa_phone_key(m.phone) = g.phone_key
                  order by m.created_at limit 1)),
       l.created_at, left(coalesce(l.body, ''), 160), l.direction, g.last_in, 0, now(),
       case when g.last_in is null then 'resolved' else 'open' end
from (
  select m.tenant_id, m.phone_key,
         (array_agg(m.id order by m.created_at desc) filter (where m.direction <> 'note'))[1]           as last_id,
         (array_agg(m.member_id order by m.created_at desc) filter (where m.member_id is not null))[1] as member_id,
         max(m.created_at) filter (where m.direction = 'in')                                          as last_in,
         (array_agg(m.phone order by m.created_at desc) filter (where m.direction = 'in'))[1]          as in_phone
  from public.wa_messages m
  where m.phone_key is not null and m.phone_key <> ''
  group by m.tenant_id, m.phone_key
) g
join public.wa_messages l on l.id = g.last_id
on conflict (tenant_id, phone_key) do nothing;

-- ---------------------------------------------------------------------
-- 6) Staff actions (called from the admin panel with the staff member's own
--    login; they record who did it). Every staff role that can open the
--    Inbox may use them.
-- ---------------------------------------------------------------------
create or replace function public.wa_conv_action(
  p_tenant uuid, p_phone text, p_action text, p_value text default null, p_minutes int default null
) returns public.wa_conversations
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  k      text := public.wa_phone_key(p_phone);
  who    text;
  target record;
  r      public.wa_conversations;
begin
  if me is null or public.tenant_role(p_tenant) is null then
    raise exception 'Only staff of this club can change conversations.' using errcode = '42501';
  end if;
  if k is null or k = '' then raise exception 'No phone number given.'; end if;
  select email into who from public.app_admins where user_id = me and tenant_id = p_tenant limit 1;
  insert into public.wa_conversations (tenant_id, phone_key, phone) values (p_tenant, k, p_phone)
  on conflict (tenant_id, phone_key) do nothing;

  if p_action = 'assign' then
    if p_value is null or p_value = '' then
      update public.wa_conversations set assignee_user_id = null, assignee_email = null, assigned_at = now(),
             assigned_by_email = who, updated_at = now()
       where tenant_id = p_tenant and phone_key = k returning * into r;
    else
      select user_id, email into target from public.app_admins where tenant_id = p_tenant and user_id::text = p_value limit 1;
      if not found then raise exception 'That person is not staff of this club.'; end if;
      update public.wa_conversations set assignee_user_id = target.user_id, assignee_email = target.email,
             assigned_at = now(), assigned_by_email = who, updated_at = now()
       where tenant_id = p_tenant and phone_key = k returning * into r;
    end if;
  elsif p_action = 'resolve' then
    update public.wa_conversations set status = 'resolved', resolved_at = now(), resolved_by_email = who, updated_at = now()
     where tenant_id = p_tenant and phone_key = k returning * into r;
  elsif p_action = 'reopen' then
    update public.wa_conversations set status = 'open', reopened_at = now(), updated_at = now()
     where tenant_id = p_tenant and phone_key = k returning * into r;
  elsif p_action = 'pause' then
    -- p_minutes null or <= 0: paused until someone resumes it
    update public.wa_conversations set
           bot_paused       = (p_minutes is null or p_minutes <= 0),
           bot_paused_until = case when p_minutes is null or p_minutes <= 0 then null else now() + make_interval(mins => least(p_minutes, 60 * 24 * 30)) end,
           bot_paused_at = now(), bot_paused_by_email = who, bot_pause_reason = 'manual', updated_at = now()
     where tenant_id = p_tenant and phone_key = k returning * into r;
  elsif p_action = 'resume' then
    update public.wa_conversations set bot_paused = false, bot_paused_until = null,
           bot_resumed_at = now(), bot_resumed_by_email = who, updated_at = now()
     where tenant_id = p_tenant and phone_key = k returning * into r;
  elsif p_action = 'read' then
    update public.wa_conversations set unread_count = 0, last_read_at = now(), last_read_by_email = who, updated_at = now()
     where tenant_id = p_tenant and phone_key = k returning * into r;
  else
    raise exception 'Unknown action %', p_action;
  end if;

  if p_action <> 'read' then
    insert into public.audit_log (tenant_id, actor_email, action, entity, entity_id, detail)
    values (p_tenant, who, 'inbox_' || p_action, 'wa_conversation', k,
            jsonb_strip_nulls(jsonb_build_object('value', p_value, 'minutes', p_minutes)));
  end if;
  return r;
end;
$$;
revoke all on function public.wa_conv_action(uuid, text, text, text, int) from public, anon;
grant execute on function public.wa_conv_action(uuid, text, text, text, int) to authenticated;

-- An internal note, stored with its author (the panel used to insert notes
-- directly, which the table's policies did not allow, so they were lost).
create or replace function public.wa_note_add(p_tenant uuid, p_phone text, p_body text, p_member uuid default null)
returns public.wa_messages
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); who text; r public.wa_messages;
begin
  if me is null or public.tenant_role(p_tenant) is null then
    raise exception 'Only staff of this club can add notes.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'The note is empty.'; end if;
  if length(p_body) > 4000 then
    raise exception 'The note is % characters long; the limit is 4,000. Shorten it and save again.', length(p_body);
  end if;
  select email into who from public.app_admins where user_id = me and tenant_id = p_tenant limit 1;
  -- The phone is stored as "note:<number>": the conversation (phone_key) is the same, but anything that
  -- looks messages up by the exact number, like the bot before this release, never sees internal notes.
  -- The member is found from the number inside this club (p_member is ignored).
  insert into public.wa_messages (tenant_id, phone, member_id, direction, body, msg_type, intent, sender_kind, sender_user_id, sender_email)
  values (p_tenant, 'note:' || regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), null, 'note', left(p_body, 4000), 'text', 'internal_note', 'note', me, who)
  returning * into r;
  return r;
end;
$$;
revoke all on function public.wa_note_add(uuid, text, text, uuid) from public, anon;
grant execute on function public.wa_note_add(uuid, text, text, uuid) to authenticated;

-- Staff of this club, for "Assign to…" (staff other than owners can't read
-- the staff list directly).
create or replace function public.wa_staff_list(p_tenant uuid)
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = public as $$
  select a.user_id, a.email, lower(a.role) from public.app_admins a
  where a.tenant_id = p_tenant and public.tenant_role(p_tenant) is not null
  order by case lower(a.role) when 'owner' then 1 when 'manager' then 2 when 'accounts' then 3 else 4 end, a.email
$$;
revoke all on function public.wa_staff_list(uuid) from public, anon;
grant execute on function public.wa_staff_list(uuid) to authenticated;

-- The conversation list, newest first, one page at a time.
-- p_tab: open | unread | mine | resolved | all. Paging: pass the last row's
-- last_message_at and phone_key as p_before_at / p_before_key.
create or replace function public.wa_inbox_list(
  p_tenant uuid, p_tab text default 'open', p_q text default null,
  p_before_at timestamptz default null, p_before_key text default null, p_limit int default 40
) returns setof jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  lim  int  := least(greatest(coalesce(p_limit, 40), 1), 200);
  tab  text := coalesce(nullif(p_tab, ''), 'open');
  st   text := case when tab = 'resolved' then 'resolved' when tab in ('open', 'unread', 'mine') then 'open' else null end;
  q    text := nullif(btrim(coalesce(p_q, '')), '');
  qd   text := regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g');
  me   uuid := auth.uid();
begin
  -- a name search matches the typed text literally (% and _ are not wildcards)
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  -- "098123 00004": drop the Indian trunk 0, so it matches the stored 91 98123 00004
  if length(qd) = 11 and left(qd, 1) = '0' then qd := substr(qd, 2); end if;
  return query
  select to_jsonb(c) || jsonb_build_object(
           'member_name', m.full_name, 'membership_no', m.membership_no, 'membership_tier', m.membership_tier,
           'member_status', m.status,
           'bot_paused_now', (c.bot_paused or coalesce(c.bot_paused_until > now(), false)))
  from (
    select c0.* from public.wa_conversations c0
    where c0.tenant_id = p_tenant
      and (st is null or c0.status = st)
      and (tab <> 'unread' or c0.unread_count > 0)
      and (tab <> 'mine' or c0.assignee_user_id = me)
      and (p_before_at is null or (c0.last_message_at, c0.phone_key) < (p_before_at, coalesce(p_before_key, '')))
      and (q is null
           or (length(qd) >= 3 and c0.phone_key like '%' || qd || '%')
           or exists (select 1 from public.members mm where mm.id = c0.member_id
                        and (mm.full_name ilike '%' || q || '%' or mm.membership_no ilike '%' || q || '%')))
    order by c0.last_message_at desc, c0.phone_key desc
    limit lim
  ) c
  left join public.members m on m.id = c.member_id
  order by c.last_message_at desc, c.phone_key desc;
end;
$$;
grant execute on function public.wa_inbox_list(uuid, text, text, timestamptz, text, int) to authenticated;

-- Tab counts and the unread badge.
create or replace function public.wa_inbox_counts(p_tenant uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'open',            count(*) filter (where status = 'open'),
    'unread',          count(*) filter (where status = 'open' and unread_count > 0),
    'mine',            count(*) filter (where status = 'open' and assignee_user_id = auth.uid()),
    'resolved',        count(*) filter (where status = 'resolved'),
    'unread_messages', coalesce(sum(unread_count) filter (where status = 'open'), 0))
  from public.wa_conversations where tenant_id = p_tenant
$$;
grant execute on function public.wa_inbox_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7) For n8n (service role only)
-- ---------------------------------------------------------------------
-- The bot asks before replying: is the bot paused for this number, and when
-- did it last post a lead for this topic?
create or replace function public.wa_bot_state(p_tenant uuid, p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object(
      'paused', (c.bot_paused or coalesce(c.bot_paused_until > now(), false)),
      'paused_until', c.bot_paused_until, 'pause_reason', c.bot_pause_reason,
      'last_lead_at', c.last_lead_at, 'last_lead_intent', c.last_lead_intent, 'last_leads', c.last_leads,
      'status', c.status, 'assignee_email', c.assignee_email)
    from public.wa_conversations c
    where c.tenant_id = p_tenant and c.phone_key = public.wa_phone_key(p_phone)),
    jsonb_build_object('paused', false))
$$;
revoke all on function public.wa_bot_state(uuid, text) from public, anon, authenticated;
grant execute on function public.wa_bot_state(uuid, text) to service_role;

-- After a staff reply: pause the bot for the club's configured minutes
-- (a longer pause that is already running is kept), and remember who.
create or replace function public.wa_bot_pause_after_reply(p_tenant uuid, p_phone text, p_minutes int, p_by_email text)
returns void language plpgsql security definer set search_path = public as $$
declare k text := public.wa_phone_key(p_phone);
begin
  if coalesce(p_minutes, 0) <= 0 or k = '' then return; end if;
  insert into public.wa_conversations (tenant_id, phone_key, phone) values (p_tenant, k, p_phone)
  on conflict (tenant_id, phone_key) do nothing;
  update public.wa_conversations set
    bot_paused_until    = greatest(coalesce(bot_paused_until, now()), now() + make_interval(mins => least(p_minutes, 60 * 24))),
    bot_paused_at       = now(),
    bot_paused_by_email = coalesce(p_by_email, bot_paused_by_email),
    bot_pause_reason    = case when bot_paused then bot_pause_reason else 'staff_reply' end,
    updated_at          = now()
  where tenant_id = p_tenant and phone_key = k;
end;
$$;
revoke all on function public.wa_bot_pause_after_reply(uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.wa_bot_pause_after_reply(uuid, text, int, text) to service_role;

-- The bot records that it posted a lead (so it posts at most one a day per topic).
create or replace function public.wa_bot_lead_posted(p_tenant uuid, p_phone text, p_intent text)
returns void language sql security definer set search_path = public as $$
  update public.wa_conversations set last_lead_at = now(), last_lead_intent = p_intent,
         last_leads = coalesce(last_leads, '{}'::jsonb) || jsonb_build_object(coalesce(p_intent, ''), now()),
         updated_at = now()
  where tenant_id = p_tenant and phone_key = public.wa_phone_key(p_phone)
$$;
revoke all on function public.wa_bot_lead_posted(uuid, text, text) from public, anon, authenticated;
grant execute on function public.wa_bot_lead_posted(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 8) Live updates in the admin panel (Supabase Realtime)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'wa_messages') then
      alter publication supabase_realtime add table public.wa_messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'wa_conversations') then
      alter publication supabase_realtime add table public.wa_conversations;
    end if;
  end if;
end $$;

-- Done. Nothing else to run: the inbox and the bot use this as soon as the
-- matching admin panel and n8n workflows are deployed.
