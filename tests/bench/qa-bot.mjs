// QA regression checks for the WhatsApp bot (wa_bot_wf.json, node "Bot Engine"), run on the local bench:
// the STAGING-BUILT code (guard included) against the staging SQL in PGlite, with simulated Meta.
// Two test doubles are added in memory only, inside the staging guard: the lead webhook can be made to
// answer an HTTP error (globalThis.__qaLeadStatus) and Meta can refuse one message type
// (globalThis.__qaFailType). Nothing here reaches a real service.
import { readFileSync } from 'node:fs';
import { makeDb, world, metaItem, cfg, B, benchCode } from './harness.mjs';
const db = await makeDb();
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0;
const ok = (l, evidence = '') => { n++; console.log(`PASS ${n}. ${l}${evidence ? ' | ' + evidence : ''}`); };
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exit(1); } };
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const PNID = cfg.whatsapp.phoneNumberId;
const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);

// ---- the bot's code, with the two test doubles ----
const once = (code, a, b) => { const parts = code.split(a); if (parts.length !== 2) throw new Error('test double: substring found ' + (parts.length - 1) + ' times: ' + a.slice(0, 60)); return parts.join(b); };
let code = benchCode('wa_bot_wf.json', 'Bot Engine');
code = once(code, 'return __stgFake(opts, 200, { ok: true, simulated: true });', 'return __stgFake(opts, globalThis.__qaLeadStatus || 200, { ok: !globalThis.__qaLeadStatus, simulated: true });');
const metaLine = String.raw`if (method === 'POST' && /(^|\/)messages$/.test(p)) {`;
code = once(code, metaLine, `if (method === 'POST' && globalThis.__qaFailType && b.type === globalThis.__qaFailType) return __stgFake(opts, 400, { error: { message: '(#131053) Media upload error', code: 131053, error_data: { details: 'Downloading media from weblink failed' } } });\n    ` + metaLine);
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFn('$input', 'Buffer', 'setTimeout', code);
const run = async (body, opts) => { const w = world(db); const item = metaItem(w, body, opts); const out = await engine.call({ helpers: w.helpers }, { first: () => item }, Buffer, setTimeout); return { out: out[0].json, w }; };

let seq = 0;
const change = (pnid, value = {}) => ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, ...value } });
const body = (...changes) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes }] });
const msgs = (pnid, msg) => change(pnid, { contacts: [{ wa_id: msg.from }], messages: [msg] });
const ev = (msg, pnid = PNID) => body(msgs(pnid, msg));
const now = () => String(Math.floor(Date.now() / 1000));
const txt = (b, from = PHONE) => ({ from, id: `wamid.QA.${++seq}`, timestamp: now(), type: 'text', text: { body: b } });
const tap = (id, from = PHONE) => ({ from, id: `wamid.QA.${++seq}`, timestamp: now(), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } });
const outbox = async () => q(`select * from public.stg_outbox where kind='meta_message' order by id`);
const lastOut = async () => (await q(`select * from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
const count = async (sql, p) => Number((await q(sql, p))[0].n);
const bodyOf = (m) => (m.payload.text && m.payload.text.body) || (m.payload.interactive && m.payload.interactive.body && m.payload.interactive.body.text) || '';

// ---------- bot_workflow-01: each club's part of an event must carry that club's own signature ----------
const [{ id: TB }] = await q(`insert into public.tenants (name, slug, wa_phone_number_id, wa_token, bot_config) values ('QA Club B','qa-club-b','PN_CLUBB','TOKB','{"brand":{"name":"QA Club B"},"menu":[{"id":"menu:human","title":"Talk to Team"}]}') returning id`);
await q(`insert into public.wa_webhook_config (tenant_id, app_secret) values ($1,'club-b-own-app-secret')`, [TB]);
let before = await count(`select count(*) n from public.wa_messages where tenant_id=$1`, [T]);
let sentBefore = (await outbox()).length;
let forged = txt('Hi, forged for Shakti');
let r = await run(body(change('PN_CLUBB'), msgs(PNID, forged)), { secret: 'club-b-own-app-secret' });
assert((await count(`select count(*) n from public.wa_messages where wamid=$1`, [forged.id])) === 0 && (await count(`select count(*) n from public.wa_messages where tenant_id=$1`, [T])) === before && (await outbox()).length === sentBefore, 'forged part stored or answered ' + JSON.stringify(r.out));
assert(r.out.results.some((x) => x.ok === false && /signature does not match/.test(x.error)), 'forged part not reported ' + JSON.stringify(r.out));
const bMsg = txt('Hello club B', PHONE);
r = await run(ev(bMsg, 'PN_CLUBB'), { secret: 'club-b-own-app-secret' });
assert(r.out.signature === 'verified' && (await count(`select count(*) n from public.wa_messages where wamid=$1 and tenant_id=$2`, [bMsg.id, TB])) === 1, 'club B own event ' + JSON.stringify(r.out));
const good = txt('Hi, the real one');
r = await run(ev(good));
assert(r.out.signature === 'verified' && (await count(`select count(*) n from public.wa_messages where wamid=$1 and tenant_id=$2`, [good.id, T])) === 1, 'shakti own event ' + JSON.stringify(r.out));
ok('an event signed with ANOTHER club\'s app secret is refused for Shakti\'s number (nothing stored, nothing sent); each club\'s own signed events still work');

// ---------- bot_workflow-02: a status sent under another club (or no club) never changes Shakti's messages or campaigns ----------
const [{ id: TC }] = await q(`insert into public.tenants (name, slug, wa_phone_number_id, wa_token, bot_config) values ('QA Club C','qa-club-c','PN_CLUBC','TOKC','{}') returning id`);
const cmpBody = (wamid) => JSON.stringify({ recipients: [{ phone: PHONE, wamid, status: 'sent' }], stats: { sent: 1, delivered: 0, read: 0, failed: 0 } });
const [{ id: BC }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Dues October','dues_reminder','All','sent',$2) returning id`, [T, cmpBody('wamid.QA.CMP.1')]);
await q(`insert into public.wa_message_status (wamid, tenant_id, broadcast_id, phone, status) values ('wamid.QA.CMP.1',$1,$2,$3,'sent'), ('wamid.QA.BOT.1',$1,null,$3,'sent')`, [T, BC, PHONE]);
const [{ id: BL }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Legacy campaign','dues_reminder','All','sent',$2) returning id`, [T, cmpBody('wamid.QA.LEGACY.1')]);
const stEv = (pnid, id, status) => body(change(pnid, { statuses: [{ id, status, timestamp: now(), recipient_id: PHONE, ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Message undeliverable' }] } : {}) }] }));
for (const id of ['wamid.QA.CMP.1', 'wamid.QA.BOT.1']) await run(stEv('PN_CLUBC', id, 'failed'), { unsigned: true });
await run(stEv('PN_NOBODY', 'wamid.QA.LEGACY.1', 'read'), { unsigned: true });
await run(stEv('PN_CLUBC', 'wamid.QA.LEGACY.1', 'read'), { unsigned: true });
let sts = Object.fromEntries((await q(`select wamid, status from public.wa_message_status where tenant_id=$1 and wamid like 'wamid.QA.%'`, [T])).map((x) => [x.wamid, x.status]));
const recip = async (id) => JSON.parse((await q(`select body from public.broadcasts where id=$1`, [id]))[0].body);
let c1 = await recip(BC), c2 = await recip(BL);
assert(sts['wamid.QA.CMP.1'] === 'sent' && sts['wamid.QA.BOT.1'] === 'sent' && c1.recipients[0].status === 'sent' && c1.stats.failed === 0 && c2.recipients[0].status === 'sent', 'forged statuses applied ' + JSON.stringify({ sts, c1: c1.recipients, c2: c2.recipients }));
await run(stEv(PNID, 'wamid.QA.CMP.1', 'delivered'));
await run(stEv(PNID, 'wamid.QA.LEGACY.1', 'read'));
sts = Object.fromEntries((await q(`select wamid, status from public.wa_message_status where tenant_id=$1 and wamid like 'wamid.QA.%'`, [T])).map((x) => [x.wamid, x.status]));
c1 = await recip(BC); c2 = await recip(BL);
assert(sts['wamid.QA.CMP.1'] === 'delivered' && c1.recipients[0].status === 'delivered' && c2.recipients[0].status === 'read', 'own statuses ' + JSON.stringify({ sts, c1: c1.recipients, c2: c2.recipients }));
ok('an unsigned status sent under another club\'s (or an unknown) phone number id leaves Shakti\'s message, campaign report and legacy campaign untouched; Shakti\'s own signed statuses still apply');

// ---------- bot_workflow-03: a lead the webhook refused is not marked as posted ----------
const P55 = '919900000055';
const leads = async () => (await q(`select * from public.stg_outbox where kind='lead' order by id`)).length;
const conv = async (p) => (await q(`select last_lead_at, last_lead_intent from public.wa_conversations where tenant_id=$1 and phone_key=$2`, [T, p]))[0] || {};
let l0 = await leads();
globalThis.__qaLeadStatus = 500;
r = await run(ev(txt('What are your membership fees?', P55)));
assert(r.out.results[0].lead_posted === false && (await leads()) === l0 + 1 && !(await conv(P55)).last_lead_at, 'lead 500 marked posted ' + JSON.stringify([r.out.results[0], await conv(P55)]));
globalThis.__qaLeadStatus = 0;
r = await run(ev(txt('Can I get a membership brochure?', P55)));
assert(r.out.results[0].lead_posted === true && (await leads()) === l0 + 2 && (await conv(P55)).last_lead_intent === 'ai_enquiry', 'lead retry ' + JSON.stringify([r.out.results[0], await conv(P55)]));
r = await run(ev(txt('And do you have a swimming pool?', P55)));
assert(r.out.results[0].lead_posted === false && (await leads()) === l0 + 2, 'lead de-dup after success');
ok('when the lead webhook answers HTTP 500 the lead is not recorded as posted, so the next enquiry posts it; after a success the once-a-day rule still holds');

// ---------- bot_workflow-05: when Meta refuses the banner, the menu carries the welcome ----------
const oldHistory = (p) => q(`update public.wa_messages set created_at = created_at - interval '1 day' where tenant_id=$1 and phone=$2`, [T, p]);
await oldHistory(PHONE);
globalThis.__qaFailType = 'image';
r = await run(ev(txt('Hi')));
let g = r.out.results[0];
let menu = await lastOut();
assert(g.banner_sent === false && menu.payload.type === 'interactive' && /How can we help you today\?/.test(bodyOf(menu)) && !/What would you like to explore/.test(bodyOf(menu)), 'member banner failed ' + JSON.stringify([g, bodyOf(menu)]));
const P66 = '919900000066';
r = await run(ev(txt('Hi', P66)));
const [prospectMenu] = await q(`select body from public.wa_messages where tenant_id=$1 and phone=$2 and direction='out' and msg_type='interactive' order by created_at desc limit 1`, [T, P66]);
assert(r.out.results[0].banner_sent === false && /Welcome to Shakti Sports Club/.test(prospectMenu.body) && !/What would you like to explore/.test(prospectMenu.body), 'prospect banner failed ' + JSON.stringify(prospectMenu));
globalThis.__qaFailType = null;
await oldHistory(PHONE);
r = await run(ev(txt('Hi')));
menu = await lastOut();
assert(r.out.results[0].banner_sent === true && /What would you like to explore\?/.test(bodyOf(menu)), 'banner ok control ' + bodyOf(menu));
ok('when Meta refuses the welcome banner, the menu itself carries the welcome (member and prospect); with the banner delivered the menu stays short', bodyOf(menu).slice(0, 50));

// ---------- events: past events, cancelled and portal registrations, legacy "confirmed", database errors ----------
for (let i = 1; i <= 11; i++) await q(`insert into public.events (tenant_id, title, kind, starts_at, capacity, fee, is_open) values ($1,$2,'tournament', now() - ($3 || ' days')::interval, 10, 100, true)`, [T, 'QA finished cup ' + i, String(i + 1)]);
r = await run(ev(tap('menu:events')));
let m = await lastOut();
let rows = m.payload.interactive.action.sections[0].rows.map((x) => x.title);
assert(rows.length && rows.every((t) => !/QA finished cup/.test(t)) && rows.some((t) => /QA test event/.test(t)), 'events list ' + JSON.stringify(rows));
const [{ id: PAST }] = await q(`select id from public.events where title='QA finished cup 3'`);
r = await run(ev(tap('act:reg:' + PAST)));
m = await lastOut();
assert(/not open for registration/.test(bodyOf(m)) && (await count(`select count(*) n from public.event_registrations where event_id=$1`, [PAST])) === 0, 'past registration ' + bodyOf(m));
ok('events that already took place are not listed under "Upcoming" and cannot be registered for; 11 stale open events no longer hide the upcoming ones', rows.join(' / '));

const newEvent = async (title) => (await q(`insert into public.events (tenant_id, title, kind, starts_at, capacity, fee, is_open) values ($1,$2,'event', now() + interval '5 days', 5, 250, true) returning id`, [T, title]))[0].id;
const EC = await newEvent('QA cancel test');
await run(ev(tap('act:reg:' + EC)));
await q(`update public.event_registrations set status='cancelled' where event_id=$1`, [EC]);
r = await run(ev(tap('act:reg:' + EC)));
m = await lastOut();
let regs = (await q(`select status from public.event_registrations where event_id=$1 order by created_at`, [EC])).map((x) => x.status);
assert(/You are registered for QA cancel test/.test(bodyOf(m)) && JSON.stringify(regs) === '["cancelled","registered"]', 'after cancel ' + JSON.stringify([bodyOf(m), regs]));
r = await run(ev(tap('act:reg:' + EC)));
m = await lastOut();
assert(/already registered for QA cancel test \(registered\)/.test(bodyOf(m)) && (await count(`select count(*) n from public.event_registrations where event_id=$1`, [EC])) === 2, 'second tap ' + bodyOf(m));
ok('after staff cancel a registration the member can register again on WhatsApp; an active registration still blocks a duplicate');

const EP = await newEvent('QA portal dup');
await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status, source) values ($1,$2,'Test Phone 1',$3,'registered','portal')`, [T, EP, PHONE.slice(-10)]);
r = await run(ev(tap('act:reg:' + EP)));
m = await lastOut();
assert(/already registered for QA portal dup/.test(bodyOf(m)) && (await count(`select count(*) n from public.event_registrations where event_id=$1`, [EP])) === 1, 'portal dup ' + bodyOf(m));
const EL = await newEvent('QA legacy confirmed');
await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status, source) values ($1,$2,$3,$3,'confirmed','WhatsApp')`, [T, EL, PHONE]);
r = await run(ev(tap('act:reg:' + EL)));
m = await lastOut();
assert(/already registered for QA legacy confirmed \(confirmed\)/.test(bodyOf(m)), 'legacy confirmed ' + bodyOf(m));
ok('a registration saved by the portal with a 10-digit phone, or by the old bot as "confirmed", counts as already registered (no second seat)');

const EX = await newEvent('QA conflict');
const EB = await newEvent('QA broken');
await db.exec(`create function public.qa_reg_fail() returns trigger language plpgsql as $$ begin
  if new.event_id = '${EX}' then raise exception 'duplicate' using errcode = '23505'; end if;
  if new.event_id = '${EB}' then raise exception 'something else went wrong'; end if; return new; end $$;
  create trigger qa_reg_fail before insert on public.event_registrations for each row execute function public.qa_reg_fail();`);
r = await run(ev(tap('act:reg:' + EX)));
m = await lastOut();
assert(r.out.ok && /already registered for QA conflict/.test(bodyOf(m)), 'conflict ' + JSON.stringify([r.out, bodyOf(m)]));
r = await run(ev(tap('act:reg:' + EB)));
m = await lastOut();
assert(r.out.ok && /could not register you for QA broken/.test(bodyOf(m)), 'insert error ' + JSON.stringify([r.out, bodyOf(m)]));
await db.exec(`drop trigger qa_reg_fail on public.event_registrations; drop function public.qa_reg_fail();`);
ok('when the database refuses a registration (a duplicate key, or any other error) the member gets a clear answer instead of silence');

// ---------- members-09 (bot part): members saved with spaces, +, dashes or a leading 0 are recognised ----------
const mem = async (name, phone) => (await q(`insert into public.members (tenant_id, full_name, phone, status) values ($1,$2,$3,'active') returning id`, [T, name, phone]))[0].id;
const MA = await mem('QA Format A', '+91 98765 00003'), MB = await mem('QA Format B', '098765 00004'), MC = await mem('QA Format C', '+91-98765-00005');
const found = [];
for (const [p, id] of [['919876500003', MA], ['919876500004', MB], ['919876500005', MC]]) { r = await run(ev(txt('hello there', p))); found.push(r.out.results[0].member === id); }
r = await run(ev(txt('hello there', '449876500003')));
assert(found.every(Boolean) && r.out.results[0].member === null, 'member formats ' + JSON.stringify([found, r.out.results[0].member]));
ok('the bot recognises members saved as "+91 98765 00003", "098765 00004" or "+91-98765-00005" (same number key as the Inbox), and not a foreign number that only shares the last 10 digits');

// ---------- settings-10: coaching rows without ages or timings ----------
await q(`update public.tenants set bot_config = jsonb_set(bot_config::jsonb, '{coaching}', '[{"sport":"क्रिकेट","timings":"4 – 7 PM"},{"sport":"Chess"},{"sport":"Tennis","ages":"8-16","timings":"6 – 8 AM","coach":"Coach R"}]'::jsonb) where id=$1`, [T]);
r = await run(ev(tap('menu:coaching')));
m = await lastOut();
const lines = bodyOf(m).split('\n').filter((x) => x.startsWith('•'));
assert(JSON.stringify(lines) === JSON.stringify(['• *क्रिकेट* — 4 – 7 PM', '• *Chess*', '• *Tennis* (age 8-16) — 6 – 8 AM · Coach R']), 'coaching ' + JSON.stringify(lines));
r = await run(ev(txt('Which coaching programs do you run?')));
const prompt = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
assert(!/\(age \)/.test(prompt) && /- Chess\n/.test(prompt) && /- क्रिकेट: 4 – 7 PM/.test(prompt), 'AI facts ' + (prompt.match(/COACHING[\s\S]{0,200}/) || [''])[0]);
ok('coaching rows saved without ages or timings read cleanly in the Coaching reply and in the AI\'s facts (no "(age ) — ")', lines.join(' | '));

// ---------- inbox-12 / bot_workflow-06: long messages are kept whole, and an emoji is never split ----------
const long = 'x'.repeat(4096);
let lm = txt(long);
await run(ev(lm));
let [st] = await q(`select body from public.wa_messages where wamid=$1`, [lm.id]);
assert(st && st.body.length === 4096, 'long stored ' + (st && st.body.length));
lm = txt('a'.repeat(1999) + '😀 please call me back about the membership renewal.');
await run(ev(lm));
[st] = await q(`select body from public.wa_messages where wamid=$1`, [lm.id]);
assert(st && st.body === lm.text.body, 'emoji at 2,000 ' + (st && st.body.length));
lm = txt('a'.repeat(4089) + '😀' + 'b'.repeat(20));
await run(ev(lm));
[st] = await q(`select body from public.wa_messages where wamid=$1`, [lm.id]);
assert(st && / \[cut\]$/.test(st.body) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(st.body), 'over-long cut ' + (st && st.body.slice(-12)));
ok('a 4,096-character member message is stored whole; one with an emoji at character 2,000 is stored intact; anything longer is marked "[cut]" without splitting an emoji');

// ---------- bot_workflow-10: clubs without a menu, or with an untitled item ----------
await q(`insert into public.tenants (name, slug, wa_phone_number_id, wa_token, bot_config) values
  ('QA Mini 1','qa-mini1','PN_MINI1','TOKM','{}'), ('QA Mini 2','qa-mini2','PN_MINI2','TOKM',null),
  ('QA Mini 3','qa-mini3','PN_MINI3','TOKM','{"brand":{},"menu":[{"id":"menu:human"},{"title":"No id"}]}')`);
const miniOut = {};
for (const p of ['PN_MINI1', 'PN_MINI2', 'PN_MINI3']) { r = await run(ev(txt('hi'), p)); assert(r.out.ok && r.out.results[0].sent, p + ' ' + JSON.stringify(r.out)); miniOut[p] = (await lastOut()).payload; }
assert(miniOut.PN_MINI1.type === 'text' && /Welcome to QA Mini 1/.test(miniOut.PN_MINI1.text.body) && miniOut.PN_MINI2.type === 'text', 'no-menu greeting ' + JSON.stringify([miniOut.PN_MINI1, miniOut.PN_MINI2]));
const mini3Rows = miniOut.PN_MINI3.interactive.action.sections[0].rows;
assert(mini3Rows.length === 1 && mini3Rows[0].title === 'Talk to Team', 'mini3 rows ' + JSON.stringify(mini3Rows));
r = await run(ev(tap('menu:visit'), 'PN_MINI3'));
m = await lastOut();
assert(!/\*\*/.test(bodyOf(m)) && bodyOf(m).trim().length > 0, 'visit text ' + JSON.stringify(bodyOf(m)));
ok('a club with no menu gets a plain-text welcome (never a list with zero rows); an item without a title gets its usual name, one without an id is left out; no stray "**"', mini3Rows.map((x) => x.title).join(','));

// ---------- bot_workflow-11: welcome requests and system notices ----------
const rw = { from: PHONE, id: `wamid.QA.${++seq}`, timestamp: now(), type: 'request_welcome' };
r = await run(ev(rw));
m = await lastOut();
assert(m.payload.type === 'interactive' && m.payload.interactive.type === 'list' && !/look at what you sent/.test(bodyOf(m)), 'request_welcome ' + JSON.stringify(m.payload).slice(0, 200));
sentBefore = (await outbox()).length;
const sys = { from: PHONE, id: `wamid.QA.${++seq}`, timestamp: now(), type: 'system', system: { body: 'User A changed from 919999900001 to 919999900002', type: 'user_changed_number', new_wa_id: '919999900002' } };
r = await run(ev(sys));
[st] = await q(`select body from public.wa_messages where wamid=$1`, [sys.id]);
assert((await outbox()).length === sentBefore && st && /\[system\] User A changed from/.test(st.body), 'system ' + JSON.stringify([st, r.out]));
ok('a first-time chat ("request_welcome") gets the greeting menu; a number-change notice is stored with its text for staff and gets no reply', st.body.slice(0, 40));

console.log(`\nAll ${n} bot QA checks passed on the local bench.`);
