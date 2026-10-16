-- Private store for the photos and files members send on WhatsApp (shown in the Inbox).
-- Safe to run again. The bot uploads with the service role; staff read through short-lived signed links.
set local lock_timeout = '5s';

insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', false)
on conflict (id) do nothing;

do $$
begin
  -- Supabase has these columns; the local test bench does not
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    update storage.buckets set file_size_limit = 10485760 where id = 'wa-media';   -- 10 MB, as the bot's own cap
  end if;
  -- staff read only their own club's files: the first folder of each path is the club's id
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists "wa media: staff of the club read" on storage.objects';
    execute $p$create policy "wa media: staff of the club read" on storage.objects for select to authenticated
      using (bucket_id = 'wa-media' and exists (
        select 1 from public.app_admins a where a.user_id = auth.uid() and a.tenant_id::text = split_part(name, '/', 1)))$p$;
  end if;
end $$;
