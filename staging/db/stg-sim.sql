-- STAGING ONLY (appended to 1-structure.sql by tools/build-staging.mjs; never part of sql/ or live).
-- What the test copy would have sent: WhatsApp messages and template submissions in "simulated Meta"
-- mode, the bot's lead posts, and every request to the AI (so tests can read the prompt).
-- RLS on and no policies: only the service key (the n8n test workflows and the test tools) can use it.
create table if not exists public.stg_outbox (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null,          -- meta_message | meta_template_submit | lead | ai_prompt | ai_embed
  workflow   text,
  node       text,
  target     text,
  phone      text,
  msg_type   text,
  wamid      text,
  payload    jsonb not null default '{}'::jsonb
);
create index if not exists stg_outbox_time_idx on public.stg_outbox (created_at desc);
alter table public.stg_outbox enable row level security;
