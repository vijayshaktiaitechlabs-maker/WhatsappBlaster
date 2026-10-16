// Settings → Payment link → "Save link": saves ONLY the payment link.
// Staging-built page in Edge on the local bench (real SQL + rules in PGlite); nothing external is called.
//   1. the button saves the link to the club settings and the line under the box says what is saved
//   2. other unsaved edits on the page are neither saved nor lost
//   3. "Save changes" afterwards saves the other edits without re-asking about the link
//   4. a link that is not https:// is refused, nothing is written
//   5. a setting someone else changed meanwhile is kept (only the link is written)
//   6. clearing the box and saving removes the link, after a confirmation
//   7. a dues reminder uses the newly saved link at once
//   8. Enter in the box saves; the action is in the activity log
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).slice(0, 260)}`); };
const { q, T, users, db } = await benchDb();
const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const cfg = async () => (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config || {};
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const LINK1 = 'https://pay.example.org/club-one', LINK2 = 'https://pay.example.org/club-two';

try {
  await q(`update public.tenants set bot_config = bot_config #- '{payments}' where id=$1`, [T]);
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => go('settings')); await sleep(1500);
  const before = await cfg();
  rec('before: no link saved, and the line under the box says so', !(before.payments && before.payments.link) && /No payment link is saved yet/.test(await t('#payLinkSaved')), await t('#payLinkSaved'));

  // an unrelated unsaved edit on the same page
  const greet0 = (before.brand && before.brand.greeting) || '';
  await page.fill('#s_greeting', 'UNSAVED greeting edit');
  await page.fill('#s_payment_link', LINK1); await sleep(200);
  const hint = await t('#payLinkSaved');
  await page.click('#payLinkSave');
  const saved1 = await until(async () => { const c = await cfg(); return c.payments && c.payments.link === LINK1 ? c : null; });
  await sleep(300);
  rec('typing shows "Not saved yet", and "Save link" writes the link to the club settings', /Not saved yet/.test(hint) && !!saved1, `hint "${hint.slice(-40)}" -> saved ${saved1 && saved1.payments.link}`);
  rec('the line under the box then shows the saved link, and the toast confirms', (await t('#payLinkSaved')) === 'Saved link: ' + LINK1 && /Payment link saved/.test(await t('#toast')), `${await t('#payLinkSaved')} | ${await t('#toast')}`);
  rec('the other unsaved edit was NOT saved', ((saved1 && saved1.brand && saved1.brand.greeting) || '') === greet0, `greeting in database: "${String((saved1 && saved1.brand && saved1.brand.greeting) || '').slice(0, 40)}"`);
  rec('the other unsaved edit is still in its box', (await page.inputValue('#s_greeting')) === 'UNSAVED greeting edit', await page.inputValue('#s_greeting'));
  rec('everything else in the settings is untouched', JSON.stringify({ ...before, payments: undefined }) === JSON.stringify({ ...saved1, payments: undefined }), 'compared all other keys');

  // "Save changes" afterwards: saves the greeting, does not ask about the link
  let d0 = issues.dialogs.length;
  await page.click('#setSave');
  const saved2 = await until(async () => { const c = await cfg(); return c.brand && c.brand.greeting === 'UNSAVED greeting edit' ? c : null; });
  rec('"Save changes" then saves the other edit, keeps the link and asks nothing about it', !!saved2 && saved2.payments.link === LINK1 && issues.dialogs.slice(d0).length === 0, `dialogs ${issues.dialogs.slice(d0).length}; link ${saved2 && saved2.payments && saved2.payments.link}`);
  await sleep(800);

  // not https
  await page.fill('#s_payment_link', 'http://pay.example.org/x'); await page.click('#payLinkSave'); await sleep(600);
  const bad1 = await t('#toast');
  await page.fill('#s_payment_link', 'pay.example.org'); await page.click('#payLinkSave'); await sleep(600);
  rec('a link that is not a full https:// address is refused and nothing is written', /must be a full https/.test(bad1) && /must be a full https/.test(await t('#toast')) && (await cfg()).payments.link === LINK1, `${bad1} | saved ${(await cfg()).payments.link}`);

  // someone else changes another setting meanwhile: only the link is written
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{maintenance}', '"CHANGED ELSEWHERE"') where id=$1`, [T]);
  await page.fill('#s_payment_link', LINK2);
  await page.press('#s_payment_link', 'Enter');
  const saved3 = await until(async () => { const c = await cfg(); return c.payments && c.payments.link === LINK2 ? c : null; });
  rec('Enter in the box saves; a setting changed elsewhere meanwhile is kept', !!saved3 && saved3.maintenance === 'CHANGED ELSEWHERE', `link ${saved3 && saved3.payments.link}; maintenance ${saved3 && saved3.maintenance}`);

  // the reminder text uses it at once
  const txt = await page.evaluate(async () => await freshPayLinkText());
  rec('a dues reminder uses the newly saved link at once', txt === LINK2, txt);

  // same link again
  await page.click('#payLinkSave'); await sleep(600);
  rec('saving the same link again says it is already saved', /already saved/.test(await t('#toast')), await t('#toast'));

  // remove, with confirmation
  d0 = issues.dialogs.length;
  await page.fill('#s_payment_link', ''); await page.click('#payLinkSave');
  const saved4 = await until(async () => { const c = await cfg(); return !(c.payments && c.payments.link) ? c : null; });
  rec('clearing the box and saving asks first, then removes the link', !!saved4 && issues.dialogs.slice(d0).some((x) => /Remove the saved payment link/.test(x)) && /No payment link is saved yet/.test(await t('#payLinkSaved')), `${issues.dialogs.slice(d0)[0] || 'no dialog'} | ${await t('#payLinkSaved')}`);

  const logs = await q(`select meta, details from public.audit_log where tenant_id=$1 and action='updated' and entity='settings' order by created_at desc limit 6`, [T]).catch(async () => q(`select * from public.audit_log where tenant_id=$1 and action='updated' and entity='settings' order by created_at desc limit 6`, [T]));
  rec('the saves are in the activity log as a payment link change', logs.filter((r) => /payments\.link/.test(JSON.stringify(r))).length >= 3, `${logs.filter((r) => /payments\.link/.test(JSON.stringify(r))).length} log rows`);

  // a role without Settings cannot save it even by calling the function
  await page.evaluate(() => document.getElementById('logout').click()); await sleep(1500);
  await login(page, 'qa-desk@club.test');
  const desk = await page.evaluate(async () => { try { SETTINGS_LOADED = true; SETTINGS_BASE = SETTINGS_BASE || {}; SETTINGS_SNAPSHOT = SETTINGS_SNAPSHOT || {}; document.getElementById('s_payment_link').value = 'https://evil.example.org/x'; await savePaymentLink(); } catch (e) { return 'threw ' + e.message; } return document.getElementById('toast').textContent; });
  await sleep(500);
  rec('front desk cannot save a payment link (the database refuses)', !((await cfg()).payments && (await cfg()).payments.link), `toast "${String(desk).slice(0, 70)}"; saved ${JSON.stringify((await cfg()).payments || null)}`);
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} payment-link-save checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
