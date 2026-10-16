// 1. The manual "dues pending" switch: Customer 360, the member form, the database's own guard and stamp, the audience rule.
// 2. The bot answers a thank-you / acknowledgement in one short line and adds no club information.
// Local bench: staging-built bot and page, simulated Meta; nothing external is called.
import { world, metaItem, cfg, benchCode } from './harness.mjs';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).replace(/\n/g, ' ⏎ ').slice(0, 300)}`); };
const { db, q, T, users } = await benchDb();
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const PNID = cfg.whatsapp.phoneNumberId;
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFn('$input', 'Buffer', 'setTimeout', benchCode('wa_bot_wf.json', 'Bot Engine'));
const run = async (body) => { const w = world(db); const item = metaItem(w, body); const out = await engine.call({ helpers: w.helpers }, { first: () => item }, Buffer, setTimeout); return out[0].json; };
let seq = 0; const now = () => String(Math.floor(Date.now() / 1000));
const ev = (msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: msg.from }], messages: [msg] } }] }] });
const aiCount = async () => Number((await q(`select count(*)::int n from public.stg_outbox where kind='ai_prompt'`))[0].n);
const lastOut = async () => (await q(`select * from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
const say = async (t) => { const a0 = await aiCount(); await run(ev({ from: PHONE, id: `wamid.QAACK.${++seq}`, timestamp: now(), type: 'text', text: { body: t } })); const o = await lastOut(); return { type: o.payload.type, text: (o.payload.text && o.payload.text.body) || (o.payload.interactive && o.payload.interactive.body && o.payload.interactive.body.text) || '', ai: (await aiCount()) - a0 }; };
const [mem] = await q(`select id, full_name from public.members where tenant_id=$1 and regexp_replace(phone,'\\D','','g') like '%' || $2 limit 1`, [T, PHONE.slice(-10)]);
const first = String(mem.full_name).trim().split(/\s+/)[0];

try {
  // ---------- A. the user's case, and its relatives
  let r = await say('Thanks for the reminder, will clear it out 👍🏽');
  rec('"Thanks for the reminder, will clear it out" gets one short thank-you, with no timings or other club information, and the AI is not asked', r.type === 'text' && r.text === `Thank you, ${first}! We are here if you need anything.` && r.ai === 0 && !/timing|AM|PM|open/i.test(r.text), r.text);
  const acks = ['ok', 'Noted, thank you', 'will pay tomorrow', '👍', 'thik che', 'Great, thanks a lot'];
  const got = []; for (const a of acks) got.push(await say(a));
  rec('"ok", "noted", "will pay tomorrow", a thumbs-up and "thik che" all get the same short line', got.every((x) => x.ai === 0 && /^Thank you, /.test(x.text) && x.text.length < 70), got.map((x) => x.text.slice(0, 24) + '/' + x.ai).join(' | '));
  r = await say('Payment done');
  rec('"Payment done" is thanked and asked for the payment screenshot', r.ai === 0 && /send the payment screenshot/.test(r.text) && /update your account/.test(r.text), r.text);
  r = await say('I have not paid yet');
  rec('"I have not paid yet" is NOT treated as a payment or a thank-you (the AI answers)', r.ai >= 1, `ai ${r.ai} | ${r.text.slice(0, 60)}`);

  // ---------- B. anything that asks something still goes to the AI
  const asks = ['ok what are the timings', 'thanks, can I pay by cheque?', 'thank you, I need a receipt', 'ok send me the bill', 'is the pool open', 'Good morning'];
  const gotQ = []; for (const a of asks) gotQ.push(await say(a));
  rec('a question or request after "ok" / "thanks" is still answered by the AI', gotQ.every((x) => x.ai >= 1), gotQ.map((x) => x.ai).join(','));
  await q(`insert into public.wa_messages (tenant_id, phone, direction, body, sender_kind) values ($1,$2,'out','Shall I connect you with our team?','bot')`, [T, PHONE]);
  r = await say('ok');
  rec('"ok" right after the bot asked a question is an answer, so the AI handles it', r.ai >= 1, `ai ${r.ai}`);
  await say('what are your timings?');
  const prompt = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('the AI is told to give information only when asked, and one short line for a thank-you', /Give information ONLY when it was asked for/.test(prompt) && /add NO club information/.test(prompt), (prompt.match(/Give information ONLY.{0,90}/) || [''])[0]);

  // ---------- C. the database: the mark, its stamp and its guard
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='members' and column_name like 'dues_%' order by 1`)).map((x) => x.column_name);
  rec('members has dues_pending, dues_marked_at and dues_marked_by', ['dues_marked_at', 'dues_marked_by', 'dues_pending'].every((c) => cols.includes(c)), cols.join(','));
  await q(`update public.members set dues_amount=0, maintenance_paid_till=current_date - 9, dues_pending=null where id=$1`, [mem.id]);

  // ---------- D. Customer 360
  const { browser, context, fake } = await openBrowser(db, users);
  const page = await context.newPage();
  const issues = watch(page);
  const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  const card = () => page.evaluate(() => { const c = document.getElementById('duesCtxCard'); return c ? { state: c.dataset.dues, text: c.textContent.replace(/\s+/g, ' ').trim(), on: (document.getElementById('duesSwitch') || {}).checked, auto: !!document.getElementById('duesAuto') } : null; });
  const dbm = async () => (await q(`select dues_pending, dues_marked_by, dues_marked_at, dues_amount from public.members where id=$1`, [mem.id]))[0];
  try {
    await login(page, 'qa-owner@club.test');
    await page.evaluate(() => go('inbox')); await sleep(800);
    await page.evaluate((k) => selectChat(k), PHONE); await sleep(1500);
    let c = await card();
    rec('a paid-till date in the past now shows "Pending" (it used to say "Nothing pending"), with the switch on', !!c && c.state === 'pending' && /Paid till .* which has passed/.test(c.text) && c.on === true && !c.auto, c ? c.text.slice(0, 140) : 'no card');

    await page.uncheck('#duesSwitch');
    let d = await until(async () => { const x = await dbm(); return x.dues_pending === false ? x : null; });
    await sleep(500); c = await card();
    rec('switching it OFF saves "paid" on the member, stamped with who and when by the database', !!d && d.dues_marked_by === 'qa-owner@club.test' && !!d.dues_marked_at, d ? `${d.dues_pending} by ${d.dues_marked_by}` : 'not saved');
    rec('the card turns green: "Nothing pending", "Marked as paid by qa-owner", and offers "Automatic"', !!c && c.state === 'paid' && /Nothing pending/.test(c.text) && /Marked as paid by qa-owner on /.test(c.text) && c.on === false && c.auto, c ? c.text.slice(0, 140) : '');

    await page.check('#duesSwitch');
    d = await until(async () => { const x = await dbm(); return x.dues_pending === true ? x : null; });
    await sleep(500); c = await card();
    rec('switching it ON saves "pending"; the card is red and shows "Pending" (no "₹0")', !!d && !!c && c.state === 'pending' && /Marked as pending by qa-owner/.test(c.text) && !/₹0/.test(c.text), c ? c.text.slice(0, 140) : '');
    const audit = await q(`select detail from public.audit_log where tenant_id=$1 and entity='member' and entity_id=$2 order by created_at desc limit 1`, [T, mem.id]).catch(() => []);
    rec('the change is written to the audit log', audit.length === 1 && /dues_pending_after/.test(JSON.stringify(audit[0].detail)), JSON.stringify(audit[0] && audit[0].detail).slice(0, 120));

    // the reminder text for a member marked pending without an amount
    await page.evaluate((id) => sendDirectDuesReminder(id), mem.id); await sleep(800);
    const rem = await page.inputValue('#inboxReplyInput');
    rec('the Reminder button writes "your … are pending" without "of ₹0"', /are pending\./.test(rem) && !/₹0/.test(rem), rem.slice(0, 140));
    await page.fill('#inboxReplyInput', '');

    // the audience rule, page and server
    const aud = await page.evaluate(async (id) => {
      const due = resolveAudience({ dues: 'due' }).some((m) => m.id === id), paid = resolveAudience({ dues: 'paid' }).some((m) => m.id === id);
      const tok = (await sb.auth.getSession()).data.session.access_token;
      const ask = async (dues) => (await (await fetch(BROADCAST_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: 'shakti', dry_run: true, template: 'dues_reminder', user_token: tok, audience_source: 'crm', segment: { dues } }) })).json());
      const sd = await ask('due'), sp = await ask('paid');
      return { due, paid, pageDue: reachableOf(resolveAudience({ dues: 'due' })).length, serverDue: sd.reachable_count != null ? sd.reachable_count : sd.audience_count, pagePaid: reachableOf(resolveAudience({ dues: 'paid' })).length, serverPaid: sp.reachable_count != null ? sp.reachable_count : sp.audience_count, err: sd.error || sp.error || '' };
    }, mem.id);
    rec('a member marked pending is in the "dues pending" audience and not in "paid"; the server counts the same as the page', aud.due && !aud.paid && aud.pageDue === aud.serverDue && aud.pagePaid === aud.serverPaid && !aud.err, JSON.stringify(aud));

    await page.click('#duesAuto');
    d = await until(async () => { const x = await dbm(); return x.dues_pending === null ? x : null; });
    await sleep(500); c = await card();
    rec('"Automatic" hands the decision back to the amount and the paid-till date', !!d && !!c && c.state === 'pending' && /which has passed/.test(c.text) && !c.auto, c ? c.text.slice(0, 120) : '');

    // the member form
    await page.evaluate((id) => openMember(id), mem.id); await sleep(1000);
    rec('the member form has a "Dues status" choice, on Automatic', (await page.inputValue('#f_dues_pending')) === '' && await page.locator('#fld_dues_pending').isVisible(), await page.inputValue('#f_dues_pending'));
    await page.selectOption('#f_dues_pending', '0');
    await page.click('#mSave');
    d = await until(async () => { const x = await dbm(); return x.dues_pending === false ? x : null; });
    rec('choosing "Paid" in the member form saves it too', !!d, d ? String(d.dues_pending) : 'not saved');
    await page.evaluate(() => { try { closeModal(); } catch (e) {} });

    // a member with nothing recorded
    await q(`update public.members set dues_amount=0, maintenance_paid_till=null, dues_pending=null where id=$1`, [mem.id]);
    await page.evaluate(async () => { await refresh(['members']); renderCustomer360(ACTIVE_CHAT); }); await sleep(800);
    c = await card();
    rec('a member with no amount and no paid-till date shows "Not recorded" instead of a green "Nothing pending"', !!c && c.state === 'none' && /Not recorded/.test(c.text) && c.on === false, c ? c.text.slice(0, 120) : '');

    // ---------- E. front desk: no money card, and the database refuses the change
    const b2 = await openBrowser(db, users);
    const p2 = await b2.context.newPage();
    await login(p2, 'qa-desk@club.test');
    await p2.evaluate(() => go('inbox')); await sleep(800);
    await p2.evaluate((k) => selectChat(k), PHONE); await sleep(1200);
    const desk = await p2.evaluate(async (id) => { const r = await sb.from('members').update({ dues_pending: true }).eq('id', id).select('id'); return { card: !!document.getElementById('duesCtxCard'), err: r.error ? r.error.message : '', rows: (r.data || []).length }; }, mem.id);
    d = await dbm();
    b2.fake.stop(); await b2.browser.close();
    rec('front desk sees no dues card, and the database refuses a direct change', !desk.card && (/Only owners, managers and accounts can change dues/.test(desk.err) || desk.rows === 0) && d.dues_pending === null, JSON.stringify(desk));
  } finally {
    rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
    rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
    fake.stop(); await browser.close();
  }
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1500));
}
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} dues-switch and acknowledgement checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
