// QA fixes, group sql_staff: staff roles and data integrity enforced by the database.
// Runs the staging structure (npm run staging:build first) in PGlite with real RLS, as each
// staff role would reach it through the public page key (PostgREST: role authenticated + JWT sub).
//   sql/staff_hardening.sql       club row, campaigns, deletes, money, audit, capacity, invites, log_gap
//   sql/wa_message_status.sql     wa_status_apply: service key only, one club only
//   sql/wa_inbox.sql              member linked later, note length, search, per-topic leads,
//                                 one-pass history backfill (same result as the old one, faster)
//   sql/wa_custom_templates.sql   a removed template frees its name
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readFileSync } from 'node:fs';
import { makeDb, B } from './harness.mjs';
import { fileURLToPath } from 'node:url';
const CRM = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');

const db = await makeDb();
const q = async (s, p) => (await db.query(s, p)).rows;
let n = 0, failed = 0;
const check = (c, label, detail = '') => { n++; if (c) console.log(`ok ${n}. ${label}`); else { failed++; console.log(`FAIL ${n}. ${label}${detail ? ' | ' + detail : ''}`); } };

/* one PostgREST request: its own transaction, role authenticated (or anon) with the JWT claims */
async function as(uid, sql, params = []) {
  try {
    const res = await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
      await tx.query(uid ? 'set local role authenticated' : 'set local role anon');
      return tx.query(sql, params);
    });
    return { rows: res.rows, affected: res.affectedRows ?? res.rows.length, err: null };
  } catch (e) { return { rows: [], affected: 0, err: String(e.message) }; }
}
const denied = (r) => !!r.err || r.affected === 0;
/* a section that throws (e.g. on a database without the fixes) counts as one failure; the next section still runs */
const section = async (name, fn) => { try { await fn(); } catch (e) { n++; failed++; console.log(`FAIL ${n}. section "${name}" stopped: ${String(e.message).slice(0, 200)}`); } };
let r, mem, ev;

const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
await q(`insert into public.tenants (slug, name) values ('qa-other', 'QA Other Club') on conflict do nothing`);
const [{ id: T2 }] = await q(`select id from public.tenants where slug='qa-other'`);
const users = await q(`insert into auth.users (email) values ('o@qa.test'),('m@qa.test'),('a@qa.test'),('d@qa.test'),('o2@qa.test'),('late@qa.test') returning id, email`);
const U = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u.id]));
await q(`delete from public.app_admins where tenant_id = $1`, [T]);
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values
  ($1,$6,'owner','o@qa.test'),($2,$6,'manager','m@qa.test'),($3,$6,'accounts','a@qa.test'),($4,$6,'front_desk','d@qa.test'),($5,$7,'owner','o2@qa.test')`,
  [U.o, U.m, U.a, U.d, U.o2, T, T2]);

// ---------------- 1. the club row (settings-01, auth_rbac-3, sql_security-04, other_pages-03)
await section("1. the club row", async () => {
const tenant = async () => (await q(`select * from public.tenants where id=$1`, [T]))[0];
const t0 = await tenant();
r = await as(U.d, `update public.tenants set bot_config = coalesce(bot_config,'{}'::jsonb) || '{"human_handoff":"CHANGED BY FRONT DESK"}', wa_phone_number_id = 'forged' where id=$1 returning id`, [T]);
let t1 = await tenant();
check(denied(r) && t1.bot_config.human_handoff === t0.bot_config.human_handoff && t1.wa_phone_number_id === t0.wa_phone_number_id, 'front desk cannot change the club settings or the WhatsApp phone number id', JSON.stringify(r));
r = await as(U.a, `update public.tenants set wa_token = 'forged-token', slug = 'hijack', name = 'Hijacked' where id=$1 returning id`, [T]);
t1 = await tenant();
check(denied(r) && t1.wa_token === t0.wa_token && t1.slug === 'shakti' && t1.name === t0.name, 'accounts cannot change the token, club code or name', JSON.stringify(r));
r = await as(U.m, `update public.tenants set bot_config = coalesce(bot_config,'{}'::jsonb) || '{"qa_manager":"yes"}' where id=$1 returning id`, [T]);
check(!r.err && r.affected === 1 && (await tenant()).bot_config.qa_manager === 'yes', 'a manager can save Settings (bot texts, payment link)', JSON.stringify(r));
r = await as(U.m, `update public.tenants set branding = coalesce(branding,'{}'::jsonb) || '{"tagline":"QA"}', name = $2, espo_team_id = 'qa-team' where id=$1 returning id`, [T, t0.name]);
check(!r.err && r.affected === 1, 'a manager can save branding and EspoCRM settings', JSON.stringify(r));
r = await as(U.m, `update public.tenants set wa_token = 'manager-token' where id=$1 returning id`, [T]);
check(!!r.err && /owner/.test(r.err) && (await tenant()).wa_token === t0.wa_token, 'a manager cannot change the WhatsApp credentials (owner only)', JSON.stringify(r));
r = await as(U.o, `update public.tenants set wa_token = 'owner-token', wa_waba_id = 'W1' where id=$1 returning id`, [T]);
check(!r.err && r.affected === 1 && (await tenant()).wa_token === 'owner-token', 'the owner can change the WhatsApp credentials', JSON.stringify(r));
r = await as(U.o, `update public.tenants set slug = 'shakti2' where id=$1 returning id`, [T]);
const r2 = await as(U.o, `update public.tenants set active = false where id=$1 returning id`, [T]);
check(!!r.err && !!r2.err && (await tenant()).slug === 'shakti', 'nobody changes the club code or active flag from the browser (orena-admin protects Shakti by slug)', r.err + ' / ' + r2.err);
r = await as(U.o2, `update public.tenants set bot_config = '{}' where id=$1 returning id`, [T]);
check(denied(r), 'another club\'s owner cannot change this club');
await q(`update public.tenants set wa_token = $2, wa_waba_id = $3, slug = 'shakti' where id=$1`, [T, t0.wa_token, t0.wa_waba_id]);
check((await tenant()).wa_token === t0.wa_token, 'n8n / SQL editor (service key, no login) are not affected');
});

// ---------------- 2. campaigns (campaigns-01, auth_rbac-2, sql_security-03, broadcast_workflows-01)
await section("2. campaigns", async () => {
const body = JSON.stringify({ template: 'dues_reminder', schedule_at: new Date(Date.now() - 60000).toISOString(), segment: {} });
r = await as(U.d, `insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'desk blast','dues_reminder','all','scheduled',$2) returning id`, [T, body]);
const r3 = await as(U.a, `insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'accounts blast','dues_reminder','all','sending',$2) returning id`, [T, body]);
check(!!r.err && !!r3.err, 'front desk and accounts cannot create a scheduled or sending campaign (the scheduler would send it)', (r.err || '') + ' / ' + (r3.err || ''));
r = await as(U.o, `insert into public.broadcasts (tenant_id, title, template_name, audience, status, body) values ($1,'owner scheduled','dues_reminder','Single','scheduled',$2) returning id`, [T, body]);
check(!r.err && r.rows.length === 1, 'the owner can schedule a campaign', r.err);
const BID = r.rows[0] && r.rows[0].id;
r = await as(U.a, `update public.broadcasts set audience = 'all', body = '{"segment":{}}' where id=$1 returning id`, [BID]);
const r4 = await as(U.d, `update public.broadcasts set status = 'sending' where id=$1 returning id`, [BID]);
check(denied(r) && denied(r4) && (await q(`select audience from public.broadcasts where id=$1`, [BID]))[0].audience === 'Single', 'accounts and front desk cannot edit or dispatch an owner\'s campaign');
r = await as(U.d, `select id from public.broadcasts where tenant_id=$1`, [T]);
check(!r.err && r.rows.length >= 2, 'every staff role can still read campaigns', r.err);
r = await as(U.m, `update public.broadcasts set title = 'manager edit' where id=$1 returning id`, [BID]);
check(!r.err && r.affected === 1, 'a manager can edit a campaign', r.err);
await q(`update public.broadcasts set status = 'sent' where id=$1`, [BID]);
r = await as(U.o, `update public.broadcasts set status = 'sending' where id=$1 returning id`, [BID]);
check(!!r.err && /already sent/.test(r.err), 'a sent campaign cannot be put back to sending (sent again) from the browser', r.err);
r = await as(U.d, `delete from public.broadcasts where id=$1`, [BID]);
check(denied(r) && (await q(`select 1 from public.broadcasts where id=$1`, [BID])).length === 1, 'front desk cannot delete campaigns');
});

// ---------------- 3. deletes (auth_rbac-4, members-01, events_regs-05, bookings_checkin-11, sql_security-07)
await section("3. deletes", async () => {
[mem] = await q(`insert into public.members (tenant_id, full_name, phone, dues_amount, status) values ($1,'QA Delete Me','919812300001',500,'active') returning id`, [T]);
for (const [who, uid] of [['front desk', U.d], ['accounts', U.a]]) {
  r = await as(uid, `delete from public.members where id=$1`, [mem.id]);
  check(!!r.err && /Only owners and managers/.test(r.err) && (await q(`select 1 from public.members where id=$1`, [mem.id])).length === 1, `${who} cannot delete a member (clear message)`, r.err);
}
[ev] = await q(`insert into public.events (tenant_id, title, kind, starts_at, capacity, is_open) values ($1,'QA delete event','tournament', now()+interval '3 days', 5, true) returning id`, [T]);
const [reg] = await q(`insert into public.event_registrations (tenant_id, event_id, member_id, name, phone, status) values ($1,$2,$3,'QA','919812300001','registered') returning id`, [T, ev.id, mem.id]);
const [bk] = await q(`insert into public.bookings (tenant_id, member_id, kind, resource, booking_date, slot, status) values ($1,$2,'court','QA Court', current_date + 5, '07:00-08:00','confirmed') returning id`, [T, mem.id]);
for (const [what, sql, id] of [['event', 'delete from public.events where id=$1', ev.id], ['registration', 'delete from public.event_registrations where id=$1', reg.id], ['booking', 'delete from public.bookings where id=$1', bk.id]]) {
  const rd = await as(U.d, sql, [id]); const ra = await as(U.a, sql, [id]);
  check(!!rd.err && !!ra.err, `front desk and accounts cannot delete a ${what}`, (rd.err || 'deleted') + ' / ' + (ra.err || 'deleted'));
}
r = await as(U.d, `update public.bookings set status = 'cancelled' where id=$1 returning id`, [bk.id]);
check(!r.err && r.affected === 1, 'front desk can still cancel a booking', r.err);
r = await as(U.d, `update public.event_registrations set status = 'cancelled' where id=$1 returning id`, [reg.id]);
check(!r.err && r.affected === 1, 'front desk can still cancel a registration', r.err);
});

// ---------------- 4. money (auth_rbac-7, payments_dues-05, sql_security-07, dashboard_reports-12)
await section("4. money", async () => {
r = await as(U.d, `select id, amount from public.payments where tenant_id=$1`, [T]);
const ra = await as(U.a, `select id, amount from public.payments where tenant_id=$1`, [T]);
check(!r.err && r.rows.length === 0 && ra.rows.length > 0, 'front desk reads no payments; accounts still does', `desk ${r.rows.length}, accounts ${ra.rows.length}`);
r = await as(U.d, `update public.members set dues_amount = 0 where id=$1 returning id`, [mem.id]);
check(!!r.err && /dues/.test(r.err) && Number((await q(`select dues_amount from public.members where id=$1`, [mem.id]))[0].dues_amount) === 500, 'front desk cannot clear a member\'s dues', r.err);
r = await as(U.d, `update public.members set full_name = 'QA Delete Me 2', dues_amount = 500, maintenance_paid_till = current_date + 30 where id=$1 returning id`, [mem.id]);
check(!r.err && r.affected === 1, 'front desk can still edit a member the way the page saves it (same dues sent back, paid-till date)', r.err);
r = await as(U.d, `insert into public.members (tenant_id, full_name, phone, dues_amount, status) values ($1,'QA Desk New','919812300002',0,'active') returning id`, [T]);
const r5 = await as(U.d, `insert into public.members (tenant_id, full_name, phone, dues_amount, status) values ($1,'QA Desk Dues','919812300003',900,'active') returning id`, [T]);
check(!r.err && !!r5.err, 'front desk can add a member, but not with dues', (r.err || 'ok') + ' / ' + (r5.err || 'inserted'));
r = await as(U.a, `update public.members set dues_amount = 250 where id=$1 returning id`, [mem.id]);
check(!r.err && r.affected === 1, 'accounts can change dues', r.err);
r = await as(U.m, `delete from public.members where id=$1`, [mem.id]);
check(!r.err && r.affected === 1, 'a manager can delete a member', r.err);
});

// ---------------- 5. audit log (auth_rbac-9, knowledge_staff-03, sql_security-09)
await section("5. audit log", async () => {
r = await as(U.d, `insert into public.audit_log (tenant_id, actor_email, action, entity, entity_id, created_at) values ($1,'o@qa.test','qa_forge','member','x','2020-01-01T00:00:00Z')`, [T]);
const [au] = await q(`select actor_email, created_at from public.audit_log where action='qa_forge'`);
check(!r.err && au && au.actor_email === 'd@qa.test' && new Date(au.created_at) > new Date(Date.now() - 600000), 'an activity entry is stored with the real signed-in email and the server time', JSON.stringify(au));
await q(`insert into public.audit_log (tenant_id, actor_email, action, entity) values ($1,'n8n','qa_service','x')`, [T]);
check((await q(`select actor_email from public.audit_log where action='qa_service'`))[0].actor_email === 'n8n', 'n8n entries keep their actor');
});

// ---------------- 6. event capacity (events_regs-01, -06, -14)
await section("6. event capacity", async () => {
const [cap] = await q(`insert into public.events (tenant_id, title, kind, starts_at, capacity, is_open) values ($1,'QA one seat','tournament', now()+interval '4 days', 1, true) returning id`, [T]);
await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status, source) values ($1,$2,'Old bot','919800000001','confirmed','WhatsApp')`, [T, cap.id]);
const [second] = await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status, source) values ($1,$2,'Second','919800000002','registered','WhatsApp') returning status`, [T, cap.id]);
check(second.status === 'waitlist', 'a registration the old bot saved as "confirmed" holds its seat: the next one is waitlisted', second.status);
r = await as(U.o2, `insert into public.event_registrations (tenant_id, event_id, name, phone, status) values ($1,$2,'Cross club','919800000003','registered') returning id`, [T2, ev.id]);
let crossSvc = null; try { await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status) values ($1,$2,'Cross club svc','919800000004','registered')`, [T2, ev.id]); } catch (e) { crossSvc = e.message; }
check(!!r.err && !!crossSvc, 'a registration cannot be attached to another club\'s event (from any club, or any writer)', (r.err || 'stored') + ' / ' + (crossSvc || 'stored'));
const [regT] = await q(`insert into public.event_registrations (tenant_id, event_id, name, phone, status) values ($1,$2,'Move me','919800000005','registered') returning id`, [T, ev.id]);
r = await as(U.o, `update public.event_registrations set event_id = (select id from public.events where tenant_id=$2 limit 1), tenant_id = $2 where id=$1 returning id`, [regT.id, T2]);
check(denied(r), 'a registration cannot be moved to another club', r.err);
});

// ---------------- 7. functions only n8n may call (auth_rbac-1, -8, sql_security-01, -02, knowledge_staff-01, other_pages-06, -17, bot_workflow-02)
await section("7. functions only n8n may call", async () => {
const gapArgs = [T, 'QA public question', 'qa public question', 0, 0, 'r', '0000'];
const gapSql = `select public.log_gap($1::uuid,$2,$3,$4::float,$5::int,$6,$7)`;
const ga = await as(null, gapSql, gapArgs), gd = await as(U.d, gapSql, gapArgs);
check(/permission denied/.test(ga.err || '') && /permission denied/.test(gd.err || ''), 'log_gap cannot be called with the public key, signed in or not', (ga.err || 'ran') + ' / ' + (gd.err || 'ran'));
await q(gapSql, gapArgs);
check((await q(`select hits from public.kb_gaps where q_norm='qa public question'`)).length === 1, 'the bot (service key) can still log a question');
await q(`select public.wa_status_apply('wamid.QA.1', $1, 'sent', now(), null, '919812399999', null, null, null, null, null, null, null, true)`, [T]);
const stSql = `select public.wa_status_apply('wamid.QA.1', $1::uuid, 'failed', now(), null, null, null, 131026, 'forged', 'forged', null, null, null, false)`;
const sa = await as(null, stSql, [T]), sd = await as(U.d, stSql, [T]), so = await as(U.o2, stSql, [T2]);
check(/permission denied/.test(sa.err || '') && /permission denied/.test(sd.err || '') && /permission denied/.test(so.err || ''), 'wa_status_apply cannot be called with the public key (anon, staff, another club)', [sa.err, sd.err, so.err].map((e) => e || 'ran').join(' / '));
await q(stSql, [T2]);
check((await q(`select status from public.wa_message_status where wamid='wamid.QA.1'`))[0].status === 'sent', 'a status event for another club does not change this club\'s message');
await q(`select public.wa_status_apply('wamid.QA.1', $1, 'delivered', now())`, [T]);
check((await q(`select status from public.wa_message_status where wamid='wamid.QA.1'`))[0].status === 'delivered', 'a status event for the right club still applies');
});

// ---------------- 8. staff: last owner, invites (knowledge_staff-07, -02, -06, auth_rbac-6)
await section("8. staff: last owner, invites", async () => {
r = await as(U.o, `delete from public.app_admins where user_id=$1 and tenant_id=$2`, [U.o, T]);
check(!!r.err && /at least one owner/.test(r.err), 'the club\'s last owner cannot be removed', r.err);
const invite = (uid, email, role) => as(uid, `insert into public.app_admin_invites (tenant_id, email, role) values ($1,$2,$3) on conflict (tenant_id, email) do update set role = excluded.role`, [T, email, role]);
r = await invite(U.o, 'late@qa.test', 'front_desk');
let adm = await q(`select role from public.app_admins where user_id=$1 and tenant_id=$2`, [U.late, T]);
check(!r.err && adm[0] && adm[0].role === 'front_desk' && (await q(`select 1 from public.app_admin_invites where email='late@qa.test'`)).length === 0, 'an invite for an email that already has a login gives access at once', r.err || JSON.stringify(adm));
await as(U.o, `delete from public.app_admins where user_id=$1 and tenant_id=$2`, [U.late, T]);
r = await invite(U.o, 'Late@QA.test', 'accounts');
adm = await q(`select role from public.app_admins where user_id=$1 and tenant_id=$2`, [U.late, T]);
check(!r.err && adm[0] && adm[0].role === 'accounts', 'removed staff can be re-added with a new role by inviting again (any capitals)', r.err || JSON.stringify(adm));
r = await invite(U.o, 'late@qa.test', 'manager');
adm = await q(`select role from public.app_admins where user_id=$1 and tenant_id=$2`, [U.late, T]);
check(!r.err && adm[0].role === 'manager', 'inviting current staff again changes their role', r.err);
r = await invite(U.o, 'o@qa.test', 'front_desk');
check(!!r.err && /at least one owner/.test(r.err) && (await q(`select role from public.app_admins where user_id=$1 and tenant_id=$2`, [U.o, T]))[0].role === 'owner', 'the last owner cannot demote themselves by an invite', r.err);
await invite(U.o, 'New.Person@QA.test', 'owner');
await invite(U.o, 'new.person@qa.test', 'front_desk');
const inv = await q(`select email, role from public.app_admin_invites where tenant_id=$1 and lower(email)='new.person@qa.test'`, [T]);
check(inv.length === 1 && inv[0].role === 'front_desk' && inv[0].email === 'new.person@qa.test', 'the same email with other capitals is one invite, the latest role wins', JSON.stringify(inv));
const [np] = await q(`insert into auth.users (email) values ('New.Person@qa.test') returning id`);
adm = await q(`select role from public.app_admins where user_id=$1 and tenant_id=$2`, [np.id, T]);
check(adm[0] && adm[0].role === 'front_desk', 'on sign-up the invited role is granted', JSON.stringify(adm));
r = await invite(U.d, 'x@qa.test', 'owner');
check(!!r.err, 'only owners can invite', r.err);
});

// ---------------- 9. Inbox (inbox-01, -05, -10, -11, bot_workflow-04)
await section("9. Inbox", async () => {
const staffGrant = `grant select on public.wa_conversations, public.wa_messages, public.members, public.app_admins to authenticated`;
await db.exec(staffGrant);
await q(`insert into public.wa_messages (tenant_id, phone, direction, body) values ($1,'919812344444','in','I want to join')`, [T]);
check((await q(`select member_id from public.wa_conversations where tenant_id=$1 and phone_key='919812344444'`, [T]))[0].member_id === null, 'a chat from an unknown number starts without a member');
r = await as(U.d, `insert into public.members (tenant_id, full_name, phone, status) values ($1,'Late Joiner','98123 44444','active') returning id`, [T]);
const conv = (await q(`select member_id from public.wa_conversations where tenant_id=$1 and phone_key='919812344444'`, [T]))[0];
check(!r.err && conv.member_id === r.rows[0].id, 'a member added after the chat exists is linked to it at once ("Add as Member")', r.err || JSON.stringify(conv));
r = await as(U.d, `select public.wa_note_add($1, '919812344444', $2)`, [T, 'x'.repeat(4001)]);
const rOk = await as(U.d, `select public.wa_note_add($1, '919812344444', $2)`, [T, 'y'.repeat(4000)]);
check(!!r.err && /4,000/.test(r.err) && !rOk.err, 'a note over 4,000 characters is refused with a message (not cut); 4,000 is kept', r.err);
r = await as(U.d, `select * from public.wa_inbox_list($1, 'all', '%')`, [T]);
const withMember = (await q(`select count(*)::int n from public.wa_conversations where tenant_id=$1 and member_id is not null`, [T]))[0].n;
check(!r.err && r.rows.length === 0 && withMember > 0, 'searching "%" matches only names that contain "%"', `${r.rows.length} of ${withMember} chats with a member`);
r = await as(U.d, `select * from public.wa_inbox_list($1, 'all', 'Late_Joiner')`, [T]);
const rName = await as(U.d, `select * from public.wa_inbox_list($1, 'all', 'late join')`, [T]);
check(r.rows.length === 0 && rName.rows.length === 1, 'an underscore is literal; a normal name search still works', `${r.rows.length} / ${rName.rows.length}`);
r = await as(U.d, `select * from public.wa_inbox_list($1, 'all', '098123 44444')`, [T]);
check(!r.err && r.rows.length === 1, 'a phone search with the trunk 0 finds the chat', r.err || String(r.rows.length));
await q(`select public.wa_bot_lead_posted($1, '919812344444', 'membership_enquiry')`, [T]);
await q(`select public.wa_bot_lead_posted($1, '919812344444', 'ai_enquiry')`, [T]);
const bs = (await q(`select public.wa_bot_state($1, '919812344444') s`, [T]))[0].s;
check(bs.last_leads && bs.last_leads.membership_enquiry && bs.last_leads.ai_enquiry && bs.last_lead_intent === 'ai_enquiry', 'the bot state remembers the last lead per topic (last_leads)', JSON.stringify(bs.last_leads));
});

// ---------------- 10. custom templates (templates-4)
await section("10. custom templates", async () => {
r = await as(U.o, `insert into public.wa_custom_templates (tenant_id, name, body) values ($1,'QA Dup','hello') returning id`, [T]);
const CT = r.rows[0].id;
await as(U.o, `update public.wa_custom_templates set status = 'archived' where id=$1`, [CT]);
r = await as(U.o, `insert into public.wa_custom_templates (tenant_id, name, body) values ($1,'QA Dup','hello again') returning id`, [T]);
const r6 = await as(U.o, `insert into public.wa_custom_templates (tenant_id, name, body) values ($1,'QA Dup','third') returning id`, [T]);
const archivedName = (await q(`select name from public.wa_custom_templates where id=$1`, [CT]))[0].name;
check(!r.err && !!r6.err && /^QA Dup \(removed \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)$/.test(archivedName), 'a removed template frees its name; two templates in use still cannot share one', (r.err || 'ok') + ' / ' + archivedName);
});

// ---------------- 11. wa_inbox.sql history backfill: one pass, same result as before
await section("11. wa_inbox.sql history backfill: one pass, same result as before", async () => {
const inboxSql = readFileSync(CRM + 'sql/wa_inbox.sql', 'utf8');
check(/^set local lock_timeout = '5s';$/m.test(inboxSql.slice(0, inboxSql.indexOf('-- 1) One phone format'))), 'wa_inbox.sql sets lock_timeout 5s before touching anything');
const OLD_BACKFILL = `select x.tenant_id, x.phone_key,
       coalesce(x.in_phone, x.phone),
       coalesce(x.member_id,
                (select m.id from public.members m where m.tenant_id = x.tenant_id and public.wa_phone_key(m.phone) = x.phone_key
                  order by m.created_at limit 1)),
       x.created_at, left(coalesce(x.body, ''), 160), x.direction, x.last_in, 0, now(),
       case when x.last_in is null then 'resolved' else 'open' end
from (
  select distinct on (m.tenant_id, m.phone_key)
         m.tenant_id, m.phone_key, m.phone, m.body, m.direction, m.created_at,
         (select m2.member_id from public.wa_messages m2
           where m2.tenant_id = m.tenant_id and m2.phone_key = m.phone_key and m2.member_id is not null
           order by m2.created_at desc limit 1) as member_id,
         (select max(m3.created_at) from public.wa_messages m3
           where m3.tenant_id = m.tenant_id and m3.phone_key = m.phone_key and m3.direction = 'in') as last_in,
         (select m4.phone from public.wa_messages m4
           where m4.tenant_id = m.tenant_id and m4.phone_key = m.phone_key and m4.direction = 'in'
           order by m4.created_at desc limit 1) as in_phone
  from public.wa_messages m
  where m.phone_key is not null and m.phone_key <> '' and m.direction <> 'note'
  order by m.tenant_id, m.phone_key, m.created_at desc
) x`;
const sec5 = inboxSql.slice(inboxSql.indexOf('-- 5) Existing history'));
const ins5 = sec5.slice(sec5.indexOf('insert into public.wa_conversations'));
const NEW_BACKFILL = ins5.slice(ins5.indexOf('\nselect ') + 1, ins5.indexOf('on conflict (tenant_id, phone_key) do nothing;'));
const structure = readFileSync(B + 'db/1-structure.sql', 'utf8');
const before = structure.slice(0, structure.indexOf('-- ================= sql/wa_inbox.sql'));
const bdb = new PGlite({ extensions: { vector } });
await bdb.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
  create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false);`);
await bdb.exec(before);
await bdb.exec(`insert into public.tenants (slug, name) values ('a','A'),('b','B')`);
const tids = (await bdb.query(`select id from public.tenants order by slug`)).rows.map((x) => x.id);
// varied history: 800 numbers in 4 formats, some members (some with duplicate phones), in/out/note/other
// directions, member ids on some rows only, numbers with only campaigns, only notes, a few with no digits
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const memberRows = [];
for (let i = 0; i < 300; i++) { const d = String(9000000000 + i * 7); memberRows.push(`('${tids[i % 2]}','M${i}','${i % 3 === 0 ? '91' + d : d}', now() - interval '${i} minutes')`); }
memberRows.push(`('${tids[0]}','Dup','9000000000', now() - interval '1 day')`);
await bdb.exec(`insert into public.members (tenant_id, full_name, phone, created_at) values ${memberRows.join(',')}`);
const mids = (await bdb.query(`select id, tenant_id, phone from public.members`)).rows;
const msgs = []; let tms = 0;
for (let i = 0; i < 3200; i++) {
  const num = Math.floor(rnd() * 800); const d = String(9000000000 + num * 7);
  const fmt = num % 4 === 0 ? d : num % 4 === 1 ? '91' + d : num % 4 === 2 ? '+91 ' + d.slice(0, 5) + ' ' + d.slice(5) : '0' + d;
  const dirRoll = rnd();
  const dir = num % 50 === 7 ? 'out' : num % 97 === 3 ? 'note' : dirRoll < 0.45 ? 'in' : dirRoll < 0.9 ? 'out' : dirRoll < 0.97 ? 'note' : 'system';
  const phone = dir === 'note' ? 'note:' + d : (i % 211 === 5 ? 'unknown' : fmt);
  const m = rnd() < 0.3 ? mids[Math.floor(rnd() * mids.length)] : null;
  tms += 1 + Math.floor(rnd() * 5000);
  msgs.push(`('${tids[num % 3 === 0 ? 1 : 0]}', '${phone}', ${m ? `'${m.id}'` : 'null'}, ${dir ? `'${dir}'` : 'null'}, 'msg ${i} ${'x'.repeat(i % 200)}', timestamptz '2026-01-01' + interval '${tms} milliseconds')`);
}
// plus three long conversations (400 messages each) from numbers with no member id on any message
for (let i = 0; i < 1200; i++) { tms += 1 + Math.floor(rnd() * 5000); msgs.push(`('${tids[0]}', '91710000000${i % 3}', null, '${rnd() < 0.5 ? 'in' : 'out'}', 'long ${i}', timestamptz '2026-01-01' + interval '${tms} milliseconds')`); }
for (let i = 0; i < msgs.length; i += 500) await bdb.exec(`insert into public.wa_messages (tenant_id, phone, member_id, direction, body, created_at) values ${msgs.slice(i, i + 500).join(',')}`);
await bdb.exec(inboxSql);
const norm = (rows) => rows.map((x) => { const v = Object.values(x); v.splice(9, 1); return JSON.stringify(v, (k, val) => val instanceof Date ? val.toISOString() : val); }).sort();
let t = Date.now(); const oldRows = (await bdb.query(OLD_BACKFILL, [], { rowMode: 'array' })).rows; const tOld = Date.now() - t;
t = Date.now(); const newRows = (await bdb.query(NEW_BACKFILL, [], { rowMode: 'array' })).rows; const tNew = Date.now() - t;
const A = norm(oldRows), Bn = norm(newRows);
const same = A.length === Bn.length && A.every((x, i) => x === Bn[i]);
const conv2 = (await bdb.query(`select count(*)::int n from public.wa_conversations`)).rows[0].n;
check(same && A.length > 500 && conv2 === A.length, `the one-pass backfill gives exactly the old result on ${msgs.length} varied messages (${A.length} conversations; old ${tOld} ms, new ${tNew} ms)`, same ? '' : `old ${A.length} rows, new ${Bn.length}; first diff ${A.find((x, i) => x !== Bn[i])} vs ${Bn.find((x, i) => x !== A[i])}`);
// 12,000 messages from 4 numbers, no member id on any of them: the case that took 447 s with the old
// backfill (three look-ups per message, each reading the whole conversation)
const many = [];
for (let i = 0; i < 12000; i++) many.push(`('${tids[0]}', '91${7000000000 + (i % 4)}',${i % 2 ? `'in'` : `'out'`}, 'bulk', timestamptz '2026-02-01' + interval '${i} seconds')`);
const bdb2 = new PGlite({ extensions: { vector } });
await bdb2.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
  create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false);`);
await bdb2.exec(before);
await bdb2.exec(`insert into public.tenants (slug, name) values ('a','A')`);
const tid2 = (await bdb2.query(`select id from public.tenants where slug='a'`)).rows[0].id;
for (let i = 0; i < many.length; i += 1000) await bdb2.exec(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values ${many.slice(i, i + 1000).join(',').replaceAll(tids[0], tid2)}`);
t = Date.now(); await bdb2.exec(inboxSql); const tFile = Date.now() - t;
const c3 = (await bdb2.query(`select count(*)::int n from public.wa_conversations`)).rows[0].n;
check(c3 === 4 && tFile < 30000, `the whole of wa_inbox.sql on 12,000 messages in 4 long non-member chats: ${(tFile / 1000).toFixed(1)} s on PGlite (old backfill: 447 s)`, `${c3} conversations`);
});

console.log(failed ? `\n${failed} of ${n} checks FAILED` : `\nqa-sql_staff: all ${n} checks passed`);
process.exit(failed ? 1 : 0);
