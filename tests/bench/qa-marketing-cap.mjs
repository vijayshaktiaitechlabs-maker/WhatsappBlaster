// WhatsApp's marketing limits in Campaigns: plain-language failure reasons, "Resend to the N who failed",
// the Step 3 advice and the template editor's category hint. Staging-built page on the local bench; nothing external.
import { benchDb, openBrowser, watch, login, sleep, PHONE } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).slice(0, 300)}`); };
const { q, T, users, db } = await benchDb();
const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const P2 = '919000000002', P3 = '919000000003', P4 = '919000000004', P5 = '919000000005';

try {
  // ---- a sent Marketing campaign of 5: 2 capped, 1 experiment, 1 unreachable, 1 read
  const recips = [[PHONE, 'Vijay Test', 'wamid.CAP.1'], [P2, 'Meera Shah', 'wamid.CAP.2'], [P3, 'Anil Kataria', 'wamid.CAP.3'], [P4, 'Ravi Old', 'wamid.CAP.4'], [P5, 'Neha Jesal', 'wamid.CAP.5']];
  const body = { recipients: recips.map(([phone, name, wamid]) => ({ phone, name, wamid, status: 'sent', sent_at: '2026-10-07T07:11:20Z' })), stats: { sent: 5, delivered: 1, read: 1, failed: 4 }, segment: { source: 'custom_sheet', fileName: 'Maintenance.csv' }, custom_recipients: recips.map(([phone, name], i) => ({ row_no: i + 2, phone, full_name: name, first_name: name.split(' ')[0], membership_no: 'M-' + (i + 1), wa_opt_in: true, row_cols: { Name: name, Mobile: phone, 'Member No': 'M-' + (i + 1) } })), vars: {} };
  const [{ id: B }] = await q(`insert into public.broadcasts (tenant_id, title, template_name, audience, status, body, sent_at, sent_count) values ($1,'Maintenance_Oct26','club_custom_broadcast','Sheet','sent',$2, now() - interval '1 hour', 5) returning id`, [T, JSON.stringify(body)]);
  const st = (wamid, phone, status, code, title) => q(`insert into public.wa_message_status (wamid, tenant_id, broadcast_id, phone, status, sent_at, failed_at, error_code, error_title, read_at) values ($1,$2,$3,$4,$5, now() - interval '1 hour', case when $5='failed' then now() - interval '59 minutes' end, $6, $7, case when $5='read' then now() - interval '30 minutes' end)`, [wamid, T, B, phone, status, code, title]);
  await st('wamid.CAP.1', PHONE, 'failed', 131049, 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.');
  await st('wamid.CAP.2', P2, 'failed', 131049, 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.');
  await st('wamid.CAP.3', P3, 'failed', 130472, "Failed to send message because this user's phone number is part of an experiment");
  await st('wamid.CAP.4', P4, 'failed', 131026, 'Message Undeliverable.');
  await st('wamid.CAP.5', P5, 'read', null, null);

  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => go('broadcasts')); await sleep(800);

  // ---------- A. the report explains the failures in plain words
  await page.evaluate((id) => openReport(id), B);
  const reasons = await until(() => page.evaluate(() => { const el = document.getElementById('reportReasons'); return el ? { text: el.textContent.replace(/\s+/g, ' '), groups: [...el.querySelectorAll('.report-reason')].map((x) => x.dataset.reason), btn: (document.getElementById('reportResendBtn') || {}).textContent || '' } : null; }), 10000);
  rec('the report groups the failures by what WhatsApp meant (limit, experiment, unreachable)', !!reasons && JSON.stringify(reasons.groups.slice().sort()) === JSON.stringify(['cap', 'experiment', 'unreachable']), reasons ? reasons.groups.join(',') : 'no reasons box');
  rec('the marketing-limit failures say it is WhatsApp\'s per-member limit, not the club, and what to do', !!reasons && /limit on marketing messages for this member/.test(reasons.text) && /not by the club/.test(reasons.text) && /Utility template/.test(reasons.text), reasons ? reasons.text.slice(0, 200) : '');
  rec('the experiment and unreachable failures are explained too', !!reasons && /experiment on this member/.test(reasons.text) && /not on WhatsApp, or the member has blocked/.test(reasons.text), '');
  rec('a "Resend to the 4 who failed" button is offered, pointing to a Utility template', !!reasons && /Resend to the 4 who failed/.test(reasons.btn) && /Utility template/.test(reasons.text), reasons ? reasons.btn : '');
  await page.evaluate(() => filterReportRecips('failed')); await sleep(300);
  const rowText = await t('#reportRecipTbody');
  rec('each failed row carries the plain-language reason with the code', /WhatsApp's limit on marketing messages for this member\.? \(#131049\)/.test(rowText) && /#130472/.test(rowText) && /#131026/.test(rowText), rowText.slice(0, 200));

  // ---------- B. resend: a new campaign with only the 4, on the Utility dues template
  await page.click('#reportResendBtn'); await sleep(1200);
  const re = await page.evaluate(() => ({ title: document.getElementById('cmpTitle').textContent, src: CMP.audSource, n: CMP.customRecipients.length, phones: CMP.customRecipients.map((r) => r.phone).sort(), names: CMP.customRecipients.map((r) => r.full_name), tpl: CMP.tpl, name: CMP.name, info: (document.getElementById('sheetInfoBox') || {}).textContent.replace(/\s+/g, ' '), rows: CMP.customRecipients.map((r) => r.row_cols && r.row_cols['Member No']) }));
  rec('a new campaign opens with exactly the 4 failed members and none of the delivered ones', re.src === 'sheet' && re.n === 4 && JSON.stringify(re.phones) === JSON.stringify([PHONE, P2, P3, P4].sort()) && re.names.includes('Meera Shah'), JSON.stringify(re.phones));
  rec('it starts on the Utility "Dues reminder" template, named after the original, and says why', re.tpl === 'dues_reminder' && /resend to failed/.test(re.name) && /4 member\(s\) whose message failed in “Maintenance_Oct26”/.test(re.info) && /Utility/.test(re.info), re.info.slice(0, 160));
  rec('the members\' sheet columns come along, so Excel fields can still be used', JSON.stringify(re.rows) === JSON.stringify(['M-1', 'M-2', 'M-3', 'M-4']), JSON.stringify(re.rows));
  const adviceU = await page.evaluate(() => { const a = document.querySelector('#tplAdvice [data-advice]'); return a ? { kind: a.dataset.advice, text: a.textContent.replace(/\s+/g, ' ') } : null; });
  rec('Step 3 shows the green Utility note', !!adviceU && adviceU.kind === 'utility' && /does not apply its marketing limits/.test(adviceU.text), adviceU ? adviceU.text.slice(0, 120) : '');

  // ---------- C. the Marketing warning with the club's own numbers, and the one-click switch
  await page.evaluate(() => pickTpl('club_custom_broadcast')); await sleep(300);
  const adviceM = await page.evaluate(() => { const a = document.querySelector('#tplAdvice [data-advice]'); return a ? { kind: a.dataset.advice, text: a.textContent.replace(/\s+/g, ' '), btn: !!document.getElementById('tplUseUtility') } : null; });
  rec('a Marketing template shows the warning with this club\'s last campaign: 4 of 9 failed', !!adviceM && adviceM.kind === 'marketing' && /blocks these for many members/.test(adviceM.text) && /“Maintenance_Oct26”/.test(adviceM.text) && /4 of 9/.test(adviceM.text) && adviceM.btn, adviceM ? adviceM.text.slice(0, 220) : '');
  await page.evaluate(() => setVarText('2', 'Your maintenance dues of Rs 29,500 are pending. Please pay by 31 October.')); await sleep(300);
  const adviceM2 = await t('#tplAdvice');
  rec('typing a dues message into a Marketing template says it reads like an account notice', /reads like an account notice/.test(adviceM2), adviceM2.slice(0, 160));
  await page.click('#tplUseUtility'); await sleep(300);
  rec('the button switches the campaign to the Utility template', (await page.evaluate(() => CMP.tpl)) === 'dues_reminder', await page.evaluate(() => CMP.tpl));
  await page.evaluate(() => { setVarText('4', 'Limited-time 10% discount if you pay early!'); }); await sleep(300);
  rec('offer words in a Utility template get the "Meta may treat it as Marketing" warning', /may treat it as Marketing/.test(await t('#tplAdvice')), (await t('#tplAdvice')).slice(0, 160));

  // ---------- D. the template editor's category hint
  await page.evaluate(() => { if (CT_EDIT) CT_EDIT._snap = null; ctNew(); }); await sleep(300);
  await page.fill('#ct_name', 'Maintenance notice');
  await page.fill('#ct_body', 'Your annual maintenance charges of {{2}} are pending. Please pay by {{3}}.'); await sleep(300);
  const hintM = await t('#ctCatHint');
  rec('editor: dues wording with Marketing selected says to choose Utility', /reads like an account notice/.test(hintM) && /Choose Utility/.test(hintM), hintM.slice(0, 160));
  await page.selectOption('#ct_cat', 'UTILITY'); await sleep(300);
  rec('editor: Utility with account wording gets the calm note', /Not subject to WhatsApp/.test(await t('#ctCatHint')), (await t('#ctCatHint')).slice(0, 120));
  await page.fill('#ct_body', 'Exclusive offer: 10% discount on early payment of {{2}}.'); await sleep(300);
  rec('editor: offer wording with Utility selected warns that Meta will make it Marketing', /approve it as Marketing/.test(await t('#ctCatHint')), (await t('#ctCatHint')).slice(0, 160));
  await page.evaluate(() => { if (CT_EDIT) CT_EDIT._snap = null; ctLeaveEditor(); });
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('no live webhook was called', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} marketing-limit checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
