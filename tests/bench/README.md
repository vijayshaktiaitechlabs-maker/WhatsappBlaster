# Local test bench

Runs the **staging-built** code (`npm run staging:build` output, with the staging guard and simulated WhatsApp)
against an in-memory Postgres (PGlite) loaded with the same SQL as the staging database, including RLS.
Nothing here talks to Supabase, n8n or Meta; the admin page runs in Microsoft Edge with its database,
login, live updates and webhooks answered locally.

```
npm run staging:build                 (from the CRM folder, after any change)
cd tests/bench
npm install                           (once)
npm test                              (all 15 suites, about 30 minutes)
npm run qa                            (only the 11 QA regression suites)
```

| Suite | What it proves |
|---|---|
| `npm run db` | `sql/wa_inbox.sql`: backfill, conversations, unread, reopen, pause, notes, RLS, paging, index use |
| `npm run workflows` | the bot and Broadcast Send code end to end: signature, duplicates, pause, staff reply and auto-pause, 24-hour rule, templates, FAILED, statuses, sheet rows with the same number, payment link |
| `npm run data` | `sql/data/shakti_bot_texts.sql`: only Shakti, only the intended keys, safe twice |
| `npm run browser` | the admin page as staff use it: Inbox, alerts, roles, Settings, Campaigns, phone layout (screenshots in `out/`) |
| `npm run qa` | one regression suite per QA fix group (`qa-*.mjs`): database rules for staff and portal members, workflows, bot, tooling, orena-admin and portal, and each admin page area |

It needs `tools/config.local.json` (the staging section) because the build and the bot read the test phone and
app secret from it. A green bench is not a substitute for the staging test list in STAGING.md.
