# Real-Meta tests on STAGING

These tests use the **real** staging setup: the staging page (preview), the staging Supabase, the `[STAGING]` n8n workflows, Meta's **test** number and **your own test phones**. They send real WhatsApp messages (to phones in `staging.testPhones` only) and check the result from Meta's own delivery reports and the staging database, not from what the page shows.

They refuse to run against the live project or with `staging.whatsapp.simulate: true`.

## Before the first run
1. `tools/config.local.json` → `staging.whatsapp` holds the Meta TEST app values and `simulate: false`; `staging.testPhones` lists the verified phones. (STAGING-FULL.md)
2. The system user's token must be able to send: Business settings → System users → Assign assets → the test WhatsApp account (full control). The app must be subscribed to the test account (`POST /{waba}/subscribed_apps`).
3. `npm run staging:build`, `npm run staging:deploy`.
4. `node tests/staging-real/create-qa-login.mjs` (creates a QA owner login in staging; saved to `tools/qa-login.local.json`, gitignored).
5. For the Excel test, save a sheet as `staging/test-sheets/campaign-test.xlsx` (gitignored: it holds phone numbers) with the columns **Name, Mobile, Due** and these rows: your phone ₹500; the same phone in another format ₹700; your second test phone; `910000000001`; `12345`.
6. Start the preview on a free port: `$env:PORT=8788; node tools/preview.mjs` (separate window).

## Run (about 15 minutes; the scheduling check waits for the scheduler's 5-minute run)
```
$env:PORT=8788
node tests/staging-real/inbox-campaign.mjs                   # bot, Inbox ticks, blocked number, Excel campaign, report
node tests/staging-real/poster-payment-template-schedule.mjs # poster image, payment link, template submit, scheduling
```
Results are printed and saved in `tests/staging-real/out/`.

A second phone must be added to Meta's recipient list (Step 1. Try it out → Recipient → Manage phone number list) before it can receive: until then the report shows Meta's own reason ("#131030 not in allowed list"), which is also a valid result.
