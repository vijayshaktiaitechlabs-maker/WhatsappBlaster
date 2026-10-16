// Bench: a 300-row sheet goes out in batches of 120 (the server ends a run at 300 s). The page continues it
// (resume with a login), the scheduler continues it when the page is closed, nothing is sent twice, and a dues
// reminder to a big audience gets its own campaign row so it can continue too.
import { readFileSync } from 'node:fs';
import { makeDb, world, runNode, fakeTimers, cfg, B } from './harness.mjs';
const db = await makeDb();
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0; const ok = (l, e = '') => console.log(`PASS ${++n}. ${l}${e ? ' | ' + e : ''}`);
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exit(1); } };
const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
const [owner] = await q(`insert into auth.users (email) values ('batch@club.test') returning id`);
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$2,'owner','batch@club.test')`, [owner.id, T]);
const tok = 'tok-' + owner.id;
const w = world(db, { users: { [tok]: { id: owner.id, email: 'batch@club.test' } } });
const phones = cfg.testPhones.map(String);
const send = (body) => runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body } }, w, fakeTimers());
const outbox = async () => Number((await q(`select count(*)::int n from public.stg_outbox where kind='meta_message'`))[0].n);
const row = async (id) => { const r = (await q(`select status, sent_at, sent_count, body from public.broadcasts where id=$1`, [id]))[0]; return { ...r, cfg: JSON.parse(r.body) }; };
const STG_CONFIRM = readFileSync(B + 'n8n/broadcast_wf_vps.json', 'utf8').match(/CONFIRM='([^']+)'/)[1];

// ---- 300 rows: 3 batches
const recips = []; for (let r = 0; r < 300; r++) recips.push({ phone: phones[r % phones.length], full_name: 'Row ' + (r + 2), row_no: r + 2, row_cols: { Due: '₹' + (100 + r) } });
const config = { template: 'dues_reminder', language: 'en', vars: { 1: { src: 'col:Name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'col:Due' }, 4: { src: 'custom', text: 'Please pay.' } }, custom_recipients: recips, segment: { source: 'custom_sheet' } };
const [{ id: bid }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Big sheet 300','dues_reminder','Sheet','sending',$2) returning id`, [T, JSON.stringify(config)]);
const body = { tenant: 'shakti', dry_run: false, broadcast_id: bid, ...config, audience_source: 'sheet', user_token: tok };
let o1 = await outbox();
const a1 = await send(body);
let r1 = await row(bid);
assert(a1.ok && a1.partial === true && a1.done === 120 && a1.remaining === 180 && (await outbox()) - o1 === 120 && r1.status === 'sending' && r1.cfg.progress.done === 120 && r1.cfg.progress.lease_until === null && r1.cfg.recipients.length === 120, 'batch 1 ' + JSON.stringify({ a1: { ok: a1.ok, partial: a1.partial, done: a1.done, remaining: a1.remaining }, row: { status: r1.status, progress: r1.cfg.progress } }));
ok('batch 1: 120 of 300 sent, answer says partial, the row keeps "sending" with its progress and the lease released', `done ${a1.done}, remaining ${a1.remaining}`);

// a second "Send now" (not a resume) must be refused; a resume with a fake login too
const dbl = await send(body); assert(dbl.ok === false && dbl.already_sending, 'double send ' + JSON.stringify(dbl));
const bad = await send({ tenant: 'shakti', dry_run: false, broadcast_id: bid, resume: true, user_token: 'tok-nobody' });
assert(bad.ok === false && (await outbox()) - o1 === 120, 'stranger resume ' + JSON.stringify(bad));
ok('a second "Send now" and a resume without a staff login are refused; nothing extra sent');

// the page continues (resume with the login)
const a2 = await send({ tenant: 'shakti', dry_run: false, broadcast_id: bid, resume: true, user_token: tok });
const r2 = await row(bid);
assert(a2.ok && a2.partial === true && a2.done === 240 && (await outbox()) - o1 === 240 && r2.cfg.progress.done === 240, 'batch 2 ' + JSON.stringify({ a2: { ok: a2.ok, partial: a2.partial, done: a2.done }, progress: r2.cfg.progress }));
ok('batch 2 (page resume): next 120 sent, 240 done; the first 120 were not sent again');

// meanwhile Meta reported two earlier recipients as delivered/read (the status webhook updates the row)
r2.cfg.recipients[0].status='delivered'; r2.cfg.recipients[1].status='read';
// the page closed: the scheduler continues (confirm code + resume), but only after the row has been quiet for 90 s
await q(`update public.broadcasts set body = $2 where id=$1`, [bid, JSON.stringify({ ...r2.cfg, progress: { ...r2.cfg.progress, next_at: new Date(Date.now() - 120000).toISOString() } })]);
/* the scheduler's POST to stg-broadcast-send is answered by the staging-built Broadcast Send, as n8n does */
const sched = () => { const w2 = world(db); const base = w2.helpers.httpRequest; w2.helpers.httpRequest = async (o) => { if (/\/webhook\/stg-broadcast-send$/.test(String(o.url || ''))) { const b2 = typeof o.body === 'string' ? JSON.parse(o.body) : o.body; return runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body: b2 } }, world(db), fakeTimers()); } return base(o); }; return runNode('broadcast_scheduler_wf.json', 'Check & Dispatch Due Campaigns', { json: {} }, w2, fakeTimers()); };
const s1 = await sched();
const r3 = await row(bid);
assert(s1.resumed === 'Big sheet 300' && s1.ok === true && s1.partial === false && (await outbox()) - o1 === 300 && r3.status === 'sent' && r3.sent_count === 300 && !r3.cfg.progress && r3.cfg.recipients.length === 300 && new Set(r3.cfg.recipients.map((x) => x.wamid)).size === 300 && new Date(r3.sent_at).getTime() === new Date(r1.sent_at).getTime(), 'scheduler resume ' + JSON.stringify({ s1, row: { status: r3.status, sent_count: r3.sent_count, recips: r3.cfg.recipients.length } }));
ok('batch 3 (scheduler, page closed): last 60 sent, campaign "sent" with 300 recipients, 300 distinct wamids, progress cleared', `sent_at kept from the start: ${new Date(r3.sent_at).getTime() === new Date(r1.sent_at).getTime()}`);
const s2 = await sched(); assert(/No scheduled/.test(s2.status || ''), 'scheduler idle ' + JSON.stringify(s2));
const r4 = await send({ tenant: 'shakti', dry_run: false, broadcast_id: bid, resume: true, user_token: tok }); assert(r4.ok === false && r4.nothing_left, 'resume after done ' + JSON.stringify(r4));
ok('after completion: the scheduler finds nothing to continue and a late resume is refused');

// lease: a resume while another run holds the lease is refused as busy
const [{ id: bid2 }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Leased','dues_reminder','Sheet','sending',$2) returning id`, [T, JSON.stringify({ ...config, custom_recipients: recips.slice(0, 130), progress: { total: 130, done: 120, lease_until: new Date(Date.now() + 300000).toISOString(), next_at: new Date().toISOString() }, recipients: [] })]);
const busy = await send({ tenant: 'shakti', dry_run: false, broadcast_id: bid2, resume: true, user_token: tok });
assert(busy.ok === false && busy.busy === true, 'busy ' + JSON.stringify(busy));
ok('a resume while another run holds the lease answers "busy" and sends nothing');

// a scheduled campaign of 150 members dispatched by the scheduler: first batch by the scheduler, rest by the next tick
const [{ id: bid3 }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'Scheduled 150','dues_reminder','Sheet','scheduled',$2) returning id`, [T, JSON.stringify({ ...config, custom_recipients: recips.slice(0, 150), schedule_at: new Date(Date.now() - 60000).toISOString() })]);
o1 = await outbox();
const d1 = await sched(); const rr = await row(bid3);
assert(d1.results && d1.results[0] && d1.results[0].ok && (await outbox()) - o1 === 120 && rr.status === 'sending' && rr.cfg.progress.done === 120, 'scheduled dispatch ' + JSON.stringify({ d1: d1.results, row: { status: rr.status, progress: rr.cfg.progress } }));
await q(`update public.broadcasts set body = $2 where id=$1`, [bid3, JSON.stringify({ ...rr.cfg, progress: { ...rr.cfg.progress, next_at: new Date(Date.now() - 120000).toISOString() } })]);
const d2 = await sched(); const rr2 = await row(bid3);
assert(d2.resumed === 'Scheduled 150' && rr2.status === 'sent' && rr2.sent_count === 150 && (await outbox()) - o1 === 150, 'scheduled resume ' + JSON.stringify({ d2, row: { status: rr2.status, sent_count: rr2.sent_count } }));
ok('a scheduled 150-recipient campaign: the scheduler sends 120, then the remaining 30 on its next tick; 150 total');

// dues reminders to a big audience (no row from the page): the server makes a row and continues by itself
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in, status, dues_amount) select $1, 'Due member '||g, '9188800'||lpad(g::text,5,'0'), true, 'active', 500 from generate_series(1,130) g`, [T]);
o1 = await outbox();
const du = await send({ tenant: 'shakti', dry_run: false, segment: { dues: 'due' }, template: 'member_custom_update', language: 'en', vars: { 1: { src: 'first_name' }, 2: { src: 'custom', text: 'Dues pending.' } }, user_token: tok });
const drow = (await q(`select id, title, status, body from public.broadcasts where title like 'Dues reminders%' order by created_at desc limit 1`))[0];
assert(du.ok && du.partial === true && du.broadcast_id === drow.id && drow.status === 'sending' && JSON.parse(drow.body).progress.done === 120, 'dues batch ' + JSON.stringify({ du: { ok: du.ok, partial: du.partial, done: du.done, remaining: du.remaining }, drow: drow && { status: drow.status } }));
ok('Payments → Send Dues Reminders to a big audience: a campaign row is created, 120 sent, the rest left for the scheduler', `audience ${du.audience_count}, done ${du.done}, remaining ${du.remaining}`);
console.log(`\nAll ${n} batch checks passed.`);
