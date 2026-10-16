// REAL-mode on STAGING: Meta TEST number, staging Supabase, [STAGING] bot, the first test phone (the user's own).
//  1. a real picture is uploaded to Meta (test number), an inbound event with its media id reaches the staging bot,
//     the bot fetches it from Meta and copies it into the staging private store; the bytes are compared.
//  2. the payment QR code: with a QR saved in the staging club settings, "send payment qr" makes the bot send a REAL
//     image message to the test phone; Meta's delivery report is awaited.
//  3. the staging page (preview on PORT) shows the member's picture through a signed link: needs sql/wa_media.sql on staging.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { simContext, metaEvent, postEvent } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const C = JSON.parse(readFileSync(HERE + '../../tools/config.local.json', 'utf8')).staging;
const ctx = simContext(); const S = ctx.S;
if (/ttpecupfolgbbdagkotc/.test(S.url)) throw new Error('refusing: live project');
if (S.wa.simulate) throw new Error('simulate is on: this suite is for real Meta mode');
const PHONE = S.phones[0], PNID = S.wa.phoneNumberId, TOKEN = C.whatsapp.token;
if (PNID !== '1395815933604771') throw new Error('not the Meta TEST number: refusing');
const BASE = `http://127.0.0.1:${process.env.PORT || 8788}`;
const login = JSON.parse(readFileSync(HERE + '../../tools/qa-login.local.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const rec = (test, ok, ev = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(ev).slice(0, 260)}`); };
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}` };
const rest = async (path, opts = {}) => { const r = await fetch(`${S.url}/rest/v1/${path}`, { ...opts, headers: { ...H, 'Content-Type': 'application/json', ...(opts.headers || {}) } }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const [tenant] = await rest('tenants?slug=eq.shakti&select=id,bot_config'); const T = tenant.id;
const stamp = Date.now().toString(36);
const waitFor = async (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(3000); } return null; };
const PNG = readFileSync(HERE + '../../staging/test-sheets/poster-test.png');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const graph = (p, opts) => fetch('https://graph.facebook.com/v20.0/' + p, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) } });

try {
  // ---------- 1. a real picture, uploaded to Meta, then "sent" by the member
  const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', 'image/png'); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'member-photo.png');
  const up = await (await graph(`${PNID}/media`, { method: 'POST', body: fd })).json();
  rec('a real picture is uploaded to Meta (test number) and gets a media id', !!up.id, up.id ? 'media id ' + String(up.id).slice(0, 6) + '…' : JSON.stringify(up).slice(0, 160));
  const wamid = 'wamid.STGMEDIA.' + stamp;
  const body = metaEvent(S, { from: PHONE, image: true, caption: 'staging media test ' + stamp, id: wamid });
  body.entry[0].changes[0].value.messages[0].image = { id: String(up.id), mime_type: 'image/png', caption: 'staging media test ' + stamp };
  const res = await postEvent(ctx, body);
  rec('the staging bot accepted the inbound event', !!res && (res.status === 200 || res.ok === true), JSON.stringify(res).slice(0, 120));
  const row = await waitFor(async () => { const r = (await rest(`wa_messages?tenant_id=eq.${T}&wamid=eq.${encodeURIComponent(wamid)}&select=body,media_url,msg_type`))[0]; return r && r.media_url ? r : null; }, 90000);
  rec('the bot copied the picture into the staging private store and the message points at it', !!row && /\/storage\/v1\/object\/wa-media\//.test(row.media_url) && row.body === '[image] staging media test ' + stamp, row ? `${row.body} | ${row.media_url}` : 'no media_url within 90 s');
  if (row) {
    const obj = await fetch(row.media_url, { headers: H });
    const bytes = Buffer.from(await obj.arrayBuffer());
    rec('the stored bytes are exactly the picture sent (same size, same hash, type image/png)', obj.status === 200 && bytes.length === PNG.length && sha(bytes) === sha(PNG) && /image\/png/.test(obj.headers.get('content-type') || ''), `HTTP ${obj.status}, ${bytes.length} bytes, type ${obj.headers.get('content-type')}`);
    const anon = await fetch(row.media_url);
    rec('the stored picture is NOT public (an anonymous request is refused)', anon.status >= 400, 'anonymous HTTP ' + anon.status);
  }

  // ---------- 2. the QR code, sent for real to the test phone
  const qrKey = `qr/stg-qr-${stamp}.png`;
  const putQr = await fetch(`${S.url}/storage/v1/object/brand/${qrKey}`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: PNG });
  const qrUrl = `${S.url}/storage/v1/object/public/brand/${qrKey}`;
  rec('a QR picture is placed in the staging public store', putQr.status < 300, 'HTTP ' + putQr.status);
  const cfg0 = JSON.parse(JSON.stringify(tenant.bot_config || {}));
  const cfg1 = JSON.parse(JSON.stringify(cfg0)); cfg1.payments = { ...(cfg1.payments || {}), qr_url: qrUrl };
  await rest(`tenants?id=eq.${T}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ bot_config: cfg1 }) });
  const askId = 'wamid.STGQR.' + stamp;
  await postEvent(ctx, metaEvent(S, { from: PHONE, text: 'please send payment qr code', id: askId }));
  const sent = await waitFor(async () => (await rest(`wa_messages?tenant_id=eq.${T}&intent=eq.payment_qr&created_at=gte.${new Date(Date.now() - 300000).toISOString()}&order=created_at.desc&limit=1&select=wamid,media_url,body,status,error_title`))[0], 60000);
  rec('the bot answered with the QR picture, accepted by Meta (real WhatsApp id)', !!sent && !!sent.wamid && !/SIM|STAGING/.test(sent.wamid) && sent.media_url === qrUrl && /Scan this QR code/.test(sent.body), sent ? `status ${sent.status} ${sent.error_title || ''} | ${String(sent.wamid).slice(0, 14)}…` : 'no QR reply within 60 s');
  const st = sent && sent.wamid ? await waitFor(async () => { const x = (await rest(`wa_message_status?wamid=eq.${encodeURIComponent(sent.wamid)}&select=status,error_code`))[0]; return x && ['delivered', 'read', 'failed'].includes(x.status) ? x : null; }, 100000) : null;
  rec('Meta delivered the QR picture to the phone', !!st && ['delivered', 'read'].includes(st.status), st ? `status ${st.status}${st.error_code ? ' error ' + st.error_code : ''}` : 'no delivery report within 100 s');
  await rest(`tenants?id=eq.${T}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ bot_config: cfg0 }) });
  const back = (await rest(`tenants?id=eq.${T}&select=bot_config`))[0].bot_config;
  rec('the staging settings are put back as they were', JSON.stringify(back) === JSON.stringify(cfg0), 'restored');

  // ---------- 3. the staging page shows the picture (signed link): needs the storage policy from sql/wa_media.sql
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  try {
    await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
    await page.fill('#email', login.email); await page.fill('#password', login.password); await page.click('#authBtn');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await sleep(2500);
    await page.evaluate(() => go('inbox')); await sleep(800);
    await page.evaluate((k) => selectChat(k), PHONE);
    const shown = await waitFor(() => page.evaluate(() => {
      const img = [...document.querySelectorAll('#inboxMessageScroll img.inbox-bubble-img')].map((i) => i.src).find((s) => /\/object\/sign\/wa-media\//.test(s));
      const err = [...document.querySelectorAll('#inboxMessageScroll .inbox-failed-why')].map((x) => x.textContent).find((x) => /could not be opened/.test(x));
      return img || err ? { img, err } : null;
    }), 30000);
    let loaded = null;
    if (shown && shown.img) { const r = await page.request.get(shown.img); loaded = { status: r.status(), type: r.headers()['content-type'], size: (await r.body()).length }; }
    rec('the Inbox shows the member\'s picture through a signed link that opens', !!shown && !!shown.img && !!loaded && loaded.status === 200 && loaded.size === PNG.length,
      shown ? (shown.img ? JSON.stringify(loaded) : shown.err + '  (the storage policy of sql/wa_media.sql is probably not on staging yet)') : 'no picture and no error shown within 30 s');
  } finally { await browser.close(); }
} catch (e) { rec('finished without a script error', false, String(e.stack || e.message).slice(0, 500)); }
console.log(bad ? `${bad} FAILED` : 'all passed');
process.exit(bad ? 1 : 0);
