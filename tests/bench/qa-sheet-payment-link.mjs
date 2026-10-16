// Campaign sheets with a payment-link column: each row's own link fills the blank set to "Payment link".
// Staging-built page in Edge on the local bench, real workflow code, simulated Meta; nothing external is called.
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
const lastOutbox = async () => Number((await q(`select coalesce(max(id),0)::int n from public.stg_outbox`))[0].n);
const outboxFrom = async (id) => q(`select id, phone, payload from public.stg_outbox where kind='meta_message' and id > $1 order by id`, [id]);
const paramsOf = (row) => { const c = (((row.payload || {}).template || {}).components || []).find((x) => x.type === 'body'); return ((c && c.parameters) || []).map((p) => String(p.text)); };
const src = (k) => page.evaluate((key) => (CMP.vars[key] || {}).src, k);
const upload = async (name, text) => { await page.setInputFiles('#sheetFile', { name, mimeType: 'text/csv', buffer: Buffer.from(text) }); await sleep(1200); };
const L1 = 'https://smartgateway.example.org/pay/order/AAA111', L2 = 'https://smartgateway.example.org/pay/order/BBB222', CLUB = 'https://pay.example.org/club-link';
/* the bench's dues template, with its 4th blank defaulting to the payment link (as a club's own template can) */
const linkTpl = () => page.evaluate(() => { const v = findTpl('dues_reminder').vars.find((x) => x.k === '4'); v.def = 'payment_link'; v.multiline = false; });
const fillRest = () => page.evaluate(() => { setVarText('2', '2026-27'); setVarText('3', 'Rs 29,500'); setVarSrc('5', 'nothing'); setVarSrc('6', 'nothing'); });

try {
  await q(`update public.tenants set bot_config = jsonb_set(coalesce(bot_config,'{}'::jsonb), '{payments}', $2::jsonb) where id=$1`, [T, JSON.stringify({ link: CLUB })]);
  await login(page, 'qa-owner@club.test');
  await linkTpl();

  // ---------- A. template first (blank = Payment link), then the sheet with a link column
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(600);
  await page.evaluate(() => { setAudSource('sheet'); pickTpl('dues_reminder'); }); await sleep(300);
  const before = await src('4');
  await upload('links.csv', `Name,Mobile,Member No,Photo,Payment Link\nAnil Kataria,${P1},SSC-101,https://img.example.org/a.jpg,${L1}\nMeera Shah,${P2},SSC-202,https://img.example.org/b.jpg,${L2}\n`);
  await fillRest(); await sleep(400);
  const state = await page.evaluate(() => ({ col: CMP.sheetLinkCol, src: CMP.vars['4'].src, note: (document.getElementById('sheetLinkNote') || {}).textContent || '',
    opt: [...document.querySelectorAll('#varBox select:not(.var-insert)')].flatMap((s) => [...s.options]).find((o) => o.value === 'col:Payment Link')?.textContent || '',
    hasSettings: [...document.querySelectorAll('#varBox select:not(.var-insert) option')].some((o) => o.value === 'payment_link') }));
  rec('before the sheet, the blank uses "Payment link" (Settings)', before === 'payment_link', before);
  rec('the column named "Payment Link" is detected, not the other column of web addresses', state.col === 'Payment Link', state.col);
  rec('the blank set to "Payment link" now takes each row\'s own link', state.src === 'col:Payment Link', state.src);
  rec('the sheet summary says which column and how many rows have a link', /Payment links found in column “Payment Link”: 2 of 2/.test(state.note.replace(/\s+/g, ' ')), state.note.replace(/\s+/g, ' ').slice(0, 130));
  rec('the dropdown names it as the sheet\'s payment link, and offers no club-wide link option in a sheet', /Payment link from the sheet: Payment Link/.test(state.opt) && !state.hasSettings, state.opt.slice(0, 80));
  const preview = await t('#waBubble');
  rec('the preview shows row 1\'s own link', preview.includes(L1) && !preview.includes(CLUB) && !/\{\{/.test(preview), (preview.match(/https:\S+/) || [''])[0]);

  let o0 = await lastOutbox();
  await page.fill('#c_name', 'QA sheet links');
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 60000);
  const res = await t('#cmpResult');
  let sent = await outboxFrom(o0);
  const a1 = paramsOf(sent.find((r) => String(r.phone).endsWith(P1.slice(-10))) || {}), a2 = paramsOf(sent.find((r) => String(r.phone).endsWith(P2.slice(-10))) || {});
  rec('both rows are sent, each with ITS OWN payment link', /Sent to 2 of 2/.test(res) && a1[3] === L1 && a2[3] === L2, `${res.slice(0, 40)} | row1 ${a1[3]} | row2 ${a2[3]}`);
  await sleep(2500);

  // ---------- A2. reopen the saved campaign: its Excel columns and the payment link column come back
  const [saved] = await q(`select id from public.broadcasts where tenant_id=$1 and title='QA sheet links'`, [T]);
  await page.evaluate(() => { if (CMP) closeComposer(); }); await sleep(300);
  await page.evaluate((id) => editCampaign(id), saved.id); await sleep(1500);
  const re = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#varBox select:not(.var-insert) option')].map((o) => o.textContent), col: sheetLinkCol(), src: CMP.vars['4'].src }));
  rec('a saved sheet campaign, reopened: the Excel columns and the payment link option are listed', re.opts.some((x) => /Excel: Member No/.test(x)) && re.opts.some((x) => /Payment link from the sheet: Payment Link/.test(x)) && re.col === 'Payment Link' && re.src === 'col:Payment Link', JSON.stringify(re).slice(0, 220));

  // ---------- B. sheet first, then the template
  await page.evaluate(() => { if (CMP) closeComposer(); go('broadcasts'); newCampaign(); }); await sleep(700);
  await page.evaluate(() => setAudSource('sheet')); await sleep(200);
  await upload('links2.csv', `Name,Mobile,Pay URL\nAnil Kataria,${P1},${L1}\nMeera Shah,${P2},${L2}\n`);
  await page.evaluate(() => pickTpl('dues_reminder')); await sleep(400);
  rec('sheet first, template second: the blank is mapped the same way (header "Pay URL")', (await src('4')) === 'col:Pay URL', await src('4'));

  // ---------- C. a choice made by hand is kept
  await page.evaluate(() => { setVarSrc('4', 'custom'); setVarText('4', 'https://pay.example.org/manual-one'); }); await sleep(300);
  await upload('links2.csv', `Name,Mobile,Pay URL\nAnil Kataria,${P1},${L1}\nMeera Shah,${P2},${L2}\n`);
  rec('a blank chosen by hand (custom text) is kept, even after the sheet is uploaded again', (await src('4')) === 'custom', await src('4'));
  await fillRest(); await sleep(300);
  o0 = await lastOutbox();
  await page.fill('#c_name', 'QA sheet club link');
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 60000);
  sent = await outboxFrom(o0);
  rec('with that choice every row gets the typed text', sent.length === 2 && sent.every((r) => paramsOf(r)[3] === 'https://pay.example.org/manual-one'), sent.map((r) => paramsOf(r)[3]).join(' | '));
  await sleep(2500);

  // ---------- D. a row without a valid link blocks the send
  await page.evaluate(() => { if (CMP) closeComposer(); go('broadcasts'); newCampaign(); }); await sleep(700);
  await page.evaluate(() => { setAudSource('sheet'); pickTpl('dues_reminder'); }); await sleep(300);
  await upload('bad.csv', `Name,Mobile,Payment Link\nAnil Kataria,${P1},${L1}\nMeera Shah,${P2},\nRavi Old,${P1},http://insecure.example.org/pay\n`);
  await fillRest(); await sleep(300);
  const noteBad = ((await t('#sheetLinkNote')) || '');
  o0 = await lastOutbox();
  await page.fill('#c_name', 'QA sheet bad links');
  await page.click('#cmpSendBtn'); await sleep(1500);
  const blocked = await t('#cmpResult');
  rec('rows with an empty or a non-https link are counted in the sheet summary', /1 of 3 row\(s\) have their own link/.test(noteBad) && /2 row\(s\) have no valid https:\/\/ link/.test(noteBad), noteBad.slice(0, 190));
  rec('the send is refused and names the column and the rows; nothing goes out', /uses the sheet's payment link column “Payment Link”, but 2 of the 3 row\(s\) have no valid https:\/\/ link/.test(blocked) && (await outboxFrom(o0)).length === 0, blocked.slice(0, 200));

  // ---------- E. leaving the sheet: back to the club's link
  await page.evaluate(() => setAudSource('crm')); await sleep(300);
  rec('switching the audience away from the sheet puts the blank back on the club\'s link', (await src('4')) === 'payment_link', await src('4'));
  await page.evaluate(() => setAudSource('sheet')); await sleep(300);
  rec('and back on the sheet it takes the rows\' links again', (await src('4')) === 'col:Payment Link', await src('4'));

  // ---------- F. a sheet with no link column changes nothing
  await upload('nolinks.csv', `Name,Mobile,Due\nAnil Kataria,${P1},500\nMeera Shah,${P2},900\n`);
  const f = await page.evaluate(() => ({ col: CMP.sheetLinkCol, src: CMP.vars['4'].src, note: !!document.getElementById('sheetLinkNote') }));
  rec('a sheet without links: nothing is detected, and the blank is custom text (no club-wide link in a sheet)', f.col === '' && f.src === 'custom' && !f.note, JSON.stringify(f));

  // ---------- G. an Excel cell that shows words but carries a hyperlink
  const b64 = await page.evaluate(({ P1, L1 }) => {
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Mobile', 'Payment Link'], ['Anil Kataria', P1, 'Pay here']]);
    ws['C2'].l = { Target: L1 };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  }, { P1, L1 });
  await page.evaluate(() => pickTpl('dues_reminder')); await sleep(300);
  await page.setInputFiles('#sheetFile', { name: 'hyper.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(b64, 'base64') }); await sleep(1500);
  const g = await page.evaluate(() => ({ col: CMP.sheetLinkCol, v: CMP.customRecipients[0] && CMP.customRecipients[0].row_cols['Payment Link'], src: CMP.vars['4'].src }));
  rec('an Excel cell showing "Pay here" with a hyperlink gives the web address, and is detected', g.v === L1 && g.col === 'Payment Link' && g.src === 'col:Payment Link', JSON.stringify(g));
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('no live webhook was called', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} sheet-payment-link checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
