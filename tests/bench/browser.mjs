// Browser QA of the staging-built admin page on the local bench (see browser-setup.mjs / fakesupa.mjs):
// real page in Edge, real SQL + RLS in PGlite, real staging-built workflow code, simulated Meta.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { benchDb, openBrowser, watch, login, sleep, PHONE, APP } from './browser-setup.mjs';
import { world, runNode, metaItem, cfg } from './harness.mjs';

const OUT = fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (area, test, ok, evidence = '') => { results.push({ area, test, ok, evidence: String(evidence).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(evidence).slice(0, 220)}`); };
const { db, q, T, users, staff } = await benchDb();
const owner = staff.find((s) => s.email === 'qa-owner@club.test'), desk = staff.find((s) => s.email === 'qa-desk@club.test');
const PNID = cfg.whatsapp.phoneNumberId;
let seq = 0;
const ev = (msg, value = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, ...value, ...(msg ? { contacts: [{ wa_id: msg.from, profile: { name: 'Member' } }], messages: [msg] } : {}) } }] }] });
const txt = (body, from = PHONE) => ({ from, id: `wamid.BENCH.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });
const tap = (id, from = PHONE) => ({ from, id: `wamid.BENCH.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } });
let fake;
const bot = async (body) => { const w = world(db); const out = await runNode('wa_bot_wf.json', 'Bot Engine', metaItem(w, body), w); await fake.drain(); return out; };
const outCount = async () => Number((await q(`select count(*)::int n from public.stg_outbox where kind='meta_message'`))[0].n);
const conv = async (key) => (await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key=$2`, [T, key]))[0];

// ---- seed: 60 more conversations (list paging), a 150-message history (thread paging), a closed 24h window, a non-test number
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at)
  select $1, '9199' || lpad(g::text, 8, '0'), 'in', 'Hello from bench member ' || g, now() - interval '2 hours' - make_interval(mins => g) from generate_series(1, 60) g`, [T]);
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at)
  select $1, $2, case when g % 2 = 0 then 'in' else 'out' end, 'Old message #' || g, now() - interval '3 days' + make_interval(secs => g) from generate_series(1, 1150) g`, [T, PHONE]);
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values ($1, '910000000003', 'in', 'Question from two days ago', now() - interval '2 days')`, [T]);
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values ($1, '910000000002', 'in', 'Hi, is the pool open?', now() - interval '10 minutes')`, [T]);
await q(`update public.wa_messages set created_at = now() - interval '1 minute' where tenant_id=$1 and phone_key=$2 and created_at > now() - interval '1 day'`, [T, PHONE]);
const [{ n: openConvs }] = await q(`select count(*)::int n from public.wa_conversations where tenant_id=$1 and status='open'`, [T]);

const opened = await openBrowser(db, users);
fake = opened.fake;
const { browser, context } = opened;
// (notification permission is simulated below: http test origins cannot be granted it)
await context.addInitScript(() => {
  window.__notes = [];
  const F = function (title, opts) { window.__notes.push({ title, body: opts && opts.body, tag: opts && opts.tag }); return { close() {}, set onclick(f) {} }; };
  F.permission = 'granted'; F.requestPermission = async () => 'granted';
  window.Notification = F;
});
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const toastTxt = () => t('#toast');
const waitFor = async (fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
/* bubble text plus the tick's meaning (Sent / Delivered / Read), because the ticks themselves are symbols */
const bubbles = () => page.$$eval('#inboxMessageScroll .inbox-bubble', (els) => els.map((e) => { const st = e.querySelector('.inbox-st'); return (e.textContent + (st ? ' ' + st.getAttribute('aria-label') : '')).replace(/\s+/g, ' ').trim(); }));

try {
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => go('inbox')); await sleep(1200);

  // ---------- list
  let s = await page.evaluate(() => ({ n: INBOX_CHATS.length, more: INBOX_MORE, first: INBOX_CHATS[0] && INBOX_CHATS[0].phone_key, sorted: INBOX_CHATS.every((c, i, a) => !i || a[i - 1].last_message_at >= c.last_message_at), open: INBOX_COUNTS.open }));
  rec('Inbox list', 'loads newest first, 40 at a time, with the real open count', s.n === 40 && s.more && s.sorted && s.open === openConvs, `loaded ${s.n}, more=${s.more}, newest-first=${s.sorted}, Open tab count ${s.open} (database: ${openConvs})`);
  await page.click('button:has-text("Load more conversations")'); await sleep(900);
  s = await page.evaluate(() => ({ n: INBOX_CHATS.length, uniq: new Set(INBOX_CHATS.map((c) => c.phone_key)).size }));
  rec('Inbox list', '"Load more conversations" loads the next page (no repeats)', s.n > 40 && s.n === s.uniq, `${s.n} loaded, ${s.uniq} distinct`);

  // ---------- open a conversation, unread, thread paging
  await page.fill('#inboxSearchInput', 'Test Phone'); await sleep(900);
  await page.click('.inbox-item:has-text("Test Phone 1")'); await sleep(1500);
  let c = await conv(PHONE);
  rec('Inbox', 'opening a conversation marks it read for the whole team (stored)', c.unread_count === 0 && c.last_read_by_email === 'qa-owner@club.test', `unread ${c.unread_count}, read by ${c.last_read_by_email}`);
  s = await page.evaluate(() => ({ n: ACTIVE_MSGS.length, more: ACTIVE_MORE, last: ACTIVE_MSGS[ACTIVE_MSGS.length - 1].body, dom: document.querySelectorAll('#inboxMessageScroll .inbox-bubble').length }));
  rec('Inbox thread', 'shows the newest 60 messages first, with "Load older messages"', s.n === 60 && s.more && s.dom === 60, `${s.n} messages, newest shown last: "${s.last.slice(0, 50)}"`);
  const before = await page.evaluate(() => ACTIVE_MSGS[0].created_at);
  await page.click('#inboxMessageScroll button:has-text("Load older messages")'); await sleep(1200);
  s = await page.evaluate(() => ({ n: ACTIVE_MSGS.length, asc: ACTIVE_MSGS.every((m, i, a) => !i || a[i - 1].created_at <= m.created_at), uniq: new Set(ACTIVE_MSGS.map((m) => m.id)).size }));
  const [{ n: total }] = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and phone_key=$2`, [T, PHONE]);
  rec('Inbox thread', 'older pages load in order, nothing repeated', s.n === 120 && s.asc && s.uniq === s.n, `${s.n} of ${total} loaded, in time order, first was ${before.slice(0, 19)}`);
  let clicks = 0;
  while (clicks < 40 && await page.locator('#inboxMessageScroll button:has-text("Load older messages")').count()) {
    await page.click('#inboxMessageScroll button:has-text("Load older messages")'); await sleep(500); clicks++;
  }
  s = await page.evaluate(() => ({ n: ACTIVE_MSGS.length, more: ACTIVE_MORE, uniq: new Set(ACTIVE_MSGS.map((m) => m.id)).size, asc: ACTIVE_MSGS.every((m, i, a) => !i || a[i - 1].created_at <= m.created_at), first: ACTIVE_MSGS[0].body }));
  const [{ n: allMsgs }] = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1`, [T]);
  rec('Inbox thread', 'a conversation with more than 1,000 messages: every message can be reached, in order, none repeated', total > 1000 && s.n === total && s.uniq === total && s.asc && !s.more, `${s.n} of ${total} after ${clicks} more pages; oldest "${s.first}"`);
  rec('Inbox list', 'with more than 1,000 messages stored, the newest conversations still show (the old Inbox read only the first 1,000 rows, oldest first)', allMsgs > 1000 && openConvs > 60, `${allMsgs} messages in the database; list showed the newest first above`);

  // ---------- assign
  await page.selectOption('#activeChatAssignee', desk.id); await sleep(900);
  c = await conv(PHONE);
  const [aud] = await q(`select actor_email, action from public.audit_log where action='inbox_assign' order by created_at desc limit 1`);
  rec('Inbox', 'assign to one staff member: stored for everyone, with who did it', c.assignee_email === 'qa-desk@club.test' && c.assigned_by_email === 'qa-owner@club.test' && aud && aud.actor_email === 'qa-owner@club.test', `assignee ${c.assignee_email}, by ${c.assigned_by_email}, audit ${aud && aud.action}`);

  // ---------- pause / resume
  await page.click('#activeChatBotBtn'); await sleep(300);
  await page.click('#inboxBotMenu .inbox-menu-item:has-text("Pause for 10 minutes")'); await sleep(900);
  c = await conv(PHONE);
  const mins = (new Date(c.bot_paused_until) - Date.now()) / 60000;
  const head = await t('#activeChatBotBtnText'), line = await t('#inboxBotLine');
  rec('Bot pause', 'Pause for 10 minutes: stored with who and when, shown in the header', mins > 9 && mins <= 10.1 && c.bot_paused_by_email === 'qa-owner@club.test' && head === 'Bot paused' && /not replying/.test(line), `${mins.toFixed(1)} min, by ${c.bot_paused_by_email}; "${line.slice(0, 90)}"`);
  let o1 = await outCount();
  await bot(ev(txt('Hello? Is anyone there?'))); await sleep(900);
  let b = await bubbles();
  rec('Bot pause', 'while paused, the member message appears live in the Inbox and the bot sends nothing', b[b.length - 1].includes('Hello? Is anyone there?') && (await outCount()) === o1, `last bubble: "${b[b.length - 1].slice(0, 60)}", WhatsApp sends: ${(await outCount()) - o1}`);
  await page.click('#inboxBotLine button:has-text("Resume bot now")'); await sleep(900);
  c = await conv(PHONE);
  rec('Bot pause', '"Resume bot now" is stored with who and when', !c.bot_paused && !c.bot_paused_until && c.bot_resumed_by_email === 'qa-owner@club.test' && (await t('#activeChatBotBtnText')) === 'Bot on', `resumed by ${c.bot_resumed_by_email}`);
  o1 = await outCount();
  await bot(ev(tap('menu:facilities'))); await sleep(1000);
  b = await bubbles();
  rec('Bot pause', 'after resuming, the bot answers again (its reply appears live, labelled Bot)', (await outCount()) === o1 + 1 && /^Bot/.test(b[b.length - 1]), `last bubble: "${b[b.length - 1].slice(0, 70)}"`);

  // ---------- staff reply + auto pause
  await page.fill('#inboxReplyInput', 'Hi, this is the front office. The pool is open till 9 PM.');
  await page.click('#inboxSendBtn'); await sleep(1500);
  const tr = await toastTxt();
  b = await bubbles();
  const [staffRow] = await q(`select sender_email, sender_kind, status, wamid from public.wa_messages where tenant_id=$1 and phone_key=$2 and sender_kind='staff' order by created_at desc limit 1`, [T, PHONE]);
  c = await conv(PHONE);
  rec('Staff reply', 'reply is sent, stored and shown with the staff member and "Sent"', staffRow && staffRow.sender_email === 'qa-owner@club.test' && staffRow.status === 'sent' && /qa-owner/.test(b[b.length - 1]) && /Sent/.test(b[b.length - 1]), `bubble: "${b[b.length - 1].slice(0, 80)}"`);
  rec('Staff reply', 'the bot pauses itself for 30 minutes after a staff reply (default), shown at once', botPaused(c) && /30 minutes/.test(tr) && (await t('#activeChatBotBtnText')) === 'Bot paused', `toast "${tr}", pause reason ${c.bot_pause_reason}`);
  o1 = await outCount();
  await bot(ev(txt('Thanks! And the gym?'))); await sleep(800);
  rec('Staff reply', 'the member writes again: no bot reply while staff handle the chat', (await outCount()) === o1, 'no WhatsApp message from the bot');

  // ---------- delivery status
  await bot(ev(null, { statuses: [{ id: staffRow.wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }] })); await sleep(900);
  const readShown = await page.evaluate((w) => { const m = ACTIVE_MSGS.find((x) => x.wamid === w); return m && m.status; }, staffRow.wamid);
  b = await bubbles();
  rec('Delivery status', 'WhatsApp\'s "read" updates the staff message live', readShown === 'read' && b.some((x) => x.includes('pool is open till 9 PM') && /Read/.test(x)), `status on screen: ${readShown}`);

  // ---------- internal note
  await page.click('#tabNoteMode'); await page.fill('#inboxReplyInput', 'Member asked about gym timings; call back after 5.');
  await page.click('#inboxSendBtn'); await sleep(900);
  b = await bubbles();
  const [note] = await q(`select sender_email, direction from public.wa_messages where tenant_id=$1 and direction='note' order by created_at desc limit 1`, [T]);
  rec('Notes', 'an internal note is saved with its author and shown as a note', note && note.sender_email === 'qa-owner@club.test' && /Internal note · qa-owner/.test(b[b.length - 1]), `bubble: "${b[b.length - 1].slice(0, 70)}"`);
  await page.click('#tabReplyMode');

  // ---------- failed reply (a number that is not a staging test phone)
  await page.fill('#inboxSearchInput', 'Diya'); await sleep(900);
  const diyaListed = await page.evaluate(() => INBOX_CHATS.map((c) => c.member_name || c.phone_key));
  await page.click('.inbox-item:has-text("Diya")'); await sleep(1200);
  await page.fill('#inboxReplyInput', 'Yes, the pool is open.'); await page.click('#inboxSendBtn'); await sleep(1500);
  b = await bubbles();
  rec('Search', 'search by name finds the conversation (server side)', diyaListed.length === 1 && /Diya/.test(diyaListed[0]), JSON.stringify(diyaListed));
  rec('Failed reply', 'a reply WhatsApp refuses shows FAILED with the reason', /FAILED/.test(b[b.length - 1]) && /Not delivered/.test(b[b.length - 1]), `bubble: "${b[b.length - 1].slice(0, 110)}"`);

  // ---------- closed 24h window: template only, built from the real template
  await page.fill('#inboxSearchInput', 'Kabir'); await sleep(900);
  await page.click('.inbox-item:has-text("Kabir")'); await sleep(1200);
  s = await page.evaluate(() => ({ chk: document.getElementById('chkSendAsTemplate').checked, dis: document.getElementById('chkSendAsTemplate').disabled, panel: !document.getElementById('inboxTplPanel').classList.contains('hidden'), ta: document.getElementById('inboxReplyInput').classList.contains('hidden'), banner: document.getElementById('inboxWindowNoticeText').textContent }));
  rec('24h window', 'more than 24 hours after the member\'s last message, only a template can be sent', s.chk && s.dis && s.panel && s.ta, s.banner);
  await waitFor(() => !!document.querySelector('#inboxTplSelect'), null, 10000);
  const opts = await page.$$eval('#inboxTplSelect option', (els) => els.map((e) => e.value).filter(Boolean));
  await page.selectOption('#inboxTplSelect', opts.find((v) => v.startsWith('dues_reminder|'))); await sleep(400);
  const fields = await page.$$eval('#inboxTplPanel .inbox-tpl-grid .inbox-tpl-l', (els) => els.map((e) => e.textContent.trim()));
  rec('Templates', 'the approved template list comes from WhatsApp; dues_reminder shows its 6 real blanks', opts.length >= 5 && fields.length === 6, `${opts.length} templates; blanks: ${fields.join(' / ')}`);
  await page.click('#inboxSendBtn'); await sleep(500);
  rec('Templates', 'sending with required blanks empty is refused before anything is sent', /Fill in every blank/.test(await toastTxt()), await toastTxt());
  const inputs = page.locator('#inboxTplPanel .inbox-tpl-grid input, #inboxTplPanel .inbox-tpl-grid textarea');
  await inputs.nth(1).fill('2nd year (2026-27)'); await inputs.nth(2).fill('₹29,500'); await inputs.nth(3).fill('Please clear the dues at the office.');
  const pv = await t('#inboxTplPreview');
  await page.click('#inboxSendBtn'); await sleep(1500);
  b = await bubbles();
  const [tplRow] = await q(`select template_name, status, body from public.wa_messages where tenant_id=$1 and phone_key='910000000003' and direction='out' order by created_at desc limit 1`, [T]);
  rec('Templates', 'the filled template is sent to WhatsApp and the Inbox shows the text the member sees', tplRow && tplRow.template_name === 'dues_reminder' && /₹29,500/.test(tplRow.body) && /Kabir/.test(pv), `stored: ${tplRow && tplRow.status}; preview starts "${pv.slice(0, 60)}"`);

  // ---------- resolve, then the member writes again
  await page.fill('#inboxSearchInput', ''); await page.evaluate(() => onInboxSearch()); await sleep(900);
  await page.fill('#inboxSearchInput', 'Test Phone'); await sleep(900);
  await page.click('.inbox-item:has-text("Test Phone 1")'); await sleep(1000);
  await page.click('#activeChatResolveBtn'); await sleep(900);
  c = await conv(PHONE);
  rec('Resolve', 'Resolve is stored for the team with who did it', c.status === 'resolved' && c.resolved_by_email === 'qa-owner@club.test', `status ${c.status}, by ${c.resolved_by_email}`);
  await page.fill('#inboxSearchInput', ''); await page.evaluate(() => onInboxSearch()); await sleep(900);
  const inOpenBefore = await page.evaluate((k) => INBOX_CHATS.some((c) => c.phone_key === k), PHONE);
  await q(`update public.wa_conversations set bot_paused=false, bot_paused_until=null where tenant_id=$1 and phone_key=$2`, [T, PHONE]);
  await bot(ev(txt('One more question please'))); await sleep(1200);
  c = await conv(PHONE);
  const inOpenAfter = await page.evaluate((k) => INBOX_CHATS.some((c) => c.phone_key === k), PHONE);
  rec('Resolve', 'a resolved chat reopens by itself when the member writes, and comes back to Open live', !inOpenBefore && c.status === 'open' && c.reopened_at && inOpenAfter, `in Open before: ${inOpenBefore}, after: ${inOpenAfter}`);

  // ---------- alerts
  await page.click('#inboxAlertBtn'); await sleep(300);
  await page.check('input[name="waAlertMode"][value="all"]'); await sleep(300);
  await page.keyboard.press('Escape');
  const n0 = await page.evaluate(() => window.__notes.length);
  await bot(ev(txt('Hello, I would like to book a court', '919900000007'))); await sleep(1500);
  const notes = await page.evaluate(() => window.__notes);
  const title = await page.title();
  rec('Alerts', 'a new member message raises a browser alert with the member and text', notes.length === n0 + 1 && /WhatsApp:/.test(notes[notes.length - 1].title) && /book a court/.test(notes[notes.length - 1].body), JSON.stringify(notes[notes.length - 1] || {}).slice(0, 140));
  rec('Alerts', 'the tab title shows the number of unread conversations', /^\(\d+\) /.test(title), title);
  const page2 = await context.newPage(); watch(page2);
  await page2.goto(APP + '/admin/'); await page2.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(2500);
  const a0 = await page.evaluate(() => window.__notes.length), b0 = await page2.evaluate(() => window.__notes.length);
  await bot(ev(txt('Second message for two tabs', '919900000008'))); await sleep(2000);
  const a1 = await page.evaluate(() => window.__notes.length), b1 = await page2.evaluate(() => window.__notes.length);
  rec('Alerts', 'with the CRM open in two tabs, one message gives one alert (not two)', (a1 - a0) + (b1 - b0) === 1, `tab 1: +${a1 - a0}, tab 2: +${b1 - b0}`);
  await page2.close();
  await page.evaluate(() => selectChat('919900000009')); await sleep(900);
  const a2 = await page.evaluate(() => window.__notes.length);
  await bot(ev(txt('Message in the open chat', '919900000009'))); await sleep(1200);
  rec('Alerts', 'no alert for the conversation already open on screen', (await page.evaluate(() => window.__notes.length)) === a2, 'no alert');

  // ---------- the connection drops (laptop sleep, network): what arrived meanwhile appears once it is back
  await page.evaluate((k) => selectChat(k), PHONE); await sleep(1000);
  fake.dropSockets(); await sleep(300);
  await bot(ev(txt('Sent while the connection was down')));
  const caughtUp = await waitFor(() => ACTIVE_MSGS.some((m) => m.body === 'Sent while the connection was down') && document.getElementById('inboxLiveState').textContent === 'Live', null, 30000);
  const listHas = await page.evaluate((k) => { const c = INBOX_CHATS.find((x) => x.phone_key === k); return c && c.last_message_preview; }, PHONE);
  rec('Live updates', 'after a dropped connection the page reconnects by itself and shows the messages that arrived meanwhile', caughtUp, `label "${await t('#inboxLiveState')}", list preview "${String(listHas || '').slice(0, 50)}"`);

  // ---------- Settings: timings, maintenance, auto-pause, quick replies, payment link; saved without losing anything
  await page.evaluate(() => go('settings')); await sleep(900);
  const cfgBefore = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  const facIdx = await page.evaluate(() => ({ sc: FACILITIES.findIndex((f) => f.name === 'Strength & Conditioning'), sh: FACILITIES.findIndex((f) => f.name === 'Shooting') }));
  await page.locator('#facilityList .set-row3').nth(facIdx.sc).locator('input').nth(1).fill('6 AM – 8 PM');
  await page.locator('#facilityList .set-row3').nth(facIdx.sh).locator('input').nth(1).fill('4 PM – 9 PM');
  await page.fill('#s_maintenance', '12 PM – 3 PM');
  await page.selectOption('#s_auto_pause', '10');
  await page.click('#inboxSettingsCard button:has-text("+ Add")');
  await page.locator('#quickReplyList input').first().fill('Pool timings');
  await page.locator('#quickReplyList textarea').first().fill('The pool is open 6 AM – 9 PM every day.');
  await page.fill('#s_payment_link', 'http://not-secure.example');
  await page.click('#setSave'); await sleep(600);
  rec('Settings', 'a payment link that is not https is refused', /https/.test(await toastTxt()), await toastTxt());
  await page.fill('#s_payment_link', 'https://pay.example.org/shakti');
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{booking_note}', '"CHANGED BY ANOTHER ADMIN"') where id=$1`, [T]);
  await page.click('#setSave'); await sleep(1500);
  const cfgAfter = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  const f = (n) => (cfgAfter.facilities || []).find((x) => x.name === n) || {};
  const lostKeys = Object.keys(cfgBefore).filter((k) => !(k in cfgAfter));
  rec('Settings', 'facility timings, maintenance, auto-pause, quick reply and payment link are saved', f('Strength & Conditioning').timings === '6 AM – 8 PM' && f('Shooting').timings === '4 PM – 9 PM' && cfgAfter.maintenance === '12 PM – 3 PM' && cfgAfter.inbox.auto_pause_minutes === 10 && cfgAfter.inbox.quick_replies.length === 1 && cfgAfter.payments.link === 'https://pay.example.org/shakti', `S&C ${f('Strength & Conditioning').timings}; Shooting ${f('Shooting').timings}; maintenance ${cfgAfter.maintenance}; pause ${cfgAfter.inbox.auto_pause_minutes}`);
  rec('Settings', 'saving keeps every other setting, including a change another admin made meanwhile', !lostKeys.length && cfgAfter.booking_note === 'CHANGED BY ANOTHER ADMIN' && JSON.stringify(cfgAfter.menu) === JSON.stringify(cfgBefore.menu), `lost keys: ${lostKeys.length ? lostKeys.join(',') : 'none'}; other admin's change kept: ${cfgAfter.booking_note === 'CHANGED BY ANOTHER ADMIN'}`);
  o1 = await outCount();
  await bot(ev(tap('menu:facilities'))); await sleep(500);
  const facMsg = (await q(`select payload from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0].payload;
  const facText = JSON.stringify(facMsg);
  rec('Bot texts', 'the bot\'s "Sports & facilities" reply uses the new Settings at once', /Strength & Conditioning\* — 6 AM – 8 PM/.test(facText) && /Shooting\* — 4 PM – 9 PM/.test(facText) && /Maintenance timings:\* 12 PM – 3 PM/.test(facText), (facMsg.interactive ? facMsg.interactive.body.text : '').split('\n').filter((l) => /Strength|Shooting|Maintenance/.test(l)).join(' / '));
  // another admin edits the FAQ while this page is open; this page changes only the maintenance timings
  await sleep(600);
  let d0 = issues.dialogs.length;
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{faq}', '[{"q":"Is there parking?","a":"Yes, free parking for members."}]') where id=$1`, [T]);
  await page.fill('#s_maintenance', '12 PM – 3:30 PM');
  await page.click('#setSave'); await sleep(1500);
  let cfgNow = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  rec('Settings', 'saving one change keeps another admin\'s change to a different setting (their new FAQ), without asking', cfgNow.faq.length === 1 && cfgNow.faq[0].q === 'Is there parking?' && cfgNow.maintenance === '12 PM – 3:30 PM' && issues.dialogs.length === d0, `FAQ "${cfgNow.faq[0] && cfgNow.faq[0].q}", maintenance ${cfgNow.maintenance}`);
  // both change the same setting: the page asks whose version to keep (the test answers OK = mine)
  await sleep(600); d0 = issues.dialogs.length;
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{maintenance}', '"1 PM – 2 PM"') where id=$1`, [T]);
  await page.fill('#s_maintenance', '12 PM – 3 PM');
  await page.click('#setSave'); await sleep(1500);
  cfgNow = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  const asked = issues.dialogs.slice(d0).find((x) => /Someone else changed these settings/.test(x));
  rec('Settings', 'when someone else changed the same setting meanwhile, the page asks before replacing it', !!asked && /Maintenance timings/.test(asked) && cfgNow.maintenance === '12 PM – 3 PM', asked ? asked.split('\n').slice(0, 3).join(' / ') : 'no question asked');

  // ---------- quick replies + the 10-minute auto pause from Settings
  await page.evaluate(() => go('inbox')); await sleep(500);
  await page.evaluate((k) => selectChat(k), PHONE); await sleep(1000);
  await page.click('button:has-text("Quick replies")'); await sleep(300);
  await page.click('#cannedItemsList .canned-item:has-text("Pool timings")'); await sleep(200);
  const qv = await page.inputValue('#inboxReplyInput');
  rec('Quick replies', 'quick replies come from Settings (no made-up texts) and fill the reply box', qv === 'The pool is open 6 AM – 9 PM every day.', qv);
  await page.evaluate(() => loadSettings()); await sleep(400);
  await page.click('#inboxSendBtn'); await sleep(1500);
  c = await conv(PHONE);
  const pm = (new Date(c.bot_paused_until) - Date.now()) / 60000;
  rec('Staff reply', 'with 10 minutes set in Settings, a staff reply pauses the bot for 10 minutes', pm > 9 && pm <= 10.2, `${pm.toFixed(1)} minutes; toast "${await toastTxt()}"`);

  // ---------- Customer 360 → Reminder uses the payment link as saved NOW, even if this tab loaded before it changed
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments}', '{"link":"https://pay.example.org/changed-elsewhere"}') where id=$1`, [T]);
  await page.evaluate((k) => selectChat(k), PHONE); await sleep(800);
  const remMember = (await q(`select id from public.members where tenant_id=$1 and phone=$2`, [T, PHONE]))[0].id;
  await page.evaluate((id) => sendDirectDuesReminder(id), remMember); await sleep(1500);
  const remText = await page.inputValue('#inboxReplyInput');
  rec('Payment link', 'Customer 360 → Reminder includes the payment link saved in Settings, even one changed after this page was opened', remText.includes('https://pay.example.org/changed-elsewhere') && /₹1,500/.test(remText), remText.replace(/\s+/g, ' ').slice(0, 160));
  await page.fill('#inboxReplyInput', '');
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments}', '{"link":"https://pay.example.org/shakti"}') where id=$1`, [T]);

  // ---------- Campaigns: two sheet rows with the same number
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(800);
  await page.evaluate(() => setAudSource('sheet')); await sleep(300);
  const csv = `Name,Mobile,Due\nRahul Shah,${PHONE.slice(2)},₹500\nRahul Shah,${PHONE},₹700\n`;
  await page.setInputFiles('#sheetFile', { name: 'dues.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await sleep(1200);
  const info = await t('#sheetInfoBox');
  const recips = await page.evaluate(() => CMP.customRecipients.map((r) => ({ row: r.row_no, phone: r.phone, due: r.row_cols.Due })));
  rec('Campaigns', 'a sheet with the same number on two rows keeps both rows and says so', recips.length === 2 && /1 row\(s\) use a phone number that is already on an earlier row/.test(info) && recips.map((r) => r.row).join(',') === '2,3', `rows ${JSON.stringify(recips)}; "${info.slice(info.indexOf('1 row'), info.indexOf('1 row') + 80)}"`);
  await page.check('#sheet_dedup_phone'); await sleep(500);
  const skipInfo = await t('#sheetInfoBox');
  const n1 = await page.evaluate(() => CMP.customRecipients.length);
  rec('Campaigns', '"Only one message per phone number" (optional) skips the repeated row and says so', n1 === 1 && /1 row\(s\) skipped/.test(skipInfo), `${n1} recipient`);
  await page.setInputFiles('#sheetFile', { name: 'dues2.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await sleep(1200);
  const reset = await page.evaluate(() => ({ chk: document.getElementById('sheet_dedup_phone').checked, n: CMP.customRecipients.length }));
  rec('Campaigns', 'a new sheet starts with every row included again (the option does not stick)', !reset.chk && reset.n === 2, JSON.stringify(reset));
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarSrc('3', 'col:Due'); setVarText('2', '2026-27'); setVarText('4', 'Please clear your dues at the office.'); setVarSrc('5', 'payment_link'); }); await sleep(500);
  const guard = await page.evaluate(() => {
    const keep = BOT_CONFIG.payments; BOT_CONFIG.payments = {};
    const noLink = msgIssues().find((x) => /no payment link is saved/.test(x)) || null;
    BOT_CONFIG.payments = keep;
    setVarSrc('3', 'dues_amount');
    const sheetDues = msgIssues().find((x) => /only CRM members have/.test(x)) || null;
    setVarSrc('3', 'col:Due');
    return { noLink, sheetDues, clean: msgIssues().length === 0 };
  });
  rec('Campaigns', 'an empty payment link or a CRM dues amount for a sheet stops the send with a clear reason (nothing blank goes out)', !!guard.noLink && !!guard.sheetDues && guard.clean, `${String(guard.noLink).slice(0, 70)} / ${String(guard.sheetDues).slice(0, 60)}`);
  await page.fill('#c_name', 'Bench dues (two rows)');
  const o2 = await outCount();
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 30000);
  const res = await t('#cmpResult');
  const sends = (await q(`select phone, payload from public.stg_outbox where kind='meta_message' order by id desc limit 2`)).reverse();
  const amounts = sends.map((x) => x.payload.template.components.find((cc) => cc.type === 'body').parameters[2].text);
  const links = sends.map((x) => x.payload.template.components.find((cc) => cc.type === 'body').parameters[4].text);
  rec('Campaigns', 'sending it gives TWO messages to that number, each with its own amount and the Settings payment link', (await outCount()) === o2 + 2 && amounts.join(',') === '₹500,₹700' && links.every((l) => l === 'https://pay.example.org/shakti') && /Sent to 2/.test(res), `${res.slice(0, 60)}; amounts ${amounts.join(' then ')}`);
  const bid = await page.evaluate(() => CMP.id);
  await page.evaluate((id) => { closeComposer && closeComposer(); openReport(id); }, bid); await sleep(1500);
  const rep = await t('#reportBody');
  const [cmpRow] = await q(`select body from public.wa_messages where tenant_id=$1 and phone_key=$2 and sender_kind='campaign' order by created_at desc limit 1`, [T, PHONE]);
  rec('Campaigns', 'in the Inbox, a campaign message shows the full text the member received', /Hi Rahul/.test(cmpRow.body) && /₹700/.test(cmpRow.body) && /https:\/\/pay\.example\.org\/shakti/.test(cmpRow.body), cmpRow.body.replace(/\s+/g, ' ').slice(0, 140));
  rec('Campaigns', 'the campaign report lists both messages with their sheet rows', /sheet row 2/.test(rep) && /sheet row 3/.test(rep), rep.match(/sheet row \d/g)?.join(', ') || rep.slice(0, 120));
  await page.evaluate(() => closeReport && closeReport());
  await page.screenshot({ path: OUT + 'owner.png' });

  // ---------- front desk: own login, Mine tab, no money details
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await fake.attach(ctx2);
  const dp = await ctx2.newPage(); const dIssues = watch(dp);
  await login(dp, 'qa-desk@club.test');
  await dp.evaluate(() => go('inbox')); await sleep(1000);
  const mine = await dp.evaluate(async () => { setInboxTab('mine'); await new Promise((r) => setTimeout(r, 900)); return INBOX_CHATS.map((c) => c.phone_key); });
  rec('Roles', 'front desk: "Mine" shows the conversation assigned to them', mine.includes(PHONE), JSON.stringify(mine));
  await dp.evaluate((k) => selectChat(k), PHONE); await sleep(1200);
  const ctxTxt = ((await dp.locator('#ctxProfileContent').textContent()) || '').replace(/\s+/g, ' ');
  const listTxt = ((await dp.locator('#inboxChatList').textContent()) || '');
  rec('Roles', 'front desk: no dues amounts in the Inbox (money is for owner, manager, accounts)', !/Pending|₹/.test(ctxTxt) && !/Due ₹/.test(listTxt), ctxTxt.slice(0, 120));
  await dp.fill('#inboxReplyInput', 'Front desk here, noted.'); await dp.click('#inboxSendBtn'); await sleep(1500);
  const db2 = await dp.$$eval('#inboxMessageScroll .inbox-bubble', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  rec('Roles', 'front desk can reply; the message shows who sent it', /qa-desk/.test(db2[db2.length - 1]), db2[db2.length - 1].slice(0, 80));
  rec('Page health', 'front desk session: no script errors', !dIssues.page.length, dIssues.page.join(' | ') || 'none');
  await ctx2.close();

  // ---------- phone layout
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await fake.attach(ctx3);
  const mp = await ctx3.newPage(); watch(mp);
  await login(mp, 'qa-owner@club.test');
  await mp.evaluate(() => go('inbox')); await sleep(1000);
  const listVis = await mp.isVisible('#inboxChatList'), threadVis0 = await mp.isVisible('#inboxMain');
  await mp.click('.inbox-item >> nth=0'); await sleep(1200);
  const listVis2 = await mp.isVisible('.inbox-sidebar'), threadVis = await mp.isVisible('#inboxThreadView');
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1
    || [...document.querySelectorAll('#inboxThreadView .inbox-header *')].some((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1; }));
  await mp.screenshot({ path: OUT + 'phone.png' });
  await mp.click('.inbox-back'); await sleep(400);
  const back = await mp.isVisible('.inbox-sidebar');
  rec('Phone layout', 'on a phone: list first, one tap opens the chat full-width, Back returns; no sideways scrolling', listVis && !threadVis0 && !listVis2 && threadVis && back && !overflow, `list ${listVis}, chat ${threadVis}, back ${back}, sideways scroll ${overflow}`);
  await ctx3.close();
} catch (e) {
  rec('Run', 'the QA run finished without a script error', false, e.message);
  await page.screenshot({ path: OUT + 'error.png' }).catch(() => {});
}
rec('Page health', 'owner session: no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('Bench', 'every database request was one the stand-in supports', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('Bench', 'no request went to a live (non-staging) webhook', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), [...new Set(fake.log.webhooks)].join(', '));
writeFileSync(OUT + 'browser-results.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`);
fake.stop(); await browser.close(); process.exit(0);

function botPaused(cv) { return !!cv && (cv.bot_paused || (cv.bot_paused_until && new Date(cv.bot_paused_until) > Date.now())); }
