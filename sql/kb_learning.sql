-- =====================================================================
-- Learning loop for the Orena / Shakti WhatsApp bot
-- Run ONCE in the Supabase SQL editor. Depends on rag_kb.sql (kb_chunks)
-- and admin_erp_backend.sql (is_tenant_staff / tenant_role). Idempotent.
--
-- The bot logs questions it could NOT answer well (weak retrieval) into
-- kb_gaps. Staff answer them once in the admin console; that Q&A is embedded
-- into kb_chunks (source='learned') and the bot knows it from then on.
-- =====================================================================

create table if not exists public.kb_gaps (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  question       text not null,                 -- the customer's question (verbatim)
  q_norm         text not null,                 -- normalized, for dedupe
  top_similarity float default 0,               -- best retrieval score (0..1)
  num_matches    int   default 0,               -- how many chunks matched at all
  bot_reply      text,                          -- what the bot ended up saying
  phone4         text,                          -- last 4 of the asker (privacy)
  hits           int   not null default 1,      -- how many times asked
  status         text  not null default 'open', -- open | answered | ignored
  answer         text,                          -- the staff-taught answer
  created_at     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  resolved_at    timestamptz
);
create unique index if not exists kb_gaps_uq        on public.kb_gaps(tenant_id, q_norm);
create index        if not exists kb_gaps_tenant_idx on public.kb_gaps(tenant_id, status, last_seen desc);

-- Staff of the tenant can read + update (answer/ignore) their gaps.
-- The bot writes via the service_role key (bypasses RLS) using log_gap().
alter table public.kb_gaps enable row level security;
drop policy if exists kb_gaps_read   on public.kb_gaps;
drop policy if exists kb_gaps_update on public.kb_gaps;
create policy kb_gaps_read   on public.kb_gaps for select using (public.is_tenant_staff(tenant_id));
create policy kb_gaps_update on public.kb_gaps for update using (public.is_tenant_staff(tenant_id));

-- Bot logs a gap; on repeat of the same question, bump the counter.
create or replace function public.log_gap(
  p_tenant uuid, p_q text, p_qnorm text, p_sim float, p_matches int, p_reply text, p_phone4 text
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.kb_gaps(tenant_id,question,q_norm,top_similarity,num_matches,bot_reply,phone4)
  values (p_tenant,p_q,p_qnorm,p_sim,p_matches,p_reply,p_phone4)
  on conflict (tenant_id,q_norm) do update
    set hits           = kb_gaps.hits + 1,
        last_seen      = now(),
        top_similarity = greatest(kb_gaps.top_similarity, excluded.top_similarity),
        num_matches    = excluded.num_matches,
        bot_reply      = excluded.bot_reply,
        question       = excluded.question;
end;$$;

-- Only the bot (service_role) should log gaps; keep anon/authenticated out.
revoke all on function public.log_gap(uuid,text,text,float,int,text,text) from public;
grant execute on function public.log_gap(uuid,text,text,float,int,text,text) to service_role;

-- Done. The console shows open gaps under "Bot Knowledge"; teaching an answer
-- posts to n8n /kb-teach which embeds it into kb_chunks and marks it answered.
