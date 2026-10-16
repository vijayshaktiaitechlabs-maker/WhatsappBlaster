// QA regression checks for the Settings / login / roles / Staff / Bot Knowledge / audit fixes in the admin page
// (group page_settings). Runs the staging-built page in Edge on the local bench (real SQL + RLS in PGlite).
//   node tools/build-staging.mjs   then   node tests/bench/qa-page_settings.mjs
import { readFileSync } from 'node:fs';
import { benchDb, openBrowser, watch, login, sleep, PHONE, APP, PAGE_FILE } from './browser-setup.mjs';
import { world, runNode, metaItem, cfg } from './harness.mjs';

const results = [];
const rec = (area, test, ok, evidence = '') => { results.push({ area, test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(evidence).slice(0, 200)}`); };
const { db, q, T, users, staff } = await benchDb();
const owner = staff.find((s) => s.email === 'qa-owner@club.test');
const accounts = staff.find((s) => s.email === 'qa-accounts@club.test');
const PNID = cfg.whatsapp.phoneNumberId;
let seq = 0;
const ev = (msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: msg.from, profile: { name: 'Member' } }], messages: [msg] } }] }] });
const tap = (id, from = PHONE) => ({ from, id: `wamid.QAPS.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } });
const branding = async () => (await q(`select branding from public.tenants where id=$1`, [T]))[0].branding || {};
const auditRows = async (action, entity) => q(`select * from public.audit_log where tenant_id=$1 and action=$2 and entity=$3 order by created_at desc`, [T, action, entity]);

// ---- seed (before login: labels, EspoCRM URL, Bot Knowledge questions, a staff member with an apostrophe, the owner's roster row without email)
const XSS = 'Fees<img src=x onerror="window.__xssLabel=1">';
await q(`update public.tenants set branding = coalesce(branding,'{}'::jsonb) || jsonb_build_object('labels', jsonb_build_object('dues', $2::text), 'espo_url', 'https://espo.example.org') where id=$1`, [T, XSS]);
const longQ = 'https://example.org/' + 'x'.repeat(260);
const [gapLong] = await q(`insert into public.kb_gaps (tenant_id, question, q_norm, bot_reply) values ($1, $2, $2, $3) returning id`, [T, longQ, 'y'.repeat(300)]);
const [gapIgnore] = await q(`insert into public.kb_gaps (tenant_id, question, q_norm) values ($1, 'Do you have a sauna?', 'do you have a sauna') returning id`, [T]);
const [obrien] = await q(`insert into auth.users (email) values ('o''brien@club.test') returning id`);
await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1, $2, 'front_desk', 'o''brien@club.test')`, [obrien.id, T]);
await q(`update public.app_admins set email = null where user_id=$1 and tenant_id=$2`, [owner.id, T]);

const { browser, context, fake } = await openBrowser(db, users);
await context.route('https://espo.example.org/**', (r) => r.fulfill({ status: 401, body: '' }));
await context.route(/orena\.solutions|espo\.orenanow\.com/, (r) => r.fulfill({ status: 599, body: 'blocked by the bench' })); // never reach a live EspoCRM (an old page would)
const page = await context.newPage();
const issues = watch(page);
const outside = [];
page.on('request', (r) => { if (/orena\.solutions|espo\.orenanow/.test(r.url())) outside.push(r.url()); });
const toastTxt = async () => ((await page.locator('#toast').textContent().catch(() => '')) || '').trim();
const dialogsSince = (n) => issues.dialogs.slice(n);

try {
  await login(page, 'qa-owner@club.test');

  // ---------- settings-02: custom vocabulary is never HTML
  await page.evaluate(() => go('payments')); await sleep(400);
  await page.evaluate(() => go('dash')); await sleep(400);
  let s = await page.evaluate(() => ({ ran: window.__xssLabel, imgs: document.querySelectorAll('#kpis img, #duesRemindTitle img, #memTbl img').length, kpi: document.querySelector('#kpis').textContent }));
  rec('Labels (settings-02)', 'a label with HTML in it is shown as text: no script runs, no element is created', s.ran === undefined && s.imgs === 0 && /Fees/i.test(s.kpi), `script ran: ${s.ran}; img elements: ${s.imgs}`);
  await page.evaluate(() => go('settings')); await sleep(600);
  const labelsBefore = JSON.stringify((await branding()).labels);
  await page.fill('#wl_term_dues', 'Fees<b>x</b>');
  await page.click('#whiteLabelCard button:has-text("Save White-Label")'); await sleep(600);
  rec('Labels (settings-02)', 'Save White-Label refuses < > in the vocabulary boxes', /cannot contain/.test(await toastTxt()) && JSON.stringify((await branding()).labels) === labelsBefore, await toastTxt());

  // ---------- settings-04: White-label and EspoCRM saves keep each other's keys and other admins' changes
  await page.fill('#wl_term_dues', 'Fees');
  await page.fill('#wl_tagline', 'Tagline saved by White-label');
  await q(`update public.tenants set branding = branding || '{"espo_url":"https://espo-other.example.org"}'::jsonb where id=$1`, [T]);
  await page.click('#whiteLabelCard button:has-text("Save White-Label")'); await sleep(900);
  let b = await branding();
  rec('Branding (settings-04)', 'Save White-Label keeps the EspoCRM URL another admin saved meanwhile', b.tagline === 'Tagline saved by White-label' && b.labels.dues === 'Fees' && b.espo_url === 'https://espo-other.example.org', `tagline "${b.tagline}", dues "${b.labels && b.labels.dues}", espo_url ${b.espo_url}`);
  await page.fill('#ec_espo_url', 'https://espo2.example.org');
  await page.click('#espoCredCard button:has-text("Save EspoCRM")'); await sleep(900);
  b = await branding();
  rec('Branding (settings-04)', 'Save EspoCRM keeps the White-label tagline and vocabulary', b.espo_url === 'https://espo2.example.org' && b.tagline === 'Tagline saved by White-label' && b.labels.dues === 'Fees', `espo_url ${b.espo_url}, tagline "${b.tagline}"`);

  // ---------- settings-05: a refused White-label save says so
  await page.route('**/rest/v1/tenants**', (r) => (r.request().method() === 'PATCH' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"bench: refused"}' }) : r.fallback()));
  await page.fill('#wl_tagline', 'This save fails');
  await page.click('#whiteLabelCard button:has-text("Save White-Label")'); await sleep(900);
  s = await page.evaluate(() => ({ tag: TENANT_BRANDING && TENANT_BRANDING.tagline }));
  const tFail = await toastTxt();
  await page.unroute('**/rest/v1/tenants**');
  rec('Branding (settings-05)', 'a refused White-label save shows an error and is not applied', /Could not save/.test(tFail) && s.tag !== 'This save fails' && (await branding()).tagline === 'Tagline saved by White-label', `toast "${tFail}", page tagline "${s.tag}"`);
  await page.fill('#wl_tagline', 'Tagline saved by White-label');

  // ---------- settings-08: module switches say they are not saved yet
  await page.evaluate(() => toggleModule('reports', false)); await sleep(200);
  const tMod = await toastTxt();
  await page.evaluate(() => toggleModule('reports', true)); await sleep(200);
  rec('Modules (settings-08)', 'switching a module off says it is not saved until Save White-Label', /Not saved yet/.test(tMod), tMod);

  // ---------- settings-03: credentials saved from an older page never put back an old token
  const credsBefore = (await q(`select wa_token, fb_page_id from public.tenants where id=$1`, [T]))[0];
  const boxToken = await page.inputValue('#mc_wa_token');
  await q(`update public.tenants set wa_token = 'QA-ROTATED-TOKEN' where id=$1`, [T]);
  await page.fill('#mc_fb_page_id', 'QA-FBPAGE-2');
  let d0 = issues.dialogs.length;
  await page.click('button:has-text("Save Credentials")'); await sleep(900);
  let c = (await q(`select wa_token, fb_page_id from public.tenants where id=$1`, [T]))[0];
  const boxNow = await page.inputValue('#mc_wa_token');
  rec('Credentials (settings-03)', 'changing only the Page ID keeps the token another owner saved meanwhile', boxToken === (credsBefore.wa_token || '') && c.wa_token === 'QA-ROTATED-TOKEN' && c.fb_page_id === 'QA-FBPAGE-2' && boxNow === 'QA-ROTATED-TOKEN' && issues.dialogs.length === d0, `token kept: ${c.wa_token === 'QA-ROTATED-TOKEN'}; page id saved: ${c.fb_page_id === 'QA-FBPAGE-2'}; box shows the new token: ${boxNow === 'QA-ROTATED-TOKEN'}`);
  await q(`update public.tenants set fb_page_id = 'QA-FBPAGE-OTHER' where id=$1`, [T]);
  await page.fill('#mc_fb_page_id', 'QA-FBPAGE-3');
  d0 = issues.dialogs.length;
  await page.click('button:has-text("Save Credentials")'); await sleep(900);
  c = (await q(`select wa_token, fb_page_id from public.tenants where id=$1`, [T]))[0];
  const asked = dialogsSince(d0).find((x) => /Someone else changed/.test(x));
  rec('Credentials (settings-03)', 'when someone else changed the same box, the page asks first', !!asked && /Facebook Page ID/.test(asked) && c.fb_page_id === 'QA-FBPAGE-3' && c.wa_token === 'QA-ROTATED-TOKEN', asked ? asked.split('\n')[0] : 'no question asked');
  const credAudit = await auditRows('updated', 'settings');
  const ca = credAudit.find((a) => a.entity_id === 'wa_credentials');
  rec('Audit (knowledge_staff-04)', 'saving credentials is logged with the field names only (never the values)', !!ca && JSON.stringify(ca.detail.changed) === '["fb_page_id"]' && !/QA-FBPAGE|QA-ROTATED/.test(JSON.stringify(ca.detail)), ca ? JSON.stringify(ca.detail) : 'no entry');

  // ---------- settings-07 / tooling_golive-05(b): no EspoCRM key or fixed live host in the page; the test uses the typed URL
  const src = readFileSync(PAGE_FILE, 'utf8');
  rec('EspoCRM (tooling_golive-05b)', 'the built page has no X-Api-Key and no fixed EspoCRM host', !/X-Api-Key/i.test(src) && !/orena\.solutions\/espo/.test(src), 'searched the staging-built admin page');
  await page.fill('#ec_espo_url', '');
  await page.evaluate(() => testEspoConn()); await sleep(300);
  const tEmpty = ((await page.textContent('#espoTestResult')) || '').trim();
  await page.fill('#ec_espo_url', 'https://espo.example.org');
  await page.evaluate(() => testEspoConn()); await sleep(800);
  const tTyped = ((await page.textContent('#espoTestResult')) || '').trim();
  rec('EspoCRM (settings-07)', 'Test Connection checks the URL typed in the card and sends no request to a fixed host', /Type the EspoCRM base URL/.test(tEmpty) && /espo\.example\.org answers/.test(tTyped) && !outside.length, `${tTyped.slice(0, 90)}; requests to a fixed host: ${outside.length}`);

  // ---------- settings-06: the Membership reply box is what the bot sends for "Membership"
  const cfg0 = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  const shown = await page.inputValue('#s_membership_text');
  await page.fill('#s_membership_text', 'QA MEMBERSHIP REPLY: family and individual plans.');
  await page.click('#setSave'); await sleep(1200);
  const cfg1 = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
  const w = world(db); await runNode('wa_bot_wf.json', 'Bot Engine', metaItem(w, ev(tap('menu:membership'))), w); await fake.drain();
  const mm = (await q(`select payload from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
  rec('Membership (settings-06)', 'the "Membership reply" box shows and saves bot_config.membership_text, and the bot sends it for Membership', shown === (cfg0.membership_text || '').replace(/\r\n/g, '\n') && cfg1.membership_text === 'QA MEMBERSHIP REPLY: family and individual plans.' && !!mm && /QA MEMBERSHIP REPLY/.test(JSON.stringify(mm.payload)), `saved: ${cfg1.membership_text === 'QA MEMBERSHIP REPLY: family and individual plans.'}; bot sent it: ${!!mm && /QA MEMBERSHIP REPLY/.test(JSON.stringify(mm.payload))}`);

  // ---------- settings-09: incomplete rows are pointed out before saving
  await page.evaluate(() => { FACILITIES.push({ name: '', detail: '', timings: '7 AM – 8 PM (row with no name)' }); renderFacilities(); });
  d0 = issues.dialogs.length;
  await page.click('#setSave'); await sleep(900);
  const inc = dialogsSince(d0).find((x) => /not complete/.test(x));
  rec('Settings (settings-09)', 'a facility row with timings but no name is named before saving', !!inc && /Sports & facilities row \d+ \(no name\)/.test(inc), inc ? inc.split('\n').slice(0, 3).join(' / ') : 'no question asked');

  // ---------- members: owner delete is logged; a new member's log entry has its id (auth_rbac-4, knowledge_staff-04)
  await page.evaluate(() => go('members')); await sleep(400);
  await page.evaluate(() => { openMember(); document.querySelector('#f_full_name').value = 'QA Audit Member'; document.querySelector('#f_phone').value = '919000000123'; return saveMember(); }); await sleep(900);
  const [nm] = await q(`select id from public.members where tenant_id=$1 and full_name='QA Audit Member'`, [T]);
  const created = (await auditRows('created', 'member')).find((a) => a.detail && a.detail.name === 'QA Audit Member');
  rec('Audit (knowledge_staff-04)', 'adding a member logs the new member\'s id (not "new")', !!nm && !!created && created.entity_id === nm.id, created ? created.entity_id : 'no entry');
  await page.evaluate((id) => delMember(id), nm.id); await sleep(900);
  const gone = !(await q(`select 1 from public.members where id=$1`, [nm.id])).length;
  const del = (await auditRows('deleted', 'member')).find((a) => a.entity_id === nm.id);
  rec('Members (auth_rbac-4)', 'an owner can still delete a member, and the delete is in the Activity log', gone && !!del && del.actor_email === 'qa-owner@club.test', `deleted ${gone}; log entry ${!!del}`);

  // ---------- Bot Knowledge: long questions wrap; Ignore is logged (knowledge_staff-10, -04)
  await page.evaluate(() => go('knowledge')); await sleep(600);
  s = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, shown: !!document.querySelector('.gap-card') }));
  rec('Bot Knowledge (knowledge_staff-10)', 'a 280-character unbroken question does not make the page scroll sideways', s.shown && s.sw <= s.iw + 1, `page ${s.sw}px wide, window ${s.iw}px`);
  await page.evaluate((id) => ignoreGap(id), gapIgnore.id); await sleep(700);
  const ign = (await auditRows('ignored', 'bot_knowledge')).find((a) => a.entity_id === gapIgnore.id);
  rec('Audit (knowledge_staff-04)', 'ignoring a Bot Knowledge question is logged', !!ign, ign ? ign.detail.name : 'no entry');

  // ---------- Staff page (auth_rbac-10, knowledge_staff-05/-06/-07/-08/-04)
  await page.evaluate(() => go('staff')); await sleep(300);
  await page.evaluate(() => loadStaff()); await sleep(600);
  s = await page.evaluate(() => [...document.querySelectorAll('#staffTbl tbody tr')].map((tr) => ({ t: tr.textContent.replace(/\s+/g, ' ').trim(), remove: !!tr.querySelector('button') })));
  const ownRow = s.find((r) => /Owner/.test(r.t));
  rec('Staff (knowledge_staff-07)', 'the owner\'s own row says "you" (no Remove) even when its roster email is empty', !!ownRow && /you/.test(ownRow.t) && !ownRow.remove, ownRow ? ownRow.t : 'no owner row');
  await page.evaluate((uid) => removeStaff(uid), owner.id); await sleep(400);
  const tOnly = await toastTxt();
  rec('Staff (knowledge_staff-07)', 'the club\'s only owner cannot be removed from the page', /only owner/.test(tOnly) && (await q(`select 1 from public.app_admins where user_id=$1 and tenant_id=$2`, [owner.id, T])).length === 1, tOnly);
  const pe0 = issues.page.length; d0 = issues.dialogs.length;
  await page.locator('#staffTbl tbody tr', { hasText: "o'brien@club.test" }).locator('button:has-text("Remove")').click(); await sleep(900);
  const rmAsk = dialogsSince(d0).find((x) => /Remove/.test(x));
  const obGone = !(await q(`select 1 from public.app_admins where user_id=$1`, [obrien.id])).length;
  const rmLog = (await auditRows('removed', 'staff')).find((a) => a.entity_id === obrien.id);
  rec('Staff (auth_rbac-10, knowledge_staff-05)', 'Remove works for an email with an apostrophe (asks with the real address, no script error) and is logged', !!rmAsk && rmAsk.includes("o'brien@club.test") && obGone && issues.page.length === pe0 && !!rmLog, `asked: ${rmAsk ? rmAsk.slice(0, 60) : 'no'}; removed ${obGone}; page errors ${issues.page.length - pe0}; logged ${!!rmLog}`);
  await page.fill('#inviteEmail', 'Case.Person@Club.test');
  await page.click('button:has-text("Send invite")'); await sleep(900);
  const inv = await q(`select id, email from public.app_admin_invites where tenant_id=$1 and lower(email)='case.person@club.test'`, [T]);
  rec('Staff (knowledge_staff-06)', 'an invite is stored with the email in lower case', inv.length === 1 && inv[0].email === 'case.person@club.test', inv.map((x) => x.email).join(', '));
  if (inv.length) { await page.evaluate((id) => revokeInvite(id), inv[0].id); await sleep(700); }
  const rv = (await auditRows('revoked', 'staff_invite')).find((a) => a.entity_id === 'case.person@club.test');
  rec('Audit (knowledge_staff-04)', 'revoking an invite is logged', !!rv, rv ? rv.entity_id : 'no entry');
  await q(`insert into public.audit_log (tenant_id, actor_email, action, entity, entity_id, detail) values ($1, 'other.staff@club.test', 'resolved', 'conversation', 'x', '{"name":"QA-FROM-ELSEWHERE"}')`, [T]);
  await page.evaluate(() => go('dash')); await sleep(300);
  await page.evaluate(() => go('staff')); await sleep(900);
  const auditTxt = await page.textContent('#auditTbl');
  rec('Staff (knowledge_staff-08)', 'opening Staff shows Activity log entries written elsewhere since login', /QA-FROM-ELSEWHERE/.test(auditTxt), /QA-FROM-ELSEWHERE/.test(auditTxt) ? 'shown' : 'missing');
} catch (e) {
  rec('Run', 'owner checks finished without a script error', false, e.message);
}
rec('Page health', 'owner session: no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');

// ---------- front desk: no Delete on members, and delMember refuses (auth_rbac-4)
const dctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); await fake.attach(dctx);
const dp = await dctx.newPage(); const dIssues = watch(dp);
try {
  await login(dp, 'qa-desk@club.test');
  await dp.evaluate(() => go('members')); await sleep(500);
  const visibleDel = await dp.locator('#memTbl button:has-text("Delete")').count();
  const [m] = await q(`select id from public.members where tenant_id=$1 order by created_at limit 1`, [T]);
  await dp.evaluate((id) => delMember(id), m.id); await sleep(600);
  const still = (await q(`select 1 from public.members where id=$1`, [m.id])).length === 1;
  const tDesk = ((await dp.locator('#toast').textContent()) || '').trim();
  rec('Members (auth_rbac-4)', 'front desk: no Delete button on members, and delete from the console is refused by the page', visibleDel === 0 && still && /Only (an owner or manager|owners and managers) can delete/.test(tDesk), `Delete buttons ${visibleDel}; member kept ${still}; toast "${tDesk}"`);
} catch (e) { rec('Run', 'front desk checks finished without a script error', false, e.message); }
rec('Page health', 'front desk session: no script errors', !dIssues.page.length, dIssues.page.join(' | ') || 'none');
await dctx.close();

// ---------- a login on two clubs keeps the chosen club after a reload; a mistyped code does not sign in (auth_rbac-11)
const [clubB] = await q(`insert into public.tenants (slug, name, branding) values ('qa-club-b', 'QA Club B', '{}'::jsonb) returning id`);
await q(`insert into public.app_admins (user_id, tenant_id, role, email, created_at) values ($1, $2, 'front_desk', 'qa-owner@club.test', now() + interval '1 minute')`, [owner.id, clubB.id]);
const mctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); await fake.attach(mctx);
const mp = await mctx.newPage(); const mIssues = watch(mp);
try {
  await mp.goto(APP + '/admin/', { waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('#email', { timeout: 30000 });
  await mp.fill('#orgCode', 'qa-club-b'); await mp.waitForFunction(() => /QA Club B/.test(document.querySelector('#orgCodeStatus').textContent), null, { timeout: 8000 }).catch(() => {});
  await mp.fill('#email', 'qa-owner@club.test'); await mp.fill('#password', 'bench-pass'); await mp.click('#authBtn');
  await mp.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(1000);
  const first = await mp.evaluate(() => ({ t: TENANT_ID, r: ROLE }));
  await mp.reload({ waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(1500);
  const after = await mp.evaluate(() => ({ t: TENANT_ID, r: ROLE }));
  rec('Login (auth_rbac-11)', 'signed in with club B\'s code, the page is still in club B after a reload', first.t === clubB.id && first.r === 'front_desk' && after.t === clubB.id && after.r === 'front_desk', `before reload ${first.t === clubB.id ? 'B' : 'A'}/${first.r}; after ${after.t === clubB.id ? 'B' : 'A'}/${after.r}`);
} catch (e) { rec('Run', 'two-club checks finished without a script error', false, e.message); }
rec('Page health', 'two-club session: no script errors', !mIssues.page.length, mIssues.page.join(' | ') || 'none');
await mctx.close();
const tctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); await fake.attach(tctx);
const tp = await tctx.newPage();
try {
  await tp.goto(APP + '/admin/', { waitUntil: 'domcontentloaded' });
  await tp.waitForSelector('#email', { timeout: 30000 });
  await tp.fill('#orgCode', 'qa-club-bb');
  await tp.fill('#email', 'qa-owner@club.test'); await tp.fill('#password', 'bench-pass'); await tp.click('#authBtn');
  await sleep(2500);
  const msg = ((await tp.textContent('#authMsg')) || '').trim();
  const inApp = await tp.isVisible('#app');
  rec('Login (auth_rbac-11)', 'a mistyped organisation code stops the sign-in with a message', /not found/.test(msg) && !inApp, `"${msg}", signed in: ${inApp}`);
} catch (e) { rec('Run', 'mistyped-code check finished without a script error', false, e.message); }
await tctx.close();

// ---------- an invite for an email that already has a login is granted at sign-in (auth_rbac-6 / knowledge_staff-02, page part).
// The database function belongs to the SQL group; this TEST-ONLY stand-in shows the page calls it before reading the roster.
await q(`create or replace function public.accept_my_invites() returns integer language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my_email text; n int := 0;
begin
  if me is null then return 0; end if;
  select u.email into my_email from auth.users u where u.id = me;
  if my_email is null then return 0; end if;
  insert into app_admins (user_id, tenant_id, role, email)
    select me, i.tenant_id, coalesce(i.role, 'staff'), my_email from app_admin_invites i where lower(i.email) = lower(my_email)
  on conflict (user_id, tenant_id) do update set role = excluded.role;
  get diagnostics n = row_count;
  delete from app_admin_invites where lower(email) = lower(my_email);
  return n;
end $$`);
await q(`delete from public.app_admins where user_id=$1 and tenant_id=$2`, [accounts.id, T]);
await q(`insert into public.app_admin_invites (tenant_id, email, role) values ($1, 'qa-accounts@club.test', 'manager')`, [T]);
const actx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); await fake.attach(actx);
const ap = await actx.newPage(); const aIssues = watch(ap);
try {
  await login(ap, 'qa-accounts@club.test');
  const r = await ap.evaluate(() => ({ t: TENANT_ID, r: ROLE }));
  const left = (await q(`select 1 from public.app_admin_invites where tenant_id=$1 and email='qa-accounts@club.test'`, [T])).length;
  rec('Invites (auth_rbac-6, page part)', 're-invited staff with an existing login get in with the invited role at sign-in', r.t === T && r.r === 'manager' && left === 0, `role ${r.r}; invites left ${left}`);
} catch (e) { rec('Invites (auth_rbac-6, page part)', 're-invited staff with an existing login get in with the invited role at sign-in', false, e.message); }
rec('Page health', 're-invited session: no script errors', !aIssues.page.length, aIssues.page.join(' | ') || 'none');
await actx.close();

rec('Bench', 'every database request was one the stand-in supports', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('Bench', 'no request went to a live (non-staging) webhook', !fake.log.webhooks.some((x) => /BLOCKED/.test(x)), [...new Set(fake.log.webhooks)].join(', ') || 'none');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`);
if (!failed.length) console.log(`All ${results.length} page_settings checks passed.`);
fake.stop(); await browser.close(); process.exit(failed.length ? 1 : 0);
