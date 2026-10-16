// sql/wa_inbox.sql on an in-memory Postgres (PGlite): conversation state, triggers, staff actions,
// bot state, paging, RLS and idempotency. Builds the full staging structure first, with messages that
// already exist BEFORE the inbox migration runs (so the backfill is tested too).
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const CRM = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
const B = CRM + '.staging-build/db/';
const structure = readFileSync(B + '1-structure.sql', 'utf8');
const testData = readFileSync(B + '2-test-data.sql', 'utf8');
const inbox = readFileSync(CRM + 'sql/wa_inbox.sql', 'utf8');
// the configured test phone: the test data seeds a member with it, so the history must use the same number
const cfg = JSON.parse(readFileSync(process.env.OPS_CONFIG || CRM + 'tools/config.local.json', 'utf8')).staging;
const PHONE = '91' + String(cfg.testPhones[0]).replace(/[^0-9]/g, '').slice(-10), P10 = PHONE.slice(-10);
const cut = structure.indexOf('-- ================= sql/wa_inbox.sql');
if (cut < 0) throw new Error('structure does not contain wa_inbox.sql');
const before = structure.slice(0, cut);

const db = new PGlite({ extensions: { vector } });
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
  create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false);
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;`);
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0; const ok = (l) => console.log(`ok ${++n}. ${l}`);
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exit(1); } };
const fails = async (fn, re, m) => { try { await fn(); } catch (e) { assert(re.test(String(e.message)), `${m}: wrong error ${e.message}`); return; } assert(false, `${m}: should have failed`); };

await db.exec(before); await db.exec(testData);
const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
await db.exec(`insert into public.tenants (slug, name) values ('other', 'Other Club') on conflict do nothing`);
const [{ id: T2 }] = await q(`select id from public.tenants where slug='other'`);
// history that exists before the migration (as the live bot writes it today: no sender_kind, no wamid)
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values
  ($1,'${PHONE}','in','Hi', now()-interval '3 days'), ($1,'${PHONE}','out','Welcome!', now()-interval '3 days' + interval '5 seconds'),
  ($1,'9898989898','in','Timings?', now()-interval '2 days'), ($1,'919898989898','out','6 AM to 11 PM', now()-interval '2 days' + interval '3 seconds'),
  ($2,'917777777777','in','other club', now()-interval '1 day'),
  ($1,'915555555555','out','Diwali offer', now()-interval '10 days')`, [T, T2]);
// the intents today's live workflows write: a campaign message and a staff reply
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, intent, created_at) values
  ($1,'915555555556','out','Navratri offer','broadcast', now()-interval '9 days'),
  ($1,'${PHONE}','out','Staff: see you tomorrow','staff_reply', now()-interval '3 days' + interval '9 seconds')`, [T]);

await db.exec(inbox);
ok('migration runs on a database that already has messages');
await db.exec(inbox);
ok('migration is safe to run twice');

// ---- phone key
const keys = await q(`select public.wa_phone_key('9898989898') a, public.wa_phone_key('+91 98989 89898') b, public.wa_phone_key('09898989898') c, public.wa_phone_key('919898989898') d, public.wa_phone_key('14155550123') e`);
assert(keys[0].a === '919898989898' && keys[0].b === '919898989898' && keys[0].c === '919898989898' && keys[0].d === '919898989898' && keys[0].e === '14155550123', 'phone keys ' + JSON.stringify(keys[0]));
ok('one phone key for 10-digit, +91, 0-prefixed and full numbers; other countries unchanged');

// ---- backfill
const bf = await q(`select phone_key, unread_count, status, last_inbound_at is not null as has_in, last_message_preview from public.wa_conversations where tenant_id=$1 order by phone_key`, [T]);
const bfOpen = bf.filter((r) => r.has_in);
  /* one conversation per distinct number in the history (test data included), open when the member ever wrote */
  const [{ n: distinctNums }] = await q(`select count(distinct public.wa_phone_key(phone))::int n from public.wa_messages where tenant_id=$1 and direction <> 'note'`, [T]);
  const [{ n: inNums }] = await q(`select count(distinct public.wa_phone_key(phone))::int n from public.wa_messages where tenant_id=$1 and direction = 'in'`, [T]);
  assert(bf.length === distinctNums && bfOpen.length === inNums && bf.length >= 3 && bfOpen.every((r) => r.unread_count === 0 && r.status === 'open'), 'backfill ' + JSON.stringify(bf));
  assert(bf.find((r) => r.phone_key === '915555555555').status === 'resolved', 'campaign-only number starts resolved');
  const [pk] = await q(`select count(*)::int n from public.wa_messages where phone_key is null`); assert(pk.n === 0, 'phone keys backfilled');
  const kinds = Object.fromEntries((await q(`select body, sender_kind from public.wa_messages where body in ('Navratri offer','Staff: see you tomorrow','Welcome!','Hi')`)).map((r) => [r.body, r.sender_kind]));
  assert(kinds['Navratri offer'] === 'campaign' && kinds['Staff: see you tomorrow'] === 'staff' && kinds['Welcome!'] === null && kinds['Hi'] === 'member', 'sender backfill ' + JSON.stringify(kinds));
  assert(bf.find((r) => r.phone_key === '915555555556').status === 'resolved', 'old campaign-only chat resolved');
assert(bf.find((r) => r.phone_key === '919898989898').last_message_preview === '6 AM to 11 PM', 'two formats of one number grouped');
ok('existing history: one conversation per number, nothing unread; numbers that only got campaigns start resolved; phone keys filled');

// ---- new member message: unread + reopen
const ins = (row) => q(`insert into public.wa_messages (tenant_id, phone, direction, body, sender_kind, wamid, status, sender_email, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now())) returning *`,
  [row.t || T, row.phone, row.dir, row.body || '', row.kind || null, row.wamid || null, row.status || null, row.email || null, row.at || null]);
await ins({ phone: PHONE, dir: 'in', body: 'Is the pool open?', wamid: 'wamid.IN1' });
await ins({ phone: PHONE, dir: 'in', body: 'Hello?', wamid: 'wamid.IN2' });
let [c] = await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
assert(c.unread_count === 2 && c.last_message_preview === 'Hello?' && c.last_message_kind === 'member', 'unread ' + JSON.stringify(c));
ok('member messages count as unread (2) and show as the latest message');
await fails(() => ins({ phone: PHONE, dir: 'in', body: 'dup', wamid: 'wamid.IN2' }), /duplicate key|unique/, 'duplicate wamid');
ok('the same WhatsApp message id cannot be stored twice (Meta retries are ignored)');

// ---- staff login simulation
const users = await q(`insert into auth.users (email) values ('owner@club.test'),('desk@club.test'),('stranger@x.test'),('other@club2.test') returning id, email`);
const U = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u.id]));
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$3,'owner','owner@club.test'),($2,$3,'front_desk','desk@club.test'),($4,$5,'owner','other@club2.test')`, [U.owner, U.desk, T, U.other, T2]);
await db.exec(`grant select on public.wa_conversations, public.wa_messages, public.members, public.app_admins to authenticated;`);
const asUser = async (uid, fn) => {
  await db.exec(`set role authenticated`); await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  try { return await fn(); } finally { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); }
};
const act = (uid, phone, action, value = null, minutes = null) => asUser(uid, () => q(`select * from public.wa_conv_action($1,$2,$3,$4,$5)`, [T, phone, action, value, minutes]));

// ---- read, assign, resolve, reopen
let [r] = await act(U.desk, P10, 'read');
assert(r.unread_count === 0 && r.last_read_by_email === 'desk@club.test', 'read ' + JSON.stringify(r));
ok('opening a chat marks it read for the whole team, and records who read it');
[r] = await act(U.desk, PHONE, 'assign', U.owner);
assert(r.assignee_user_id === U.owner && r.assignee_email === 'owner@club.test' && r.assigned_by_email === 'desk@club.test', 'assign');
ok('a conversation is assigned to an individual staff member (by the desk), with who assigned it');
await fails(() => act(U.desk, PHONE, 'assign', U.stranger), /not staff/, 'assign stranger');
ok('assigning to someone who is not staff of this club is refused');
[r] = await act(U.owner, PHONE, 'resolve');
assert(r.status === 'resolved' && r.resolved_by_email === 'owner@club.test', 'resolve');
await ins({ phone: PHONE, dir: 'in', body: 'One more question', wamid: 'wamid.IN3' });
[c] = await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
assert(c.status === 'open' && c.reopened_at && c.unread_count === 1, 'reopen ' + JSON.stringify(c));
ok('a resolved conversation re-opens by itself when the member writes again (1 unread)');

// ---- bot pause / resume
let st = await q(`select public.wa_bot_state($1,'${PHONE}') s`, [T]);
assert(st[0].s.paused === false, 'not paused');
[r] = await act(U.desk, PHONE, 'pause', null, 30);
st = await q(`select public.wa_bot_state($1,'${P10}') s`, [T]);
assert(st[0].s.paused === true && r.bot_paused_by_email === 'desk@club.test' && r.bot_pause_reason === 'manual' && !r.bot_paused, 'timed pause');
ok('staff pause the bot for 30 minutes; the bot sees "paused" (any phone format); who paused it is stored');
await db.exec(`update public.wa_conversations set bot_paused_until = now() - interval '1 minute' where phone_key='${PHONE}'`);
st = await q(`select public.wa_bot_state($1,'${PHONE}') s`, [T]);
assert(st[0].s.paused === false, 'expired');
ok('a timed pause ends by itself');
[r] = await act(U.owner, PHONE, 'pause', null, null);
st = await q(`select public.wa_bot_state($1,'${PHONE}') s`, [T]);
assert(st[0].s.paused === true && r.bot_paused === true && r.bot_paused_until === null, 'indefinite pause');
[r] = await act(U.owner, PHONE, 'resume');
st = await q(`select public.wa_bot_state($1,'${PHONE}') s`, [T]);
assert(st[0].s.paused === false && r.bot_resumed_by_email === 'owner@club.test', 'resume');
ok('"pause until resumed" holds until a staff member resumes it; who resumed is stored');
await q(`select public.wa_bot_pause_after_reply($1,'${PHONE}',10,'desk@club.test')`, [T]);
[c] = await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
const mins = (new Date(c.bot_paused_until) - Date.now()) / 60000;
assert(mins > 9 && mins <= 10.1 && c.bot_pause_reason === 'staff_reply', 'auto pause ' + mins);
await q(`select public.wa_bot_pause_after_reply($1,'${PHONE}',0,'desk@club.test')`, [T]);
ok('after a staff reply the bot pauses for the configured 10 minutes (0 = off)');
const audit = await q(`select action, actor_email from public.audit_log where entity='wa_conversation' order by created_at`);
assert(audit.map((a) => a.action).join(',') === 'inbox_assign,inbox_resolve,inbox_pause,inbox_pause,inbox_resume', 'audit ' + audit.map((a) => a.action));
ok('assign, resolve, pause and resume are written to the audit log with the staff email');

// ---- staff reply, statuses, failed
await ins({ phone: PHONE, dir: 'out', body: 'Yes, 6 AM to 9 PM', kind: 'staff', wamid: 'wamid.OUT1', email: 'desk@club.test' });
[c] = await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
assert(c.unread_count === 0 && c.last_staff_reply_at && c.last_message_kind === 'staff', 'staff reply');
let [msg] = await q(`select status from public.wa_messages where wamid='wamid.OUT1'`);
let [srow] = await q(`select status from public.wa_message_status where wamid='wamid.OUT1'`);
assert(msg.status === 'sent' && srow && srow.status === 'sent', 'status row created');
ok('a staff reply clears unread; its message gets a "sent" status row for Meta\'s updates');
await q(`select public.wa_status_apply('wamid.OUT1',$1,'delivered',now(),null,null,null,null,null,null,null,null,null,false)`, [T]);
await q(`select public.wa_status_apply('wamid.OUT1',$1,'read',now(),null,null,null,null,null,null,null,null,null,false)`, [T]);
[msg] = await q(`select status from public.wa_messages where wamid='wamid.OUT1'`);
assert(msg.status === 'read', 'read ' + msg.status);
ok('Meta\'s delivered and read events reach the message in the inbox');
await ins({ phone: PHONE, dir: 'out', body: 'Bot answer', kind: 'bot', wamid: 'wamid.OUT2' });
await q(`select public.wa_status_apply('wamid.OUT2',$1,'failed',now(),null,null,null,131026,'Message undeliverable','Receiver is incapable of receiving this message',null,null,null,false)`, [T]);
[msg] = await q(`select status, error_code, error_title from public.wa_messages where wamid='wamid.OUT2'`);
assert(msg.status === 'failed' && msg.error_code === 131026 && /incapable/.test(msg.error_title), 'failed ' + JSON.stringify(msg));
ok('a message Meta reports as failed shows FAILED with the reason');
await ins({ phone: PHONE, dir: 'out', body: 'Rejected at send', kind: 'staff', status: 'failed', email: 'desk@club.test' });
[msg] = await q(`select status from public.wa_messages where body='Rejected at send'`);
assert(msg.status === 'failed', 'failed at send');
ok('a reply Meta refused at send time is stored as failed, not sent');
await q(`select public.wa_status_apply('wamid.OUT3',$1,'delivered',now(),null,null,null,null,null,null,null,null,null,false)`, [T]);
await ins({ phone: PHONE, dir: 'out', body: 'late row', kind: 'bot', wamid: 'wamid.OUT3' });
[msg] = await q(`select status from public.wa_messages where wamid='wamid.OUT3'`);
assert(msg.status === 'sent', 'unknown wamid events are ignored');
await q(`select public.wa_status_apply('wamid.OUT3',$1,'read',now(),null,null,null,null,null,null,null,null,null,false)`, [T]);
[msg] = await q(`select status from public.wa_messages where wamid='wamid.OUT3'`);
assert(msg.status === 'read', 'later event applies');
ok('events for a message the club never stored are ignored; once stored, the next event applies');

// ---- notes
const [note] = await asUser(U.desk, () => q(`select * from public.wa_note_add($1,'${PHONE}','Called him back',null)`, [T]));
assert(note.direction === 'note' && note.sender_email === 'desk@club.test', 'note');
[c] = await q(`select last_message_preview from public.wa_conversations where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
assert(c.last_message_preview !== 'Called him back', 'notes do not move the conversation');
await fails(() => asUser(U.stranger, () => q(`select * from public.wa_note_add($1,'${PHONE}','x',null)`, [T])), /Only staff/, 'stranger note');
assert(note.phone === 'note:' + PHONE && note.phone_key === PHONE, 'note stored out of reach of exact-number lookups ' + note.phone);
ok('internal notes are saved with their author; outsiders cannot add them; notes do not change the chat preview');

// ---- RLS and access
let seen = await asUser(U.desk, () => q(`select count(*)::int n from public.wa_conversations`));
const [{ n: ownClub }] = await q(`select count(*)::int n from public.wa_conversations where tenant_id=$1`, [T]);
const [{ n: allClubs }] = await q(`select count(*)::int n from public.wa_conversations`);
assert(seen[0].n === ownClub && allClubs > ownClub, `desk sees own club only ${seen[0].n} (own ${ownClub}, all ${allClubs})`);
seen = await asUser(U.other, () => q(`select count(*)::int n from public.wa_conversations`));
assert(seen[0].n === 1, 'other club sees only its own');
await fails(() => asUser(U.other, () => q(`select * from public.wa_conv_action($1,'${PHONE}','resolve',null,null)`, [T])), /Only staff/, 'cross-club action');
await fails(() => asUser(U.desk, () => q(`update public.wa_conversations set status='resolved'`)), /permission denied|policy/, 'direct update');
const anonBot = await q(`select has_function_privilege('anon','public.wa_bot_state(uuid,text)','execute') a, has_function_privilege('authenticated','public.wa_bot_state(uuid,text)','execute') b, has_function_privilege('anon','public.wa_conv_action(uuid,text,text,text,int)','execute') c`);
assert(!anonBot[0].a && !anonBot[0].b && !anonBot[0].c, 'function privileges ' + JSON.stringify(anonBot[0]));
ok('each club sees only its own conversations; changes only through the audited functions; bot functions are server-only');

// ---- list, counts, paging at scale
await db.exec(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at)
  select '${T}', '9100' || lpad(g::text, 8, '0'), 'in', 'message ' || g, now() - (g || ' seconds')::interval from generate_series(1, 2500) g`);
const counts = await asUser(U.owner, () => q(`select public.wa_inbox_counts($1) c`, [T]));
assert(counts[0].c.open === 2502 && counts[0].c.unread === 2500 && counts[0].c.mine === 1 && counts[0].c.unread_messages === 2500, 'counts ' + JSON.stringify(counts[0].c));
let page = await asUser(U.owner, () => q(`select * from public.wa_inbox_list($1,'open',null,null,null,40)`, [T]));
let seenKeys = new Set(page.map((x) => x.wa_inbox_list.phone_key)); let pages = 1;
while (page.length === 40) {
  const last = page[page.length - 1].wa_inbox_list;
  page = await asUser(U.owner, () => q(`select * from public.wa_inbox_list($1,'open',null,$2,$3,40)`, [T, last.last_message_at, last.phone_key]));
  page.forEach((x) => seenKeys.add(x.wa_inbox_list.phone_key)); pages++;
}
assert(seenKeys.size === counts[0].c.open, `paged ${seenKeys.size} of ${counts[0].c.open}`);
ok(`${seenKeys.size} conversations paged 40 at a time (${pages} pages), newest first, none missed or repeated`);
const mine = await asUser(U.owner, () => q(`select * from public.wa_inbox_list($1,'mine',null,null,null,40)`, [T]));
assert(mine.length === 1 && mine[0].wa_inbox_list.assignee_email === 'owner@club.test', 'mine');
const search = await asUser(U.owner, () => q(`select * from public.wa_inbox_list($1,'all','Test Phone',null,null,40)`, [T]));
assert(search.length === 1 && search[0].wa_inbox_list.member_name === 'Test Phone 1', 'search by member name ' + search.length);
const search2 = await asUser(U.owner, () => q(`select * from public.wa_inbox_list($1,'all','00000123',null,null,40)`, [T]));
assert(search2.length >= 1, 'search by number');
ok('"Mine" shows chats assigned to me; search finds members by name and chats by number');
// thread paging uses the index
await db.exec(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at)
  select '${T}', '${PHONE}', case when g % 2 = 0 then 'in' else 'out' end, 'thread ' || g, now() - (g || ' minutes')::interval from generate_series(1, 3000) g`);
await db.exec(`analyze public.wa_messages`);
const plan = await q(`explain select * from public.wa_messages where tenant_id='${T}' and phone_key='${PHONE}' order by created_at desc, id desc limit 50`);
const planText = plan.map((p) => p['QUERY PLAN']).join(' ');
assert(/wa_msg_key_time_idx/.test(planText), 'thread query uses index: ' + planText);
let all = 0, cursor = null;
for (;;) {
  const rows = await q(`select id, created_at from public.wa_messages where tenant_id=$1 and phone_key='${PHONE}' and ($2::timestamptz is null or created_at < $2) order by created_at desc, id desc limit 500`, [T, cursor]);
  all += rows.length; if (rows.length < 500) break; cursor = rows[rows.length - 1].created_at;
}
const [{ total }] = await q(`select count(*)::int total from public.wa_messages where tenant_id=$1 and phone_key='${PHONE}'`, [T]);
assert(all === total && total > 3000, `thread paged ${all} of ${total}`);
ok(`a thread of ${total} messages pages newest-first through the index to the very first message`);
console.log(`\nAll ${n} inbox-database checks passed.`);

// ---- appended checks for the reworked migration ----
// a new campaign-only number does not open a chat; the member's reply opens it
await ins({ phone: '916666666666', dir: 'out', body: 'Offer', kind: 'campaign', wamid: 'wamid.C1' });
let [cc] = await q(`select status, unread_count from public.wa_conversations where tenant_id=$1 and phone_key='916666666666'`, [T]);
assert(cc.status === 'resolved' && cc.unread_count === 0, 'campaign-only chat resolved ' + JSON.stringify(cc));
await ins({ phone: '916666666666', dir: 'in', body: 'Interested!', wamid: 'wamid.C1R' });
[cc] = await q(`select status, unread_count from public.wa_conversations where tenant_id=$1 and phone_key='916666666666'`, [T]);
assert(cc.status === 'open' && cc.unread_count === 1, 'reply opens it');
ok('a campaign message alone does not add an open chat; the member\'s reply opens it');
// the member is linked by phone whatever format the member's phone was typed in (10 digits here)
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in) values ($1,'Ten Digit Member','9123456780',true)`, [T]);
await ins({ phone: '919123456780', dir: 'in', body: 'hello', wamid: 'wamid.TD1' });
const [lk] = await q(`select m.member_id, c.member_id as conv_member from public.wa_messages m join public.wa_conversations c on c.tenant_id=m.tenant_id and c.phone_key=m.phone_key where m.wamid='wamid.TD1'`);
const [tdm] = await q(`select id from public.members where phone='9123456780'`);
assert(lk.member_id === tdm.id && lk.conv_member === tdm.id, 'member linked ' + JSON.stringify(lk));
ok('a message is linked to the member even when the member\'s phone was saved as 10 digits');
// replies go to the number exactly as the member's WhatsApp sends it
await ins({ phone: '6591234567', dir: 'in', body: 'from Singapore', wamid: 'wamid.SG1' });
await ins({ phone: '916591234567', dir: 'out', body: 'staff answer', kind: 'staff', wamid: 'wamid.SG2', email: 'desk@club.test' });
const [sg] = await q(`select phone from public.wa_conversations where tenant_id=$1 and phone_key='916591234567'`, [T]);
assert(sg.phone === '6591234567', 'reply number kept from the member ' + sg.phone);
ok('the conversation keeps the number exactly as the member\'s WhatsApp sent it (staff replies do not overwrite it)');
// staff list for "Assign to"
const staff = await asUser(U.desk, () => q(`select * from public.wa_staff_list($1)`, [T]));
assert(staff.length === 2 && staff[0].role === 'owner' && staff.some((x) => x.email === 'desk@club.test'), 'staff list ' + JSON.stringify(staff));
const none = await asUser(U.stranger, () => q(`select * from public.wa_staff_list($1)`, [T]));
assert(none.length === 0, 'outsiders get no staff list');
ok('every staff member can list colleagues to assign a chat to; outsiders get nothing');
// a trigger problem never loses the message
await db.exec(`alter table public.wa_message_status rename to wa_message_status_x`);
await ins({ phone: PHONE, dir: 'out', body: 'stored even if status tracking breaks', kind: 'bot', wamid: 'wamid.SAFE1' });
await db.exec(`alter table public.wa_message_status_x rename to wa_message_status`);
const [safe] = await q(`select count(*)::int n from public.wa_messages where wamid='wamid.SAFE1'`);
assert(safe.n === 1, 'message stored despite trigger error');
ok('if status tracking fails inside the trigger, the message is still stored (warning only)');
// the "open" list uses its index
await db.exec(`analyze public.wa_conversations`);
const lp = await q(`explain select * from public.wa_conversations c0 where c0.tenant_id='${T}' and c0.status='open' order by c0.last_message_at desc, c0.phone_key desc limit 40`);
const lpt = lp.map((p) => p['QUERY PLAN']).join(' '); assert(/Index Scan using wa_conv_(list|all)_idx/.test(lpt) && !/Seq Scan/.test(lpt), 'list index: ' + lpt);
ok('the conversation list query reads its index (no full scan of every chat)');
console.log(`\nAll ${n} inbox-database checks passed (with appended checks).`);
