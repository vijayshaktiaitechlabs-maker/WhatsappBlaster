// QA fixes, workflows group: regression checks on the local bench for Broadcast Send, the Broadcast Scheduler,
// WhatsApp Status and the File Upload Relay. Runs the STAGING-BUILT code (guard + simulated Meta) against the
// staging SQL in PGlite, like workflows.mjs. Run `node tools/build-staging.mjs` first.
import { readFileSync } from 'node:fs';
import { makeDb, world, runNode, metaItem, fakeTimers, cfg, B, benchCode } from './harness.mjs';

const db = await makeDb();
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0; const fails = [];
const check = (c, label, evidence = '') => {
  n++;
  if (c) console.log(`PASS ${n}. ${label}${evidence ? ' | ' + evidence : ''}`);
  else { fails.push(n); console.log(`FAIL ${n}. ${label} | ${evidence}`); }
};
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
const [{ id: OT }] = await q(`insert into public.tenants (slug, name) values ('qa-wf-other', 'QA Other Club') returning id`);
const outbox = async (kind = 'meta_message') => q(`select * from public.stg_outbox where kind=$1 order by id`, [kind]);
const sentCount = async () => (await outbox()).length;
const sentWith = async (from, marker) => (await outbox()).slice(from).filter((s) => JSON.stringify(s.payload).includes(marker));
const builtCode = (file, node) => benchCode(file, node);
const BS = 'broadcast_wf_vps.json', BSN = 'Broadcast Send';
const CONFIRM = builtCode(BS, BSN).match(/CONFIRM='([^']+)'/)[1];

// staff logins (user_token 'own' = owner, 'desk' = front desk)
const users = await q(`insert into auth.users (email) values ('qa-wf-owner@club.test'),('qa-wf-desk@club.test') returning id, email`);
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$3,'owner','qa-wf-owner@club.test'),($2,$3,'front_desk','qa-wf-desk@club.test')`, [users[0].id, users[1].id, T]);
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$2,'owner','qa-wf-owner@club.test')`, [users[0].id, OT]);
const LOGINS = { own: { id: users[0].id, email: 'qa-wf-owner@club.test' }, desk: { id: users[1].id, email: 'qa-wf-desk@club.test' } };
const bs = async (body, timers) => runNode(BS, BSN, { json: { body } }, world(db, { users: LOGINS }), timers || fakeTimers());

// runs a Code node from its staging-built source, optionally changed first (for fault injection in the guard)
async function runCode(code, item, w, timers) {
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFn('$input', 'Buffer', 'setTimeout', code);
  const out = await fn.call({ helpers: w.helpers }, { first: () => item }, Buffer, (timers || fakeTimers()).setTimeout);
  return out[0].json;
}

// the scheduler, with its POST to stg-broadcast-send answered by the staging-built Broadcast Send (as n8n's
// "respond with the last node" does); onDispatch runs before each answer (to overlap a second scheduler run)
async function runScheduler(onDispatch) {
  const w = world(db);
  const base = w.helpers.httpRequest;
  w.helpers.httpRequest = async (o) => {
    if (/\/webhook\/stg-broadcast-send$/.test(String(o.url || ''))) {
      const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
      if (onDispatch) await onDispatch(body);
      return bs(body);
    }
    return base(o);
  };
  return runNode('broadcast_scheduler_wf.json', 'Check & Dispatch Due Campaigns', { json: {} }, w, fakeTimers());
}
const past = () => new Date(Date.now() - 60000).toISOString();
const sheet = (due, extra = {}) => ({ template: 'dues_reminder', language: 'en',
  vars: { 1: { src: 'col:Name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'col:Due' }, 4: { src: 'custom', text: 'Please pay.' }, 5: { src: 'custom', text: '​' }, 6: { src: 'custom', text: '​' } },
  segment: { source: 'custom_sheet', fileName: 'qa.csv' }, custom_recipients: [{ phone: PHONE, row_no: 1, row_cols: { Name: 'Rahul', Due: due } }], schedule_at: past(), ...extra });
const addCampaign = async (title, status, body, tenant = T) => (await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,$2,'dues_reminder','Sheet',$3,$4) returning id`, [tenant, title, status, JSON.stringify(body)]))[0].id;
const row = async (id) => (await q(`select status, sent_at, sent_count, body from public.broadcasts where id=$1`, [id]))[0];
await q(`update public.broadcasts set status='draft' where status='scheduled'`); // only this file's campaigns are due

// ================= Broadcast Scheduler + the scheduler path of Broadcast Send =================
// broadcast_workflows-02: overlapping scheduler runs send each campaign once
const A = await addCampaign('QA overlap A', 'scheduled', sheet('₹101'));
const Bc = await addCampaign('QA overlap B', 'scheduled', sheet('₹202'));
let s0 = await sentCount();
let inner = null;
const outer = await runScheduler(async () => { if (!inner) { inner = 'running'; inner = await runScheduler(); } });
const a1 = (await sentWith(s0, '₹101')).length, b1 = (await sentWith(s0, '₹202')).length;
check(a1 === 1 && b1 === 1 && (await row(A)).status === 'sent' && (await row(Bc)).status === 'sent',
  'two overlapping scheduler runs: each due campaign is claimed by one run and sent once', `A sent ${a1}x, B sent ${b1}x; run 1 ${JSON.stringify(outer.results.map((r) => r.skipped || r.ok))}`);

// the same 'sending' row dispatched twice at the same moment with the code: one send
const C = await addCampaign('QA double dispatch', 'sending', sheet('₹303'));
s0 = await sentCount();
const both = await Promise.all([bs({ confirm: CONFIRM, dry_run: false, broadcast_id: C }), bs({ confirm: CONFIRM, dry_run: false, broadcast_id: C })]);
check((await sentWith(s0, '₹303')).length === 1 && both.filter((x) => x.ok).length === 1,
  'two simultaneous confirm-code dispatches of one campaign: only one sends', JSON.stringify(both.map((x) => x.ok ? 'sent ' + x.sent : x.error)));

// campaigns-01: a sent campaign put back to 'sending' is not sent again with the code
await q(`update public.broadcasts set status='sending' where id=$1`, [C]);
s0 = await sentCount();
let x = await bs({ confirm: CONFIRM, dry_run: false, broadcast_id: C });
check(x.ok === false && (await sentWith(s0, '₹303')).length === 0, 'a campaign already sent and set back to "sending" is not sent again with the confirm code', x.error);

// campaigns-01: a 'sending' row that was never scheduled (the page's "Send now" row) cannot be sent with the code
const D = await addCampaign('QA send-now row', 'sending', sheet('₹404', { schedule_at: null }));
s0 = await sentCount();
x = await bs({ confirm: CONFIRM, dry_run: false, broadcast_id: D });
check(x.ok === false && (await sentWith(s0, '₹404')).length === 0, 'the confirm code only sends a campaign saved with a schedule time that has come', x.error);

// broadcast_workflows-10: the code path sends exactly the saved campaign (no header or list from the request)
const E = await addCampaign('QA exact saved', 'sending', sheet('₹505'));
s0 = await sentCount();
x = await bs({ confirm: CONFIRM, dry_run: false, broadcast_id: E, header: { url: 'https://evil.example/not-saved.png' }, image_url: 'https://evil.example/x.png', custom_recipients: [{ phone: '910000000009' }] });
const eSent = await sentWith(s0, '₹505');
check(x.ok && eSent.length === 1 && !JSON.stringify(eSent[0].payload).includes('evil.example') && !eSent[0].payload.template.components.some((c) => c.type === 'header'),
  'a scheduled text campaign is sent without the image header the request carried', eSent[0] ? eSent[0].payload.template.components.map((c) => c.type).join(',') : 'nothing sent');

// campaigns-04 / broadcast_workflows-03: a campaign Broadcast Send refuses ends "failed" with the reason
const F = await addCampaign('QA refused', 'scheduled', sheet('₹606', { custom_recipients: [{ full_name: 'No phone', row_no: 1 }] }));
let r = await runScheduler();
const fRow = await row(F); const fCfg = JSON.parse(fRow.body);
const fRes = r.results.find((y) => y.id === F);
check(fRow.status === 'failed' && /no valid WhatsApp numbers/.test(fCfg.last_error || '') && fRes && fRes.ok === false,
  'a scheduled campaign that Broadcast Send refuses is marked failed, with the reason kept for staff', `${fRow.status}: ${String(fCfg.last_error).slice(0, 60)}`);

// broadcast_workflows-03: another club's scheduled campaign is not taken by the Shakti-only scheduler
const G = await addCampaign('QA other club', 'scheduled', sheet('₹707'), OT);
s0 = await sentCount();
r = await runScheduler();
check((await row(G)).status === 'scheduled' && (await sentWith(s0, '₹707')).length === 0 && !r.results,
  'another club\'s scheduled campaign is left alone (not stuck at "sending", nothing sent from Shakti\'s number)', (await row(G)).status);

// ================= Broadcast Send =================
// focus: no recipient phone numbers or message payloads in the n8n log
const code = builtCode(BS, BSN);
const logged = [];
const realLog = console.log;
console.log = (...a) => { logged.push(a.map(String).join(' ')); };
try { await bs({ user_token: 'own', dry_run: false, audience_source: 'sheet', template: 'dues_reminder', language: 'en', vars: sheet('₹808').vars, custom_recipients: sheet('₹808').custom_recipients }); }
finally { console.log = realLog; }
check(!/PARAMS_DEBUG|META_PAYLOAD/.test(code) && !logged.some((l) => l.includes(PHONE.slice(-6)) || /META_PAYLOAD|PARAMS_DEBUG/.test(l)),
  'a campaign send writes no phone numbers or message payloads to the n8n log', `${logged.length} log line(s)`);

// broadcast_workflows-04: a network error from WhatsApp for one member does not stop the campaign or lose its report
const H3 = await addCampaign('QA network error', 'sending', {});
let metaCalls = 0;
globalThis.__qaMetaFail = () => (++metaCalls === 2);
const hook = 'if (host.endsWith(\'.supabase.co\') && host !== __stg.db)';
if (!code.includes(hook)) throw new Error('guard hook not found');
const faulty = code.replace(hook, "if (host === 'graph.facebook.com' && /\\/messages$/.test(url.split('?')[0]) && globalThis.__qaMetaFail && globalThis.__qaMetaFail()) throw new Error('read ECONNRESET');\n    " + hook);
s0 = await sentCount();
x = await runCode(faulty, { json: { body: { user_token: 'own', dry_run: false, broadcast_id: H3, audience_source: 'sheet', template: 'dues_reminder', language: 'en', vars: sheet('').vars,
  custom_recipients: [1, 2, 3].map((i) => ({ phone: PHONE, row_no: i, row_cols: { Name: 'Row' + i, Due: '₹61' + i } })) } } }, world(db, { users: LOGINS }));
delete globalThis.__qaMetaFail;
const h3 = await row(H3); const h3cfg = JSON.parse(h3.body || '{}');
const h3rec = h3cfg.recipients || [];
check(x.ok === true && x.sent === 2 && x.failed === 1 && h3.status === 'sent' && h3rec.length === 3 && /network/.test((h3rec.find((y) => y.status === 'failed') || {}).error || ''),
  'a network error on the 2nd of 3 members: the 3rd is still sent and the report lists all three (1 failed "network")', `answer ${JSON.stringify({ ok: x.ok, sent: x.sent, failed: x.failed, error: x.error })}, row ${h3.status}, report rows ${h3rec.length}`);
const firstAt = h3rec.map((y) => y.sent_at).sort()[0];
check(h3.sent_at && firstAt && new Date(h3.sent_at) <= new Date(firstAt),
  'the campaign\'s sent_at is when sending started, so replies during a long send count in the report', `sent_at ${h3.sent_at}, first message ${firstAt}`);
const [camRow] = await q(`select sender_email, sender_user_id from public.wa_messages where sender_kind='campaign' and body like '%₹611%' order by created_at desc limit 1`);
check(camRow && camRow.sender_email === 'qa-wf-owner@club.test' && camRow.sender_user_id === users[0].id,
  'campaign messages are stored with the staff member who sent them', JSON.stringify(camRow));

// inbox-04 / broadcast_workflows-07: long Inbox replies are refused, never cut; the Inbox stores exactly what was sent
await q(`insert into public.wa_messages (tenant_id, phone, direction, body) values ($1,$2,'in','qa: hello')`, [T, PHONE]);
await q(`update public.wa_conversations set last_inbound_at=now() where tenant_id=$1 and phone_key=$2`, [T, PHONE]);
s0 = await sentCount();
const long5000 = 'L'.repeat(4990) + ' END-5000';
x = await bs({ user_token: 'desk', inbox_reply: true, reply_to: PHONE, text: long5000 });
check(x.ok === false && /4,096/.test(x.error || '') && (await sentCount()) === s0, 'a 5,000-character reply is refused with the limit named, nothing sent', x.error);
x = await bs({ user_token: 'desk', inbox_reply: true, reply_to: PHONE, text: 'C'.repeat(1500), image_url: 'https://example.org/poster.jpg' });
check(x.ok === false && /1,024/.test(x.error || '') && (await sentCount()) === s0, 'an image with a 1,500-character caption is refused, nothing sent', x.error);
const long4063 = 'M'.repeat(4050) + ' END-OF-REPLY';
x = await bs({ user_token: 'desk', inbox_reply: true, reply_to: PHONE, text: long4063 });
const got = (await outbox()).slice(s0)[0];
const [stored] = await q(`select body from public.wa_messages where wamid=$1`, [x.wamid || '-']);
check(x.ok && got && got.payload.text.body === long4063 && stored && stored.body === long4063,
  'a 4,063-character reply is sent whole and the Inbox stores exactly that text', `member got ${got ? got.payload.text.body.length : 0}, Inbox ${stored ? stored.body.length : 0}`);

// payments_dues-09: a request for another club is refused (never answered with Shakti's members)
x = await bs({ tenant: 'qa-wf-other', user_token: 'own', dry_run: true, segment: { dues: 'due' } });
const xs = await bs({ tenant: 'shakti', user_token: 'own', dry_run: true, segment: { dues: 'due' } });
check(x.ok === false && !('audience_count' in x) && /not set up for this club/.test(x.error || '') && xs.ok === true,
  'dues reminders from another club\'s page are refused instead of counting/sending to Shakti\'s members; Shakti still works', x.error);

// payments_dues-15: "today" is the club's date (India), not UTC
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in, status, membership_tier, maintenance_paid_till, dues_amount) values ($1,'IST Member','919000000001',true,'active','QA-IST','2026-09-30',0)`, [T]);
const realNow = Date.now;
Date.now = () => Date.parse('2026-09-30T19:30:00Z'); // 01:00 IST on 1 Oct
try { x = await bs({ user_token: 'own', dry_run: true, segment: { tiers: ['QA-IST'], dues: 'due' } }); } finally { Date.now = realNow; }
check(x.ok && x.audience_count === 1, 'at 01:00 IST on 1 Oct, a member paid till 30 Sep counts as due (same day as the page)', `audience ${x.audience_count}`);

// broadcast_workflows-08: tier names with & work
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in, status, membership_tier) values ($1,'Amp Member','919000000002',true,'active','Gold & Family')`, [T]);
x = await bs({ user_token: 'own', dry_run: true, segment: { tiers: ['Gold & Family'] } });
check(x.ok && x.audience_count === 1, 'a CRM campaign for the tier "Gold & Family" finds its member', JSON.stringify({ ok: x.ok, count: x.audience_count, error: x.error }));

// campaigns-02 (server part): a list row marked as not opted in is skipped
x = await bs({ user_token: 'own', dry_run: true, audience_source: 'sheet', custom_recipients: [{ phone: PHONE, row_no: 1, wa_opt_in: false }, { phone: '919000000003', row_no: 2 }] });
check(x.ok && x.audience_count === 1 && x.skipped_opted_out === 1, 'a sheet row marked wa_opt_in:false is skipped and counted as skipped', JSON.stringify({ count: x.audience_count, skipped: x.skipped_opted_out }));

// broadcast_workflows-05 + dashboard_reports-04: 0 / 0091 prefixed numbers are sent as 91..., the report keeps the sent number
// the test member is re-saved as 0+10 digits (so it comes first), then the same person is added as 91+10 digits
await q(`update public.members set phone=$3, membership_tier='QA-ZERO', wa_opt_in=true where tenant_id=$1 and phone=$2`, [T, PHONE, '0' + PHONE.slice(2)]);
await q(`insert into public.members (tenant_id, full_name, phone, wa_opt_in, status, membership_tier) values ($1,'Full format',$2,true,'active','QA-ZERO')`, [T, PHONE]);
const Z = await addCampaign('QA zero prefix', 'sending', {});
s0 = await sentCount();
x = await bs({ user_token: 'own', dry_run: false, broadcast_id: Z, audience_source: 'crm', segment: { tiers: ['QA-ZERO'] }, template: 'dues_reminder', language: 'en', vars: { 1: { src: 'first_name' }, 2: { src: 'custom', text: 'QA-ZERO-RUN' } } });
const zSent = await sentWith(s0, 'QA-ZERO-RUN');
const zRec = (JSON.parse((await row(Z)).body).recipients || [])[0] || {};
check(x.ok && x.sent === 1 && zSent.length === 1 && zSent[0].phone === PHONE && zRec.phone === PHONE,
  'a member saved as 0+10 digits and as 91+10 digits gets one message, to 91..., and the report shows 91...', JSON.stringify({ sent: x.sent, to: zSent.map((s) => s.phone.slice(0, 2) + '…'), report: String(zRec.phone || '').slice(0, 2) + '…' }));
s0 = await sentCount();
x = await bs({ user_token: 'own', dry_run: false, audience_source: 'sheet', template: 'dues_reminder', language: 'en', vars: { 1: { src: 'custom', text: 'QA-0091-RUN' } }, custom_recipients: [{ phone: '0091 ' + PHONE.slice(2), row_no: 1 }] });
const s91 = await sentWith(s0, 'QA-0091-RUN');
check(x.ok && x.sent === 1 && s91.length === 1 && s91[0].phone === PHONE, 'a sheet number written 0091 … is sent as 91…', JSON.stringify({ sent: x.sent, failed: x.failed }));

// broadcast_workflows-09: results are never written onto another club's campaign
const OB = await addCampaign('Other club draft', 'draft', { note: 'theirs' }, OT);
s0 = await sentCount();
x = await bs({ user_token: 'own', dry_run: false, broadcast_id: OB, audience_source: 'sheet', template: 'dues_reminder', language: 'en', vars: { 1: { src: 'custom', text: 'QA-OTHER-ROW' } }, custom_recipients: [{ phone: PHONE, row_no: 1 }] });
const ob = await row(OB);
check(x.ok === false && ob.status === 'draft' && JSON.parse(ob.body).note === 'theirs' && (await sentWith(s0, 'QA-OTHER-ROW')).length === 0,
  'a send naming another club\'s campaign id is refused; that campaign is untouched', x.error);

// templates-1 (server part): "{{ 1 }}" is submitted to Meta as "{{1}}"
if (cfg.whatsapp.wabaId) {
  const t0 = (await outbox('meta_template_submit')).length;
  x = await bs({ user_token: 'own', tpl_submit: true, name: 'qa_spaces_check', category: 'UTILITY', language: 'en', text: 'Hi {{ 1 }},\n\nYour court {{2}} booking is confirmed.', examples: ['Rahul', 'Court 5'] });
  const sub = (await outbox('meta_template_submit')).slice(t0)[0];
  const bodyText = sub ? (sub.payload.components.find((c) => c.type === 'BODY') || {}).text : null;
  check(x.ok && bodyText === 'Hi {{1}},\n\nYour court {{2}} booking is confirmed.', 'a template written with "{{ 1 }}" is submitted to Meta as "{{1}}"', JSON.stringify(bodyText));
}

// ================= WhatsApp Status =================
const WS = 'wa_status_wf.json', WSN = 'Record statuses';
const WCONF = builtCode(WS, WSN).match(/CONFIRM='([^']+)'/)[1];
const evMsg = (from, id, text) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const evSt = (id, status) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }] } }] }] });
const ws = async (body, { secret = 'qa-app-secret', unsigned = false, forward = false } = {}) => {
  const w = world(db); const item = metaItem(w, body, { secret, unsigned });
  if (forward) item.json.headers['x-confirm'] = WCONF;
  return runNode(WS, WSN, item, w);
};
const msgCount = async () => Number((await q(`select count(*) n from public.wa_messages`))[0].n);
const [{ wamid: camWamid }] = await q(`select wamid from public.wa_messages where sender_kind='campaign' and wamid is not null and status='sent' order by created_at desc limit 1`);
await q(`insert into public.wa_webhook_config (tenant_id, app_secret, verify_token) values ($1, null, 'qa') on conflict (tenant_id) do update set app_secret = null`, [T]);
let m0 = await msgCount();
r = await ws(evMsg('919111111111', 'wamid.QA.FAKE.1', 'Please pay dues to UPI x'), { unsigned: true });
const r2 = await ws(evSt(camWamid, 'read'), { unsigned: true });
const stNow = (await q(`select status from public.wa_messages where wamid=$1`, [camWamid]))[0].status;
check(r.ok === false && r2.ok === false && (await msgCount()) === m0 && stNow === 'sent',
  'with no app secret stored, WhatsApp Status records nothing: no injected member message, no status change', r.error);
await q(`update public.wa_webhook_config set app_secret='qa-app-secret' where tenant_id=$1`, [T]);
r = await ws(evSt(camWamid, 'read'), { unsigned: true, forward: true });
check(r.ok === false && (await q(`select status from public.wa_messages where wamid=$1`, [camWamid]))[0].status === 'sent',
  'the shared confirm code (x-confirm) no longer skips the signature check', r.error);
m0 = await msgCount();
r = await ws({ ...evSt(camWamid, 'delivered'), entry: [{ id: 'W', changes: [{ field: 'messages', value: { ...evSt(camWamid, 'delivered').entry[0].changes[0].value, messages: evMsg('919111111111', 'wamid.QA.FWD.1', 'fwd').entry[0].changes[0].value.messages } }] }] }, { forward: true });
check(r.ok && r.applied === 1 && (await msgCount()) === m0 && (await q(`select status from public.wa_messages where wamid=$1`, [camWamid]))[0].status === 'delivered',
  'a signed forward applies the status and stores no message (the inbound workflow already stores them)', JSON.stringify({ applied: r.applied, replies: r.replies }));
r = await ws(evMsg(PHONE, 'wamid.QA.DIRECT.1', 'signed reply'));
const again = await ws(evMsg(PHONE, 'wamid.QA.DIRECT.1', 'signed reply'));
const direct = await q(`select wamid from public.wa_messages where wamid='wamid.QA.DIRECT.1'`);
check(r.ok && again.ok && direct.length === 1, 'a signed member message sent twice by Meta is stored once, with its WhatsApp id', `${direct.length} row(s)`);

// ================= File Upload Relay =================
const RL = 'file_upload_relay_wf.json', RLN = 'Check request';
const rlCode = builtCode(RL, RLN);
const RCONF = rlCode.match(/CONFIRM='([^']+)'/)[1];
const STGDB = rlCode.match(/SUPA='([^']+)'/)[1];
const relay = async (target_url) => runNode(RL, RLN, { json: { body: { confirm: RCONF, target_url, mime: 'image/png', file_base64: 'iVBORw0KGgo=' } } }, world(db));
const allowed = ['https://graph.facebook.com/v20.0/upload:MTphdHRhY2htZW50OjEyMw==?sig=ARb123', STGDB + '/storage/v1/object/brand/posters/x.png'];
const refused = ['https://graph.facebook.com/v20.0/upload:x/../../v20.0/123456/messages', 'https://graph.facebook.com/v20.0/upload:x/%2e%2e/%2E%2E/v20.0/123456/message_templates',
  'https://graph.facebook.com/v20.0/upload:x/.%2e/.%2e/v20.0/1/messages', STGDB + '/storage/v1/object/%2e%2e/%2e%2e/%2e%2e/rest/v1/members', STGDB + '/storage/v1/object/../../rest/v1/members'];
const okA = []; for (const u of allowed) okA.push((await relay(u)).ok === true);
const okR = []; for (const u of refused) okR.push((await relay(u)).ok === false);
check(okA.every(Boolean) && okR.every(Boolean), 'the upload relay allows only real upload-session and storage addresses (no ../ or %2e tricks)', `allowed ${JSON.stringify(okA)}, refused ${JSON.stringify(okR)}`);

if (fails.length) { console.log(`\n${fails.length} of ${n} QA workflow checks FAILED: ${fails.join(', ')}`); process.exit(1); }
console.log(`\nAll ${n} QA workflow checks passed.`);
