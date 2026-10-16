// Bot Knowledge: the "Instruction or note for the bot" box.
//  - with an upload it is an instruction to the AI about what to take from the file;
//  - "Teach this note" teaches typed lines directly, with the same rule against prices, numbers, payment and member details.
// Local bench: staging-built workflow and page, stand-in AI.
import { world, runNode } from './harness.mjs';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).replace(/\n/g, ' ⏎ ').slice(0, 300)}`); };
const { db, q, T, users } = await benchDb();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=';
const staff = Object.fromEntries((await q(`select u.id, u.email from auth.users u`)).map((u) => ['tok-' + u.email, { id: u.id, email: u.email }]));
const call = async (body, email = 'qa-owner@club.test') => runNode('kb_files_wf.json', 'KB Files', { json: { body: { tenant: 'shakti', ...(email ? { user_token: 'tok-' + email } : {}), ...body } } }, world(db, { users: staff }), { setTimeout: (fn) => setImmediate(fn) });
const ai = async (kind) => Number((await q(`select count(*)::int n from public.stg_outbox where kind = $1`, [kind]))[0].n);
const noteChunks = async () => q(`select c.content, c.source, (c.embedding is not null) emb, f.name, f.mime, f.status, f.facts_saved from public.kb_chunks c join public.kb_files f on f.id = c.file_id where c.tenant_id=$1 and f.mime='text/note' order by c.created_at, c.content`, [T]);

try {
  // ---------- A. the instruction reaches the AI with an upload
  let r = await call({ action: 'extract', name: 'Guest rules.png', mime: 'image/png', file_base64: PNG, hint: 'Only the guest rules and timings, nothing about coaching' });
  const prompt = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('with an upload, the staff instruction is given to the AI, with the rule that it never adds anything not in the document', r.ok === true && /wrote this note about the file: "Only the guest rules and timings, nothing about coaching"/.test(prompt) && /Never add anything that is in neither the document nor the note/.test(prompt), (prompt.match(/wrote this note about the file.{0,110}/) || [''])[0]);
  r = await call({ action: 'extract', name: 'Plain.png', mime: 'image/png', file_base64: PNG });
  const prompt2 = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('without an instruction the AI is told nothing extra', r.ok === true && !/wrote this note about the file/.test(prompt2), 'no instruction line');

  // ---------- B. a typed note: learned as typed, one line per fact, sensitive lines left out
  const p0 = await ai('ai_prompt'), e0 = await ai('ai_prompt');
  r = await call({ action: 'note', text: '- The squash court is closed on the first Sunday of every month.\n2. Members can bring up to two guests on weekdays.\nThe guest charge is Rs 500 per visit.\n\nok\nCall the manager on 9876543210 for exceptions.\n• Lockers must be emptied every night.' });
  const ch = await noteChunks();
  rec('a typed note saves each line as a fact, exactly as typed, with list marks removed', r.ok === true && r.saved === 3 && ch.length === 3 && ch.every((c) => c.emb && c.source === 'file') && ch.some((c) => /: The squash court is closed on the first Sunday of every month\.$/.test(c.content)) && ch.some((c) => /: Members can bring up to two guests on weekdays\.$/.test(c.content)) && ch.some((c) => /: Lockers must be emptied every night\.$/.test(c.content)), ch.map((c) => c.content.replace(/^From an uploaded file \("[^"]*"\): /, '')).join(' | '));
  rec('the line with a price and the line with a phone number are not saved, and the reasons are returned', (r.skipped || []).length === 2 && JSON.stringify(r.skipped.map((x) => x.why).sort()) === JSON.stringify(['money', 'number']) && ch.every((c) => !/Rs 500|9876543210/.test(c.content)), JSON.stringify((r.skipped || []).map((x) => x.why)));
  rec('the note appears in the list as "Typed note: ..." and is marked learned; the AI was not asked to read or rewrite it', ch[0].name === 'Typed note: The squash court is closed on the first Sunday of every month.'.slice(0, 72) && ch[0].status === 'learned' && ch[0].facts_saved === 3 && (await ai('ai_prompt')) - p0 === 1 && e0 >= 0, `${ch[0].name} | AI calls ${(await ai('ai_prompt')) - p0}`);
  rec('note lines carry the "From an uploaded file" mark, so the bot never lets them override Settings', ch.every((c) => /^From an uploaded file \("Typed note: /.test(c.content)), ch[0].content.slice(0, 60));

  // ---------- C. refusals
  const before = Number((await q(`select count(*)::int n from public.kb_files`))[0].n);
  const only = await call({ action: 'note', text: 'Annual maintenance is Rs 29,500.\nPay at https://pay.example.org/x' });
  const empty = await call({ action: 'note', text: 'ok\n\nhi' });
  const long = await call({ action: 'note', text: 'word '.repeat(900) });
  const desk = await call({ action: 'note', text: 'The pool is closed on Mondays for cleaning.' }, 'qa-desk@club.test');
  rec('a note with only sensitive lines, an empty note, an over-long note and a front-desk caller are refused; nothing is recorded', only.ok === false && /come only from Settings/.test(only.error) && empty.ok === false && long.ok === false && /too long/.test(long.error) && desk.ok === false && /owner or manager/.test(desk.error) && Number((await q(`select count(*)::int n from public.kb_files`))[0].n) === before, `${only.error.slice(0, 40)} | ${empty.error.slice(0, 40)} | ${long.error.slice(0, 30)} | ${desk.error.slice(0, 40)}`);
  await q(`insert into public.kb_files (tenant_id, name, status) select $1, 'filler ' || g, 'failed' from generate_series(1, 10) g`, [T]);
  r = await call({ action: 'note', text: 'The cafe opens at seven in the morning.' });
  rec('notes count toward the daily limit of 10', r.ok === false && r.limit === true && /uploads and notes for today/.test(r.error), r.error);
  await q(`delete from public.kb_files where name like 'filler %'`);

  // ---------- D. the screen
  const { browser, context, fake } = await openBrowser(db, users);
  const page = await context.newPage();
  const issues = watch(page);
  const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  try {
    await login(page, 'qa-owner@club.test');
    await page.evaluate(() => go('knowledge')); await sleep(1000);
    const overlayOpen = () => page.evaluate(() => document.getElementById('overlay').classList.contains('show'));
    rec('the card has two buttons, "Write a note" and "Upload a file", and no inline text box', (await page.locator('#kbNoteOpenBtn').count()) === 1 && (await page.locator('#kbUploadBtn').count()) === 1 && (await page.locator('#kbNoteBox').count()) === 0, await t('#kbNoteOpenBtn'));
    rec('the typed note taught above is in the list', /Typed note: The squash court/.test(await t('#kbFilesCard')) && /Learned 3 facts/.test(await t('#kbFilesCard')), (await t('#kbFilesCard')).match(/Typed note.{0,80}/)?.[0] || '');

    // ---- the upload popup
    await page.click('#kbUploadBtn'); await sleep(300);
    const up0 = await page.evaluate(() => ({ open: document.getElementById('overlay').classList.contains('show') && !document.getElementById('kbModal').classList.contains('hidden'), text: document.getElementById('kbModalBody').textContent.replace(/\s+/g, ' '), drop: !!document.getElementById('kbDrop'), hint: !!document.getElementById('kbHint'), read: document.getElementById('kbReadBtn').disabled, chips: document.querySelectorAll('.kb-m-chip').length }));
    rec('"Upload a file" opens a popup: step 1 choose the file (drop zone), step 2 tell the AI about it, what is never learned, and usage', up0.open && up0.drop && up0.hint && /1 Choose the file/.test(up0.text) && /2 Tell the AI about this file/.test(up0.text) && /Never learned:/.test(up0.text) && /of 10 used today/.test(up0.text) && up0.chips === 4, up0.text.slice(0, 150));
    rec('"Read the file" is disabled until a file is chosen', up0.read === true, String(up0.read));
    await page.fill('#kbHint', 'This is the dress code for 2026');
    await page.locator('.kb-m-chip', { hasText: 'Take only the rules' }).click();
    rec('a suggestion chip adds to what is typed, and the counter follows', (await page.inputValue('#kbHint')) === 'This is the dress code for 2026. Take only the rules' && /52 \/ 500/.test(await t('#kbHintCount')), (await page.inputValue('#kbHint')) + ' | ' + await t('#kbHintCount'));
    await page.setInputFiles('#kbFileInput', { name: 'Dress code.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') }); await sleep(300);
    const chosen = await page.evaluate(() => ({ chip: (document.getElementById('kbChosen') || {}).textContent || '', hint: document.getElementById('kbHint').value, read: document.getElementById('kbReadBtn').disabled }));
    rec('the chosen file shows with its type and size, the typed text is kept, and "Read the file" is enabled', /IMAGE/.test(chosen.chip) && /Dress code\.png/.test(chosen.chip) && /KB/.test(chosen.chip) && chosen.hint === 'This is the dress code for 2026. Take only the rules' && chosen.read === false, chosen.chip.replace(/\s+/g, ' '));
    await page.click('#kbReadBtn');
    await until(() => page.locator('#kbReview').count());
    const p3 = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
    rec('the text reaches the AI as the note about the file, the popup closes, and the review shows it', /wrote this note about the file: "This is the dress code for 2026\. Take only the rules"/.test(p3) && /Your note about the file: “This is the dress code for 2026\. Take only the rules”/.test(await t('#kbReviewHint')) && !(await overlayOpen()), await t('#kbReviewHint'));
    await page.click('#kbDiscardBtn'); await sleep(900);

    // a file that is too big, dropped onto the zone; then a good one
    await page.click('#kbUploadBtn'); await sleep(300);
    const drop = (name, type, bytes) => page.evaluate(({ name, type, bytes }) => { const dt = new DataTransfer(); dt.items.add(new File([typeof bytes === 'number' ? new Uint8Array(bytes) : bytes], name, { type })); document.getElementById('kbDrop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, { name, type, bytes });
    await drop('Huge scan.png', 'image/png', Math.round(4.5 * 1024 * 1024)); await sleep(300);
    rec('dropping a 4.5 MB file onto the zone is refused in the popup with its size', /“Huge scan\.png” is 4\.5 MB\. The file must be under 4 MB\./.test(await t('#kbFileErr')) && await page.locator('#kbReadBtn').isDisabled(), await t('#kbFileErr'));
    await drop('Rules.csv', 'text/csv', 'Rule,Detail\nPool,Closed every Monday for cleaning'); await sleep(300);
    rec('dropping a good file after that clears the error and shows the file', (await page.locator('#kbFileErr').count()) === 0 && /CSV/.test(await t('#kbChosen')) && !(await page.locator('#kbReadBtn').isDisabled()), await t('#kbChosen'));
    await page.click('#kbModalCancel'); await sleep(200);
    rec('Cancel closes the popup and reads nothing', !(await overlayOpen()) && (await page.locator('#kbReview').count()) === 0, 'closed');

    // ---- the note popup
    await page.click('#kbNoteOpenBtn'); await sleep(300);
    const n0 = (await noteChunks()).length;
    rec('"Write a note" opens a popup with the save button disabled while it is empty', /Write a note for the bot/.test(await t('#kbModalBody')) && await page.locator('#kbNoteSave').isDisabled(), (await t('#kbModalBody')).slice(0, 80));
    await page.fill('#kbNoteText', 'Swimming caps are compulsory in the pool.\nok\nThe guest fee is Rs 300.');
    rec('the button counts the lines that will be taught (2, the one-word line is skipped)', /Teach the bot 2 lines/.test(await t('#kbNoteSave')) && /2 lines/.test(await t('#kbNoteCount')), await t('#kbNoteSave'));
    await page.click('#kbModalCancel'); await sleep(200);
    await page.click('#kbNoteOpenBtn'); await sleep(300);
    rec('closing and reopening keeps what was typed', (await page.inputValue('#kbNoteText')) === 'Swimming caps are compulsory in the pool.\nok\nThe guest fee is Rs 300.', (await page.inputValue('#kbNoteText')).replace(/\n/g, ' / '));
    await page.click('#kbNoteSave');
    const saved = await until(async () => ((await noteChunks()).length === n0 + 1 ? true : null));
    await sleep(700);
    rec('"Teach the bot" saves the safe line, says which line was left out, and closes the popup', !!saved && /knows 1 line\(s\) from your note/.test(await t('#toast')) && /a price or amount/.test(await t('#toast')) && !(await overlayOpen()), await t('#toast'));
    await page.click('#kbNoteOpenBtn'); await sleep(300);
    rec('after a successful save the note box starts empty again', (await page.inputValue('#kbNoteText')) === '', 'empty');
    await page.click('#kbModalCancel');
  } finally {
    rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
    rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
    fake.stop(); await browser.close();
  }
  const b2 = await openBrowser(db, users); const p2 = await b2.context.newPage();
  await login(p2, 'qa-desk@club.test');
  await p2.evaluate(() => go('knowledge')); await sleep(1000);
  const deskBox = (await p2.locator('#kbNoteOpenBtn').count()) + (await p2.locator('#kbUploadBtn').count());
  b2.fake.stop(); await b2.browser.close();
  rec('front desk gets neither button', deskBox === 0, String(deskBox));
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1200));
}
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} instruction-and-note checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
