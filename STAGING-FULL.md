# Testing with every feature really working (staging)

Staging today (see STAGING.md) runs the real admin page, database, logins, Broadcast Send, Scheduler, WhatsApp Status, File Upload Relay and the WhatsApp bot. Two things are still simulated: **WhatsApp** (your Meta test app answers "(#200) API access blocked") and **the AI** (no staging Gemini key). Three workflows are not in staging at all: **KB Teach** (Bot Knowledge, "Teach the bot"), **Staff Invite** (the invite email) and **Client Lead Intake** (the bot's leads to EspoCRM).

To test everything for real you need four things, in this order. None of them touches the live club.

## 1. A WhatsApp sender for staging (about 30 minutes)

**Never point the club's app (`1582681763587760`) or its number at staging.** Meta sends every message and status of an app to ONE callback address. The club's app sends to `/webhook/wa-bot`, the live bot of all three clubs: changing it would move every member's messages to the test copy.

**Why your test app is blocked.** "(#200) API access blocked" is Meta blocking the *app*, not our code or your token (an expired token is #190, a missing permission #10, an unapproved template #132001). Usual reasons: no or broken Privacy Policy URL, incomplete app settings (icon, category, contact email), an overdue Data Use Checkup, or a restricted developer account or business portfolio. The exact reason is on the app's dashboard (red banner), developers.facebook.com → Alerts, or business.facebook.com → Account Quality.

**Option A: unblock the current app (10 minutes to check).** Open the app's dashboard and follow the banner. Fill App settings → Basic: a Privacy Policy URL that opens (the club website's privacy page), an app icon (1024×1024), a category, a contact email. Check Account Quality in your own business portfolio. If it's not cleared within a day, use Option B.

**Option B (recommended): a fresh app with Meta's free test number.**
1. Use **your own** business portfolio (business.facebook.com), not the club's.
2. developers.facebook.com → My Apps → **Create app** → "Connect with customers through WhatsApp" (Business) → your portfolio. Fill App settings → Basic straight away (privacy URL, icon, category, contact email).
3. WhatsApp → **API Setup**: Meta shows a **test number** with its **Phone number ID** and a test **WhatsApp Business Account ID**. Under **To**, add up to 5 phones (yours and a colleague's); each confirms with a code. Send the page's `hello_world` to each.
4. Permanent token: your portfolio → Users → **System users** → Add ("staging-bot", Admin) → **Assign assets**: the new app (Apps) **and the test WhatsApp account (WhatsApp accounts)**, both with full control → **Generate token** for the new app with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**. **Without the WhatsApp account assigned, the token is valid but every send fails with "(#100) Authorization Error".** Check: `GET https://graph.facebook.com/v21.0/<TEST_WABA_ID>/phone_numbers` with the token must list the test number.
5. App settings → Basic → **App secret** → copy.
6. WhatsApp → **Configuration** → Webhook: Callback URL `https://n8n.example.com/webhook/stg-wa-bot` (the staging bot, which handles messages and statuses like live), Verify token = your `staging.whatsapp.verifyToken` → **Verify and save** → **Subscribe** to `messages`.
7. **Subscribe the app to the test account (required).** The dashboard usually does NOT do this: without it Meta sends staging no incoming messages and no delivery reports, even though the webhook "Verify and save" succeeds. In PowerShell (after step 4): `Invoke-RestMethod -Method Post -Uri "https://graph.facebook.com/v21.0/<TEST_WABA_ID>/subscribed_apps" -Headers @{Authorization="Bearer <TOKEN>"}` → `success: True`. Check: `GET …/<TEST_WABA_ID>/subscribed_apps` lists your app by name.
8. In `tools/config.local.json` → `staging.whatsapp`: `phoneNumberId`, `wabaId`, `token`, `appSecret`, `verifyToken` from above, and **`"simulate": false`**. Put the same phones in `staging.testPhones`.
9. `npm run staging:build`, run `.staging-build/db/2-test-data.sql` again in the **staging** SQL Editor (it stores the sender and secret), then `npm run staging:deploy`.
10. From your phone write "hi" **to the test number**: the menu comes back and the chat appears in the staging Inbox. The app does **not** need to be published: messages and delivery reports from the phones in Meta's recipient list arrive in Development mode once steps 4 and 7 are done. If nothing arrives, check in this order: step 7 (subscribed apps), the phone is in the recipient list, the bot is not paused for that chat (Inbox header), `staging.testPhones` contains the phone, and the n8n Executions of "[STAGING] WhatsApp Bot".
11. Templates: the new account starts with Meta's samples only (`hello_world`, Jasper's Market; the staging page lists them). For the club's templates (Dues Reminder, `member_custom_update` used by the dues button, …) create each one on the test account with the **same name and text** (WhatsApp Manager → Message templates), or submit them from staging Campaigns (+ New template). Until Meta approves one, sends that use it fail with #132001, which is expected.

## 2. A staging Gemini key (5 minutes)

1. aistudio.google.com → **Get API key** → **Create API key in a new project** (`shakti-staging`). Never reuse the live key; the build refuses it.
2. Put it in `staging.geminiKey`, then `npm run staging:build` and `npm run staging:deploy`.
3. Models used: bot `gemini-2.5-flash` (fallback `-lite`), knowledge `gemini-embedding-001`. The free tier is enough. Staging holds only made-up members; **never copy live member data into staging.**
4. The staging knowledge base (`kb_chunks`) starts empty. Teach 5–10 answers through Bot Knowledge (needs step 3), or copy the club's FAQ chunks read-only from live (`select content, source, embedding from kb_chunks where tenant_id = '935a6acc-d8dc-44d7-9c33-7f21e7e69010'` in the **live** SQL Editor → CSV → import into staging `kb_chunks` with the staging club's id). That is club FAQ text, not member data.

## 3. The missing workflows (a separate change, on a new branch)

The staging guard now **refuses every address it doesn't know** (only the staging database, simulated/allowed Meta calls, the Gemini API when a staging key is set, the staging relay and `/webhook/stg-…` pass), and the build finds and swaps the EspoCRM key and the invite secret. So a workflow copied into staging can no longer reach live EspoCRM or other live services. Still, each one needs a small preparation:

| Workflow (live id) | Used by | What staging needs | Risk |
|---|---|---|---|
| KB Teach (`3Z8A0YtghVl79vPp`) | Bot Knowledge → Teach the bot | Nothing more: add it to `tools/targets.json`, `npm run prod:pull` records it (read-only), build, deploy. Needs the staging Gemini key. | Low |
| Staff Invite Email (`LGsnk3BElQBIYxaI`) | Staff → Send invite (the invite is saved even without the email) | An email stand-in (a Code step that records the email in `stg_outbox`) instead of the Gmail step, the admin link swapped to staging, and the security fix first: require a staff login of an owner of that club, take the club name from the database, escape the HTML. | Medium |
| Client Lead Intake (`o9sZ8GtsWdNa82g2`) | The bot's leads, website forms | Optional. An EspoCRM stand-in (record in `stg_outbox`), and staging `contacts` + `leads` tables (copy their definitions from the live Table editor, read-only). Until then the bot's leads are recorded in `stg_outbox` (kind `lead`). | Medium |

Steps: add the entries to `tools/targets.json` → commit → `npm run prod:pull` (reads live n8n only, records the files on a `live-capture-…` branch) → `git merge live-capture-…` → make the changes above → bench tests in `tests/bench` → `npm run staging:build` → `npm run staging:deploy`.

Leave out: Dues Broadcast (nothing uses it: the dues button uses Broadcast Send), Broadcast (multi-tenant), Event Registration, Client Provisioning, SALESCRMMM (Orena's own sales CRM), Global Error Alert, WF Shakti Broadcast, My workflow. Several of these are open on live without a login: see GO-LIVE.md "Security issues found".

## 4. Full test script (browser + phone)

Before each session: the page shows the yellow **TEST COPY** label (without "WhatsApp simulated", WhatsApp is real); `npm run staging:check-db` shows no "missing in staging"; your phones are in `testPhones` and in Meta's To list. Make extra staff logins with plus-addresses of your own email (`you+manager@gmail.com`). Keep campaigns small (≤ 20 recipients): the [STAGING] workflows run on the same n8n server as live.

**A. Logins and roles.** Staff → invite `+manager`, `+accounts`, `+desk` → each creates a login. Owner sees everything; manager everything but Staff; accounts Dashboard, Inbox, Members, Payments, Reports, Events, Registrations; front desk Dashboard, Inbox, Members, Bookings, Check-in, Events, Registrations with **no money**. As front desk and accounts, Settings, credentials, deleting and scheduling campaigns are refused (also by the database).

**B. Members.** Add a member with a Gujarati name, an emoji, an apostrophe and a 10-digit phone; search, edit, reload: unchanged. The same phone twice: refused. `<img src=x onerror=alert(1)>` as a name: shown as text. Bulk import a sheet with a bad row, `Rs. 1,500` dues and dd/mm/yyyy dates: the good rows are added, the bad ones listed with the reason.

**C. Payments and dues.** Record ₹1,25,000 (UPI); a partial payment leaves the rest as dues; "clear dues" moves paid-till. Payments → Send Dues Reminders: Preview shows a count; Send asks, then "Sent to X of Y"; your phone receives `member_custom_update` once approved; others fail with STAGING GUARD. As accounts, Send is refused.

**D. Bookings, check-in, events.** Book a court (a second booking of the same court and time, even typed differently, is refused), a cafe table; cancel one. Check a member in. "QA test event (1 seat)": register from your phone through the bot menu (confirmed), from a colleague's phone (**waitlisted**); both show in Registrations.

**E. Bot on the phone.** "hi" → banner and menu; Sports & facilities → timings and maintenance from Settings; "What are the gym timings?" → a real AI answer; a photo → "our team will look at it"; 👍 → no reply; an unknown question → it appears in Bot Knowledge → Teach the bot → ask again: the answer uses it.

**F. Inbox.** Your message appears by itself; Alerts "Every member message": one alert even with two CRM tabs. Reply: your phone receives it; the message shows your name, then Sent → Delivered → Read; header "Bot paused". Write "thanks": no bot reply. Resume the bot, "hi": it answers. Settings → quiet time 10 min, reply: the pause ends 10 minutes later. Assign to the manager, Resolve, write again: it reopens, and it's under the manager's Mine. Internal note: shows your name, never sent, never in `stg_outbox` `ai_prompt`. A chat older than 24 hours (Kabir): only templates.

**G. Campaigns.** New template → Submit → "Waiting for Meta" → ↻ Check later. Send test: text matches the preview word for word. Poster template: the image shows on the phone. CSV with your number on two rows (₹12,000 and ₹4,500): two messages ≥ 6 s apart, the report shows both sheet rows. Schedule a campaign 10 minutes ahead: the scheduler sends it once; the report shows sent → delivered → read and failed ones with reasons.

**H. Settings.** Change timings, maintenance, quiet time, quick replies, payment link; save, reload: kept. Two browsers saving different settings: nothing lost; the same setting: the page asks.

**I. Reports, audit, portal.** Reports totals match what you entered; the audit log lists invites, deletes, teaches with the real staff email. http://localhost:8787/portal/: log in with your staging email, book, register; it shows in the admin page.

**J. Proof live wasn't touched.** The live admin page shows no test members, chats or campaigns; the live `wa_messages` newest rows (read-only) have nothing from your session.

## 5. Rules that keep live safe

- Never put the club's live token, app secret or number into `config.local.json`; never change the club app's webhook.
- Never run staging SQL on live (the staging files stop themselves if they detect live).
- Use live access **read-only** for copies of structure, bot texts and knowledge; never copy members, payments or messages.
- Don't upload staging pages to the public server (`staging:deploy --pages`) until `/staging/` has a password (basic auth) in `staging/server/nginx.conf`.

## 6. Automatic real-Meta tests

`tests/staging-real/` (see its README) runs the real staging chain with your phones: bot reply, Inbox ticks from Meta's own reports, the blocked-number safety, an Excel campaign with repeated numbers, the report, poster image, payment link, custom template submit and a scheduled campaign. Each check is verified in the staging database and from Meta's events, not from the page.

**The 5-phone limit** belongs to Meta's free test number (up to 5 verified recipients). The club's live number has no recipient list: it can message any opted-in member (new-conversation limits per day start at 250 and grow with the number's quality). The campaign and Excel code is identical.
