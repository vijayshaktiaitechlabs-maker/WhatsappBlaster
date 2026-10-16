// REAL-mode: a long campaign through the real server. 14 sheet rows with the SAME test phone (your own) means 14 rounds
// 6.5 s apart (about 95 s), longer than most proxies allow for one request. Checks: the browser gets the answer (or the
// page follows the running send), a second "Send now" during the run is refused, every row is sent exactly once.
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simContext } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url)); const SP = HERE + 'out/'; mkdirSync(SP, { recursive: true });
const BASE = `http://127.0.0.1:${process.env.PORT || 8788}`;
const login = JSON.parse(readFileSync(HERE + '../../tools/qa-login.local.json', 'utf8'));
const ctx = simContext(); const S = ctx.S;
if (/ttpecupfolgbbdagkotc/.test(S.url) || (S.wa && S.wa.simulate)) throw new Error('refusing');
const PHONE = S.phones[0]; const ROWS = Number(process.env.ROWS || 14);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const rec = (area, test, ok, ev = '') => { results.push({ area, test, ok, ev: String(ev).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(ev).slice(0, 230)}`); };
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}`, 'Content-Type': 'application/json' };
const rest = async (path, opts = {}) => { const r = await fetch(`${S.url}/rest/v1/${path}`, { headers: { ...H, ...(opts.headers || {}) }, ...opts }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const [tenant] = await rest('tenants?slug=eq.shakti&select=id'); const T = tenant.id;
const stamp = Date.now().toString(36);
const csv = 'Name,Mobile,Due\n' + Array.from({ length: ROWS }, (_, i) => `Row ${i + 2},${PHONE},₹${100 + i}`).join('\n') + '\n';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200))); page.on('dialog', async (d) => { await d.accept(); });
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
try {
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  await page.fill('#email', login.email); await page.fill('#password', login.password); await page.click('#authBtn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(2500);
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(900);
  await page.evaluate(() => setAudSource('sheet')); await sleep(300);
  await page.setInputFiles('#sheetFile', { name: 'long.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await sleep(1500);
  const parsed = await page.evaluate(() => CMP.customRecipients.length);
  rec('Long send', `the ${ROWS}-row sheet (one phone, ${ROWS} rows) is read`, parsed === ROWS, `${parsed} rows`);
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarSrc('3', 'col:Due'); setVarText('2', '2026-27'); setVarText('4', 'Long-send test.'); }); await sleep(400);
  const title = 'Real long send ' + stamp; await page.fill('#c_name', title);
  const t0 = Date.now();
  await page.click('#cmpSendBtn');
  await sleep(12000);
  const [row] = await rest(`broadcasts?tenant_id=eq.${T}&title=eq.${encodeURIComponent(title)}&select=id,status,sent_at`);
  rec('Long send', 'while sending, the row is claimed (status sending, start time set)', !!row && row.status === 'sending' && !!row.sent_at, JSON.stringify(row));
  // a second "Send now" from another tab while the first is running
  const page2 = await context.newPage(); await page2.goto(BASE + '/admin/', { waitUntil: 'networkidle' }); await page2.waitForSelector('#app:not(.hidden)', { timeout: 30000 }).catch(() => {}); await sleep(2000);
  const second = await page2.evaluate(async (id) => { const { data: { session } } = await sb.auth.getSession(); const r = await fetch(BROADCAST_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: 'shakti', dry_run: false, broadcast_id: id, template: 'dues_reminder', language: 'en', vars: {}, custom_recipients: [{ phone: '919999900001' }], user_token: session.access_token }) }); return r.json(); }, row.id);
  rec('Double send', 'a second "Send now" of the same campaign during the run is refused by the server', second.ok === false && second.already_sending === true, String(second.error || JSON.stringify(second)).slice(0, 120));
  await page2.close();
  const done = await page.waitForFunction(() => /Sent to|Finished|failed|⚠️|dropped/.test(document.getElementById('cmpResult').textContent), null, { timeout: 15 * 60 * 1000 }).then(() => true).catch(() => false);
  const secs = (Date.now() - t0) / 1000; const res = await t('#cmpResult');
  rec('Long send', `the page shows the result after ${secs.toFixed(0)} s (answer kept open by the server, or followed from the row)`, done && /Sent to|Finished/.test(res), res.slice(0, 160));
  const [fin] = await rest(`broadcasts?id=eq.${row.id}&select=status,body`);
  const recips = JSON.parse(fin.body).recipients || []; const wamids = new Set(recips.map((r) => r.wamid).filter(Boolean));
  const msgs = await rest(`wa_messages?tenant_id=eq.${T}&sender_kind=eq.campaign&wamid=in.(${[...wamids].join(',')})&select=id`);
  rec('Long send', `every row was sent exactly once (${ROWS} real messages, no duplicates)`, fin.status === 'sent' && recips.filter((r) => r.status === 'sent').length === ROWS && wamids.size === ROWS && msgs.length === ROWS, `status ${fin.status}; sent rows ${recips.filter((r) => r.status === 'sent').length}; distinct wamids ${wamids.size}; stored ${msgs.length}`);
  const gaps = recips.map((r) => new Date(r.sent_at).getTime()).sort((a, b) => a - b); const minGap = Math.min(...gaps.slice(1).map((v, i) => (v - gaps[i]) / 1000));
  rec('Long send', 'messages to the same phone were at least 6 s apart', minGap >= 6, `smallest gap ${minGap.toFixed(1)} s`);
  rec('Page health', 'no script errors', !errs.length, errs.join(' | ') || 'none');
} catch (e) { rec('Run', 'finished without a script error', false, e.message); }
writeFileSync(SP + 'long-send-results.json', JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} PASS, ${results.filter((r) => !r.ok).length} FAIL`);
await browser.close(); process.exit(0);
