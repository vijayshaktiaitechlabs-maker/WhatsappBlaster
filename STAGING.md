# Changing Shakti One safely

There are now two copies of the product:

| | Live (members use this) | Test copy (staging) |
|---|---|---|
| Web pages | `https://n8n.example.com/admin/` etc. | `http://localhost:8787/admin/` on your PC, or `https://n8n.example.com/staging/admin/` for sharing |
| Database | the live Shakti Sports Club Supabase project | your own separate staging Supabase project |
| n8n workflows | "Broadcast Send (Shakti)", webhook `/webhook/broadcast-send` | "[STAGING] Broadcast Send (Shakti)", webhook `/webhook/stg-broadcast-send` |
| WhatsApp bot | "WhatsApp Bot (multi-tenant)", webhook `/webhook/wa-bot` (Meta sends every club's messages here) | "[STAGING] WhatsApp Bot (multi-tenant)", webhook `/webhook/stg-wa-bot` (`npm run staging:wa` sends to it, and your Meta **test** app once its webhook points here) |
| WhatsApp | real members | only the phone numbers you list as test phones, or simulated (see below) |

You change the code, try it on the test copy, get approval, and then put it live with one command. That command backs up first and can undo.

**Why merging never causes conflicts:** the files in this folder always stay the live version. The test copy is generated from them by `npm run staging:build`, which swaps in the test database, the test webhooks and the test keys each time. So a branch only ever contains your real change, never "test settings" that would clash when merged.

**Why the test copy can't hurt live:** the build refuses to finish if anything in the output still points at the live database, a live key (database, AI, EspoCRM, staff-invite secret), a live webhook, the live EspoCRM or a WhatsApp token, or if a test page would carry a `service_role` database key. In the test workflows, every request made from a code step goes through a guard that **denies by default**: it only lets through the staging database, Meta (WhatsApp messages only to your test phones, templates only to a Meta test account), Google's AI only with your own staging key, the `stg-` webhooks, and the download of a public image link (a poster's example picture). Everything else, including the live database, live webhooks and EspoCRM, is stopped with "STAGING GUARD". The one request that doesn't come from a code step is the File Upload Relay's "Send bytes" step (n8n code steps can't send files). Its own check only lets it send to a Meta upload session or to the staging storage, and the build stops if any other workflow has such a step. The database scripts refuse to run if they detect the live database.

---

## One-time setup (about 30 minutes)

You need Node.js (already installed) and nothing else. Run commands in a terminal opened in this `CRM` folder.

### 1. Create the staging database
1. Go to https://supabase.com/dashboard, then **New project**. Name it `shakti-staging`, pick region **South Asia (Mumbai)**, and set any database password. The free plan is fine.
2. Wait until it finishes setting up.

### 2. Fill in `tools/config.local.json`
This file is already created and never goes into git. Fill in:
- `supabaseUrl`: Project Settings > **Data API** > Project URL.
- `anonKey` and `serviceKey`: Project Settings > **API Keys** > **Legacy API keys** tab: the `anon` key and the `service_role` key. Use the legacy ones (they start with `eyJ`).
- `testPhones`: your own WhatsApp number with country code, like `919876543210`. You can list several.
- `adminEmail`: already set to your handover email. This is the login for the test admin panel.

Leave `whatsapp` and `n8nApiKey` empty for now.

### 3. Load the database
1. Run `npm run staging:build`.
2. In the **staging** project, open **SQL Editor**, paste all of `.staging-build/db/1-structure.sql`, and click **Run**.
3. Do the same with `.staging-build/db/2-test-data.sql`. It adds 8 made-up members, your test phone as a member with dues pending, some bookings, payments and chat messages.
4. Leave **Authentication > Sign In / Providers > Email > Confirm email** switched **ON** (as on live). Do not turn it off: sign-up links a login to a member row and to a staff invite by email, so with it off anyone could sign up with your `adminEmail` (or a test member's email) and take that role. Create your own login instead in **Authentication > Users > Add user > Create new user**: your `adminEmail`, any password, and tick **Auto Confirm User**. Do the same for any other test login.
5. Go to **Authentication > URL Configuration** and add these Redirect URLs: `http://localhost:8787/**` and `https://n8n.example.com/staging/**`.
6. Check it: `npm run staging:check-db` should say staging and live have the same tables, columns and functions.

### 4. Open the test copy
Run `npm run staging:preview` and open http://localhost:8787/admin/. Sign in with the login you created in step 3.4. You're Owner of the test club (the owner invite in `2-test-data.sql`; if the login was created after that file ran, run `2-test-data.sql` once more). The same login also works in the test portal at http://localhost:8787/portal/. A yellow "TEST COPY" label sits at the bottom left of every test page.


### 5. Optional: send real test WhatsApp messages and submit templates to Meta
Skip this until you need to test sending or template approval.
1. **n8n API key:** open n8n, go to **Settings > n8n API > Create an API key**, and paste it as `n8nApiKey`.
2. **WhatsApp sender: a Meta test account, in your OWN Meta developer app** (free). In Meta for Developers create an app of your own (type Business, add the WhatsApp product), then open **WhatsApp > API Setup**. It shows a *test* phone number with its own **Phone number ID** and **WhatsApp Business Account ID**, and a temporary token. Put those three into `whatsapp` (`phoneNumberId`, `wabaId`, `token`). Add your own number under "To" on that page so it can receive messages. With this, both test sends **and** "Submit to WhatsApp for approval" work in staging, and nothing touches the club's real account or its template list.

   **Never use the club's real sender, token or Meta app in staging.** A Meta app has exactly ONE webhook address: pointing the club's app at a staging address moves every member's incoming message (all clubs) away from the live bot. The club's token would also sit in the staging database, and every test page with the staging keys could read it. The staging guard refuses template submission to the club's account, but it cannot protect the webhook.
3. Run `npm run staging:build`, then run `.staging-build/db/2-test-data.sql` again in the staging SQL Editor. It is safe to run twice.
4. Run `npm run staging:deploy`. This creates the "[STAGING]" workflows in n8n and switches them on. It doesn't touch the live workflows.

Test messages only reach your test phones. Anything else shows up as a failed send saying "STAGING GUARD".

### 6. Optional: a test link you can share for approval
Run `npm run staging:setup-server` once. It adds one small container on the server that serves the test copy under `/staging/`. Nothing already running is changed or restarted. After that, `npm run staging:deploy -- --pages` also uploads the pages (without `--pages` they stay on your PC and the shared link keeps the OLD version), and you can send people `https://n8n.example.com/staging/admin/`. The link has no password: anyone who has it sees the test copy and its staging keys, so share it only with the approvers and keep only made-up data in staging.

If Windows says the SSH key permissions are too open, the tool prints the one command that fixes it.

---

## Delivered / read tracking (message status webhook)

WhatsApp reports what happened to each message (delivered, read, failed and why) by calling a webhook, the same one that receives the member's incoming messages. A Meta app has exactly ONE webhook address, so you connect **your own** Meta test app (step 5) to ONE staging address. Nothing of this reaches the club's account.

1. In your Meta app → **App settings → Basic**, copy the **App secret** into `whatsapp.appSecret` in `tools/config.local.json`. Choose any word for `whatsapp.verifyToken` (default `shakti-staging-verify`).
2. `npm run staging:build`, re-run `.staging-build/db/1-structure.sql` and `2-test-data.sql` in the staging SQL Editor, then `npm run staging:deploy`.
3. In your Meta app → **WhatsApp → Configuration → Webhook**: Callback URL `https://n8n.example.com/webhook/stg-wa-bot`, Verify token = your `verifyToken`, click **Verify and save**. Then under Webhook fields, **Subscribe** to `messages`.

Use `stg-wa-bot` (recommended): the staging bot handles both what you type on your phone (the real-phone bot tests below need it) and the delivery statuses, exactly as the live bot does on `/webhook/wa-bot`. Use `stg-wa-status` instead only to test the `[STAGING] WhatsApp Status (Shakti)` workflow on its own; then your phone's messages don't reach the staging bot. Never point any app at a live address: `/webhook/wa-bot` is the live bot of every club, and `/webhook/whatsapp-crm` belongs to the separate sales-CRM workflow ("SALESCRMMM").

What arrives: `sent`, `delivered`, `read` (only when the member has read receipts on) and `failed` with Meta's error code and reason. Replies you send from your phone are logged too, so the report's "Replied" count works. There is no "shared / forwarded" event for business messages in the WhatsApp API, so the report does not show one.

For the live club: Meta sends these events to the club's live bot (`/webhook/wa-bot`), and the new bot already writes delivered / read / failed into the Inbox and the campaign report. The live "WhatsApp Status (Shakti)" workflow is only needed for later forwarding, so `prod:deploy` creates it switched OFF (`"activate": false` in `tools/targets.json`); switching it on is a separate live change, done only with approval and after the club's app secret is stored in `wa_webhook_config`.

## Testing like a real user (nothing here touches the live club)

Do step 5 first with a **Meta test account**. Then, with `npm run staging:preview` running, go through this at http://localhost:8787/admin/ → Campaigns:

1. **+ New campaign**, Step 3: click the dashed **+ New template** card. Write an opening, the message (try the **• Bullet**, **B** and **I** buttons), tick the sign-off and edit it. Use `{{1}}` for the member's name and `{{2}}` for something you'll fill per campaign. Give each variable a label, a default and an example. The phone preview shows the exact text a member gets.
2. **Submit to WhatsApp for approval.** The card shows *Waiting for Meta*. Meta's answer usually takes minutes; the page checks by itself when you open Campaigns, or click **↻ Check** on the card. (*Rejected* shows the reason: fix and resubmit.)
3. Once the card is plain (approved), click it: its variables appear under "Fill the template variables" like any club template. Fill them, set Audience to **Single Test Number** with your phone, and **Send test**. The message on your phone must match the preview word for word.
4. Send a real campaign to **CRM Members** (about 8 test members): only your test phone can actually receive, every other number is blocked by the staging guard and shows as failed, with the reason. Open **Report** on the campaign: the funnel (matched → reachable → sent → delivered → read), the failed count with reasons, and the recipient list. Delivered / read only count once your Meta test app's webhook points at `/webhook/stg-wa-bot` (see "Delivered / read tracking" above); without it they stay at 0.
5. Edit an approved template (✎ Edit on its card): change wording, submit again. The card shows *Update: waiting for Meta* while the approved version keeps working in campaigns.
6. Click **✎ Edit copy** on an approved club template (e.g. Offer Broadcast), change the opening or sign-off, tick **With poster image** and paste an image link, and submit it: a poster version of any club template.
7. Also check what must NOT change: the club's own templates (Dues Reminder etc.) send exactly as before, "Nothing" on an optional variable leaves it out, and the campaign list, drafts and scheduling behave as on live.

## WhatsApp Inbox and bot in staging

The bot, the shared Inbox, staff alerts and Settings timings can all be tested here without Meta and without the club's number.

**Simulated WhatsApp.** With `"simulate": true` under `staging.whatsapp` in `tools/config.local.json`, the test workflows never call Meta: every message they would send is recorded in the staging table `stg_outbox` (what, to whom, the full payload) and answered like Meta would (a fake `wamid.STAGING…` id). Templates come from the page's catalog. Use this while your Meta test app answers "(#200) API access blocked". Set it back to `false` to send real test messages again. The page shows "WhatsApp simulated" in its yellow TEST COPY label.

**The AI in staging.** Without `staging.geminiKey`, the bot's AI answers are a fixed "[TEST] AI stand-in" text, and the exact prompt it would have sent is recorded in `stg_outbox` (kind `ai_prompt`), so you can read what the AI is told. The live Gemini key is never used in staging (the build stops if it finds it). To test real AI answers, create your own key at aistudio.google.com and put it in `staging.geminiKey`.

**Once, after pulling this branch:**
1. `npm run staging:build`
2. Staging SQL Editor: run `.staging-build/db/1-structure.sql` (adds `sql/wa_inbox.sql` and the `stg_outbox` table), then `.staging-build/db/2-test-data.sql`, then `sql/data/shakti_bot_texts.sql` (the same data change planned for live; it prints what the bot will use).
3. `npm run staging:check-db`. "only in staging" lines for the new Inbox columns, table and functions are expected until they are live.
4. `npm run staging:deploy` (creates "[STAGING] WhatsApp Bot (multi-tenant)" and updates the other [STAGING] workflows; add `-- --pages` to also update the shared test link).
5. `npm run staging:preview` and open http://localhost:8787/admin/.

**Being the member** (from a second terminal; each command waits for the bot and prints what was stored and what would have been sent):
```
npm run staging:wa -- --text "hi"                      the banner and menu
npm run staging:wa -- --tap menu:facilities            the Sports & facilities list with maintenance timings
npm run staging:wa -- --text "What are the gym timings?"   an AI answer (stand-in without a key)
npm run staging:wa -- --image --caption "receipt"      a photo: short acknowledgement, not the menu
npm run staging:wa -- --reaction 👍                     no reply
npm run staging:wa -- --text "hi" --bad-signature      refused: nothing stored
npm run staging:wa -- --text "hi" --id wamid.SAME1     run twice: the second is ignored (Meta's retries)
npm run staging:wa -- --status read --wamid <id>       a delivery status for a message the Inbox shows
npm run staging:wa -- --from 919900000001 --text "hello"   a message from another number (it can't receive replies: they show FAILED)
```

**Test list** (tick each in the browser, with the Inbox open):
1. Settings → Sports & facilities timings: Strength & Conditioning 6 AM – 8 PM, Shooting 4 PM – 9 PM; Maintenance timings 12 PM – 3 PM; Save. `--tap menu:facilities` shows them.
2. A member message appears in the Inbox by itself; with **Alerts** set to "Every member message", the browser shows an alert (allow notifications when asked). Open the CRM in a second tab: still one alert per message.
3. Reply from the Inbox: your name and "Sent" on the message, "Bot paused" in the header. `--text "thanks"`: no bot reply. **Bot paused → Resume the bot now**, `--text "hi"`: the bot answers.
4. Settings → "the bot stays quiet for" 10 minutes; reply again: the header shows the pause until 10 minutes from now.
5. Assign the conversation to a staff member, resolve it, then `--text "one more question"`: it reopens by itself. Log in as that staff member in another browser: the same state, and it's under **Mine**.
6. Internal note: shown with your name, not sent to the member, never given to the AI.
7. A conversation whose member last wrote more than 24 hours ago (e.g. Kabir in the test data): only templates can be sent; choose Dues Reminder, fill its blanks, send.
8. Campaigns → a CSV with the same number on two rows and different amounts: two recipients with rows 2 and 3, sent at least 6 seconds apart, each with its own amount; the Report shows both rows. Blank 5 = "Payment link (Settings)" after saving a link in Settings.
9. The existing Campaigns checks in "Testing like a real user" above.

**Being the member from a real phone:** your Meta test app's webhook must point at `https://n8n.example.com/webhook/stg-wa-bot` (see "Delivered / read tracking" above), `simulate` must be `false`, and you write from a test phone to the test app's number. Without that webhook, nothing you type on the phone reaches the staging bot.

What staging can't show: the real WhatsApp app on a phone while Meta blocks the test app, and real AI answers without your own Gemini key.

## Every change, start to finish

```
git switch main
git switch -c change/short-name          # 1. a branch for this change
   ...edit files...                       # 2. make the change
npm run staging:preview                   # 3. try it at http://localhost:8787 (refresh after each edit)
git add -A
git commit -m "What changed and why"      # 4. save it
npm run staging:deploy -- --pages        # 5. optional: put it on the shared test link for approval
                                          #    ...approval...
git switch main
git merge change/short-name               # 6. approved: bring it into main
npm run prod:check                        # 7. see exactly what will go live
npm run prod:deploy                       # 8. put it live (type DEPLOY)
```

What `prod:deploy` does for you:
- It refuses unless you're on `main` with everything committed, so only approved, saved code goes live.
- It refuses a file that is a test copy (the TEST COPY label, a `[TEST]` title, the staging guard, a `[STAGING]` workflow, `stg-` webhooks, the staging database or its keys), e.g. a page copied back from `.staging-build/`.
- It refuses if someone changed live by hand since the last deploy (pages, workflow nodes, node options such as "retry on fail", and workflow settings such as the error workflow or run history), instead of silently overwriting their change. Run `npm run prod:pull` to record their change in git first. For workflows it compares the version that runs; an unpublished draft in n8n is only mentioned (it stays in the backup).
- It refuses while an earlier deploy is unfinished (a backup in `deploy-backups/` without its `release-…` tag, e.g. the PC switched off half-way): run `npm run prod:rollback` first. `prod:check` warns about it too.
- It backs up the live files (on the server in `/root/deploy-backups/`, on your PC in `deploy-backups/`), uploads, then downloads the live page to confirm it's really the new version. If anything fails, it automatically puts the old version back, `tools/targets.json` included.
- A NEW workflow is created switched on, unless its entry in `tools/targets.json` says `"activate": false` (the WhatsApp Status workflow): then it is created switched off.
- It moves the `live` git tag. This tag is always the record of what is live right now.

If something is wrong after going live, run **`npm run prod:rollback`** (type ROLLBACK). It restores the version from before the last deploy. If live was changed after that deploy (a hot-fix in n8n), it lists the changes and asks you to type OVERWRITE as well; either way it first saves the current live copies in `deploy-backups/before-rollback-<time>/`. Then fix the change on a branch and go through the steps again.

## Database changes

- Never edit tables by hand on live. Write the change as a new file in `sql/`. Only add things (`add column if not exists`, new tables). Never drop or delete.
- Run it in the **staging** SQL Editor first, and test.
- After approval, run the same file in the **live** SQL Editor **before** `npm run prod:deploy`, so the new pages find the columns they need. `prod:deploy` reminds you when `sql/` changed. It never runs SQL on live by itself.
- Then add the file name to `staging/db/schema-files.txt`, so a freshly built staging database includes it.
- A change to one club's **data** (not the structure) goes in `sql/data/`, guarded to that club and safe to run twice, and is run by hand on staging and then, with approval, on live. Example: `sql/data/shakti_bot_texts.sql`.

## What the test copy does not cover yet

- **Staff invite emails and bot "teach"** in the admin panel call n8n workflows that are not in this folder. Only "Broadcast Send", "Broadcast Scheduler", "WhatsApp Status", "File Upload Relay" and the WhatsApp bot are here. In the test copy the invite is still saved (only its email is not sent) and "teach" returns an error. **Dues reminders do work**: they go through `/webhook/stg-broadcast-send` like campaigns.
- **EspoCRM** (the sales CRM) is not in staging. In the test copy its address and key are replaced by ones that reach nothing, so Settings > EspoCRM > "Test connection" shows an error.
- **The bot's leads** go to a recorded stand-in (`stg_outbox`, kind `lead`) instead of EspoCRM. To include one, download it from n8n (workflow menu > Download), save the file here, and add it to the `workflows` list in `tools/targets.json`.
- **Poster image upload** works, but not through the server's upload helper: that helper writes to live storage. The test copy stores posters in the staging project's public `brand` bucket (folder `posters/`) instead. On live, the real helper is used, so the upload itself is only fully proven after go-live.
- **The member portal is not deployed to live.** `https://n8n.example.com/portal/` currently shows the n8n login page, so `prod:deploy` leaves the portal out until its hosting is fixed.

## Keep this folder private

This repository carries placeholders instead of keys. Never put real keys in it: they belong in `tools/config.local.json` (git-ignored) or n8n credentials.
