// QA regression checks for the Members and Payments & Dues pages (group page_members), on the local bench:
// the staging-built admin page in Edge (India time), real SQL + RLS in PGlite, Broadcast Send run locally.
//   node tests/bench/qa-page_members.mjs        (after node tools/build-staging.mjs)
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const OUT = fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (area, test, ok, evidence = '') => { results.push({ area, test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(evidence).slice(0, 260)}`); };
const { db, q, T, users } = await benchDb();
const TZ = 'Asia/Kolkata';
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusYear = (d) => { const [y, m, dd] = d.split('-'); return `${Number(y) + 1}-${m}-${dd}`; };
const mem = async (name) => (await q(`select * from public.members where tenant_id=$1 and full_name=$2`, [T, name]))[0];
const dstr = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null);

// ---- seed: 2,500 members with the SAME created_at (paging), 3,100 payments (5 for Aarav, older), export edge cases
await q(`insert into public.members (tenant_id, full_name, phone, status, wa_opt_in, dues_amount, guest_passes_remaining, created_at)
  select $1, 'Bulk ' || g, '9188' || lpad(g::text, 8, '0'), 'active', false, 0, 0, now() - interval '400 days' from generate_series(1, 2500) g`, [T]);
const aarav = await mem('Aarav Mehta (Test)');
await q(`insert into public.payments (tenant_id, member_id, amount, method, purpose, receipt_no, paid_at, created_by)
  select $1, case when g <= 5 then $2::uuid else null end, 100, 'cash', 'cafe', 'QA-' || g, now() - interval '200 days' - make_interval(mins => g), 'seed' from generate_series(1, 3100) g`, [T, aarav.id]);
await q(`insert into public.members (tenant_id, full_name, phone, status, wa_opt_in) values ($1, '=HYPERLINK("http://example.invalid","x")', '919000000210', 'active', false), ($1, 'રમેશ પટેલ', '919000000211', 'active', false)`, [T]);
const [{ n: dbMembers }] = await q(`select count(*)::int n from public.members where tenant_id=$1`, [T]);
const [{ n: dbPays }] = await q(`select count(*)::int n from public.payments where tenant_id=$1`, [T]);

const { browser, context, fake: fk } = await openBrowser(db, users, { context: { timezoneId: TZ } });
await context.close();
// one browser context per staff login (India time), all answered by the same local Supabase
async function newPage(email, viewport = { width: 1440, height: 950 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, timezoneId: TZ });
  await fk.attach(ctx);
  const page = await ctx.newPage();
  const issues = watch(page);
  await login(page, email);
  return { ctx, page, issues };
}
const savePay = async () => { await page.evaluate(() => $('#receiptModal').classList.add('hidden')); await page.click('#paySave'); await page.waitForFunction(() => !$('#receiptModal').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {}); await sleep(200); };
const toastOf = async (page) => ((await page.locator('#toast').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
async function download(page, fn) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(fn)]);
  const p = await dl.path(); return readFileSync(p);
}

let page;
try {
  // ================= front desk logs in FIRST and keeps the page open (stale copy of the members)
  const desk = await newPage('qa-desk@club.test');
  let s = await desk.page.evaluate(() => ({ pays: PAYMENTS.length, delBtns: document.querySelectorAll('#memTbl button.danger').length, has: HAS.payments }));
  rec('Roles: front desk', 'no payment rows are downloaded (money is for owner, manager, accounts) [payments_dues-05 page part]', s.pays === 0 && s.has === true, JSON.stringify(s));
  rec('Roles: front desk', 'no Delete button on the member list [members-01]', s.delBtns === 0, `${s.delBtns} delete buttons`);
  const diya = await mem('Diya Sharma (Test)');
  await desk.page.evaluate((id) => delMember(id), diya.id); await sleep(400);
  rec('Roles: front desk', 'delMember() refuses for front desk; the member stays [members-01]', !!(await mem('Diya Sharma (Test)')) && /Only owners and managers/.test(await toastOf(desk.page)), await toastOf(desk.page));
  const deskCsv = (await download(desk.page, () => exportCsv('members'))).toString('utf8');
  rec('Roles: front desk', 'members Export CSV has no dues column for front desk [members-12]', !/dues_amount/.test(deskCsv.split('\n')[0]) && deskCsv.length > 100, deskCsv.split('\n')[0]);
  s = await desk.page.evaluate(() => { _importHeaders = ['Name', 'Phone', 'Dues']; _importParsedRows = [['Desk Import', '9825000001', '500']]; _importRowNos = [2]; setupColumnMapping('x.csv', 1); const r = buildImportRecords(); return { hidden: $('#map_dues').parentElement.style.display === 'none', sendsDues: 'dues_amount' in r.records[0].rec }; });
  rec('Roles: front desk', 'Import hides the Dues column and never sends dues for front desk [members-12]', s.hidden && !s.sendsDues, JSON.stringify(s));

  // ================= owner
  const own = await newPage('qa-owner@club.test');
  page = own.page;
  s = await page.evaluate(() => ({ n: MEMBERS.length, uniq: new Set(MEMBERS.map((m) => m.id)).size }));
  rec('Members', 'more than 1,000 members with the same created_at: each loaded exactly once [members-04]', s.n === dbMembers && s.uniq === dbMembers, `${s.n} loaded, ${s.uniq} distinct, ${dbMembers} in the database`);
  s = await page.evaluate((id) => ({ n: PAYMENTS.length, uniq: new Set(PAYMENTS.map((p) => p.id)).size, aarav: paymentsForMember(id).length }), aarav.id);
  rec('Payments', 'every payment is loaded (no 3,000 cap); older payments show in the member profile [payments_dues-07]', s.n === dbPays && s.uniq === dbPays && s.aarav === 5, `${s.n} of ${dbPays} loaded; Aarav ${s.aarav}`);
  const payCsv = (await download(page, () => exportCsv('payments'))).toString('utf8');
  rec('Payments', 'Export CSV contains every payment [payments_dues-07]', payCsv.trim().split('\n').length - 1 === dbPays, `${payCsv.trim().split('\n').length - 1} lines`);
  const memBuf = await download(page, () => exportCsv('members'));
  const memCsv = memBuf.toString('utf8');
  rec('Export', 'CSV starts with a UTF-8 BOM; Gujarati name intact [payments_dues-12, members-13]', memBuf[0] === 0xef && memBuf[1] === 0xbb && memBuf[2] === 0xbf && memCsv.includes('રમેશ પટેલ'), memBuf.subarray(0, 3).toString('hex'));
  const fline = memCsv.split('\n').find((l) => l.includes('HYPERLINK')) || '';
  rec('Export', 'a cell starting with "=" is neutralised; phone numbers unchanged [payments_dues-12, members-13]', fline.startsWith(`"'=HYPERLINK`) && /,919000000210,/.test(fline), fline.slice(0, 80));
  s = await page.evaluate(async () => { MEMBERS_SAVE = MEMBERS; MEMBERS = []; await loadErpTables(); const r = HAS.duesCol; MEMBERS = MEMBERS_SAVE; return r; }).catch((e) => String(e));
  rec('Members', 'Dues / Flag / Notes are available even when the club has no members yet [members-17]', s === true, String(s));

  // ---- member form: negative values, phone format, duplicates, audit ids, tier filter
  await page.evaluate(() => go('members'));
  const [{ n: before1 }] = await q(`select count(*)::int n from public.members where tenant_id=$1`, [T]);
  const fillNew = async (vals) => { await page.evaluate(() => openMember()); await sleep(200); for (const [k, v] of Object.entries(vals)) await page.fill('#f_' + k, String(v)); await page.evaluate(() => saveMember()); await sleep(700); return toastOf(page); };
  let t1 = await fillNew({ full_name: 'Neg Dues', phone: '9825099001', dues_amount: -5000 });
  let t2 = await fillNew({ full_name: 'Neg Passes', phone: '9825099002', guest_passes_remaining: -3 });
  const [{ n: after1 }] = await q(`select count(*)::int n from public.members where tenant_id=$1`, [T]);
  rec('Members', 'negative dues and negative guest passes are refused [payments_dues-13, members-14]', after1 === before1 && /negative/.test(t1) && /Guest passes/.test(t2), `${t1} / ${t2}`);
  await fillNew({ full_name: 'Phone Format', phone: '+91 98765 00003', membership_tier: 'Diamond' });
  const pf = await mem('Phone Format');
  rec('Members', 'a phone typed as "+91 98765 00003" is stored as 919876500003 (the bot finds the member) [members-09]', pf && pf.phone === '919876500003', pf && pf.phone);
  const aud = await q(`select entity_id from public.audit_log where tenant_id=$1 and action='created' and entity='member' order by created_at desc limit 1`, [T]);
  rec('Audit', 'a new member is recorded with its real id [members-11]', aud[0] && pf && aud[0].entity_id === pf.id, aud[0] && aud[0].entity_id);
  s = await page.evaluate(() => [...document.querySelectorAll('#mTier option')].map((o) => o.value));
  rec('Members', 'the Tier filter offers a new tier without a reload [members-16]', s.includes('Diamond'), s.join(', '));
  t1 = await fillNew({ full_name: 'Phone Dup', phone: '98765 00003' });
  rec('Members', 'the same number in another format is refused, naming the member [members-09, members-15]', !(await mem('Phone Dup')) && /already belongs to Phone Format/.test(t1), t1);
  const dlg0 = own.issues.dialogs.length;
  await fillNew({ full_name: 'No Dup', phone: '9825099003', membership_no: 'tst-101' });
  rec('Members', 'a duplicate member no. asks first, naming who has it [members-15]', own.issues.dialogs.slice(dlg0).some((d) => /TST-101|tst-101/.test(d) && /Aarav/.test(d)), own.issues.dialogs.slice(dlg0).join(' | ').slice(0, 160));

  // ---- outstanding ignores negative dues already stored
  await q(`update public.members set dues_amount=-2500 where tenant_id=$1 and full_name='Kabir Patel (Test)'`, [T]);
  await page.evaluate(() => refresh(['members'])); await sleep(500);
  const [{ s: posSum }] = await q(`select coalesce(sum(dues_amount) filter (where dues_amount > 0),0)::float s from public.members where tenant_id=$1`, [T]);
  s = await page.evaluate(() => outstandingTotal());
  rec('Payments', 'Outstanding counts only amounts owed (a negative dues row does not lower it) [payments_dues-13]', Math.abs(s - posSum) < 0.01, `page ${s}, positive dues ${posSum}`);

  // ---- payments
  await page.evaluate(() => go('payments')); await sleep(300);
  const tp = await mem('Test Phone 1');
  await page.evaluate((id) => openPayment(id), tp.id); await sleep(300);
  s = await page.evaluate(() => ({ amt: $('#pay_amount').value, purpose: $('#pay_purpose').value, clear: $('#pay_clear').checked, till: $('#pay_paid_till').value }));
  const expTill = plusYear(istToday());
  rec('Payments', 'Record on an overdue member pre-fills the dues, For=Dues and a new paid-till date (today + 1 year) [payments_dues-02]', s.amt === '1500' && s.purpose === 'dues' && !s.clear && s.till === expTill, JSON.stringify(s));
  await savePay();
  let m1 = await mem('Test Phone 1');
  s = await page.evaluate((id) => ({ due: isDue(MEMBERS.find((m) => m.id === id)), listed: [...document.querySelectorAll('#payTbl tbody tr')].some((r) => /Test Phone 1/.test(r.textContent)) }), tp.id);
  rec('Payments', 'after the payment the member is paid: dues 0, paid-till moved, not Overdue, not in the dues list [payments_dues-02]', Number(m1.dues_amount) === 0 && dstr(m1.maintenance_paid_till) === expTill && !s.due && !s.listed, `dues ${m1.dues_amount}, paid till ${dstr(m1.maintenance_paid_till)}, ${JSON.stringify(s)}`);
  const rcp = await page.locator('#receiptBody').textContent();
  const [lastPay] = await q(`select receipt_no from public.payments where tenant_id=$1 order by created_at desc limit 1`, [T]);
  rec('Payments', 'receipt numbers come from date and time to the millisecond (no 27.8-hour repeat) [payments_dues-06 page part]', /^R\d{6}-\d{9}$/.test(lastPay.receipt_no) && rcp.includes(lastPay.receipt_no), lastPay.receipt_no);

  const an = await mem('Ananya Iyer (Test)');
  await page.evaluate((id) => openPayment(id), an.id); await sleep(300);
  await page.fill('#pay_amount', '5000'); await sleep(100);
  s = await page.evaluate(() => ({ clear: $('#pay_clear').checked, shown: getComputedStyle($('#payClearWrap')).display !== 'none', info: $('#payDuesInfo').textContent, till: $('#pay_paid_till').value }));
  await savePay();
  m1 = await mem('Ananya Iyer (Test)');
  const aAud = (await q(`select detail from public.audit_log where tenant_id=$1 and action='paid' order by created_at desc limit 1`, [T]))[0];
  rec('Payments', 'a partial payment (5,000 of 12,000) leaves 7,000 owing by default; write-off is an unticked option [payments_dues-03]', Number(m1.dues_amount) === 7000 && !s.clear && s.shown && /7,000/.test(s.info) && dstr(m1.maintenance_paid_till) === dstr(an.maintenance_paid_till), `dues ${m1.dues_amount}; ${s.info}`);
  rec('Audit', 'the payment audit keeps the old and new dues [payments_dues-03]', aAud && aAud.detail.dues_before === 12000 && aAud.detail.dues_after === 7000, JSON.stringify(aAud && aAud.detail).slice(0, 160));

  const viv = await mem('Vivaan Joshi (Test)'), roh = await mem('Rohan Desai (Test)');
  await page.evaluate((id) => openPayment(id), viv.id); await sleep(300);
  await page.selectOption('#payMember', roh.id); await page.waitForFunction(() => $('#pay_amount').value === '8000', null, { timeout: 5000 }).catch(() => {}); await sleep(300);
  s = await page.evaluate(() => ({ amt: $('#pay_amount').value, purpose: $('#pay_purpose').value }));
  await savePay();
  const roh2 = await mem('Rohan Desai (Test)'), viv2 = await mem('Vivaan Joshi (Test)');
  rec('Payments', 'changing the Member re-applies that member\'s amount; only the chosen member\'s dues change [payments_dues-04]', s.amt === '8000' && Number(roh2.dues_amount) === 0 && Number(viv2.dues_amount) === 4500, `amount ${s.amt}; Rohan ${roh2.dues_amount}, Vivaan ${viv2.dues_amount}`);
  await page.evaluate(() => openPayment()); await sleep(300);
  await page.selectOption('#payMember', diya.id); await page.waitForFunction(() => $('#pay_amount').value === '29500', null, { timeout: 5000 }).catch(() => {}); await sleep(300);
  s = await page.evaluate(() => $('#pay_amount').value);
  await savePay();
  const diya2 = await mem('Diya Sharma (Test)');
  rec('Payments', 'header "Record payment" then picking a member with dues: paying it all clears the dues [payments_dues-04]', s === '29500' && Number(diya2.dues_amount) === 0, `amount ${s}; Diya dues ${diya2.dues_amount}`);

  await page.evaluate(() => openPayment()); await sleep(200);
  await page.fill('#pay_amount', '1500.5'); await page.selectOption('#pay_purpose', 'cafe');
  await savePay();
  const rtxt = ((await page.locator('#receiptBody').textContent()) || '').replace(/\s+/g, ' ');
  rec('Payments', 'a 1,500.50 payment prints as ₹1,500.50 on the receipt [payments_dues-11]', /₹1,500\.50/.test(rtxt), rtxt.slice(rtxt.indexOf('Amount paid'), rtxt.indexOf('Amount paid') + 30));

  // members PATCH fails -> staff are told
  await page.route('**/rest/v1/members?**', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"simulated failure"}' }) : route.fallback());
  await page.evaluate((id) => openPayment(id), viv.id); await sleep(300);
  await savePay();
  const failToast = await toastOf(page);
  await page.unroute('**/rest/v1/members?**');
  rec('Payments', 'if updating the dues fails, staff are told (not "Payment recorded ✓") [payments_dues-10]', /NOT updated/.test(failToast) && Number((await mem('Vivaan Joshi (Test)')).dues_amount) === 4500, failToast);

  // ---- dues reminders: double click, audit, other club
  await page.evaluate(() => { closeModal(); go('payments'); }); await sleep(300);
  const d0 = own.issues.dialogs.length, w0 = fk.log.webhooks.filter((w) => /broadcast-send/.test(w)).length;
  const a0 = (await q(`select count(*)::int n from public.audit_log where tenant_id=$1 and entity='dues_reminder'`, [T]))[0].n;
  await page.dblclick('#duesSendBtn');
  await page.waitForFunction(() => /Sent to|Not sent|No opted-in/.test($('#duesInfo').textContent) && !$('#duesSendBtn').disabled, null, { timeout: 30000 }).catch(() => {});
  await sleep(500);
  const dlg = own.issues.dialogs.slice(d0), calls = fk.log.webhooks.filter((w) => /broadcast-send/.test(w)).length - w0;
  const a1 = (await q(`select count(*)::int n from public.audit_log where tenant_id=$1 and entity='dues_reminder'`, [T]))[0].n;
  rec('Dues reminders', 'double-clicking "Send reminders" asks once and sends once [payments_dues-08]', dlg.length === 1 && calls === 2, `${dlg.length} confirm(s), ${calls} webhook calls; ${await page.locator('#duesInfo').textContent()}`);
  rec('Audit', 'sending dues reminders records who sent them [payments_dues-16]', a1 === a0 + 1, `${a1 - a0} audit row(s)`);
  const d1 = own.issues.dialogs.length, w1 = fk.log.webhooks.filter((w) => /broadcast-send/.test(w)).length;
  s = await page.evaluate(async () => { const keep = TENANT_INFO.name; TENANT_INFO.name = 'QA Other Club'; try { await previewDues(); const pv = $('#duesInfo').textContent; await sendDues(); return { pv, after: $('#duesInfo').textContent }; } finally { TENANT_INFO.name = keep; } });
  rec('Dues reminders', 'on another club\'s page the preview and send refuse (Broadcast Send serves one club) [payments_dues-09 page part]', /not available for QA Other Club/.test(s.pv) && /not available/.test(s.after) && own.issues.dialogs.length === d1 && fk.log.webhooks.filter((w) => /broadcast-send/.test(w)).length - w1 === 2, JSON.stringify(s).slice(0, 200));

  // ---- phone width
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(400);
  await page.evaluate(() => go('payments')); await sleep(500);
  s = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
  rec('Layout', 'Payments & Dues fits a 390 px phone (no sideways scroll) [payments_dues-17]', s.doc <= 390, JSON.stringify(s));
  await page.screenshot({ path: OUT + 'qa-members-phone-payments.png' });
  await page.setViewportSize({ width: 1440, height: 950 }); await sleep(300);

  // ---- import mapping
  s = await page.evaluate(() => {
    const map = (h) => { _importHeaders = h; _importParsedRows = [h.map(() => '')]; _importRowNos = [2]; setupColumnMapping('m.csv', 1); const o = {}; ['map_name', 'map_phone', 'map_id', 'map_dues'].forEach((id) => { const v = $('#' + id).value; o[id] = v === '' ? '' : h[Number(v)]; }); return o; };
    return [map(['Member No', 'Name', 'Mobile', 'Amount Paid', 'Balance']), map(['Contact Name', 'Mobile Number', 'Email'])];
  });
  rec('Import', 'column auto-mapping: Name→Name, Dues→Balance, Phone→Mobile Number [members-18]', s[0].map_name === 'Name' && s[0].map_dues === 'Balance' && s[0].map_id === 'Member No' && s[0].map_phone === 'Mobile' && s[1].map_name === 'Contact Name' && s[1].map_phone === 'Mobile Number', JSON.stringify(s));

  // ---- import a UTF-8 CSV (no BOM) with good and bad rows
  const csv = ['Member No,Name,Mobile,Amount Paid,Balance,Paid Till',
    'QA-1,રમેશ પટેલ,098250 11112,100,"Rs. 1,500",31/03/2026',
    'QA-2,राहुल शर्मा,+91 98250 11113,0,Rs.2500/-,05/04/2026',
    'QA-3,Zoë Fernandes,9825011114,0,"₹ 4,999.50",31-Mar-2026',
    'QA-4,Dup Of Diya,910000000002,0,0,01/12/2026',
    'QA-5,Bad Phone,12345,0,0,',
    'QA-6,Bad Date,9825011116,0,0,31/13/2026',
    'QA-7,Same Phone,98250 11113,0,0,',
    'QA-8,Bad Dues,9825011118,0,abc,',
    'QA-9,Good One,9825011119,0,"1,50,000",2026-08-15',
    'QA-10,Month Name,9825011120,0,0,31 March 2026'].join('\n');
  await page.evaluate(() => { go('members'); openImportModal(); });
  await page.setInputFiles('#importFile', { name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await sleep(800);
  const check = await page.locator('#importCheck').textContent();
  await page.click('#btnExecuteImport');
  await page.waitForFunction(() => !$('#importDoneActions').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
  const status = await page.locator('#importStatusSub').textContent();
  const skippedTxt = (await page.evaluate(() => [...document.querySelectorAll('#importSkipped tr')].map((tr) => [...tr.cells].map((c) => c.textContent).join(' | ')).join(' || '))).replace(/\s+/g, ' ');
  const got = Object.fromEntries((await q(`select membership_no, full_name, phone, dues_amount::float d, maintenance_paid_till from public.members where tenant_id=$1 and membership_no like 'QA-%'`, [T])).map((r) => [r.membership_no, { n: r.full_name, p: r.phone, d: r.d, t: dstr(r.maintenance_paid_till) }]));
  rec('Import', 'good rows are imported, bad rows skipped and listed with row number and reason [members-05]', Object.keys(got).sort().join(',') === 'QA-1,QA-10,QA-2,QA-3,QA-9' && /5 contact\(s\) imported, 5 row\(s\) skipped/.test(status) && /Row 5 .*already belongs to Diya/.test(skippedTxt) && /Row 6 .*phone not valid/.test(skippedTxt) && /Row 7 .*date/.test(skippedTxt) && /Row 8 .*same phone as row 3/.test(skippedTxt) && /Row 9 .*dues not a number/.test(skippedTxt), `${status} | ${skippedTxt.slice(0, 200)} | check: ${check}`);
  rec('Import', 'dues "Rs. 1,500" → 1500, "Rs.2500/-" → 2500, "₹ 4,999.50" → 4999.5, "1,50,000" → 150000 [members-07]', got['QA-1']?.d === 1500 && got['QA-2']?.d === 2500 && got['QA-3']?.d === 4999.5 && got['QA-9']?.d === 150000, JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.d]))));
  rec('Import', 'DD/MM/YYYY, 31-Mar-2026, 31 March 2026 and YYYY-MM-DD are stored as that exact day [members-06]', got['QA-1']?.t === '2026-03-31' && got['QA-2']?.t === '2026-04-05' && got['QA-3']?.t === '2026-03-31' && got['QA-9']?.t === '2026-08-15' && got['QA-10']?.t === '2026-03-31', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.t]))));
  rec('Import', 'Gujarati / Hindi / accented names from a UTF-8 CSV without BOM are stored as written [members-08]', got['QA-1']?.n === 'રમેશ પટેલ' && got['QA-2']?.n === 'राहुल शर्मा' && got['QA-3']?.n === 'Zoë Fernandes', [got['QA-1']?.n, got['QA-2']?.n, got['QA-3']?.n].join(' / '));
  rec('Import', 'phones are stored in one format (leading 0 / +91 / spaces → 91 + 10 digits); invalid numbers refused [members-09]', got['QA-1']?.p === '919825011112' && got['QA-2']?.p === '919825011113', `${got['QA-1']?.p}, ${got['QA-2']?.p}`);

  // ---- import an .xlsx with real Excel date cells (India time)
  const xl = await page.evaluate(async () => {
    const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Phone', 'Paid Till'], ['Excel One', '9825022001', 0], ['Excel Two', '9825022002', 0]]);
    ws.C2 = { t: 'n', v: serial(2026, 3, 31), z: 'dd/mm/yyyy' }; ws.C3 = { t: 'n', v: serial(2027, 1, 1), z: 'dd/mm/yyyy' };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    resetImport(); showModal('m_import_contacts');
    processImportFile(new File([buf], 'dates.xlsx'));
    await new Promise((r) => setTimeout(r, 800));
    await executeImport();
    return $('#importStatusSub').textContent;
  });
  const x1 = await mem('Excel One'), x2 = await mem('Excel Two');
  rec('Import', 'Excel date cells 31/03/2026 and 01/01/2027 are stored as that day in India time (not a day early) [members-06]', x1 && dstr(x1.maintenance_paid_till) === '2026-03-31' && x2 && dstr(x2.maintenance_paid_till) === '2027-01-01', `${x1 && dstr(x1.maintenance_paid_till)}, ${x2 && dstr(x2.maintenance_paid_till)}; ${xl}`);
  await page.evaluate(() => closeModal());

  // ---- delete as owner: clear confirm text, audit row
  const d2 = own.issues.dialogs.length;
  await page.evaluate(() => refresh(['members', 'payments'])); await sleep(600);
  await page.evaluate((id) => delMember(id), aarav.id); await sleep(800);
  const delDlg = own.issues.dialogs.slice(d2).join(' | ');
  const delAud = await q(`select actor_email, detail from public.audit_log where tenant_id=$1 and action='deleted' and entity='member' and entity_id=$2`, [T, aarav.id]);
  rec('Members', 'deleting a member with payments warns that receipts will show "Walk-in" and suggests "expired"; registrations wording is right [members-10]', /5 payment\(s\)/.test(delDlg) && /Walk-in/.test(delDlg) && /expired/.test(delDlg) && !/removes their .* & registrations/.test(delDlg), delDlg.slice(0, 200));
  rec('Audit', 'a member deletion is recorded with who and which member [members-11]', delAud.length === 1 && delAud[0].actor_email === 'qa-owner@club.test' && delAud[0].detail.name === 'Aarav Mehta (Test)', JSON.stringify(delAud).slice(0, 160));

  // ================= front desk (page loaded before the owner's changes) edits Diya's email
  await q(`update public.members set guest_passes_remaining=5 where id=$1`, [diya.id]);
  await desk.page.evaluate((id) => openMember(id), diya.id); await sleep(300);
  await desk.page.fill('#f_email', 'diya.new@example.com');
  await desk.page.evaluate(() => saveMember()); await sleep(800);
  const diya3 = await mem('Diya Sharma (Test)');
  rec('Members', 'front desk (page opened before the payment) edits Diya\'s email: dues stay 0, guest passes stay 5 [members-03]', diya3.email === 'diya.new@example.com' && Number(diya3.dues_amount) === 0 && diya3.guest_passes_remaining === 5, `email ${diya3.email}, dues ${diya3.dues_amount}, passes ${diya3.guest_passes_remaining}`);

  // ================= accounts
  const acc = await newPage('qa-accounts@club.test');
  await acc.page.evaluate(() => go('payments')); await sleep(400);
  s = await acc.page.evaluate(() => ({ send: !!$('#duesSendBtn').offsetParent, preview: !![...document.querySelectorAll('#duesCard button')].find((b) => /Preview/.test(b.textContent) && b.offsetParent), pays: PAYMENTS.length }));
  await acc.page.evaluate(() => go('members')); await sleep(300);
  const accDel = await acc.page.evaluate(() => document.querySelectorAll('#memTbl button.danger').length);
  rec('Roles: accounts', '"Send reminders" is hidden for accounts (Preview stays); payments are loaded [payments_dues-14]', !s.send && s.preview && s.pays > 3000, JSON.stringify(s));
  rec('Roles: accounts', 'no Delete button on the member list for accounts [members-01]', accDel === 0, `${accDel} delete buttons`);

  const pageErrors = [...desk.issues.page, ...own.issues.page, ...acc.issues.page];
  rec('Page', 'no script errors on the page', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  rec('Bench', 'run completed', false, e.stack || e.message);
} finally {
  await browser.close().catch(() => {});
  fk.stop && fk.stop();
}
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails} of ${results.length} checks passed${fails ? `, ${fails} FAILED` : ''}.`);
console.log(fails ? 'qa-page_members: FAILED' : 'qa-page_members: all checks passed');
process.exit(fails ? 1 : 0);
