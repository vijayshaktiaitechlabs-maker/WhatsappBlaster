// REAL-mode end-to-end part 2 on STAGING: poster image, custom template submit to Meta, payment link, bulk dues reminder, scheduling.
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simContext } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url)); const SP = HERE + 'out/'; mkdirSync(SP, { recursive: true });
const BASE = `http://127.0.0.1:${process.env.PORT || 8788}`;
const login = JSON.parse(readFileSync(HERE + '../../tools/qa-login.local.json', 'utf8'));
const ctx = simContext(); const S = ctx.S; const W = S.wa;
if (/ttpecupfolgbbdagkotc/.test(S.url) || W.simulate) throw new Error('refusing');
if (String(W.wabaId).trim() === '000000000000000') throw new Error('refusing: club WABA');
const PHONE = S.phones[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (area, test, ok, ev = '') => { results.push({ area, test, ok, ev: String(ev).slice(0, 300) }); console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(ev).slice(0, 230)}`); };
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}`, 'Content-Type': 'application/json' };
const rest = async (path, opts = {}) => { const r = await fetch(`${S.url}/rest/v1/${path}`, { headers: { ...H, ...(opts.headers || {}) }, ...opts }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const [tenant] = await rest('tenants?slug=eq.shakti&select=id'); const T = tenant.id;
const stamp = Date.now().toString(36);
const waitRow = async (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(3000); } return null; };
const graph = async (path, opts = {}) => { const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, { ...opts, headers: { Authorization: `Bearer ${String(W.token).trim()}`, ...(opts.headers || {}) } }); return r.json(); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage(); const errs = []; const dialogs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/storage\/v1|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const waitFor = (fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const toast = () => t('#toast');
const isReal = (w) => w && !String(w).startsWith('wamid.SIM');

try {
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  await page.fill('#email', login.email); await page.fill('#password', login.password); await page.click('#authBtn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(2500);

  // ---------- 1. Poster: upload a JPG/PNG, preview, real test send with the image header
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(900);
  await page.evaluate(() => pickTpl('club_custom_broadcast')); await sleep(600);
  await page.setInputFiles('#posterFileInput', HERE + '../../staging/test-sheets/poster-test.png');
  await waitFor(() => /Poster attached|attached/i.test(document.getElementById('varBox').textContent), null, 45000);
  const posterUrl = await page.evaluate(() => CMP.imageUrl);
  const posterHead = posterUrl ? await fetch(posterUrl) : null;
  rec('Poster', 'the uploaded image is stored in staging storage and publicly reachable as an image', !!posterUrl && /alwbvprwcnbetknxqbik/.test(posterUrl) && posterHead.ok && /image\//.test(posterHead.headers.get('content-type') || ''), `${posterUrl ? posterUrl.split('/').slice(-2).join('/') : 'none'} ${posterHead && posterHead.status}`);
    await page.evaluate(() => { const t = curTpl(); (t.vars || []).forEach((v) => { if (v.def === 'custom' || !v.def) setVarText(v.k, 'QA message ' + v.k); }); }); await sleep(400);
  await page.fill('#c_test', PHONE);
  await page.evaluate(() => sendTest());
  const posterMsg = await waitRow(async () => { const r = (await rest(`wa_messages?tenant_id=eq.${T}&sender_kind=eq.campaign&template_name=eq.club_custom_broadcast&order=created_at.desc&limit=1&select=*`))[0]; return r && new Date(r.created_at) > new Date(Date.now() - 60000) ? r : null; }, 45000);
  rec('Poster', 'a real test send with the image header was accepted by Meta and stored with the image', !!posterMsg && isReal(posterMsg.wamid) && !!posterMsg.media_url, posterMsg ? `status ${posterMsg.status}, image stored ${!!posterMsg.media_url}` : (await toast()));
  const posterDel = posterMsg && await waitRow(async () => { const r = (await rest(`wa_messages?id=eq.${posterMsg.id}&select=status,error_code,error_title`))[0]; return r && ['delivered', 'read', 'failed'].includes(r.status) ? r : null; }, 90000);
  rec('Poster', 'Meta delivered the image message to the phone', !!posterDel && ['delivered', 'read'].includes(posterDel.status), posterDel ? `${posterDel.status} ${posterDel.error_title || ''}` : 'no status');

  // ---------- 2. "Nothing" variable and removed image
  await page.evaluate(() => { const t = curTpl(); const opt = (t.vars || []).find((v) => v.optional); if (opt) setVarSrc(opt.k, 'nothing'); });
  const prev = await page.evaluate(() => { const el = document.getElementById('waBubble'); return el ? el.textContent : ''; });
  rec('Variables', '"Nothing" leaves no {{n}} placeholder in the real preview box', prev.length > 20 && !/\{\{\s*\d+\s*\}\}/.test(prev), prev.replace(/\s+/g, ' ').slice(0, 100) || '(preview box empty)');

  // ---------- 3. Payment link in Settings, Inbox reminder text, bulk dues reminder text and real send
  const LINK = 'https://pay.example.org/shakti-staging';
  await page.evaluate(() => go('settings')); await sleep(900);
  await page.fill('#s_payment_link', LINK); await page.click('#setSave'); await sleep(1800);
  const saved = (await rest(`tenants?id=eq.${T}&select=bot_config`))[0].bot_config;
  rec('Payment link', 'the payment link saved in Settings is stored in the database', saved && saved.payments && saved.payments.link === LINK, JSON.stringify(saved && saved.payments));
  await page.evaluate(() => go('inbox')); await sleep(900);
  const mid = (await rest(`members?tenant_id=eq.${T}&phone=eq.${PHONE}&select=id`))[0].id;
  await page.evaluate((id) => sendDirectDuesReminder(id), mid); await sleep(1800);
  const composer = await page.inputValue('#inboxReplyInput').catch(() => '');
  const owed = Number((await rest(`members?id=eq.${mid}&select=dues_amount`))[0].dues_amount || 0);
  rec('Payment link', 'Inbox "Reminder" writes the member\'s own amount and the payment link into the message', composer.includes('₹' + owed.toLocaleString('en-IN')) && composer.includes(LINK), `owes ₹${owed.toLocaleString('en-IN')}: ` + composer.replace(/\s+/g, ' ').slice(0, 150));
  await page.fill('#inboxReplyInput', '');
  await page.evaluate(() => go('payments')); await sleep(900);
  const d0 = dialogs.length;
  await page.evaluate(() => sendDues()); await sleep(6000);
  const dlg = dialogs.slice(d0).find((x) => /dues reminder/i.test(x)) || '';
  rec('Payment link', 'the bulk "Send Dues Reminders" confirmation shows the exact message including the link', dlg.includes(LINK), dlg.replace(/\s+/g, ' ').slice(0, 170));
  const dueMsg = await waitRow(async () => { const r = (await rest(`wa_messages?tenant_id=eq.${T}&sender_kind=eq.campaign&template_name=eq.member_custom_update&order=created_at.desc&limit=1&select=*`))[0]; return r && new Date(r.created_at) > new Date(Date.now() - 90000) ? r : null; }, 40000);
  rec('Payment link', 'the reminder that reached the phone contains the link, was accepted by Meta and delivered', !!dueMsg && isReal(dueMsg.wamid) && String(dueMsg.body).includes(LINK), dueMsg ? `status ${dueMsg.status}; body has link: ${String(dueMsg.body).includes(LINK)}` : 'no reminder stored');
  const dueFinal = dueMsg && await waitRow(async () => { const r = (await rest(`wa_messages?id=eq.${dueMsg.id}&select=status`))[0]; return r && ['delivered', 'read', 'failed'].includes(r.status) ? r : null; }, 80000);
  rec('Payment link', 'Meta confirmed delivery of the reminder', !!dueFinal && ['delivered', 'read'].includes(dueFinal.status), dueFinal ? dueFinal.status : 'no status');

  // ---------- 4. Custom template: create, submit to Meta (test WABA), check
  const tname = 'qa_real_' + stamp;
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(900);
  await page.evaluate(() => ctNew()); await sleep(600);
  await page.fill('#ct_name', tname);
  await page.fill('#ct_body', 'Court maintenance is planned for Sunday morning. All other courts stay open as usual.');
  await page.evaluate(() => ctEditorPreview());
  await page.evaluate(() => ctSubmit()); await sleep(7000);
  const row = (await rest(`wa_custom_templates?tenant_id=eq.${T}&name=eq.${tname}&select=name,meta_status,pending`))[0];
  const onMeta = await graph(`${String(W.wabaId).trim()}/message_templates?name=${(row && row.pending && row.pending.meta_name) || tname}&fields=name,status,category`);
  rec('Template', 'a custom template is submitted to Meta and exists on the TEST account', !!row && Array.isArray(onMeta.data) && onMeta.data.length >= 1, `staging row ${row && row.meta_status}; Meta: ${JSON.stringify((onMeta.data || [])[0] || onMeta.error || {}).slice(0, 110)}`);
  if (onMeta.data && onMeta.data[0]) { const del = await graph(`${String(W.wabaId).trim()}/message_templates?name=${onMeta.data[0].name}`, { method: 'DELETE' }); rec('Template', 'cleanup: the QA template was removed from the test account only', !!del.success, JSON.stringify(del).slice(0, 80)); }

  // ---------- 5. Scheduling: a campaign scheduled 3 minutes ahead is sent once by the staging scheduler
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(900);
  await page.evaluate(() => setAudSource('single')); await sleep(300);
  await page.fill('#aud_single_phone', PHONE); await page.fill('#aud_single_name', 'Scheduled QA');
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarText('2', '2026-27'); setVarText('3', '₹1,500'); setVarText('4', 'Scheduled test.'); }); await sleep(500);
  const cname = 'Real E2E scheduled ' + stamp;
  await page.fill('#c_name', cname);
  await page.evaluate(() => setSchedule('later'));
  const when = new Date(Date.now() + 3 * 60 * 1000); const pad = (n) => String(n).padStart(2, '0');
  await page.fill('#c_sched', `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`);
  await page.evaluate(() => { updateSummary && updateSummary(); }); await sleep(400);
  const tSched = Date.now();
  await page.click('#cmpSendBtn'); await sleep(3500);
  const [c1] = await rest(`broadcasts?tenant_id=eq.${T}&title=eq.${encodeURIComponent(cname)}&select=id,status`);
  rec('Scheduling', 'the campaign is saved as scheduled and nothing is sent yet', !!c1 && c1.status === 'scheduled', c1 ? c1.status : 'not saved: ' + (await toast()));
  const done = c1 && await waitRow(async () => { const r = (await rest(`broadcasts?id=eq.${c1.id}&select=status,body`))[0]; return r && ['sent', 'failed'].includes(r.status) ? r : null; }, 11 * 60 * 1000);
  const rr = done && (JSON.parse(done.body).recipients || [])[0];
  rec('Scheduling', 'the staging scheduler sent it by itself, once, after the chosen time', !!done && done.status === 'sent' && !!rr && isReal(rr.wamid), done ? `status ${done.status} after ${Math.round((Date.now() - tSched) / 1000)} s; recipient ${rr && rr.status}` : 'not sent within 11 min');
  const count = (await rest(`wa_messages?tenant_id=eq.${T}&sender_kind=eq.campaign&wamid=eq.${rr && rr.wamid}&select=id`)).length;
  rec('Scheduling', 'it was sent exactly once (no double send)', count === 1, `${count} message row(s)`);
} catch (e) {
  rec('Run', 'finished without a script error', false, e.message);
  await page.screenshot({ path: SP + 'real-e2e2-error.png' }).catch(() => {});
}
rec('Page health', 'no script errors on the page', !errs.length, errs.slice(0, 3).join(' | ') || 'none');
writeFileSync(SP + 'real-e2e2-results.json', JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} PASS, ${results.filter((r) => r.ok === false).length} FAIL, ${results.filter((r) => r.ok === null).length} SKIP`);
await browser.close(); process.exit(0);
