// "＋ Insert a field…" in the campaign composer: typed text and per-recipient fields in ONE template blank.
// Staging-built page in Edge on the local bench, real workflow code, simulated Meta; nothing external is called.
//   1. the picker is offered only for "Custom text" blanks and lists Excel columns and name fields (not "Custom" / "Nothing")
//   2. a field is inserted at the cursor (middle of a sentence) and at the end; typing continues after it
//   3. the live preview shows row 1's own values, never a {{…}} left over
//   4. sending a sheet: every recipient's message carries THEIR values in the same sentence
//   5. a one-line blank has the picker too
//   6. CRM audience: member fields (name, member no.) can be inserted and are filled per member by the server
//   7. a sheet header with awkward characters (quote, <, &) can be inserted and is filled
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';
import { cfg } from './harness.mjs';

const P1 = String(cfg.testPhones[0]).replace(/\D/g, ''), P2 = String(cfg.testPhones[1]).replace(/\D/g, '');
const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).slice(0, 300)}`); };
const { q, T, users, db } = await benchDb();
const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const waitFor = async (fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const outboxFrom = async (id) => q(`select id, phone, payload from public.stg_outbox where kind='meta_message' and id > $1 order by id`, [id]);
const lastOutbox = async () => Number((await q(`select coalesce(max(id),0)::int n from public.stg_outbox`))[0].n);
const paramsOf = (row) => { const c = (((row.payload || {}).template || {}).components || []).find((x) => x.type === 'body'); return ((c && c.parameters) || []).map((p) => String(p.text)); };
const picker = (k) => page.locator(`.var-insert[onchange*="insertToken('${k}'"]`);
const box = (k) => page.locator(`[data-vk="${k}"]`);
const varText = (k) => page.evaluate((key) => (CMP.vars[key] || {}).text || '', k);

try {
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(600);
  await page.evaluate(() => setAudSource('sheet')); await sleep(200);
  const HDR = 'Name,Mobile,FCM No.,Member No,Maintenance,"Due ""Amt"" <&>"';
  await page.setInputFiles('#sheetFile', { name: 'fields.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`${HDR}\nAnil Kataria,${P1},FCM000,SSC-101,"₹29,500",₹500\nMeera Shah,${P2},FCM017,SSC-202,"₹12,000",₹900\n`) }); await sleep(1200);
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarText('2', '2026-27'); setVarSrc('3', 'col:Maintenance'); setVarSrc('5', 'nothing'); setVarSrc('6', 'nothing'); }); await sleep(400);

  // ---------- 1. where the picker is offered, and what it lists
  const offered = await page.evaluate(() => ({
    custom: !!document.querySelector(`.var-insert[onchange*="insertToken('4'"]`),
    mapped: !!document.querySelector(`.var-insert[onchange*="insertToken('3'"]`),
    nothing: !!document.querySelector(`.var-insert[onchange*="insertToken('5'"]`),
    opts: [...document.querySelectorAll(`.var-insert[onchange*="insertToken('4'"] option`)].map((o) => o.value),
  }));
  rec('the picker is offered on a "Custom text" blank only, and lists the Excel columns and name fields (not "Custom" or "Nothing")',
    offered.custom && !offered.mapped && !offered.nothing && offered.opts.includes('col:FCM No.') && offered.opts.includes('col:Member No') && offered.opts.includes('first_name') && !offered.opts.includes('custom') && !offered.opts.includes('nothing'),
    JSON.stringify(offered.opts));

  // ---------- 2. insert in the middle of a sentence, then at the end, then keep typing
  await box('4').click();
  await box('4').fill('Your membership  is over, please pay ');
  await page.evaluate(() => { const el = document.querySelector('[data-vk="4"]'); el.focus(); el.setSelectionRange(16, 16); });   /* cursor between the two spaces */
  await picker('4').selectOption('col:Member No'); await sleep(250);
  const afterMiddle = await varText('4');
  await page.evaluate(() => { const el = document.querySelector('[data-vk="4"]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await picker('4').selectOption('col:FCM No.'); await sleep(250);
  const focusedBox = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-vk'));
  await page.keyboard.type(' today.'); await sleep(250);
  const sentence = await varText('4');
  rec('a field goes in at the cursor in the middle of the sentence', afterMiddle === 'Your membership {{col:Member No}} is over, please pay ', afterMiddle);
  rec('a second field goes at the end, the cursor returns to the box and typing continues the sentence',
    sentence === 'Your membership {{col:Member No}} is over, please pay {{col:FCM No.}} today.' && focusedBox === '4', `focus on blank ${focusedBox}: ${sentence}`);
  rec('the picker goes back to "Insert a field" after each use', (await picker('4').inputValue()) === '', await picker('4').inputValue());

  // ---------- 5. a one-line blank
  await box('2').click(); await box('2').fill('Year ');
  await picker('2').selectOption('col:Member No'); await sleep(250);
  const oneLine = await varText('2');
  rec('a one-line blank has the picker too', oneLine === 'Year {{col:Member No}}', oneLine);
  await box('2').fill('2026-27'); await sleep(200);

  // ---------- 7. an awkward header
  const awkward = offered.opts.find((o) => /Due "Amt"/.test(o)) || '';
  await page.evaluate(() => { setVarSrc('5', 'custom'); }); await sleep(250);
  await box('5').click(); await box('5').fill('Balance: ');
  if (awkward) { await picker('5').selectOption(awkward); await sleep(250); }
  const awkText = await varText('5');

  // ---------- 3. preview
  await sleep(400);
  const preview = await t('#waBubble');
  rec('the preview shows row 1\'s own values in the sentence and no {{…}} is left',
    /Your membership SSC-101 is over, please pay FCM000 today\./.test(preview) && /Hi Anil/.test(preview) && !/\{\{/.test(preview), preview.slice(preview.indexOf('Hi '), preview.indexOf('Hi ') + 230));
  rec('a header with quotes and < & can be inserted and shows its value in the preview', !!awkward && awkText === `Balance: {{${awkward}}}` && /Balance: ₹500/.test(preview), `${awkText} -> ${(preview.match(/Balance: \S+/) || [''])[0]}`);

  // ---------- 4. send the sheet
  const o0 = await lastOutbox();
  await page.fill('#c_name', 'QA insert field sheet');
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 60000);
  const res = await t('#cmpResult');
  const sent = await outboxFrom(o0);
  const m1 = sent.find((r) => String(r.phone).endsWith(P1.slice(-10))), m2 = sent.find((r) => String(r.phone).endsWith(P2.slice(-10)));
  const a1 = m1 ? paramsOf(m1) : [], a2 = m2 ? paramsOf(m2) : [];
  rec('both rows were sent', /Sent to 2 of 2/.test(res) && !!m1 && !!m2, res);
  rec('row 1 gets its own member no. and FCM no. inside the sentence', a1[3] === 'Your membership SSC-101 is over, please pay FCM000 today.' && a1[0] === 'Anil' && a1[2] === '₹29,500' && a1[4] === 'Balance: ₹500', JSON.stringify(a1));
  rec('row 2 gets its own values in the same sentence', a2[3] === 'Your membership SSC-202 is over, please pay FCM017 today.' && a2[0] === 'Meera' && a2[2] === '₹12,000' && a2[4] === 'Balance: ₹900', JSON.stringify(a2));
  rec('no {{…}} reaches WhatsApp', ![...a1, ...a2].some((x) => /\{\{|\}\}/.test(x)), 'ok');
  const [camp] = await q(`select status, sent_count, body from public.broadcasts where tenant_id=$1 and title='QA insert field sheet'`, [T]);
  rec('the campaign is stored as sent with 2 recipients', camp && camp.status === 'sent' && camp.sent_count === 2, camp ? `${camp.status} ${camp.sent_count}` : 'no row');

  // ---------- 6. CRM audience: member fields
  await sleep(2500);   /* the page closes the composer by itself 1.6 s after a successful send */
  await page.evaluate(() => { if (CMP) closeComposer(); go('broadcasts'); newCampaign(); }); await sleep(800);
  await page.evaluate(() => { setAudSource('crm'); pickTpl('dues_reminder'); setVarText('2', '2026-27'); setVarText('3', 'as per record'); setVarSrc('5', 'nothing'); setVarSrc('6', 'nothing'); }); await sleep(500);
  const crmOpts = await page.evaluate(() => [...document.querySelectorAll(`.var-insert[onchange*="insertToken('4'"] option`)].map((o) => o.value));
  await box('4').click(); await box('4').fill('Dear , your member no.  is on our records.');
  await page.evaluate(() => { const el = document.querySelector('[data-vk="4"]'); el.focus(); el.setSelectionRange(5, 5); });
  await picker('4').selectOption('full_name'); await sleep(250);
  await page.evaluate(() => { const el = document.querySelector('[data-vk="4"]'); const i = el.value.indexOf('no. ') + 4; el.focus(); el.setSelectionRange(i, i); });
  await picker('4').selectOption('membership_no'); await sleep(400);
  const crmText = await varText('4');
  const crmPreview = await t('#waBubble');
  rec('CRM audience: member fields are offered and inserted at the cursor', crmOpts.includes('full_name') && crmOpts.includes('membership_no') && crmOpts.includes('dues_amount') && !crmOpts.some((o) => o.startsWith('col:'))
    && crmText === 'Dear {{full_name}}, your member no. {{membership_no}} is on our records.', crmText);
  rec('CRM audience: the preview fills them from a sample member', /Dear [A-Z][^,{]+, your member no\. [A-Z]+-\d+ is on our records\./.test(crmPreview) && !/\{\{/.test(crmPreview), (crmPreview.match(/Dear .{0,70}/) || [''])[0]);
  /* a real member-list campaign on the bench: the server reads the members itself and fills the fields for each one
     (members whose number is not a test phone are stopped by the staging guard, which is expected here) */
  const o1 = await lastOutbox();
  await page.fill('#c_name', 'QA insert field crm');
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 90000);
  const crmRes = await t('#cmpResult');
  const crmSent = await outboxFrom(o1);
  const mems = await q(`select full_name, membership_no, right(regexp_replace(phone,'[^0-9]','','g'),10) as p10 from public.members where tenant_id=$1 and wa_opt_in`, [T]);
  const checked = crmSent.map((r) => { const m = mems.find((x) => String(r.phone).endsWith(x.p10)); const p = paramsOf(r); return { ok: !!m && p[3] === `Dear ${m.full_name}, your member no. ${m.membership_no} is on our records.`, got: p[3] }; });
  rec('CRM audience: every member gets their own name and member no. in the sentence', checked.length >= 2 && checked.every((c) => c.ok) && new Set(checked.map((c) => c.got)).size === checked.length,
    `${checked.length} messages reached the outbox; ${checked.slice(0, 2).map((c) => c.got).join(' | ')}; result: ${crmRes.slice(0, 60)}`);
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/[[0-9;]*m/g, '').slice(0, 1500));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('no live webhook was called', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} insert-field checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
