// REAL-mode: batches on the real server. A 7-row sheet to your own phone with a test-copy batch size of 3: the first
// call sends 3 and answers partial; a resume sends 3 more; then the row is left "quiet" and the [STAGING] scheduler
// (every 5 minutes) sends the last row by itself. Every row exactly once. (The batch size knob exists only in the
// test copy; live always uses 120.)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simContext } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url)); const SP = HERE + 'out/'; mkdirSync(SP, { recursive: true });
const ctx = simContext(); const S = ctx.S;
if (/ttpecupfolgbbdagkotc/.test(S.url) || (S.wa && S.wa.simulate)) throw new Error('refusing');
const PHONE = S.phones[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const rec = (test, ok, ev = '') => { results.push({ test, ok, ev: String(ev).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(ev).slice(0, 230)}`); };
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}`, 'Content-Type': 'application/json' };
const rest = async (path, opts = {}) => { const r = await fetch(`${S.url}/rest/v1/${path}`, { headers: { ...H, Prefer: 'return=representation', ...(opts.headers || {}) }, ...opts }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const [tenant] = await rest('tenants?slug=eq.shakti&select=id'); const T = tenant.id;
// a staff login for the webhook (the QA owner)
const login = JSON.parse(readFileSync(HERE + '../../tools/qa-login.local.json', 'utf8'));
const auth = await (await fetch(`${S.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: S.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: login.email, password: login.password }) })).json();
if (!auth.access_token) throw new Error('QA login failed: ' + JSON.stringify(auth).slice(0, 120));
const WEBHOOK = 'https://n8n.example.com/webhook/stg-broadcast-send';
const send = async (body) => (await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const stamp = Date.now().toString(36);
const recips = Array.from({ length: 7 }, (_, i) => ({ phone: PHONE, full_name: 'Batch row ' + (i + 2), row_no: i + 2, row_cols: { Due: '₹' + (200 + i) } }));
const config = { template: 'dues_reminder', language: 'en', vars: { 1: { src: 'col:Name' }, 2: { src: 'custom', text: '2026-27' }, 3: { src: 'col:Due' }, 4: { src: 'custom', text: 'Batch test ' + stamp }, 5: { src: 'nothing' }, 6: { src: 'nothing' } }, custom_recipients: recips, segment: { source: 'custom_sheet' } };
const [row] = await rest('broadcasts', { method: 'POST', body: JSON.stringify({ tenant_id: T, title: 'Real batches ' + stamp, template_name: 'dues_reminder', audience: 'Sheet (7)', status: 'sending', body: JSON.stringify(config) }) });
const bid = row.id;
const rowNow = async () => { const [r] = await rest(`broadcasts?id=eq.${bid}&select=status,sent_count,body`); return { ...r, cfg: JSON.parse(r.body || '{}') }; };
const base = { tenant: 'shakti', dry_run: false, broadcast_id: bid, ...config, audience_source: 'sheet', user_token: auth.access_token, batch_size: 3 };
const t0 = Date.now();
const a1 = await send(base); let r1 = await rowNow();
rec('batch 1 (3 of 7) on the real server: partial answer, progress saved on the row', a1.ok === true && a1.partial === true && a1.done === 3 && a1.remaining === 4 && r1.status === 'sending' && r1.cfg.progress && r1.cfg.progress.done === 3, `${JSON.stringify({ ok: a1.ok, partial: a1.partial, done: a1.done, remaining: a1.remaining })} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const dbl = await send(base);
rec('a second "Send now" while batches are pending is refused', dbl.ok === false && dbl.already_sending === true, String(dbl.error || '').slice(0, 100));
const a2 = await send({ tenant: 'shakti', dry_run: false, broadcast_id: bid, resume: true, user_token: auth.access_token, batch_size: 3 }); const r2 = await rowNow();
rec('batch 2 (resume by the page): 3 more sent, 6 done', a2.ok === true && a2.partial === true && a2.done === 6 && r2.cfg.progress.done === 6, JSON.stringify({ ok: a2.ok, partial: a2.partial, done: a2.done, remaining: a2.remaining }));
// the page "closes": make the row look quiet for 2 minutes, then wait for the [STAGING] scheduler tick
await rest(`broadcasts?id=eq.${bid}`, { method: 'PATCH', body: JSON.stringify({ body: JSON.stringify({ ...r2.cfg, progress: { ...r2.cfg.progress, next_at: new Date(Date.now() - 120000).toISOString() } }) }) });
const tS = Date.now(); let fin = null;
while (Date.now() - tS < 7 * 60 * 1000) { await sleep(10000); const r = await rowNow(); if (r.status !== 'sending') { fin = r; break; } }
const recs = fin ? (fin.cfg.recipients || []) : [];
const msgs = fin ? await rest(`wa_messages?tenant_id=eq.${T}&sender_kind=eq.campaign&wamid=in.(${recs.map((r) => r.wamid).filter(Boolean).join(',')})&select=id`) : [];
rec('the [STAGING] scheduler finished the last row by itself (page closed), campaign "sent"', !!fin && fin.status === 'sent' && fin.sent_count === 7 && !fin.cfg.progress, fin ? `status ${fin.status}, sent_count ${fin.sent_count}, after ${((Date.now() - tS) / 1000).toFixed(0)} s wait` : 'not finished within 7 minutes');
rec('every row sent exactly once: 7 recipients, 7 distinct WhatsApp ids, 7 stored messages', recs.length === 7 && new Set(recs.map((r) => r.wamid)).size === 7 && msgs.length === 7 && recs.every((r) => r.wamid && r.status !== 'failed'), `recipients ${recs.length}, distinct ${new Set(recs.map((r) => r.wamid)).size}, stored ${msgs.length}`);
writeFileSync(SP + 'batches-results.json', JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} PASS, ${results.filter((r) => !r.ok).length} FAIL`);
