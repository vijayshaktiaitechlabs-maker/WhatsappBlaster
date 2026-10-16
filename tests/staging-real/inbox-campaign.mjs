// REAL-mode end-to-end on STAGING: staging page (preview), staging Supabase, [STAGING] n8n, Meta TEST number, the user's own phone.
// Every check is verified in the database and from Meta's own events, not from what the page says.
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simContext, metaEvent, postEvent } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url)); const SP = HERE + 'out/'; mkdirSync(SP, { recursive: true });
const BASE = `http://127.0.0.1:${process.env.PORT || 8788}`;
const login = JSON.parse(readFileSync(HERE + '../../tools/qa-login.local.json', 'utf8'));
const ctx = simContext(); const S = ctx.S;
if (/ttpecupfolgbbdagkotc/.test(S.url)) throw new Error('refusing: live project');
if (S.wa && S.wa.simulate) throw new Error('simulate is on: this suite is for real Meta mode');
const PHONE = S.phones[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (area, test, ok, ev = '') => { results.push({ area, test, ok, ev: String(ev).slice(0, 300) }); console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(ev).slice(0, 230)}`); };
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}`, 'Content-Type': 'application/json' };
const rest = async (path, opts = {}) => { const r = await fetch(`${S.url}/rest/v1/${path}`, { headers: { ...H, ...(opts.headers || {}) }, ...opts }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const [tenant] = await rest('tenants?slug=eq.shakti&select=id');
const T = tenant.id;
const stamp = Date.now().toString(36);
const msgBy = async (filter) => (await rest(`wa_messages?tenant_id=eq.${T}&${filter}&order=created_at.desc&limit=1&select=*`))[0];
const waitRow = async (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(3000); } return null; };
const asIST = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage(); const errs = []; const dialogs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/storage\/v1|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const waitFor = (fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const resetPause = () => rest(`wa_conversations?tenant_id=eq.${T}&phone_key=eq.${PHONE}`, { method: 'PATCH', body: JSON.stringify({ bot_paused: false, bot_paused_until: null, status: 'open' }) });

try {
  await resetPause();
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  await page.fill('#email', login.email); await page.fill('#password', login.password); await page.click('#authBtn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(2500);

  // ---------- A. BOT, inbound simulated (real inbound needs the phone), outbound REAL, delivery REAL
  await page.evaluate(() => go('inbox')); await sleep(1500);
  await page.evaluate((k) => selectChat(k), PHONE); await sleep(1500);
  await postEvent(ctx, metaEvent(S, { from: PHONE, text: 'hi ' + stamp }));
  const botRow = await waitRow(async () => { const r = await msgBy(`direction=eq.out&sender_kind=eq.bot&created_at=gt.${new Date(Date.now() - 40000).toISOString()}`); return r && r.wamid && !String(r.wamid).startsWith('wamid.SIM') ? r : null; }, 60000);
  rec('Bot', 'a member "hi" gets a real bot reply accepted by Meta (real wamid)', !!botRow, botRow ? `status ${botRow.status}, wamid ${String(botRow.wamid).slice(0, 14)}…` : 'no real reply stored');
  const botDelivered = botRow && await waitRow(async () => { const r = (await rest(`wa_messages?id=eq.${botRow.id}&select=status,error_code`))[0]; return r && ['delivered', 'read'].includes(r.status) ? r : (r && r.status === 'failed' ? r : null); }, 90000);
  rec('Delivery (Meta event)', 'Meta\'s own "delivered" report reached the staging webhook and updated the bot message', !!botDelivered && ['delivered', 'read'].includes(botDelivered.status), botDelivered ? `status ${botDelivered.status}${botDelivered.error_code ? ' error ' + botDelivered.error_code : ''}` : 'no status event within 90 s');

  // ---------- B. Inbox reply, REAL send, ticks on screen
  await page.evaluate((k) => selectChat(k), PHONE); await sleep(1200);
  await page.fill('#inboxReplyInput', 'Real E2E Inbox reply ' + stamp);
  await page.click('#inboxSendBtn');
  const reply = await waitRow(async () => { const r = await msgBy(`direction=eq.out&sender_kind=eq.staff&body=eq.${encodeURIComponent('Real E2E Inbox reply ' + stamp)}`); return r; }, 40000);
  rec('Inbox', 'staff reply is stored with the sender and a real wamid', !!reply && !!reply.wamid && !String(reply.wamid).startsWith('wamid.SIM') && !!reply.sender_email, reply ? `sender ${reply.sender_email}, status ${reply.status}` : 'not stored');
  const replyFinal = reply && await waitRow(async () => { const r = (await rest(`wa_messages?id=eq.${reply.id}&select=status,error_code,error_title`))[0]; return r && ['delivered', 'read', 'failed'].includes(r.status) ? r : null; }, 90000);
  rec('Inbox ticks', 'the reply\'s status comes from Meta (delivered/read), not from the page', !!replyFinal && ['delivered', 'read'].includes(replyFinal.status), replyFinal ? `status ${replyFinal.status}${replyFinal.error_title ? ' ' + replyFinal.error_title : ''}` : 'no status');
  await sleep(2500);
  const tick = await page.evaluate((id) => { const m = (typeof ACTIVE_MSGS !== 'undefined' ? ACTIVE_MSGS : []).find((x) => x.id === id); const els = [...document.querySelectorAll('#inboxMessageScroll .inbox-bubble')]; const b = els.find((e) => e.textContent.includes('Real E2E Inbox reply')); const st = b && b.querySelector('.inbox-st, .inbox-failed'); return { status: m && m.status, label: st ? (st.getAttribute('aria-label') || st.textContent) : null }; }, reply && reply.id);
  rec('Inbox ticks', 'the page shows two ticks (Delivered/Read) for it, live, without reloading', /Delivered|Read/.test(tick.label || ''), JSON.stringify(tick));
  await resetPause();

  // ---------- C. FAILED shown with Meta's/guard's reason (a number that is not a test phone)
  await page.evaluate(() => { INBOX_CHATS; });
  const diya = (await rest(`wa_conversations?tenant_id=eq.${T}&phone_key=eq.910000000002&select=phone_key`))[0];
  if (diya) {
    /* the seed chat ages: reopen its 24-hour window (staging row only) so the free-text box is offered and the guard is what stops the send */
    await rest(`wa_conversations?tenant_id=eq.${T}&phone_key=eq.910000000002`, { method: 'PATCH', body: JSON.stringify({ last_inbound_at: new Date().toISOString() }) });
    await page.evaluate(() => loadInboxList(true)); await sleep(1500);
    await page.evaluate(() => selectChat('910000000002')); await sleep(1200);
    await page.fill('#inboxReplyInput', 'Should be blocked ' + stamp); await page.click('#inboxSendBtn'); await sleep(4000);
    const bubble = await page.evaluate(() => { const els = [...document.querySelectorAll('#inboxMessageScroll .inbox-bubble')]; const b = els.find((e) => e.textContent.includes('Should be blocked')); return b ? b.textContent.replace(/\s+/g, ' ').trim() : null; });
    rec('Safety', 'a message to a number outside the test list is blocked and shown FAILED with the reason', /FAILED/.test(bubble || '') && /STAGING GUARD|not a test phone|Not delivered/.test(bubble || ''), (bubble || '').slice(0, 160));
  } else rec('Safety', 'blocked-number check', null, 'seed conversation missing');

  // ---------- D. Excel sheet campaign (same phone twice, phone 2 not yet in Meta list, non-test number, invalid number)
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(900);
  await page.evaluate(() => setAudSource('sheet')); await sleep(300);
  await page.setInputFiles('#sheetFile', HERE + '../../staging/test-sheets/campaign-test.xlsx'); await sleep(1800);
  const parsed = await page.evaluate(() => CMP.customRecipients.map((r) => `${r.row_no}:${r.phone}:${r.row_cols.Due}`));
  rec('Excel upload', 'the .xlsx is read: rows 2-5 kept, the invalid row 6 skipped, repeated number noted', parsed.length === 4 && /already on an earlier row/.test(await t('#sheetInfoBox')), parsed.join(' | '));
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarSrc('3', 'col:Due'); setVarText('2', '2026-27'); setVarText('4', 'Please clear your dues at the office.'); }); await sleep(500);
  await page.fill('#c_name', 'Real E2E sheet ' + stamp);
  const tSend = Date.now();
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 120000);
  const sres = await t('#cmpResult');
  const [camp] = await rest(`broadcasts?tenant_id=eq.${T}&title=eq.${encodeURIComponent('Real E2E sheet ' + stamp)}&select=id,body,status`);
  const recips = JSON.parse(camp.body).recipients || [];
  const r2 = recips.find((r) => r.row_no === 2), r3 = recips.find((r) => r.row_no === 3), r4 = recips.find((r) => r.row_no === 4), r5 = recips.find((r) => r.row_no === 5);
  rec('Campaign (sheet)', 'rows 2 and 3 (same phone) were both sent as separate real messages with their own amounts', !!(r2 && r3 && r2.wamid && r3.wamid && r2.wamid !== r3.wamid), `row2 ${r2 && r2.status}, row3 ${r3 && r3.status}; result: ${sres.slice(0, 80)}`);
  rec('Campaign (sheet)', 'row 5 (not a test phone) is blocked with the guard\'s reason; row 4 (phone 2) fails with Meta\'s reason until it is added to the recipient list', !!(r5 && r5.status === 'failed' && /STAGING GUARD/.test(r5.error || '')) && !!(r4 && (r4.status === 'failed' ? /131030|allowed list|recipient/i.test(r4.error || '') : true)), `row4: ${r4 && r4.status} ${String(r4 && r4.error || '').slice(0, 70)} | row5: ${r5 && r5.status}`);
  const gap = r2 && r3 && r2.sent_at && r3.sent_at ? (new Date(r3.sent_at) - new Date(r2.sent_at)) / 1000 : null;
  rec('Campaign (sheet)', 'the two messages to one phone are at least 6 seconds apart (Meta\'s pacing)', gap !== null && gap >= 6, gap === null ? 'no timestamps' : `${gap.toFixed(1)} s`);

  // ---------- E. Campaign report fills from Meta's real events
  const delivered = await waitRow(async () => { const rows = await rest(`wa_message_status?wamid=in.(${[r2, r3].filter(Boolean).map((r) => r.wamid).join(',')})&select=wamid,status`); return rows.length === 2 && rows.every((x) => ['delivered', 'read'].includes(x.status)) ? rows : null; }, 100000);
  rec('Report', 'Meta\'s delivered events for both sheet messages reached staging', !!delivered, delivered ? delivered.map((x) => x.status).join(', ') : 'not both delivered within 100 s');
  await page.evaluate((id) => { closeComposer && closeComposer(); openReport(id); }, camp.id); await sleep(3500);
  const rep = await t('#reportBody');
  const deliveredCount = Number((rep.match(/Delivered to the phone\s*(\d+)/) || [])[1] || (rep.match(/(\d+)\s*DELIVERED/i) || [])[1] || 0);
  rec('Report', 'the campaign report shows the delivered count and the failed rows with their reasons', deliveredCount >= 2 && /STAGING GUARD|not a test phone/.test(rep), `delivered ${deliveredCount}; ${rep.slice(0, 140)}`);
  await page.evaluate(() => closeReport && closeReport());
  await page.screenshot({ path: SP + 'real-e2e.png' });
} catch (e) {
  rec('Run', 'finished without a script error', false, e.message);
  await page.screenshot({ path: SP + 'real-e2e-error.png' }).catch(() => {});
}
rec('Page health', 'no script errors on the page', !errs.length, errs.slice(0, 3).join(' | ') || 'none');
writeFileSync(SP + 'real-e2e-results.json', JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} PASS, ${results.filter((r) => r.ok === false).length} FAIL, ${results.filter((r) => r.ok === null).length} SKIP`);
await browser.close(); process.exit(0);
