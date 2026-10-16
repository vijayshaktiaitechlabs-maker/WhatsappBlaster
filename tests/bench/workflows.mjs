// End-to-end on the local bench: the STAGING-BUILT bot and Broadcast Send code (with the staging guard,
// simulated Meta, stand-in AI) against the real staging SQL (incl. sql/wa_inbox.sql) in PGlite.
import { readFileSync } from 'node:fs';
import { makeDb, world, runNode, metaItem, fakeTimers, cfg, B } from './harness.mjs';
const db = await makeDb();
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0; const results = [];
const ok = (l, evidence = '') => { n++; results.push({ ok: true, l, evidence }); console.log(`PASS ${n}. ${l}${evidence ? ' | ' + evidence : ''}`); };
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exit(1); } };
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const PNID = cfg.whatsapp.phoneNumberId;
const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
let seq = 0;
const ev = (msg, value = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, ...value, ...(msg ? { contacts: [{ wa_id: msg.from }], messages: [msg] } : {}) } }] }] });
const txt = (body, from = PHONE, id) => ({ from, id: id || `wamid.IN.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });
const tap = (tid, from = PHONE) => ({ from, id: `wamid.IN.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: tid, title: tid } } });
const bot = async (body, opts) => { const w = world(db); return { out: await runNode('wa_bot_wf.json', 'Bot Engine', metaItem(w, body, opts), w), w }; };
const outbox = async (kind) => q(`select * from public.stg_outbox where kind=$1 order by id`, [kind]);
const lastOut = async () => (await q(`select * from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
const count = async (sql, p) => Number((await q(sql, p))[0].n);

// ---------- signature ----------
let before = await count(`select count(*) n from public.wa_messages`);
let r = await bot(ev(txt('hi')), { secret: 'wrong-secret' });
assert(r.out.ok === false && /signature mismatch/.test(r.out.error) && (await count(`select count(*) n from public.wa_messages`)) === before, 'forged signature ' + JSON.stringify(r.out));
r = await bot(ev(txt('hi')), { unsigned: true });
assert(r.out.ok === false && (await count(`select count(*) n from public.wa_messages`)) === before, 'missing signature');
ok('a forged or missing Meta signature is refused: nothing stored, nothing sent');

// ---------- greeting ----------
// the staging test data has recent chat rows for this phone; make them a day old so "Hi" starts a new conversation
await q(`update public.wa_messages set created_at = created_at - interval '1 day' where phone_key=$1`, [PHONE]);
r = await bot(ev(txt('Hi')));
assert(r.out.ok && r.out.signature === 'verified', 'verified ' + JSON.stringify(r.out));
const g = r.out.results[0];
const sentG = await outbox('meta_message');
assert(g.reply_type === 'interactive' && sentG.length === 2 && sentG[0].payload.type === 'image' && sentG[1].payload.interactive.type === 'list', 'greeting ' + JSON.stringify(g));
const rowsG = await q(`select direction, sender_kind, status, wamid from public.wa_messages where phone_key=$1 and created_at > now() - interval '1 hour' order by created_at, id`, [PHONE]);
const outs = rowsG.filter((x) => x.direction === 'out');
assert(rowsG.some((x) => x.direction === 'in' && x.sender_kind === 'member' && x.wamid) && outs.length >= 2 && outs.every((x) => x.sender_kind === 'bot' && x.status === 'sent' && /^wamid\.STAGING\./.test(x.wamid)), 'rows ' + JSON.stringify(rowsG));
ok('a signed "Hi" gets the banner and the menu; the member message and both bot messages are stored with WhatsApp ids, sender and "sent"', `menu rows: ${sentG[1].payload.interactive.action.sections[0].rows.length}`);

// ---------- predefined texts from the club's settings (as edited in Settings) ----------
await q(`update public.tenants set bot_config = jsonb_set(jsonb_set(bot_config,
  '{facilities}', (select jsonb_agg(case f->>'name'
      when 'Strength & Conditioning' then f || '{"timings":"6 AM–8 PM"}'
      when 'Shooting' then f || '{"timings":"4 PM–9 PM","detail":"10 m range (with coach present), members only"}'
      else f end) from jsonb_array_elements(bot_config->'facilities') f)),
  '{maintenance}', '"12 PM – 3 PM"') where id=$1`, [T]);
r = await bot(ev(tap('menu:facilities')));
let m = await lastOut();
const facBody = m.payload.interactive.body.text;
assert(/\*Strength & Conditioning\* — 6 AM–8 PM/.test(facBody) && /\*Shooting\* — 4 PM–9 PM/.test(facBody) && /Maintenance timings:\* 12 PM – 3 PM/.test(facBody), 'facilities text: ' + facBody);
ok('"Sports & facilities" shows Strength & Conditioning 6 AM–8 PM, Shooting 4 PM–9 PM and "Maintenance timings: 12 PM – 3 PM" from the club settings', facBody.split('\n').filter((l) => /Strength|Shooting|Maintenance/.test(l)).join(' / '));
r = await bot(ev(tap('menu:visit')));
m = await lastOut();
assert(/Maintenance: 12 PM – 3 PM/.test(JSON.stringify(m.payload)), 'visit shows maintenance');
ok('"Timings & Location" also shows the maintenance timings');

// ---------- the AI: prompt content ----------
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, sender_kind, created_at) values ($1,$2,'out',$3,'bot', now() - interval '30 seconds')`,
  [T, PHONE, 'At Shakti Sports Club, we offer 10-year Family and Individual memberships. ' + 'x'.repeat(420) + ' annual maintenance ₹18,000 + GST from the 2nd year']);
await q(`select public.wa_note_add($1,$2,'INTERNAL NOTE: member owes a cheque',null)`, [T, PHONE]).catch(async () => {
  await q(`insert into public.wa_messages (tenant_id, phone, direction, body, sender_kind) values ($1,$2,'note','INTERNAL NOTE: member owes a cheque','note')`, [T, PHONE]);
});
r = await bot(ev(txt('What sports do you offer?')));
const prompts = await outbox('ai_prompt');
const prompt = prompts[prompts.length - 1].payload.text;
assert(/CURRENT TIMINGS \(always correct/.test(prompt) && /Strength & Conditioning: Fully air-conditioned performance gym \(6 AM–8 PM\)/.test(prompt) && /Maintenance timings: 12 PM – 3 PM/.test(prompt), 'timings in prompt');
assert(!/CONTINUE it/.test(prompt) && /context only - do NOT repeat, continue or complete them/.test(prompt) && /\[message shortened\]/.test(prompt) && /never begin with "\.\.\."/.test(prompt), 'history rules');
assert(!/INTERNAL NOTE/.test(prompt), 'internal notes must not reach the AI');
/* the club description comes only from the club's own settings (brand.descriptor), never from the bot's code */
const [{ d: descriptor }] = await q(`select bot_config->'brand'->>'descriptor' d from public.tenants where id=$1`, [T]);
assert(descriptor ? prompt.includes(descriptor) : !/a premium sports club in Vadodara/.test(prompt), 'club description only from settings');
ok('the AI gets the current timings as always-correct facts, earlier messages as context only (long ones marked "[message shortened]"), and never the internal notes', `prompt ${prompt.length} chars`);
const aiRow = (await q(`select body, sender_kind, status from public.wa_messages where phone_key=$1 and direction='out' order by created_at desc limit 1`, [PHONE]))[0];
assert(/^\[TEST\] AI stand-in/.test(aiRow.body) && aiRow.sender_kind === 'bot', 'stand-in answer stored ' + JSON.stringify(aiRow));
ok('without a staging AI key, the stand-in answer is sent and stored as the bot\'s reply');

// ---------- leads: once a day per topic ----------
let leads = await outbox('lead');
const leadsAfterFirst = leads.length;
r = await bot(ev(txt('And what about swimming coaching fees?')));
leads = await outbox('lead');
assert(leadsAfterFirst >= 1 && leads.length === leadsAfterFirst, `leads ${leadsAfterFirst} -> ${leads.length}`);
ok('an AI enquiry posts one lead; the next enquiry the same day does not post another', `leads recorded: ${leads.length}`);

// ---------- Meta retries the same event ----------
const dupId = `wamid.IN.DUP.${Date.now()}`;
r = await bot(ev(txt('Is the pool open today?', PHONE, dupId)));
const sentBefore = (await outbox('meta_message')).length;
const rowsBefore = await count(`select count(*) n from public.wa_messages`);
r = await bot(ev(txt('Is the pool open today?', PHONE, dupId)));
assert(r.out.results[0].duplicate === true && (await outbox('meta_message')).length === sentBefore && (await count(`select count(*) n from public.wa_messages`)) === rowsBefore, 'duplicate ' + JSON.stringify(r.out));
ok('when Meta delivers the same message twice, the second is recognised and ignored (no second reply, nothing stored twice)');

// ---------- human takeover ----------
const users = await q(`insert into auth.users (email) values ('desk@club.test'),('owner2@club.test') returning id, email`);
const desk = users[0].id;
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$2,'front_desk','desk@club.test'),($3,$2,'owner','owner2@club.test')`, [desk, T, users[1].id]);
await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: desk })]);
await q(`select public.wa_conv_action($1,$2,'pause',null,null)`, [T, PHONE]);
await db.query(`select set_config('request.jwt.claims', '', false)`);
const sentP = (await outbox('meta_message')).length;
r = await bot(ev(txt('Hello? Anyone there?')));
assert(r.out.results[0].paused === true && (await outbox('meta_message')).length === sentP, 'paused ' + JSON.stringify(r.out));
const lastIn = (await q(`select body from public.wa_messages where phone_key=$1 and direction='in' order by created_at desc limit 1`, [PHONE]))[0];
assert(lastIn.body === 'Hello? Anyone there?', 'message still stored');
ok('while staff have paused the bot for this member, the message still lands in the Inbox but the bot sends nothing');
await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: desk })]);
await q(`select public.wa_conv_action($1,$2,'resume',null,null)`, [T, PHONE]);
await db.query(`select set_config('request.jwt.claims', '', false)`);
r = await bot(ev(tap('menu:membership')));
assert(r.out.results[0].sent === true, 'resumed');
ok('after "Resume bot" the bot answers again');

// ---------- staff reply through Broadcast Send: stored with the staff member, then the bot pauses ----------
const deskTok = 'tok-desk';
const bs = async (body, timers) => { const w = world(db, { users: { [deskTok]: { id: desk, email: 'desk@club.test' } } }); return runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body } }, w, timers); };
let x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, text: 'Hi! This is Riya from the front desk.\nThe pool is open till 9 PM.' });
assert(x.ok === true && x.status === 'sent' && /^wamid\.STAGING\./.test(x.wamid) && x.bot_paused_minutes === 30, 'staff reply ' + JSON.stringify(x));
const staffRow = (await q(`select sender_kind, sender_email, sender_user_id, status, body from public.wa_messages where wamid=$1`, [x.wamid]))[0];
assert(staffRow.sender_kind === 'staff' && staffRow.sender_email === 'desk@club.test' && staffRow.sender_user_id === desk && staffRow.status === 'sent', 'staff row ' + JSON.stringify(staffRow));
ok('a staff reply is sent and stored with who sent it (desk@club.test), its WhatsApp id and "sent"; the bot pauses 30 minutes (the default)');
const sentS = (await outbox('meta_message')).length;
r = await bot(ev(txt('Thanks! One more thing')));
assert(r.out.results[0].paused === true && (await outbox('meta_message')).length === sentS, 'auto pause');
ok('the member writes again within the pause: the bot stays quiet while the staff member handles it');
await q(`update public.tenants set bot_config = bot_config || '{"inbox":{"auto_pause_minutes":10}}' where id=$1`, [T]);
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, text: 'Noted, thank you.' });
const conv = (await q(`select bot_paused_until, bot_pause_reason, bot_paused_by_email from public.wa_conversations where tenant_id=$1 and phone_key=$2`, [T, PHONE]))[0];
const mins = (new Date(conv.bot_paused_until) - Date.now()) / 60000;
assert(x.bot_paused_minutes === 10 && mins > 9 && mins <= 30.2 && conv.bot_paused_by_email === 'desk@club.test', 'configured pause ' + JSON.stringify(conv));
ok('with "auto-pause after a staff reply" set to 10 minutes in Settings, a reply pauses the bot for 10 minutes (a longer pause already running is kept)', `pause reason ${conv.bot_pause_reason}`);

// ---------- 24-hour window and templates ----------
await q(`update public.wa_messages set created_at = created_at - interval '2 days' where phone_key=$1`, [PHONE]);
await q(`update public.wa_conversations set last_inbound_at = last_inbound_at - interval '2 days' where tenant_id=$1 and phone_key=$2`, [T, PHONE]);
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, text: 'Following up' });
assert(x.ok === false && x.window_closed === true, 'window closed ' + JSON.stringify(x));
ok('more than 24 hours after the member\'s last message, a free-text reply is refused with a clear reason (nothing sent)');
const list = await bs({ user_token: deskTok, tpl_list: true });
const dues = list.templates.find((t) => t.name === 'dues_reminder');
assert(list.ok && dues && dues.body.vars.length === 6 && !dues.header, 'tpl_list ' + JSON.stringify(dues && dues.body.vars));
ok('the Inbox gets the approved templates with their real structure (dues_reminder: 6 blanks, no image)', `${list.templates.length} templates`);
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, send_as_template: true, template: 'dues_reminder', language: 'en', params: ['Rahul', '2nd year'] });
assert(x.ok === false && /every blank/i.test(x.error), 'missing params refused ' + JSON.stringify(x));
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, send_as_template: true, template: 'dues_reminder', language: 'en', params: ['Rahul', '2nd year (2026-27)', '₹29,500', 'Please pay at the office.', 'Pay online: https://pay.example.org/abc', 'Thank you.'] });
m = await lastOut();
assert(x.ok && m.payload.type === 'template' && m.payload.template.name === 'dues_reminder' && m.payload.template.components[0].parameters.length === 6, 'template sent ' + JSON.stringify(x));
const tplRow = (await q(`select body, template_name, msg_type from public.wa_messages where wamid=$1`, [x.wamid]))[0];
assert(tplRow.template_name === 'dues_reminder' && /₹29,500/.test(tplRow.body) && /Pay online: https:\/\/pay\.example\.org\/abc/.test(tplRow.body), 'stored template text ' + tplRow.body.slice(0, 120));
ok('a template reply must fill every blank the template really has; sent with 6 values, and the Inbox shows the filled-in text (incl. a pay link)');

// ---------- a failed reply shows as failed ----------
const other = '910000000002';
await q(`insert into public.wa_messages (tenant_id, phone, direction, body) values ($1,$2,'in','hello from a non-test number')`, [T, other]);
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: other, text: 'Hello!' });
const failRow = (await q(`select status, error_title from public.wa_messages where phone_key=$1 and direction='out' order by created_at desc limit 1`, [other]))[0];
assert(x.ok === false && x.status === 'failed' && failRow.status === 'failed' && /not a test phone/.test(failRow.error_title), 'failed ' + JSON.stringify(failRow));
ok('a reply WhatsApp refuses is stored and shown as FAILED with the reason, not as sent', failRow.error_title.slice(0, 70));

// ---------- delivery statuses from Meta ----------
const [{ wamid: sentWamid }] = await q(`select wamid from public.wa_messages where phone_key=$1 and sender_kind='staff' and status='sent' order by created_at desc limit 1`, [PHONE]);
r = await bot(ev(null, { statuses: [{ id: sentWamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }] }));
r = await bot(ev(null, { statuses: [{ id: sentWamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000) + 1), recipient_id: PHONE }] }));
const st = (await q(`select status from public.wa_messages where wamid=$1`, [sentWamid]))[0].status;
assert(st === 'read', 'status ' + st);
ok('Meta\'s delivered and read events update that exact message in the Inbox');

// ---------- media and reactions ----------
r = await bot(ev({ from: PHONE, id: `wamid.IN.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'MEDIA1', caption: 'payment screenshot' } }));
await q(`update public.wa_conversations set bot_paused=false, bot_paused_until=null where tenant_id=$1`, [T]);
r = await bot(ev({ from: PHONE, id: `wamid.IN.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'MEDIA2', caption: 'receipt' } }));
m = await lastOut();
const imgIn = (await q(`select body, msg_type from public.wa_messages where wamid like 'wamid.IN.%' and msg_type='image' order by created_at desc limit 1`))[0];
assert(m.payload.type === 'text' && /look at what you sent/.test(m.payload.text.body) && imgIn.body === '[image] receipt', 'image ' + JSON.stringify(m.payload));
ok('a photo gets a short "our team will look at it" reply (not the menu) and shows in the Inbox as "[image] <caption>"');
const sentR = (await outbox('meta_message')).length;
r = await bot(ev({ from: PHONE, id: `wamid.IN.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'reaction', reaction: { message_id: 'x', emoji: '👍' } }));
assert((await outbox('meta_message')).length === sentR && r.out.results[0].reaction === true, 'reaction');
ok('a reaction (👍) is stored but gets no reply');

// ---------- events: capacity and waitlist ----------
const [{ id: EV }] = await q(`select id from public.events where title='QA test event (1 seat)'`);
r = await bot(ev(tap('act:reg:' + EV)));
m = await lastOut();
assert(/You are registered for QA test event/.test(m.payload.text.body), 'registered ' + m.payload.text.body);
await q(`delete from public.event_registrations where event_id=$1 and phone=$2`, [EV, PHONE]);
await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status, source) values ($1,$2,'Someone','910000000003','registered','desk')`, [T, EV]);
r = await bot(ev(tap('act:reg:' + EV)));
m = await lastOut();
const reg = (await q(`select status, name from public.event_registrations where event_id=$1 and phone=$2`, [EV, PHONE]))[0];
assert(/WAITLISTED/.test(m.payload.text.body) && reg.status === 'waitlist' && reg.name === 'Test Phone 1', 'waitlist ' + JSON.stringify(reg));
ok('WhatsApp event registrations count toward capacity: the 1-seat event puts the next member on the waitlist, with their real name');

// ---------- campaigns: two sheet rows with the same number ----------
const owner = users[1].id; const ownTok = 'tok-owner';
const bsOwner = async (body, timers) => { const w = world(db, { users: { [ownTok]: { id: owner, email: 'owner2@club.test' } } }); return runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body } }, w, timers); };
const [{ id: BID }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Dues (sheet)','dues_reminder','Sheet','sending','{}') returning id`, [T]);
const timers = fakeTimers();
const sentC = (await outbox('meta_message')).length;
x = await bsOwner({ user_token: ownTok, dry_run: false, broadcast_id: BID, audience_source: 'sheet', template: 'dues_reminder', language: 'en',
  vars: { 1: { src: 'col:Name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'col:Due' }, 4: { src: 'custom', text: 'Please pay.' }, 5: { src: 'custom', text: '​' }, 6: { src: 'custom', text: '​' } },
  custom_recipients: [
    { phone: PHONE, full_name: 'Rahul', row_no: 1, row_cols: { Name: 'Rahul', Due: '₹500' } },
    { phone: PHONE.slice(2), full_name: 'Rahul', row_no: 2, row_cols: { Name: 'Rahul', Due: '₹700' } }] }, timers);
const sends = (await outbox('meta_message')).slice(sentC);
const amounts = sends.map((s) => s.payload.template.components.find((c) => c.type === 'body').parameters[2].text);
assert(x.ok && x.sent === 2 && sends.length === 2 && sends.every((s) => s.phone === PHONE) && amounts.join(',') === '₹500,₹700', 'two rows ' + JSON.stringify({ x, amounts }));
assert(timers.waits.some((ms) => ms >= 6000 && ms <= 6500), 'paced ' + JSON.stringify(timers.waits));
const bodyAfter = JSON.parse((await q(`select body from public.broadcasts where id=$1`, [BID]))[0].body);
assert(bodyAfter.recipients.length === 2 && bodyAfter.recipients.map((x2) => x2.row_no).join(',') === '1,2', 'report rows ' + JSON.stringify(bodyAfter.recipients));
ok('a sheet with the same number on two rows (₹500 and ₹700) sends TWO messages to that number, each with its own amount, the second one 6+ seconds later; the report lists rows 1 and 2', `amounts ${amounts.join(' then ')}, waited ${Math.round(Math.max(...timers.waits) / 100) / 10}s`);
x = await bsOwner({ user_token: ownTok, dry_run: false, audience_source: 'sheet', template: 'dues_reminder', language: 'en', vars: {}, custom_recipients: [] });
assert(x.ok === false && /never sent to all members/.test(x.error), 'empty sheet refused ' + JSON.stringify(x));
ok('a sheet campaign with no valid rows is refused; it is never sent to all members instead');
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in, status) values ($1,'Dup Format','9998887776',true,'active'),($1,'Dup Format 2','919998887776',true,'active')`, [T]);
x = await bsOwner({ user_token: ownTok, dry_run: true, segment: {}, template: 'dues_reminder', language: 'en', vars: {} });
const [{ n: optedIn }] = await q(`select count(distinct public.wa_phone_key(phone))::int n from public.members where tenant_id=$1 and wa_opt_in and phone is not null`, [T]);
assert(x.dry_run && x.audience_count === optedIn, `crm dedup ${x.audience_count} vs ${optedIn}`);
ok('a CRM-members campaign still sends one message per person, even when a number is saved twice in different formats', `${x.audience_count} unique numbers`);

// ---------- "Dues amount" and "Payment link" sources (CRM members) ----------
await q(`update public.members set membership_tier='QA-Tier', dues_amount=12345, wa_opt_in=true where tenant_id=$1 and public.wa_phone_key(phone)=$2`, [T, PHONE]);
const [{ n: qaMembers }] = await q(`select count(*)::int n from public.members where tenant_id=$1 and membership_tier='QA-Tier'`, [T]);
await q(`update public.tenants set bot_config = bot_config || '{"payments":{"link":"https://pay.example.org/shakti"}}' where id=$1`, [T]);
const sentD = (await outbox('meta_message')).length;
x = await bsOwner({ user_token: ownTok, dry_run: false, audience_source: 'crm', segment: { tiers: ['QA-Tier'] }, template: 'dues_reminder', language: 'en',
  vars: { 1: { src: 'first_name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'dues_amount' }, 4: { src: 'custom', text: 'Please pay at the office or online.' }, 5: { src: 'custom', text: 'Pay online: {{payment_link}}' }, 6: { src: 'payment_link' } } }, fakeTimers());
const dsend = (await outbox('meta_message')).slice(sentD);
const dp = dsend.length ? dsend[0].payload.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text) : [];
assert(qaMembers >= 1 && x.ok && x.sent === 1 && dp[2] === '₹12,345' && dp[4] === 'Pay online: https://pay.example.org/shakti' && dp[5] === 'https://pay.example.org/shakti', 'dues/link ' + JSON.stringify({ x, dp }));
ok('a CRM dues campaign fills "Dues amount" from the member (₹12,345) and "Payment link" from Settings, as a blank or inside custom text', dp.slice(2, 3).concat(dp.slice(5)).join(' | '));
await q(`update public.tenants set bot_config = bot_config - 'payments' where id=$1`, [T]);
const sentE = (await outbox('meta_message')).length;
x = await bsOwner({ user_token: ownTok, dry_run: false, audience_source: 'crm', segment: { tiers: ['QA-Tier'] }, template: 'dues_reminder', language: 'en',
  vars: { 1: { src: 'first_name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'dues_amount' }, 4: { src: 'custom', text: 'Please pay.' }, 5: { src: 'payment_link' }, 6: { src: 'custom', text: '​' } } }, fakeTimers());
const ep = (await outbox('meta_message')).slice(sentE)[0].payload.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
assert(ep[4] === '​' && !/http/.test(ep.join(' ')), 'no link invented ' + JSON.stringify(ep));
ok('with no payment link in Settings, the "Payment link" blank stays empty: no link is ever made up');

// ================= fixes after the code review =================
// ---------- a long "hi!!!!…" message can't freeze the bot
let t0 = Date.now();
r = await bot(ev(txt('hi' + '!'.repeat(3000) + ' a b c')));
const took = Date.now() - t0;
assert(took < 5000 && r.out.ok, 'long message took ' + took + ' ms');
ok('a 3,000-character "hi!!!…" message is answered at normal speed (the old greeting check could run for hours)', `${took} ms`);

// ---------- rows written the old way (before this release's workflows) get the right sender
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, msg_type, intent) values ($1, '919812300001', 'out', 'Diwali offer', 'template', 'broadcast')`, [T]);
const [legacyCmp] = await q(`select m.sender_kind, c.status from public.wa_messages m join public.wa_conversations c on c.tenant_id=m.tenant_id and c.phone_key=m.phone_key where m.phone='919812300001'`);
assert(legacyCmp.sender_kind === 'campaign' && legacyCmp.status === 'resolved', 'legacy campaign ' + JSON.stringify(legacyCmp));
ok('a campaign message stored by the current live workflow is recognised as a campaign and does not open a chat', JSON.stringify(legacyCmp));

// ---------- internal notes are invisible to anything that looks messages up by the exact number
await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: desk })]);
const [note] = await q(`select * from public.wa_note_add($1, $2, 'Private: member is disputing the bill', null)`, [T, PHONE]);
await db.query(`select set_config('request.jwt.claims', '', false)`);
const oldBotSees = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and phone=$2 and body like 'Private:%'`, [T, PHONE]);
const threadSees = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and phone_key=$2 and body like 'Private:%'`, [T, PHONE]);
assert(note.phone === 'note:' + PHONE && oldBotSees[0].n === 0 && threadSees[0].n === 1, 'note ' + JSON.stringify({ phone: note.phone, old: oldBotSees[0].n, thread: threadSees[0].n }));
ok('an internal note is in the conversation, but the bot of today (which reads by exact number) can never see it, even after a rollback', note.phone.replace(/\d{6}(?=\d{2}$)/, '******'));

// ---------- a status that arrives before its message is kept; bot/staff statuses don't read campaigns
const early = `wamid.EARLY.${Date.now()}`;
r = await bot(ev(null, { statuses: [{ id: early, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }] }));
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, wamid, sender_kind) values ($1, $2, 'out', 'reply stored after its status', $3, 'staff')`, [T, PHONE, early]);
const [earlyRow] = await q(`select status from public.wa_messages where wamid=$1`, [early]);
assert(earlyRow.status === 'delivered', 'early status ' + JSON.stringify(earlyRow));
ok('"delivered" arriving before the message is stored is not lost: the message shows Delivered');
const [{ wamid: botWamid }] = await q(`select wamid from public.wa_messages where tenant_id=$1 and sender_kind='bot' and wamid is not null order by created_at desc limit 1`, [T]);
r = await bot(ev(null, { statuses: [{ id: botWamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }] }));
const campaignReads = r.w.calls.filter((c) => /\/rest\/v1\/broadcasts\?/.test(c.url)).length;
assert(campaignReads === 0, 'campaign bodies read for a bot message: ' + campaignReads);
ok('a delivery status for a bot or staff message no longer downloads campaign lists', `${campaignReads} campaign reads`);

// ---------- the shared "confirm" token (it is in the public page) no longer unlocks anything by itself
const built = JSON.parse(readFileSync(B + 'n8n/broadcast_wf_vps.json', 'utf8'));
const STG_CONFIRM = (Array.isArray(built) ? built[0] : built).nodes.find((x) => x.name === 'Broadcast Send').parameters.jsCode.match(/CONFIRM='([^']+)'/)[1];
const anon = async (body) => { const w = world(db); return runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body: { confirm: STG_CONFIRM, ...body } } }, w, fakeTimers()); };
const sentBeforeTok = (await outbox('meta_message')).length;
const tries = {
  history: await anon({ get_messages: true }),
  count: await anon({ dry_run: true, segment: {} }),
  upload: await anon({ upload_media: true, filename: 'x.png', mime: 'image/png', file_base64: 'AAAA' }),
  templates: await anon({ tpl_list: true }),
  test: await anon({ test_to: PHONE, template: 'dues_reminder', language: 'en', vars: {} }),
  send: await anon({ dry_run: false, template: 'dues_reminder', language: 'en', vars: {}, custom_recipients: [{ phone: PHONE, full_name: 'X' }] }),
};
const leaked = Object.entries(tries).filter(([, v]) => v.ok !== false || v.messages || v.sample || v.templates);
assert(!leaked.length && (await outbox('meta_message')).length === sentBeforeTok, 'token still works for ' + JSON.stringify(leaked));
ok('with only the shared token: no chat history, no counts or names, no upload, no templates, no test send, no campaign', Object.keys(tries).join(', ') + ' refused');
const [{ id: SCHED }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1, 'Scheduled dues', 'dues_reminder', 'Sheet', 'scheduled', $2) returning id`,
  [T, JSON.stringify({ template: 'dues_reminder', language: 'en', vars: { 1: { src: 'col:Name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'col:Due' }, 4: { src: 'custom', text: 'Please pay.' } }, segment: { source: 'custom_sheet', fileName: 'dues.csv' }, custom_recipients: [{ phone: PHONE, row_no: 2, row_cols: { Name: 'Rahul', Due: '₹900' } }], schedule_at: new Date(Date.now() - 60000).toISOString() })]);
x = await anon({ dry_run: false, broadcast_id: SCHED, template: 'offer_broadcast', vars: { 1: { src: 'custom', text: 'HACKED' } }, custom_recipients: [{ phone: '910000000009' }] });
assert(x.ok === false && (await outbox('meta_message')).length === sentBeforeTok, 'not yet dispatching ' + JSON.stringify(x));
await q(`update public.broadcasts set status='sending' where id=$1`, [SCHED]);
x = await anon({ dry_run: false, broadcast_id: SCHED, template: 'offer_broadcast', vars: { 1: { src: 'custom', text: 'HACKED' } }, custom_recipients: [{ phone: '910000000009' }] });
const schedSends = (await outbox('meta_message')).slice(sentBeforeTok);
assert(x.ok && schedSends.length === 1 && schedSends[0].phone === PHONE && schedSends[0].payload.template.name === 'dues_reminder' && !JSON.stringify(schedSends[0].payload).includes('HACKED'), 'scheduler ' + JSON.stringify({ x, schedSends: schedSends.map((s) => s.payload.template.name) }));
ok('the scheduler can still send a campaign that staff scheduled, and only exactly as it was saved (other content in the request is ignored)', `sent ${schedSends[0].payload.template.name} to the saved recipient`);

// ---------- a member id sent by the browser is ignored; the member comes from the number inside this club
const [{ id: OT }] = await q(`insert into public.tenants (slug, name) values ('otherclub', 'Other Club') returning id`);
const [{ id: otherMember }] = await q(`insert into public.members (tenant_id, full_name, phone) values ($1, 'Other club member', $2) returning id`, [OT, PHONE]);
await q(`update public.wa_messages set created_at = now() where id = (select id from public.wa_messages where tenant_id=$1 and phone_key=$2 and direction='in' order by created_at desc limit 1)`, [T, PHONE]);
await q(`update public.wa_conversations set last_inbound_at = now() where tenant_id=$1 and phone_key=$2`, [T, PHONE]);
x = await bs({ user_token: deskTok, inbox_reply: true, reply_to: PHONE, text: 'Checking member link', member_id: otherMember });
const [linked] = await q(`select m.member_id, mem.tenant_id = $2 as same_club from public.wa_messages m left join public.members mem on mem.id = m.member_id where m.wamid=$1`, [x.wamid, T]);
assert(x.ok && linked.member_id !== otherMember && linked.same_club === true, 'member link ' + JSON.stringify(linked));
ok('an Inbox reply is linked to this club\'s member for that number, whatever member id the browser sends');

console.log(`\nAll ${n} end-to-end checks passed on the local bench.`);
