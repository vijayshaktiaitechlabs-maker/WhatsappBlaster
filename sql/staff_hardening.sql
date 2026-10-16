-- =====================================================================
-- Staff roles enforced by the database (not only by the admin page)
-- Run ONCE in the Supabase SQL editor, AFTER shakti_admin.sql,
-- shakti_prod_hardening.sql, admin_erp_backend.sql and kb_learning.sql.
-- Idempotent and additive: it replaces policies and functions and adds
-- triggers. No table, column or row is removed or changed.
--
-- The admin page gives each role these rights (PERMS in admin-panel):
--   owner      everything, and the only one who changes WhatsApp/Meta credentials and staff
--   manager    everything except staff and credentials
--   accounts   members, payments, events; no delete, no campaigns, no settings
--   front_desk members, bookings, check-in, events; no money, no delete, no campaigns, no settings
-- Until now the database let every staff role do everything in its club.
-- After this file:
--   * club row (settings, bot texts, payment link, branding): owner and manager only;
--     WhatsApp/Meta credentials: owner only; club code, active, WhatsApp provider: nobody
--     from the browser (Orena and n8n use the service key, which is not affected).
--   * campaigns (broadcasts): every staff role can read; only owner and manager can
--     create, edit, schedule, send or delete. A sent campaign can't be edited again.
--   * deleting members, events, registrations and bookings: owner and manager only.
--   * payments: read by owner, manager and accounts only; member dues are changed by
--     owner, manager and accounts only.
--   * activity log: the database writes who did it and when (not the browser).
--   * event capacity counts registrations saved as 'confirmed' (the older bot) too,
--     and a registration must belong to the same club as its event.
--   * staff: the last owner can't be removed; an invite for an email that already has a
--     login takes effect at once (so removed staff can be re-added and a role changed
--     by inviting again); invite emails are stored in lower case, the latest invite wins.
--   * log_gap (bot only) can no longer be called with the public key.
-- n8n, the SQL editor and Orena's console (service key) are not affected by any trigger
-- below: they only act when a signed-in user (a JWT with a user id) makes the change.
-- =====================================================================

-- Fail fast instead of queuing behind live traffic (only applies inside the editor's transaction).
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 0) The signed-in user making this change, or null for n8n (service key),
--    the SQL editor and database-internal work.
-- ---------------------------------------------------------------------
create or replace function public.jwt_uid() returns uuid
language plpgsql stable set search_path = public as $$
begin
  return auth.uid();
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 1) The club row (tenants)
-- ---------------------------------------------------------------------
drop policy if exists "admin updates own tenant" on public.tenants;
drop policy if exists "owner or manager updates own tenant" on public.tenants;
create policy "owner or manager updates own tenant" on public.tenants
  for update using (public.tenant_role(id) in ('owner', 'manager'))
  with check (public.tenant_role(id) in ('owner', 'manager'));

create or replace function public.tenants_staff_update_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.jwt_uid();
  n jsonb; o jsonb; c text;
begin
  if me is null then return new; end if;
  n := to_jsonb(new); o := to_jsonb(old);
  foreach c in array array['id', 'slug', 'active', 'wa_provider', 'wa_api_key'] loop
    if (n -> c) is distinct from (o -> c) then
      raise exception 'The club code, status and WhatsApp provider can only be changed by Orena (%).', c using errcode = '42501';
    end if;
  end loop;
  if coalesce(public.tenant_role(old.id), '') <> 'owner' then
    foreach c in array array['wa_token', 'wa_phone_number_id', 'wa_waba_id', 'fb_page_id', 'fb_page_token', 'ig_user_id'] loop
      if (n -> c) is distinct from (o -> c) then
        raise exception 'Only the club owner can change the WhatsApp and Meta credentials.' using errcode = '42501';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists tenants_staff_update_guard on public.tenants;
create trigger tenants_staff_update_guard before update on public.tenants
  for each row execute function public.tenants_staff_update_guard();

-- ---------------------------------------------------------------------
-- 2) Campaigns (broadcasts): all staff read, owner/manager write
--    (the scheduler sends every 'scheduled' row, so writing one is sending)
-- ---------------------------------------------------------------------
drop policy if exists "admin manages broadcasts" on public.broadcasts;
drop policy if exists "staff read broadcasts" on public.broadcasts;
create policy "staff read broadcasts" on public.broadcasts
  for select using (public.is_tenant_staff(tenant_id));
drop policy if exists "owner or manager adds broadcasts" on public.broadcasts;
create policy "owner or manager adds broadcasts" on public.broadcasts
  for insert with check (public.tenant_role(tenant_id) in ('owner', 'manager'));
drop policy if exists "owner or manager edits broadcasts" on public.broadcasts;
create policy "owner or manager edits broadcasts" on public.broadcasts
  for update using (public.tenant_role(tenant_id) in ('owner', 'manager'))
  with check (public.tenant_role(tenant_id) in ('owner', 'manager'));
drop policy if exists "owner or manager deletes broadcasts" on public.broadcasts;
create policy "owner or manager deletes broadcasts" on public.broadcasts
  for delete using (public.tenant_role(tenant_id) in ('owner', 'manager'));

-- A campaign that was sent stays as it was sent (the page only offers Report and Duplicate for it).
create or replace function public.broadcasts_sent_lock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'sent' and public.jwt_uid() is not null then
    raise exception 'This campaign was already sent. Duplicate it to send it again.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists broadcasts_sent_lock on public.broadcasts;
create trigger broadcasts_sent_lock before update on public.broadcasts
  for each row execute function public.broadcasts_sent_lock();

-- ---------------------------------------------------------------------
-- 3) Deleting: owner and manager only (members, events, registrations, bookings).
--    A clear error instead of a silent "0 rows". Members using the portal are not staff
--    and keep their own rules.
-- ---------------------------------------------------------------------
create or replace function public.staff_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.jwt_uid() is null then return old; end if;
  r := public.tenant_role(old.tenant_id);
  if r is not null and r not in ('owner', 'manager') then
    raise exception 'Only owners and managers can delete %.', tg_argv[0] using errcode = '42501';
  end if;
  return old;
end;
$$;
drop trigger if exists staff_delete_guard on public.members;
create trigger staff_delete_guard before delete on public.members
  for each row execute function public.staff_delete_guard('members');
drop trigger if exists staff_delete_guard on public.events;
create trigger staff_delete_guard before delete on public.events
  for each row execute function public.staff_delete_guard('events');
drop trigger if exists staff_delete_guard on public.event_registrations;
create trigger staff_delete_guard before delete on public.event_registrations
  for each row execute function public.staff_delete_guard('registrations');
drop trigger if exists staff_delete_guard on public.bookings;
create trigger staff_delete_guard before delete on public.bookings
  for each row execute function public.staff_delete_guard('bookings');

-- ---------------------------------------------------------------------
-- 4) Money: payments readable by owner/manager/accounts; member dues changed only by them
-- ---------------------------------------------------------------------
drop policy if exists pay_read on public.payments;
create policy pay_read on public.payments for select
  using (public.tenant_role(tenant_id) in ('owner', 'manager', 'accounts'));

create or replace function public.members_dues_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.jwt_uid() is null
     or coalesce(public.tenant_role(new.tenant_id), '') in ('owner', 'manager', 'accounts') then
    return new;
  end if;
  if (tg_op = 'INSERT' and coalesce(new.dues_amount, 0) <> 0)
     or (tg_op = 'UPDATE' and coalesce(new.dues_amount, 0) <> coalesce(old.dues_amount, 0)) then
    raise exception 'Only owners, managers and accounts can change dues.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists members_dues_guard on public.members;
create trigger members_dues_guard before insert or update on public.members
  for each row execute function public.members_dues_guard();

-- ---------------------------------------------------------------------
-- 5) Activity log: who and when are set by the database for signed-in users
-- ---------------------------------------------------------------------
create or replace function public.audit_log_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := public.jwt_uid(); em text;
begin
  if me is null then return new; end if;
  select u.email into em from auth.users u where u.id = me;
  if em is null then
    select a.email into em from public.app_admins a where a.user_id = me and a.tenant_id = new.tenant_id limit 1;
  end if;
  new.actor_email := em;
  new.created_at  := now();
  return new;
end;
$$;
drop trigger if exists audit_log_stamp on public.audit_log;
create trigger audit_log_stamp before insert on public.audit_log
  for each row execute function public.audit_log_stamp();

-- ---------------------------------------------------------------------
-- 6) Event registrations: same club as the event; capacity counts 'confirmed' too
--    (the bot before this release saved registrations as 'confirmed'); the event row
--    is locked while seats are counted, so two registrations at once can't both take
--    the last seat.
-- ---------------------------------------------------------------------
create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare cap int; ev_tenant uuid; taken int;
begin
  select capacity, tenant_id into cap, ev_tenant from events where id = new.event_id for update;
  if found and ev_tenant is distinct from new.tenant_id then
    raise exception 'That event belongs to another club.' using errcode = '42501';
  end if;
  if cap is null then return new; end if;
  if coalesce(new.status, 'registered') not in ('registered', 'confirmed') then return new; end if;
  select count(*) into taken from event_registrations
    where event_id = new.event_id and status in ('registered', 'confirmed');
  if taken >= cap then
    new.status := 'waitlist';
  end if;
  return new;
end;
$$;

create or replace function public.event_reg_same_club() returns trigger
language plpgsql security definer set search_path = public as $$
declare ev_tenant uuid;
begin
  if new.event_id is not distinct from old.event_id and new.tenant_id is not distinct from old.tenant_id then
    return new;
  end if;
  select tenant_id into ev_tenant from events where id = new.event_id;
  if found and ev_tenant is distinct from new.tenant_id then
    raise exception 'That event belongs to another club.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists event_reg_same_club on public.event_registrations;
create trigger event_reg_same_club before update of event_id, tenant_id on public.event_registrations
  for each row execute function public.event_reg_same_club();

-- ---------------------------------------------------------------------
-- 7) Staff: invites and the last owner
-- ---------------------------------------------------------------------
-- The club always keeps at least one owner (removing or changing the last one is refused).
create or replace function public.app_admins_keep_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.jwt_uid() is null or lower(coalesce(old.role, '')) <> 'owner' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and lower(coalesce(new.role, '')) = 'owner' and new.tenant_id = old.tenant_id then
    return new;
  end if;
  if not exists (select 1 from public.app_admins a
                  where a.tenant_id = old.tenant_id and lower(a.role) = 'owner' and a.user_id <> old.user_id) then
    raise exception 'The club must keep at least one owner.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists app_admins_keep_owner on public.app_admins;
create trigger app_admins_keep_owner before delete or update of role, tenant_id on public.app_admins
  for each row execute function public.app_admins_keep_owner();

-- Invite emails in lower case, so "A@x.com" and "a@x.com" are one invite (the page's
-- "upsert on tenant_id,email" then updates the role of the existing invite).
create or replace function public.app_admin_invites_normalise() returns trigger
language plpgsql set search_path = public as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;
drop trigger if exists app_admin_invites_normalise on public.app_admin_invites;
create trigger app_admin_invites_normalise before insert or update of email on public.app_admin_invites
  for each row execute function public.app_admin_invites_normalise();

-- After an invite is saved: older invites for the same email in this club go (the latest
-- role wins), and when that email already has a login it gets access at once, with the
-- invited role (this is also how an owner changes someone's role, or re-adds removed staff).
create or replace function public.app_admin_invites_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare u record;
begin
  delete from public.app_admin_invites
   where tenant_id = new.tenant_id and lower(email) = lower(new.email) and id <> new.id;
  select id, email into u from auth.users where lower(email) = lower(new.email) limit 1;
  if found then
    insert into public.app_admins (user_id, tenant_id, role, email)
    values (u.id, new.tenant_id, coalesce(new.role, 'staff'), u.email)
    on conflict (user_id, tenant_id) do update set role = excluded.role, email = coalesce(public.app_admins.email, excluded.email);
    delete from public.app_admin_invites where id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists app_admin_invites_apply on public.app_admin_invites;
create trigger app_admin_invites_apply after insert or update on public.app_admin_invites
  for each row execute function public.app_admin_invites_apply();

-- Sign-up: same as before (link the member row, grant pending invites), but with more
-- than one invite for the email in a club the newest one decides the role.
create or replace function public.link_member_on_signup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- (a) link a pre-created member record to this login by email
  update members
     set user_id = new.id
   where user_id is null
     and email is not null
     and lower(email) = lower(new.email);

  -- (b) if this email was invited as staff, grant admin + clear the invite
  insert into app_admins (user_id, tenant_id, role, email)
  select distinct on (i.tenant_id) new.id, i.tenant_id, coalesce(i.role,'staff'), new.email
  from app_admin_invites i
  where lower(i.email) = lower(new.email)
  order by i.tenant_id, i.created_at desc
  on conflict (user_id, tenant_id) do nothing;

  delete from app_admin_invites where lower(email) = lower(new.email);

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 8) log_gap is for the bot only (service key). On Supabase, "from public" alone
--    leaves the anon and authenticated grants in place.
-- ---------------------------------------------------------------------
revoke all on function public.log_gap(uuid,text,text,float,int,text,text) from public, anon, authenticated;
grant execute on function public.log_gap(uuid,text,text,float,int,text,text) to service_role;

-- Done. Nothing else to run. Staff see a clear message when their role can't do something.
