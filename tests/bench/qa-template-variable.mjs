// Template editor: "＋ Variable" adds the next numbered blank; empty or malformed {{ }} is explained, never "Ready to submit".
// Staging-built page in Edge on the local bench; Meta is simulated (stg_outbox). Nothing external is called.
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).slice(0, 280)}`); };
const { q, T, users, db } = await benchDb();
const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const rows = () => page.evaluate(() => [...document.querySelectorAll('#ctVarRows .vk')].map((e) => e.textContent.trim()));
const submits = async () => Number((await q(`select count(*)::int n from public.stg_outbox where kind='meta_template_submit'`))[0].n);
const issueText = () => page.evaluate((txt) => ctIssues({ ...ctDraft(), body: txt === null ? ctDraft().body : txt }).join(' || '), null);
const issuesFor = (body) => page.evaluate((b) => ctIssues({ name: 'x', opening: 'Hi {{1}},', body: b, use_signature: true, signature: 'Regards', vars: [{ k: '1', example: 'Rahul' }, { k: '2', example: 'a' }, { k: '3', example: 'b' }] }).join(' || '), body);

try {
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(600);
  await page.evaluate(() => ctNew()); await sleep(400);
  await page.fill('#ct_name', 'QA variable button');
  await page.fill('#ct_open', 'Announcement from Shakti Sports Club\n\nHi {{1}},');
  rec('the editor has a "＋ Variable" button', (await page.locator('#ctAddVarBtn').count()) === 1 && /Variable/.test(await t('#ctAddVarBtn')), await t('#ctAddVarBtn'));

  // ---- the user's case: {{}} typed by hand
  await page.locator('#ct_body').click();
  await page.fill('#ct_body', 'Your dues are pending.\n\n{{}}'); await sleep(300);
  const st1 = await t('#ctIssues');
  rec('an empty {{}} is explained and the template is NOT "Ready to submit"', /\{\{\}\} is empty/.test(st1) && !/Ready to submit/.test(st1), st1.slice(0, 150));
  const s0 = await submits();
  await page.click('#ctSubmitBtn'); await sleep(900);
  rec('Submit is refused while {{}} is empty (nothing goes to Meta)', (await submits()) === s0, `submissions before ${s0}, after ${await submits()}`);

  // ---- the button fills the empty {{}} with the next number
  await page.click('#ctAddVarBtn'); await sleep(300);
  rec('"＋ Variable" turns the empty {{}} into {{2}} and adds its row', (await page.inputValue('#ct_body')) === 'Your dues are pending.\n\n{{2}}' && JSON.stringify(await rows()) === '["{{1}}","{{2}}"]', `${JSON.stringify(await page.inputValue('#ct_body'))} rows ${JSON.stringify(await rows())}`);

  // ---- at the cursor, in the middle of a sentence
  await page.fill('#ct_body', 'Member no.  owes  this year.'); await sleep(200);
  await page.evaluate(() => { const el = document.getElementById('ct_body'); el.focus(); el.setSelectionRange(11, 11); });
  await page.click('#ctAddVarBtn'); await sleep(200);
  await page.evaluate(() => { const el = document.getElementById('ct_body'); const i = el.value.indexOf('owes ') + 5; el.focus(); el.setSelectionRange(i, i); });
  await page.click('#ctAddVarBtn'); await sleep(300);
  const body2 = await page.inputValue('#ct_body');
  rec('the button inserts at the cursor and numbers in order ({{2}} then {{3}})', body2 === 'Member no. {{2}} owes {{3}} this year.' && JSON.stringify(await rows()) === '["{{1}}","{{2}}","{{3}}"]', `${body2} rows ${JSON.stringify(await rows())}`);

  // ---- typing continues after the inserted variable
  await page.evaluate(() => { const el = document.getElementById('ct_body'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type(' Pay here: ');
  await page.click('#ctAddVarBtn'); await sleep(200);
  await page.keyboard.type(' today.'); await sleep(300);
  const body3 = await page.inputValue('#ct_body');
  rec('the cursor stays after the new variable so typing continues', body3 === 'Member no. {{2}} owes {{3}} this year. Pay here: {{4}} today.', body3);

  // ---- a gap in the numbering is filled first
  await page.fill('#ct_body', 'A {{2}} and {{4}} end.'); await sleep(200);
  await page.evaluate(() => { const el = document.getElementById('ct_body'); el.focus(); el.setSelectionRange(1, 1); });
  await page.click('#ctAddVarBtn'); await sleep(300);
  rec('a missing number is used first ({{3}}), so the numbering has no gap', /\{\{3\}\}/.test(await page.inputValue('#ct_body')) && JSON.stringify(await rows()) === '["{{1}}","{{2}}","{{3}}","{{4}}"]', await page.inputValue('#ct_body'));

  // ---- the new variable can be mapped and the template submitted
  await page.fill('#ct_body', 'Member no.  owes dues. Thank you.'); await sleep(200);
  await page.evaluate(() => { const el = document.getElementById('ct_body'); el.focus(); el.setSelectionRange(11, 11); });
  await page.click('#ctAddVarBtn'); await sleep(300);
  await page.evaluate(() => { ctVarSet('2', 'def', 'membership_no'); }); await sleep(300);
  const st2 = await t('#ctIssues');
  const s1 = await submits();
  await page.click('#ctSubmitBtn');
  const submitted = await (async () => { const end = Date.now() + 12000; while (Date.now() < end) { if ((await submits()) > s1) return true; await sleep(250); } return false; })();
  const [sp] = await q(`select payload from public.stg_outbox where kind='meta_template_submit' order by id desc limit 1`);
  const sentText = sp ? JSON.stringify(sp.payload) : '';
  rec('with the variable mapped to "Member no." the template is ready and is submitted with {{1}} and {{2}}', /Ready to submit/.test(st2) && submitted && /\{\{1\}\}/.test(sentText) && /\{\{2\}\}/.test(sentText) && !/\{\{\}\}/.test(sentText), `${st2.slice(0, 40)} | submitted ${submitted}`);

  // ---- the checks, on text only
  const c = {
    empty: await issuesFor('Text {{}} more.'),
    spaced: await issuesFor('Text {{  }} more.'),
    oneBrace: await issuesFor('Text {2} more.'),
    unclosed: await issuesFor('Text {{2} more.'),
    closeOnly: await issuesFor('Text 2}} more.'),
    word: await issuesFor('Text {{name}} more.'),
    good: await issuesFor('Text {{2}} and {{3}} more.'),
    plain: await issuesFor('Pay before 31st October → ₹26,550 (discounted rate). {Note} 5 > 3 }'),
  };
  rec('empty braces (with or without spaces) are named', /\{\{\}\} is empty/.test(c.empty) && /\{\{\}\} is empty/.test(c.spaced), `${c.empty.slice(0, 60)} | ${c.spaced.slice(0, 40)}`);
  rec('half-written variables ({2}, {{2}, 2}}) are named as not complete', /not a complete variable/.test(c.oneBrace) && /not a complete variable/.test(c.unclosed) && /not a complete variable/.test(c.closeOnly), `${c.oneBrace.slice(0, 50)} | ${c.unclosed.slice(0, 50)} | ${c.closeOnly.slice(0, 50)}`);
  rec('a word in braces keeps its own message', /can't be used in a WhatsApp template/.test(c.word) && !/not a complete variable/.test(c.word), c.word.slice(0, 90));
  rec('correct variables and ordinary text raise nothing', c.good === '' && c.plain === '', `good "${c.good}" plain "${c.plain}"`);
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} template-variable checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
