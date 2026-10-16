# Changelog: what was done, when, and why

## 16 October 2026: WhatsApp Blaster repository

- Clean copy of ShaktiOneCRM at `9ff180c` with a fresh history; keys replaced by placeholders that the staging
  build fills; deploys switched off (`deployEnabled: false`); a `blaster` preset in the console; Shakti-only and
  secret-bearing documents removed; the bench reads `OPS_CONFIG`. See README.md. Nothing live was touched.

---

The entries below are the history of the code this product comes from (Shakti One CRM), kept for reference.
Commit ids refer to the ShaktiOneCRM repository, not this one.

Everything changed in Shakti One CRM since the handover on 28 September 2026, release by release. Each entry says
what changed, why, and how it was tested. "Live" means deployed to Shakti Sports Club's installation. The commit
ids are in this repository's history (`git log`).

---

## 28 September 2026: taking over the product (baseline)

- **Baseline captured** (`0112274`): the pages and workflows exactly as they were live, pulled into git and verified
  against the site, so every later change has a known starting point.
- **Staging and deploy tooling** (`a3d911e`): a test copy that cannot reach live (every key, address and webhook is
  swapped, and a guard refuses anything else), a local preview, a deploy to a `/staging` path with `[STAGING]`
  workflows, and `prod:check` / `prod:deploy` / `prod:rollback` with backups and release tags. Why: the handover had
  no safe way to change a live system used by a real club.
- **Campaigns: Template Manager** (`4117329` to `037beb5`): custom templates are written in the console and submitted
  to Meta for approval; sign-offs; the phone preview shows the real text; "Edit copy" on approved templates; poster
  upload with a fixed frame. Why: staff needed new wording without a developer, and the preview used to lie.

## 29 September: tracking, QA, runbook

- **Message status tracking** (`d5830ca`): sent → delivered → read / failed per message, live in the campaign
  report, through Meta's status webhook and a new `wa_message_status` table.
- **Staging QA fixes** (`f2ca77f`, `e9d6008`): webhook handshake, deploy without SSH, status edge cases, reports that
  never show less than the bot saw.
- **Campaign editor** (`ad9ba8c`): editor separated from the campaign, bullets and bold/italic, fuller report.
- **Posters and the File Upload Relay** (`4da6797`): a working poster upload and a relay workflow because a Code node
  cannot send bytes to Meta.
- **GO-LIVE runbook** (`05e262f` to `8e05ddf`): what the handover keys can do, settings found, exact checks.

## 30 September: the shared Inbox, the new bot, and a full QA pass

- **Shared WhatsApp Inbox** (`d32db1a`): all chats in the database, assignment, internal notes, bot pause, staff
  alerts, one message per sheet row in campaigns. Why: WhatsApp replies were visible only on one phone.
- **New multi-tenant bot** (`d32db1a`, `47736b4`): per-club signature checks, status checks by club, events and
  leads, greetings; the old live bot recorded read-only first (`0369490`).
- **Member portal hardening** (`2b517ff`): no self-update of member rows; bookings and registrations tied to the
  member's own club and open events.
- **QA fixes across every page and workflow** (`0466fea` to `476ca5f`, merged `8845341` to `9c06137`): Inbox,
  Campaigns, Settings, Members and Payments, bookings/check-in/events, orena-admin and portal, tools and docs. Staff
  roles enforced by the database (`a97d400`). Scheduler claims a campaign once; Broadcast Send hardened; WhatsApp
  Status refuses unsigned events; deny-by-default staging guard.
- **Bench**: `npm test` runs all suites (`1e35929`). Why: every fix got a regression check so it cannot come back.
- **Plain-language Meta errors** (`22ea487`): "(#200) API access blocked" explained where it happens.

## 1 to 2 October: go-live of the Inbox and Campaigns release

- **Inbox polish** (`b6f0af2`): WhatsApp-style ticks, clean chat header, bulk dues reminder carries the payment link.
- **Payment link read fresh** (`867dd59`); template cards show long messages, real-Meta staging tests (`b81d0cb`).
- **Bot AI** (`bf058d6`): current model fallback list, full answers, WhatsApp formatting instead of Markdown.
- **Announcement template preview** (`efeda3a`): no stray `{{2}}` while the message is empty.
- **Long sends in batches** (`d00cd0c`, `546556f`): a double-send guard and a lock; the page follows a running
  send; every successful send counts. Why: a 150-member campaign used to be one fragile request.
- **Go-live** (`634d525` to `4022ce1`): runbook corrected after reviews; live workflow ids recorded. **Live.**
- **Tables fit the window** (`b1d4050`): row buttons visible without sideways scrolling. Why: reported from live.

## 3 October: fields inside text, Save link, Variable button

- **Insert a field inside custom text** (`faba8ae`, `ddd3a97`): name, member no., amount, payment link or any Excel
  column in the middle of a sentence, with a live per-recipient preview. Why: "Hi {name}, your membership
  {member no} is over" was impossible. Bench + one real staging send.
- **Save link** (`4563d7b`): the payment link saves on its own button without touching other unsaved boxes.
- **"＋ Variable"** in the template editor (`13ba27c`): adds the next `{{n}}` at the cursor; empty or half-written
  braces are explained instead of "Ready to submit". Why: `{{}}` was accepted and Meta would have rejected it.

## 5 October: payment links from a sheet

- **Payment-link column** (`3f9d5cf`, `9caf067`): a link column in an uploaded sheet is detected and fills the
  "Payment link" blank per row; rows without a valid `https://` link block the send; the club-wide link option is
  removed from sheet campaigns to avoid confusion.
- **Reopened sheet campaigns** (`9510121`): a saved or copied sheet campaign lists its Excel columns again. Why: a
  bug since the first release hid every "Excel:" option on reopen.
- **Proven on live**: the "Read more" fold is caused by Meta's **Marketing** category, not message length (A/B/C/D
  test to the user's phone); Utility templates show in full.

## 7 October: members' media, payment QR and UPI, marketing limits

- **Members' photos and files in the Inbox** (`f621ac6`, `1d06932`): copied from Meta into a private store
  (`wa-media`) through the Relay (a Code node serialises bytes, found on real staging), shown through signed links.
  SQL `wa_media.sql`.
- **Payment QR code** (`f621ac6`, `8bd92ad`): uploaded in Settings; the bot sends it when a member asks for QR / UPI /
  GPay / PhonePe / Paytm; a "Payment QR" button in the Inbox; no payment link in its caption.
- **UPI ID** (`f983212`): typed in Settings with its own Save; written under the QR code; sent as text when there is
  no QR picture.
- **WhatsApp's marketing limits explained and avoided** (`95d8264`): the report says in plain words why each message
  failed (per-member marketing cap 131049, experiment 130472, unreachable 131026) and offers "Resend to the N who
  failed" on a Utility template; Step 3 warns on Marketing templates with the club's own last failure count; the
  editor hints at the right category. Why: 75 of 149 failed in a maintenance campaign; the cap is Meta's and only
  Utility templates avoid it.

## 9 October: every kind of WhatsApp message reaches staff

- (`3a33352`) Contact cards, locations (with a Maps link), catalogue orders, form answers and unsupported kinds
  (polls, view-once, deleted) are stored in words; forwarded messages and ad referrals are marked; voice notes and
  videos play in the Inbox; office documents are kept; links are clickable (escaped first). Why: `[contacts]` lost the
  details staff needed.

## 10 October: dues switch, short thank-you replies, teaching from files

- **Manual dues switch** (`ecf925b`): Customer 360 showed "Nothing pending" whenever no dues amount was stored; it
  now follows the real rule (amount owed or paid-till in the past) and staff can mark dues pending or paid by hand,
  stamped by the database (`members_dues_mark.sql`). Audience rules and reminders follow the mark.
- **Thank-you replies** (`ecf925b`): "thanks, will clear it" gets one short line and no club information; "payment
  done" asks for the screenshot; the AI is told to give information only when asked. Why: the bot answered a
  thank-you with timings.
- **Teach the bot from a file** (`05548c0`, `91e666d`): pictures, PDFs, text, CSV, Excel; the AI's reading is reviewed
  and corrected by staff before anything is learned; prices, amounts, phone/account numbers, emails/UPI, links and
  member data are never learned from a file (checked again on save); 10 uploads a day, 4 MB; new `KB Files`
  workflow and `kb_files.sql`; "Add a file" beside "Teach the bot" on each open question; an "Already handled"
  history with "Put back in the list". **Live** (deployed by the client on 10 October).

## 12 October: separate repository and documentation

- This folder (`ShaktiOneCRM`) created as a clone of the shared `CRM` folder with the Lead Hub, the sales CRM, the
  website and company documents removed. Why: the other product's uncommitted work kept stopping this product's
  deploys, and two products in one repository hid which change belonged to which.
- Documents added: this changelog, a new
  `README.md`. Nothing was deployed; live is unchanged (`prod:check`: every file already live).

---

## How each change was tested

- **Bench**: 22 automated suites (about 600 checks) run the staging-built code against an in-memory copy of the
  live database structure and drive the real page in Edge; every release ran all of them green.
- **Staging-real**: 8 scripts send through Meta's test number to the configured test phones only (insert-field,
  media, QR, long sends, batches, scheduling, Inbox and campaign flows).
- **Live**: after each deploy, the client checked the feature from their own phone and the live console; the deploy
  tool verified every file and workflow and kept a backup.

## Known open items

- Add the live `KB Teach` workflow to this repository.
- Host the member portal on live.
- Two Orena documents requested on 9 October (the Social CRM documentation update and an onboarding document) are
  not started; they belong to the Lead Hub project.

## 12 October (later): instruction or note box in Bot Knowledge

- An "Instruction or note for the bot" box beside "Upload a file". With an upload it tells the AI what to take from the
  file; on its own, "Teach this note" teaches each typed line as written. Same rule against prices, numbers, payment
  details, links and member data; notes count toward the daily limit. Why: staff wanted to guide the reading and to
  teach short facts without making a file. Changes the admin page and the KB Files workflow; no SQL.
  Bench: 17 new checks, all 30 suites green. Not live until deployed.

## 12 October (evening): popups in Bot Knowledge

- "Upload a file" and "Write a note" each open a popup instead of an inline box. Upload: choose or drop the file,
  then write about it (what it is, what the bot should take from it), with suggestions and clear errors. Note: type
  facts one per line with a live count; a closed draft is kept. Why: staff could not find where to type, and wanted
  to describe every file at the moment of uploading it. Page and KB Files workflow; no SQL.
  Bench: all 30 suites green (26 checks in the notes suite). Not live until deployed.
