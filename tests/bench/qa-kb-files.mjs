// Bot Knowledge: teaching the bot from a file. The AI's reading is reviewed by staff before anything is learned; prices,
// numbers, payment and member details are never learned from a file; the AI quota is protected.
// Local bench: staging-built workflow and page, a stand-in for the AI (a fixed reading with safe and sensitive lines).
import { world, runNode, benchCode, cfg } from './harness.mjs';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).replace(/\n/g, ' ⏎ ').slice(0, 320)}`); };
const { db, q, T, users } = await benchDb();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=';
const staff = Object.fromEntries((await q(`select u.id, u.email from auth.users u`)).map((u) => ['tok-' + u.email, { id: u.id, email: u.email }]));
const call = async (body, email = 'qa-owner@club.test', code) => {
  const w = world(db, { users: staff });
  const b = { tenant: 'shakti', ...(email ? { user_token: 'tok-' + email } : {}), ...body };
  if (!code) return runNode('kb_files_wf.json', 'KB Files', { json: { body: b } }, w, { setTimeout: (fn) => setImmediate(fn) });
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const out = await new AsyncFn('$input', 'Buffer', 'setTimeout', code).call({ helpers: w.helpers }, { first: () => ({ json: { body: b } }) }, Buffer, setTimeout);
  return out[0].json;
};
const ai = async () => Number((await q(`select count(*)::int n from public.stg_outbox where kind in ('ai_prompt','ai_embed')`))[0].n);
const chunks = async (fid) => q(`select content, source, file_id, (embedding is not null) emb, meta from public.kb_chunks where tenant_id=$1 and file_id=$2 order by created_at, content`, [T, fid]);
const fileRow = async (fid) => (await q(`select * from public.kb_files where id=$1`, [fid]))[0];
const allChunks = async () => Number((await q(`select count(*)::int n from public.kb_chunks where tenant_id=$1`, [T]))[0].n);

try {
  // ---------- A. reading a file: a list for review, nothing learned yet
  const c0 = await allChunks();
  let r = await call({ action: 'extract', name: 'Club notice.png', mime: 'image/png', file_base64: PNG });
  const safe = (r.facts || []).filter((f) => !f.blocked), blocked = (r.facts || []).filter((f) => f.blocked);
  rec('the AI\'s reading comes back as a list for review: 4 lines that can be learned, 6 that cannot', r.ok === true && safe.length === 4 && blocked.length === 6 && !!r.file_id, `${safe.length} ok / ${blocked.length} blocked | ${r.error || ''}`);
  rec('a price, a phone number, a payment link, member data, an email and bank details are each blocked with the reason', JSON.stringify(blocked.map((f) => f.why).sort()) === JSON.stringify(['contact', 'identity', 'link', 'member', 'money', 'number']), blocked.map((f) => f.why + ': ' + f.fact.slice(0, 28)).join(' | '));
  rec('nothing is learned at this point: no new knowledge rows, the file waits for review', (await allChunks()) === c0 && (await fileRow(r.file_id)).status === 'review', `status ${(await fileRow(r.file_id)).status}`);
  const F1 = r.file_id;

  // ---------- B. saving what staff approved: corrected text is kept, a smuggled price is refused by the server
  const a0 = await ai();
  r = await call({ action: 'save', file_id: F1, facts: [
    { topic: 'Pool', fact: 'The swimming pool is closed every Monday morning for cleaning.' },           // corrected by staff
    { topic: 'Dress', fact: 'Non-marking shoes are compulsory on all indoor courts.' },
    { topic: 'Fees', fact: 'The guest fee is Rs 500 per visit.' },                                      // typed in by hand: must not pass
    { topic: 'Contact', fact: 'For bookings call 9876543210.' }] });
  const ch = await chunks(F1);
  rec('2 approved lines are saved; the price and the phone number typed in by hand are refused by the server', r.ok === true && r.saved === 2 && (r.skipped || []).length === 2 && JSON.stringify(r.skipped.map((x) => x.why).sort()) === JSON.stringify(['money', 'number']), JSON.stringify({ saved: r.saved, skipped: (r.skipped || []).map((x) => x.why), err: r.error }));
  rec('the saved lines are marked as coming from the file, carry the staff\'s corrected wording, and are indexed for the bot', ch.length === 2 && ch.every((c) => c.source === 'file' && c.emb && /^From an uploaded file \("Club notice\.png"\)/.test(c.content)) && ch.some((c) => /Monday morning/.test(c.content)) && ch.every((c) => !/Rs 500|9876543210/.test(c.content)) && ch[0].meta.taught_by === 'qa-owner@club.test', ch.map((c) => c.content.slice(0, 80)).join(' | '));
  rec('saving costs one AI call for all lines together', (await ai()) - a0 === 1, `AI calls ${(await ai()) - a0}`);
  rec('the file is now "learned" with its counts', ((x) => x.status === 'learned' && x.facts_saved === 2 && x.facts_blocked === 2)(await fileRow(F1)), JSON.stringify(((x) => ({ status: x.status, saved: x.facts_saved, left: x.facts_blocked }))(await fileRow(F1))));
  r = await call({ action: 'save', file_id: F1, facts: [{ topic: 'Fees', fact: 'Annual maintenance is Rs 29,500.' }] });
  rec('a save with only sensitive lines saves nothing and says why', r.ok === false && /come only from Settings/.test(r.error) && (await chunks(F1)).length === 2, r.error);

  // ---------- C. who may use it
  r = await call({ action: 'extract', name: 'x.png', mime: 'image/png', file_base64: PNG }, 'qa-desk@club.test');
  const r2 = await call({ action: 'extract', name: 'x.png', mime: 'image/png', file_base64: PNG }, null);
  const r3 = await call({ action: 'remove', file_id: F1 }, 'qa-accounts@club.test');
  rec('front desk, accounts and a caller without a login are refused, and nothing changes', r.ok === false && /owner or manager/.test(r.error) && r2.ok === false && /sign in/.test(r2.error) && r3.ok === false && (await chunks(F1)).length === 2, `${r.error} | ${r2.error} | ${r3.error}`);

  // ---------- D. files that are refused before the AI is asked
  const a1 = await ai(), n1 = Number((await q(`select count(*)::int n from public.kb_files`))[0].n);
  const bad = [
    await call({ action: 'extract', name: 'virus.exe', mime: 'application/x-msdownload', file_base64: PNG }),
    await call({ action: 'extract', name: 'page.html', mime: 'text/html', file_base64: PNG }),
    await call({ action: 'extract', name: 'big.png', mime: 'image/png', file_base64: 'A'.repeat(Math.ceil(4.2 * 1024 * 1024 * 4 / 3)) }),
    await call({ action: 'extract', name: 'empty.txt', text: 'hi' }),
    await call({ action: 'extract', name: 'long.txt', text: 'word '.repeat(13000) })];
  rec('a program, a web page, a file over 4 MB, an empty text and an over-long text are refused without using the AI or the daily count', bad.every((x) => x.ok === false) && (await ai()) === a1 && Number((await q(`select count(*)::int n from public.kb_files`))[0].n) === n1, bad.map((x) => String(x.error).slice(0, 34)).join(' | '));

  // ---------- E. a text file (CSV / Excel arrive as text)
  r = await call({ action: 'extract', name: 'Rules.csv', text: 'Rule,Detail\nPool,Closed every Monday for cleaning\nGuests,Photo identity card required' });
  rec('a text / CSV file is read the same way', r.ok === true && (r.facts || []).length === 10 && (await fileRow(r.file_id)).mime === 'text/plain', `${(r.facts || []).length} lines | ${r.error || ''}`);
  const F2 = r.file_id;

  // ---------- F. remove: the bot forgets the file; the day's count is not reset
  const usedBefore = Number((await q(`select count(*)::int n from public.kb_files where tenant_id=$1 and created_at >= current_date`, [T]))[0].n);
  r = await call({ action: 'remove', file_id: F1 });
  rec('removing a file deletes what the bot learned from it', r.ok === true && (await chunks(F1)).length === 0 && (await fileRow(F1)).status === 'removed', `${r.ok} | chunks ${(await chunks(F1)).length}`);
  rec('a removed file still counts toward today\'s uploads (the limit cannot be reset by removing)', Number((await q(`select count(*)::int n from public.kb_files where tenant_id=$1 and created_at >= current_date`, [T]))[0].n) === usedBefore, `used ${usedBefore}`);
  r = await call({ action: 'save', file_id: F1, facts: [{ topic: 'Pool', fact: 'The pool is closed on Mondays.' }] });
  rec('a removed file cannot be taught again without a new upload', r.ok === false && /no longer in the list/.test(r.error), r.error);

  // ---------- G. the daily limit protects the AI quota
  await q(`insert into public.kb_files (tenant_id, name, status) select $1, 'filler ' || g, 'failed' from generate_series(1, 10) g`, [T]);
  const a2 = await ai();
  r = await call({ action: 'extract', name: 'one more.png', mime: 'image/png', file_base64: PNG });
  rec('after 10 uploads in a day the next one is refused before the AI is asked', r.ok === false && r.limit === true && /used all 10 file uploads for today/.test(r.error) && (await ai()) === a2, r.error);
  await q(`update public.kb_files set created_at = now() - interval '2 days' where name like 'filler %'`);
  r = await call({ action: 'extract', name: 'next day.png', mime: 'image/png', file_base64: PNG });
  rec('the count is per day: uploads from earlier days do not block today', r.ok === true, r.error || 'ok');
  const F3 = r.file_id;

  // ---------- H. Google says "quota exceeded": one attempt, a clear message, nothing changed
  const quotaCode = benchCode('kb_files_wf.json', 'KB Files').replace('if (key === __stg.noAi) {', "if (globalThis.__qaQuota) return __stgFake(opts, 429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });\n      if (key === __stg.noAi) {");
  if (quotaCode === benchCode('kb_files_wf.json', 'KB Files')) throw new Error('quota test double not placed');
  globalThis.__qaQuota = true;
  const a3 = await ai(), c3 = await allChunks();
  r = await call({ action: 'extract', name: 'quota.png', mime: 'image/png', file_base64: PNG }, 'qa-owner@club.test', quotaCode);
  const rs = await call({ action: 'save', file_id: F3, facts: [{ topic: 'Pool', fact: 'The pool is closed on Mondays for cleaning.' }] }, 'qa-owner@club.test', quotaCode);
  globalThis.__qaQuota = false;
  rec('when Google answers "quota exceeded" the AI is asked once only (no retries on other models) and staff get a clear message', r.ok === false && r.quota === true && /usage limit/.test(r.error) && rs.ok === false && rs.quota === true && (await ai()) - a3 === 2 && (await allChunks()) === c3 && (await fileRow(r.file_id)).status === 'failed', `${(await ai()) - a3} AI calls | ${r.error.slice(0, 90)}`);

  // ---------- I. the bot is told that file lines never override Settings
  const bot = benchCode('wa_bot_wf.json', 'Bot Engine');
  rec('the bot\'s instructions say file lines never override the club settings, and prices or numbers are never taken from them', /Lines that begin with \\?"From an uploaded file\\?"/.test(bot) && /NEVER override the club settings/.test(bot) && /Never take a price, amount, phone number, payment detail or link from such a line/.test(bot), 'rule present');

  // ---------- J. the screen
  const { browser, context, fake } = await openBrowser(db, users);
  const page = await context.newPage();
  const issues = watch(page);
  const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  try {
    await login(page, 'qa-owner@club.test');
    await page.evaluate(() => go('knowledge')); await sleep(1000);
    const card = await t('#kbFilesCard');
    rec('Bot Knowledge shows "Teach from a file", what is never learned from files, and today\'s usage', /Teach from a file/.test(card) && /never learned from a file/.test(card) && /of 10 uploads and notes used today/.test(card) && (await page.locator('#kbUploadBtn').count()) === 1, card.slice(0, 200));
    rec('files taught earlier are listed; a removed one is not', /Rules\.csv/.test(card) && !/Club notice\.png/.test(card), (card.match(/Rules\.csv.{0,60}/) || [''])[0]);

    await page.setInputFiles('#kbFileInput', { name: 'Timetable.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') }); await page.click('#kbReadBtn');
    const review = await until(() => page.evaluate(() => { const r = document.getElementById('kbReview'); if (!r) return null; return { text: r.textContent.replace(/\s+/g, ' '), editable: r.querySelectorAll('textarea.kb-fact-text').length, blocked: r.querySelectorAll('.kb-fact.blocked').length, disabled: [...r.querySelectorAll('.kb-fact.blocked input')].every((i) => i.disabled), btn: document.getElementById('kbTeachBtn').textContent.trim() }; }));
    rec('after an upload the review shows 4 editable lines and 6 struck-out lines with their reasons', !!review && review.editable === 4 && review.blocked === 6 && review.disabled && /Nothing has been learned yet/.test(review.text) && /Not learned: this line contains a price or amount/.test(review.text) && /Teach the bot 4 lines/.test(review.btn), review ? `${review.editable} editable, ${review.blocked} blocked | ${review.btn}` : 'no review panel');
    const before = await allChunks();
    await page.locator('textarea.kb-fact-text').nth(0).fill('The swimming pool is closed every Monday until noon.');
    await page.locator('#kbReview .kb-fact:not(.blocked) input[type=checkbox]').nth(1).uncheck();
    rec('unticking a line updates the button to 3 lines', /Teach the bot 3 lines/.test(await t('#kbTeachBtn')), await t('#kbTeachBtn'));
    await page.click('#kbTeachBtn');
    const learned = await until(async () => { const x = (await q(`select id, status, facts_saved from public.kb_files where tenant_id=$1 and name='Timetable.png'`, [T]))[0]; return x && x.status === 'learned' ? x : null; });
    const ch2 = learned ? await chunks(learned.id) : [];
    rec('"Teach the bot" saves exactly the 3 ticked lines, with the corrected wording', !!learned && learned.facts_saved === 3 && (await allChunks()) === before + 3 && ch2.some((c) => /closed every Monday until noon/.test(c.content)) && ch2.every((c) => !/Rs 29,500|98765|pay\.example|ICM004|office@|1234567890123/.test(c.content)), ch2.map((c) => c.content.replace(/^From an uploaded file \("[^"]*"\)(, [^:]*)?: /, '').slice(0, 50)).join(' | '));
    await sleep(600);
    rec('the list shows the file as "Learned 3 facts"', /Timetable\.png.*Learned 3 facts/.test(await t('#kbFilesCard')) && (await page.locator('#kbReview').count()) === 0, (await t('#kbFilesCard')).match(/Timetable\.png.{0,90}/)?.[0] || '');
    await page.locator(`.kb-file[data-file="${learned.id}"] button`, { hasText: 'Show what the bot learned' }).click(); await sleep(800);
    const shown = await page.evaluate((id) => [...document.querySelectorAll(`.kb-file[data-file="${id}"] .kb-learned li`)].map((x) => x.textContent), learned.id);
    rec('"Show what the bot learned" lists the saved lines to staff', shown.length === 3 && shown.some((x) => /until noon/.test(x)) && shown.every((x) => !/^From an uploaded file/.test(x)), shown.join(' | ').slice(0, 200));
    const d0 = issues.dialogs.length;
    await page.locator(`.kb-file[data-file="${learned.id}"] button`, { hasText: 'Remove' }).click();
    const gone = await until(async () => ((await chunks(learned.id)).length === 0 ? true : null));
    await sleep(500);
    rec('Remove asks first, then the bot forgets the file and it leaves the list', !!gone && issues.dialogs.slice(d0).some((x) => /The bot will forget the 3 line\(s\)/.test(x)) && !/Timetable\.png/.test(await t('#kbFilesCard')), issues.dialogs.slice(d0).join(' ').slice(0, 100));

    // discard a review
    await page.setInputFiles('#kbFileInput', { name: 'Poster.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') }); await page.click('#kbReadBtn');
    await until(() => page.locator('#kbReview').count());
    const cb = await allChunks();
    await page.click('#kbDiscardBtn'); await sleep(1200);
    rec('Discard learns nothing and removes the file from the list', (await allChunks()) === cb && (await page.locator('#kbReview').count()) === 0 && !/Poster\.png/.test(await t('#kbFilesCard')), 'discarded');
    await page.setInputFiles('#kbFileInput', { name: 'letter.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('x') }); await sleep(500);
    rec('a Word file is refused in the popup with advice to save it as PDF, and "Read the file" stays disabled', /Save a Word file as PDF first/.test(await t('#kbFileErr')) && await page.locator('#kbReadBtn').isDisabled(), await t('#kbFileErr'));
    await page.click('#kbModalCancel');
  } finally {
    rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
    rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
    fake.stop(); await browser.close();
  }

  // ---------- K. front desk: can see the list, cannot upload; other clubs see nothing
  const b2 = await openBrowser(db, users); const p2 = await b2.context.newPage();
  await login(p2, 'qa-desk@club.test');
  await p2.evaluate(() => go('knowledge')); await sleep(1000);
  const desk = await p2.evaluate(async () => ({ list: /Rules\.csv/.test(document.getElementById('kbFilesCard')?.textContent || ''), upload: !!document.getElementById('kbUploadBtn'), remove: document.querySelectorAll('#kbFilesCard .link-btn.danger').length, write: (await sb.from('kb_files').insert({ tenant_id: TENANT_ID, name: 'sneak' }).select('id')).error?.message || 'INSERTED' }));
  b2.fake.stop(); await b2.browser.close();
  rec('front desk sees the list but has no Upload or Remove, and cannot write to the table directly', desk.list && !desk.upload && desk.remove === 0 && desk.write !== 'INSERTED', JSON.stringify(desk));
  void F2; void cfg;
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1500));
}
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} file-training checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
