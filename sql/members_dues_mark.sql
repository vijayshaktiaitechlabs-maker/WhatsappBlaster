-- A manual "dues pending / paid" mark on a member, set by staff from the Inbox or the member form.
-- Safe to run again. NULL means "automatic": the CRM decides from the dues amount and the paid-till date, as before.
set local lock_timeout = '5s';

alter table public.members add column if not exists dues_pending   boolean;       -- true = pending, false = paid, null = automatic
alter table public.members add column if not exists dues_marked_at timestamptz;   -- when the mark was last changed
alter table public.members add column if not exists dues_marked_by text;          -- the staff member who changed it

-- Only owners, managers and accounts may change dues (amount or mark); the change is stamped with who and when.
create or replace function public.members_dues_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  money_role boolean := public.jwt_uid() is null
    or coalesce(public.tenant_role(new.tenant_id), '') in ('owner', 'manager', 'accounts');
  mark_changed boolean := (tg_op = 'INSERT' and new.dues_pending is not null)
    or (tg_op = 'UPDATE' and new.dues_pending is distinct from old.dues_pending);
begin
  if not money_role then
    if (tg_op = 'INSERT' and coalesce(new.dues_amount, 0) <> 0)
       or (tg_op = 'UPDATE' and coalesce(new.dues_amount, 0) <> coalesce(old.dues_amount, 0))
       or mark_changed then
      raise exception 'Only owners, managers and accounts can change dues.' using errcode = '42501';
    end if;
    -- the stamp is the database's, never the caller's
    if tg_op = 'UPDATE' then new.dues_marked_at := old.dues_marked_at; new.dues_marked_by := old.dues_marked_by; end if;
    return new;
  end if;
  if mark_changed then
    new.dues_marked_at := now();
    new.dues_marked_by := coalesce((select u.email from auth.users u where u.id = public.jwt_uid()), 'system');
  elsif tg_op = 'UPDATE' then
    new.dues_marked_at := old.dues_marked_at; new.dues_marked_by := old.dues_marked_by;
  end if;
  return new;
end;
$$;
drop trigger if exists members_dues_guard on public.members;
create trigger members_dues_guard before insert or update on public.members
  for each row execute function public.members_dues_guard();
