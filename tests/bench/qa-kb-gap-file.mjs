// Bot Knowledge: "Add a file" beside "Teach the bot" on an open question, and the "Already handled" history.
// Local bench: staging-built workflow and page, stand-in AI reading.
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).replace(/\n/g, ' ⏎ ').slice(0, 300)}`); };
const { db, q, T, users } = await benchDb();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=', 'base64');
const gap = async (question, status = 'open', answer = null) => (await q(`insert into public.kb_gaps (tenant_id, question, q_norm, status, answer, hits, last_seen, resolved_at) values ($1,$2,lower($2),$3,$4,2,now(), case when $3='open' then null else now() end) returning id`, [T, question, status, answer]))[0].id;
const G1 = await gap('Is the swimming pool open on Mondays?');
const G2 = await gap('Please send payment QR code');
await gap('Hello my name spelling is incorrect', 'answered', 'What would you like to change it to?');
const G4 = await gap('QA TEST: the fictional facility', 'ignored');
const g = async (id) => (await q(`select status, answer from public.kb_gaps where id=$1`, [id]))[0];
const chunksN = async () => Number((await q(`select count(*)::int n from public.kb_chunks where tenant_id=$1`, [T]))[0].n);

const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
try {
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => go('knowledge')); await sleep(1200);
  const btns = await page.evaluate(() => [...document.querySelectorAll('.gap-card')].map((c) => ({ q: c.querySelector('h3').textContent, file: !!c.querySelector('[id^=gapFile_]'), teach: !!c.querySelector('button[onclick^=teachGap]') })));
  rec('every open question has "Add a file" beside "Teach the bot"', btns.length === 2 && btns.every((b) => b.file && b.teach), JSON.stringify(btns).slice(0, 200));

  const hist0 = await t('#kbHistory');
  rec('the questions already taught or dismissed are listed under "Already handled", collapsed', /Already handled \(2\)/.test(hist0) && /1 taught, 1 dismissed/.test(hist0) && /Nothing is deleted/.test(hist0) && (await page.locator('.kb-done').count()) === 0, hist0.slice(0, 160));
  await page.click('#kbHistoryToggle'); await sleep(300);
  const done = await page.evaluate(() => [...document.querySelectorAll('.kb-done')].map((d) => ({ s: d.dataset.status, t: d.textContent.replace(/\s+/g, ' ') })));
  rec('opening it shows each question with its status and, if taught, its answer', done.length === 2 && done.some((d) => d.s === 'answered' && /What would you like to change it to\?/.test(d.t) && /Taught/.test(d.t)) && done.some((d) => d.s === 'ignored' && /Dismissed/.test(d.t) && /Put back in the list/.test(d.t)), done.map((d) => d.s).join(','));
  await page.locator('.kb-done[data-status=ignored] button', { hasText: 'Put back in the list' }).click(); await sleep(800);
  rec('"Put back in the list" returns a dismissed question to the open list', (await g(G4)).status === 'open' && (await page.locator('.gap-card').count()) === 3, (await g(G4)).status);
  await page.evaluate((id) => ignoreGap(id), G4); await sleep(600);

  // the file for question 1
  const c0 = await chunksN();
  await page.evaluate((id) => kbAttachToGap(id), G1);
  const popup = await t('#kbModalBody');
  await page.setInputFiles('#kbFileInput', { name: 'Pool rules.png', mimeType: 'image/png', buffer: PNG }); await page.click('#kbReadBtn');
  rec('"Add a file" opens the popup naming the question it is for', /Answering the question“Is the swimming pool open on Mondays\?”/.test(popup), popup.slice(0, 120));
  const review = await until(() => page.evaluate(() => { const r = document.getElementById('kbReview'); return r ? { text: r.textContent.replace(/\s+/g, ' '), editable: r.querySelectorAll('textarea.kb-fact-text').length } : null; }));
  rec('the reading is shown for review with the question it is for', !!review && /Looking for the answer to: “Is the swimming pool open on Mondays\?”/.test(review.text) && review.editable === 4, review ? review.text.slice(0, 140) : 'no review');
  const ai = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('the AI was told which question to look for, and to return nothing if the file does not answer it', /A member asked: "Is the swimming pool open on Mondays\?"/.test(ai) && /If the document does not answer it, return an empty facts list/.test(ai), (ai.match(/A member asked.{0,100}/) || [''])[0]);
  rec('nothing is learned or marked taught while the lines are being reviewed', (await chunksN()) === c0 && (await g(G1)).status === 'open', (await g(G1)).status);
  await page.click('#kbTeachBtn');
  const done1 = await until(async () => ((await g(G1)).status === 'answered' ? await g(G1) : null));
  await sleep(600);
  rec('"Teach the bot" saves the lines and marks that question as taught, with the file named in its answer', !!done1 && /Taught from the file "Pool rules\.png" \(4 lines\)/.test(done1.answer) && (await chunksN()) === c0 + 4, done1 ? done1.answer : 'still open');
  const meta = (await q(`select meta from public.kb_chunks where tenant_id=$1 and file_id is not null order by created_at desc limit 1`, [T]))[0].meta;
  rec('each saved line remembers which question it answered', meta.gap_id === G1, JSON.stringify(meta).slice(0, 140));
  rec('the question leaves the open list and appears under "Already handled" as taught', (await page.locator('.gap-card').count()) === 1 && /Already handled \(3\)/.test(await t('#kbHistory')), await t('#kbHistory'));

  // a file uploaded from the top card is not tied to any question
  const before = await g(G2);
  await page.setInputFiles('#kbFileInput', { name: 'Loose notice.png', mimeType: 'image/png', buffer: PNG }); await page.click('#kbReadBtn');
  await until(() => page.locator('#kbReview').count());
  const rv = await t('#kbReview');
  await page.click('#kbDiscardBtn'); await sleep(900);
  rec('a file uploaded from the top card (not from a question) is not tied to any question', !/Looking for the answer to/.test(rv) && (await g(G2)).status === before.status, rv.slice(0, 80));

  // desk: no button
  const b2 = await openBrowser(db, users); const p2 = await b2.context.newPage();
  await login(p2, 'qa-desk@club.test');
  await p2.evaluate(() => go('knowledge')); await sleep(1000);
  const desk = await p2.evaluate(() => ({ cards: document.querySelectorAll('.gap-card').length, fileBtn: document.querySelectorAll('[id^=gapFile_]').length }));
  b2.fake.stop(); await b2.browser.close();
  rec('front desk sees the questions but not "Add a file"', desk.cards >= 1 && desk.fileBtn === 0, JSON.stringify(desk));
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} question-file checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
