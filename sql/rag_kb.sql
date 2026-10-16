-- =====================================================================
-- RAG knowledge base for the Orena / Shakti WhatsApp bot
-- Run ONCE in the Supabase SQL editor (Dashboard -> SQL Editor -> Run).
-- Safe to re-run (idempotent). Uses pgvector + Gemini embeddings (768-dim).
-- =====================================================================

-- 1) pgvector extension (Supabase ships it; this just enables it)
create extension if not exists vector;

-- 2) chunk store: one row per bite-sized fact, with its embedding
create table if not exists public.kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  content     text not null,                 -- the fact, in natural language
  source      text,                          -- 'faq' | 'facility' | 'membership' | ...
  meta        jsonb default '{}'::jsonb,      -- optional {name, sport, ...}
  embedding   vector(768),                   -- gemini-embedding-001 @ 768 dims
  created_at  timestamptz default now()
);

create index if not exists kb_chunks_tenant_idx
  on public.kb_chunks (tenant_id);

-- cosine-distance ANN index (fast at scale; harmless while small)
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks using hnsw (embedding vector_cosine_ops);

-- 3) Lock it down. The bot reads via the service_role key (bypasses RLS).
--    No public/anon policy => anon cannot read the KB. (Add a staff-read
--    policy later if an admin-panel "Knowledge" screen needs it.)
alter table public.kb_chunks enable row level security;

-- 4) Similarity search RPC (n8n calls this with the service_role key).
--    p_query is the query embedding as a JSON-array string, cast to vector.
create or replace function public.match_kb(
  p_tenant    uuid,
  p_query     text,
  p_count     int   default 8,
  p_threshold float default 0.35
)
returns table (content text, source text, similarity float)
language sql stable
as $$
  select c.content,
         c.source,
         1 - (c.embedding <=> p_query::vector) as similarity
  from public.kb_chunks c
  where c.tenant_id = p_tenant
    and c.embedding is not null
    and 1 - (c.embedding <=> p_query::vector) > p_threshold
  order by c.embedding <=> p_query::vector
  limit greatest(p_count, 1);
$$;

-- Done. Next: Orena's ingestion script embeds the club's knowledge into
-- kb_chunks, and the bot retrieves from here on every question.
