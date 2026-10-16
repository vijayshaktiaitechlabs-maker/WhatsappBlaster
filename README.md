# WhatsApp Blaster

A WhatsApp messaging product for any organisation with a contact list:

- **Campaigns**: send approved WhatsApp templates (or your own, submitted to Meta from the console) to a filtered
  contact list or an uploaded Excel/CSV sheet, personalised per person, with posters, test sends, scheduling,
  batches with a double-send guard, and a live delivery report (sent, delivered, read, replied, failed with the
  reason in plain words, resend to the failed).
- **One-to-one messages**: staff reply to any contact from the shared Inbox: free text inside WhatsApp's 24-hour
  window, an approved template outside it.
- **Shared team Inbox**: every WhatsApp chat for the whole team, with assignment, internal notes, quick replies,
  photos, documents, voice notes, contact cards, locations, and live updates.
- **WhatsApp AI bot**: answers contacts day and night from the organisation's own information, in English, Hindi or
  Gujarati, with a menu, payment QR/UPI on request, hand-over to staff and automatic pause when staff reply.
- **Bot Knowledge**: questions the bot could not answer, taught in one line or from a file or note, reviewed by staff.

It is built from the WhatsApp half of Shakti One CRM, which is live for Shakti Sports Club since 2 October 2026.
Every feature above is live and tested there.

## Where this repository comes from

Made on 16 October 2026 as a clean copy of `C:\ShaktiAItechlabs\ShaktiOneCRM` (commit `9ff180c`, the code live for
Shakti Sports Club since 12 October 2026), with a fresh git history. Differences from that repository:

| Change | Why |
|---|---|
| Every key in the code replaced by a placeholder: `__SUPABASE_URL__`, `__SUPABASE_ANON_KEY__`, `__SUPABASE_SERVICE_KEY__`, `__GEMINI_KEY__`, `__CONFIRM_TOKEN__` | The originals are Shakti's live keys. `tools/build-staging.mjs` fills the placeholders with the test copy's values and refuses to finish if one is left |
| Deploys switched off: `tools/targets.json` has `"deployEnabled": false`, no server, no SSH key, no live workflow ids; `prod:*` and `staging:deploy` stop with a message | A copy must never be able to change Shakti's live system. Switch on only when the product has its own server, n8n and database |
| New `blaster` preset in the console (`INDUSTRY_PRESETS.blaster`): wording "Contact/Contacts", modules Inbox, Contacts, Campaigns, Bot Knowledge, Staff, Settings | So a customer sees only the WhatsApp product |
| Removed (the code split): the member portal, the ops console, Shakti's guides and test pages, the live schema snapshot, Shakti's live runbook (`GO-LIVE.md`), the handover document with live keys, the ops dashboard, document generators, the live admin-page server files, `.mcp.json` | Shakti-only or secret-bearing |
| The bench reads its settings from `OPS_CONFIG` when set; two checks that read Shakti's git history now use equivalent local inputs | The bench runs in this repository |

Shakti Sports Club's live system keeps being deployed from `ShaktiOneCRM`. A fix made in one repository must be
carried to the other by hand until both run from one codebase.

## Set up on a new PC

1. Node.js 18 or newer, Git, Microsoft Edge (the bench drives it).
2. `git clone` this repository.
3. Copy `tools/config.example.json` to `tools/config.local.json` and fill in the **staging** block with a separate
   Supabase test project and a Meta test number (see `STAGING.md`). Never use a live project. Values come from the
   release owner through the company password manager.
4. `npm run staging:build` builds the test copy into `.staging-build/`.
5. `npm run staging:preview` opens it at `http://localhost:8787/admin/`.
6. `cd tests/bench`, `npm install`, `npm test` runs every automated suite (about 30 minutes; nothing real is called).

To use settings kept elsewhere without copying them: set `OPS_CONFIG` to that file's path.

## Folder map

```
admin-panel/      the console (one HTML file): Inbox, Contacts, Campaigns, Bot Knowledge, Staff, Settings, ...
*_wf*.json        the six n8n workflows: Broadcast Send, Broadcast Scheduler, WhatsApp Bot, WhatsApp Status,
                  File Upload Relay, KB Files
sql/              the database, in the order listed in staging/db/schema-files.txt
tools/            build, preview, simulator; deploy tools (switched off here)
staging/          test-copy recipe: schema order, test data, simulation table
tests/bench/      automated suites (in-memory database, staging-built code, the page in Edge)
tests/staging-real/  real sends through a Meta test number to test phones only
```

## Known limits before a second customer

- Broadcast Send and the Scheduler serve only the tenant `shakti` today (hard-coded); a second organisation needs
  that changed first.
- The built-in template list, sample texts and test data are Shakti's.
- The Dashboard and parts of Settings still show club fields (dues, facilities) even with the `blaster` preset.
- Three workflows the console calls run on Shakti's live n8n but are not in this repository: KB Teach,
  Staff Invite, Dues Broadcast.

