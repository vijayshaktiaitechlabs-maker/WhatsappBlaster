// Member photos and files in the Inbox, and the club's payment QR code (bot, Settings, Inbox composer).
// Local bench: the staging-built bot and page, simulated Meta (media ids and bytes included), an in-memory private store.
import { world, metaItem, cfg, benchCode, STG } from './harness.mjs';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).slice(0, 300)}`); };
const { db, q, T, users } = await benchDb();
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const PNID = cfg.whatsapp.phoneNumberId;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=', 'base64');
const LINK = 'https://pay.example.org/club', QR = 'https://img.example.org/club-qr.png';

/* ---- the bot, as on the bench ---- */
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFn('$input', 'Buffer', 'setTimeout', benchCode('wa_bot_wf.json', 'Bot Engine'));
const run = async (body) => { const w = world(db); const item = metaItem(w, body); const out = await engine.call({ helpers: w.helpers }, { first: () => item }, Buffer, setTimeout); return { out: out[0].json, w }; };
let seq = 0; const now = () => String(Math.floor(Date.now() / 1000));
const ev = (msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: msg.from }], messages: [msg] } }] }] });
const base = () => ({ from: PHONE, id: `wamid.QAMEDIA.${++seq}`, timestamp: now() });
const imageMsg = (id, caption) => ({ ...base(), type: 'image', image: { id, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } });
const docMsg = (id, filename) => ({ ...base(), type: 'document', document: { id, mime_type: 'application/pdf', filename } });
const textMsg = (t) => ({ ...base(), type: 'text', text: { body: t } });
const row = async (wamid) => (await q(`select body, media_url, msg_type from public.wa_messages where tenant_id=$1 and wamid=$2`, [T, wamid]))[0] || {};
const lastOut = async () => (await q(`select * from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
const outRow = async (wamid) => (await q(`select body, media_url, intent, msg_type from public.wa_messages where tenant_id=$1 and wamid=$2`, [T, wamid]))[0] || {};
const store = (w) => [...w.helpers.storage.entries()].map(([k, v]) => ({ key: k, mime: v.mime, size: v.bytes.length }));

try {
  // ---------- A. a photo the member sent is copied to the private store and the stored message points at it
  const m1 = imageMsg('SIM-MEDIA-1', 'payment done');
  let r = await run(ev(m1));
  let st = store(r.w), rw = await row(m1.id), lo = await lastOut();
  const want1 = `${T}/${PHONE}/${m1.id}.png`;
  rec('a photo: stored as "[image] caption", copied to wa-media/<club>/<phone>/<message id>.<type>, and the message points at it',
    rw.body === '[image] payment done' && rw.media_url === `${STG}/storage/v1/object/wa-media/${want1}` && st.length === 1 && st[0].key === 'wa-media/' + want1 && st[0].mime === 'image/png' && st[0].size === PNG.length,
    `${rw.body} | ${rw.media_url} | store ${JSON.stringify(st)}`);
  rec('the member still gets the usual reply to a photo', lo && lo.payload.type === 'text' && /team|thank/i.test(lo.payload.text.body), lo && lo.payload.text && lo.payload.text.body);

  // ---------- B. a document keeps its name and type
  const m2 = docMsg('SIM-MEDIA-PDF-2', 'receipt.pdf');
  r = await run(ev(m2)); st = store(r.w); rw = await row(m2.id);
  rec('a document: "[document] receipt.pdf", copied as .pdf with its type', rw.body === '[document] receipt.pdf' && rw.msg_type === 'document' && /\.pdf$/.test(rw.media_url || '') && st.length === 1 && st[0].mime === 'application/pdf', `${rw.body} | ${rw.media_url} | ${JSON.stringify(st)}`);

  // ---------- C. too large, or missing at Meta: the message is kept without the file, the reply still goes
  const m3 = imageMsg('SIM-MEDIA-BIG-3');
  r = await run(ev(m3)); rw = await row(m3.id); const big = { st: store(r.w), out: await lastOut() };
  const m4 = imageMsg('SIM-MEDIA-FAIL-4');
  r = await run(ev(m4)); const rw4 = await row(m4.id); const fail = { st: store(r.w), out: await lastOut() };
  rec('a file over 10 MB is not copied; the message stays "[image]" and the reply still goes', rw.body === '[image]' && !rw.media_url && big.st.length === 0 && big.out.payload.type === 'text', `${rw.body} | ${rw.media_url} | store ${big.st.length}`);
  rec('a file Meta cannot serve: the message stays "[image]" and the reply still goes', rw4.body === '[image]' && !rw4.media_url && fail.st.length === 0 && fail.out.payload.type === 'text', `${rw4.body} | store ${fail.st.length}`);

  // ---------- D. Meta retrying the same event: no second copy
  const nOut = Number((await q(`select count(*)::int n from public.stg_outbox where kind='meta_message'`))[0].n);
  r = await run(ev(m1));
  rec('a repeated delivery of the same photo is ignored: nothing copied, nothing sent again', store(r.w).length === 0 && /"duplicate":true/.test(JSON.stringify(r.out)) && Number((await q(`select count(*)::int n from public.stg_outbox where kind='meta_message'`))[0].n) === nOut, JSON.stringify(r.out).slice(0, 120));

  // ---------- E. the payment QR code: the bot sends the picture when asked
  await q(`update public.tenants set bot_config = bot_config || jsonb_build_object('payments', jsonb_build_object('link', $2::text, 'qr_url', $3::text)) where id=$1`, [T, LINK, QR]);
  const ask = async (t) => { const m = textMsg(t); await run(ev(m)); return { out: await lastOut(), row: await outRow((await lastOut()).wamid) }; };
  let a = await ask('please send payment QR code');
  rec('"please send payment QR code": the bot answers with the QR picture, the caption has NO payment link', a.out.payload.type === 'image' && a.out.payload.image.link === QR && /Scan this QR code/.test(a.out.payload.image.caption) && !/https?:|pay online/i.test(a.out.payload.image.caption), JSON.stringify(a.out.payload).slice(0, 200));
  rec('the sent QR is stored with its picture and the intent payment_qr (the Inbox shows it)', a.row.media_url === QR && a.row.intent === 'payment_qr' && /Scan this QR code/.test(a.row.body), JSON.stringify(a.row).slice(0, 160));
  a = await ask('can i pay by upi?');
  const b = await ask('gpay chalega?');
  rec('"pay by upi" and "gpay" get the QR too', a.out.payload.type === 'image' && b.out.payload.type === 'image', `${a.out.payload.type} / ${b.out.payload.type}`);
  a = await ask('I want to scan my face at the gate');
  rec('"scan my face at the gate" is NOT a QR request (goes to the usual answer)', a.out.payload.type !== 'image', a.out.payload.type);
  await ask('what are your timings?');
  const prompt = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('the AI is told a UPI QR code exists and to offer it', /PAYMENT BY UPI \/ QR CODE/.test(prompt) && prompt.includes(LINK), (prompt.match(/PAYMENT BY UPI.{0,80}/) || [''])[0]);
  await q(`update public.tenants set bot_config = bot_config #- '{payments,qr_url}' where id=$1`, [T]);
  a = await ask('send me the QR code');
  rec('with no QR code saved, "send me the QR code" gets a normal text answer', a.out.payload.type !== 'image', a.out.payload.type);

  // ---------- E3. a UPI ID in the settings
  const UPI = '9999900001@fampay';
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments,upi_id}', to_jsonb($2::text)) where id=$1`, [T, UPI]);
  a = await ask('send me the QR code');
  rec('a UPI ID but no QR picture saved: the member gets the UPI ID as text', a.out.payload.type === 'text' && a.out.payload.text.body.includes(UPI) && /After paying/.test(a.out.payload.text.body) && a.row.intent === 'payment_upi', JSON.stringify(a.out.payload).slice(0, 200));
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments,qr_url}', to_jsonb($2::text)) where id=$1`, [T, QR]);
  a = await ask('qr please');
  rec('with both saved: the QR picture, and the UPI ID written under it in the caption', a.out.payload.type === 'image' && a.out.payload.image.caption.includes('UPI ID: ' + UPI) && /After paying/.test(a.out.payload.image.caption) && !/https?:/.test(a.out.payload.image.caption), JSON.stringify(a.out.payload.image).slice(0, 220));
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments,upi_id}', to_jsonb($2::text)) where id=$1`, [T, 'not a upi id']);
  a = await ask('qr please');
  rec('an invalid UPI ID in the settings is never sent: the QR goes without a UPI line', a.out.payload.type === 'image' && !/UPI ID:|not a upi/.test(a.out.payload.image.caption), a.out.payload.image.caption.slice(0, 120));
  await q(`update public.tenants set bot_config = jsonb_set(bot_config, '{payments,upi_id}', to_jsonb($2::text)) where id=$1`, [T, UPI]);
  await ask('what are your timings?');
  const prompt2 = (await q(`select payload from public.stg_outbox where kind='ai_prompt' order by id desc limit 1`))[0].payload.text;
  rec('the AI is told the UPI ID too', prompt2.includes('UPI ID: ' + UPI), (prompt2.match(/PAYMENT BY UPI.{0,90}/) || [''])[0]);
  await q(`update public.tenants set bot_config = bot_config #- '{payments,upi_id}' #- '{payments,qr_url}' where id=$1`, [T]);

  // ---------- E2. the AI quota is exhausted (Google answers 429 for every model): the bot still answers, with its fixed menu
  const quotaCode = benchCode('wa_bot_wf.json', 'Bot Engine').replace('if (key === __stg.noAi) {', "if (globalThis.__qaQuota) return __stgFake(opts, 429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });\n      if (key === __stg.noAi) {");
  if (quotaCode === benchCode('wa_bot_wf.json', 'Bot Engine')) throw new Error('quota test double not placed');
  const engineQ = new AsyncFn('$input', 'Buffer', 'setTimeout', quotaCode);
  globalThis.__qaQuota = true;
  const nAi0 = Number((await q(`select count(*)::int n from public.stg_outbox where kind in ('ai_prompt','ai_embed')`))[0].n);
  { const w = world(db); const m = textMsg('what are your timings?'); const item = metaItem(w, ev(m)); await engineQ.call({ helpers: w.helpers }, { first: () => item }, Buffer, setTimeout);
    const o = await lastOut(); const calls = Number((await q(`select count(*)::int n from public.stg_outbox where kind in ('ai_prompt','ai_embed')`))[0].n) - nAi0;
    rec('AI quota exhausted (429 on every model): the member still gets an answer, the fixed help menu, and nothing crashes', o.payload.type === 'interactive' && /here to help/i.test(o.payload.interactive.body.text) && calls >= 4, `${o.payload.type} | Google asked ${calls} times | ${(o.payload.interactive && o.payload.interactive.body.text || '').slice(0, 60)}`); }
  globalThis.__qaQuota = false;

  // ---------- F. the Inbox shows the photo and the file through signed links; old rows and public pictures unchanged
  const seed = (dir, body, type, media, kind) => q(`insert into public.wa_messages (tenant_id, phone, direction, body, msg_type, media_url, sender_kind) values ($1,$2,$3,$4,$5,$6,$7)`, [T, PHONE, dir, body, type, media, kind]);
  await seed('in', '[image] my receipt', 'image', `${STG}/storage/v1/object/wa-media/${T}/${PHONE}/seed-1.png`, 'member');
  await seed('in', '[document] receipt.pdf', 'document', `${STG}/storage/v1/object/wa-media/${T}/${PHONE}/seed-2.pdf`, 'member');
  await seed('in', '[image]', 'image', null, 'member');
  await seed('out', 'poster', 'image', `${STG}/storage/v1/object/public/brand/posters/poster.png`, 'staff');
  const { browser, context, fake } = await openBrowser(db, users);
  const page = await context.newPage();
  const issues = watch(page);
  const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  try {
    await login(page, 'qa-owner@club.test');
    await page.evaluate(() => go('inbox')); await sleep(800);
    await page.evaluate((k) => selectChat(k), PHONE);
    const shown = await until(() => page.evaluate(() => {
      const imgs = [...document.querySelectorAll('#inboxMessageScroll img.inbox-bubble-img')].map((i) => i.src);
      const files = [...document.querySelectorAll('#inboxMessageScroll a.inbox-bubble-file')].map((a) => a.href);
      const legacy = [...document.querySelectorAll('#inboxMessageScroll .inbox-bubble')].filter((b) => /^\[image\]$/.test(b.querySelector('.inbox-bubble-text')?.textContent.trim() || ''));
      const broken = [...document.querySelectorAll('#inboxMessageScroll .inbox-failed-why')].map((x) => x.textContent);
      const ok = imgs.some((s) => /\/object\/sign\/wa-media\/.*seed-1\.png\?token=/.test(s)) && files.some((h) => /\/object\/sign\/wa-media\/.*seed-2\.pdf\?token=/.test(h));
      return ok ? { imgs, files, legacy: legacy.length, legacyImgs: legacy.filter((b) => b.querySelector('img')).length, broken } : null;
    }), 15000);
    rec('the member\'s photo shows through a signed link, the document as an "Open document" link', !!shown, JSON.stringify(shown).slice(0, 260));
    rec('an old "[image]" message without a file stays as text, and a public picture (poster) shows as before', !!shown && shown.legacy === 3 /* the seeded one + the two the bot could not copy */ && shown.legacyImgs === 0 && shown.imgs.some((s) => /\/object\/public\/brand\/posters\/poster\.png$/.test(s)) && !shown.broken.length, shown ? `legacy ${shown.legacy}, broken ${shown.broken.length}` : '');
    const signedBefore = fake.log.signed;
    await page.evaluate(() => renderThread(true)); await sleep(600);
    rec('redrawing the thread reuses the signed links (no new signing)', fake.log.signed === signedBefore && signedBefore === 4 /* 2 from the bot part + 2 seeded */, `signed ${signedBefore} -> ${fake.log.signed}`);

    // ---------- G. Settings: upload the QR code; it is saved at once
    await page.evaluate(() => go('settings')); await sleep(1500);
    rec('Settings shows "No QR code saved yet" with an upload button', /No QR code saved yet/.test(await t('#payQrBox')) && (await page.locator('#payQrUpload').count()) === 1, await t('#payQrBox'));
    await page.setInputFiles('#payQrFile', { name: 'club-qr.png', mimeType: 'image/png', buffer: PNG });
    const saved = await until(async () => { const c = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config; return c.payments && c.payments.qr_url ? c : null; }, 15000);
    rec('the uploaded QR picture is saved to the club settings (payments.qr_url), the link kept', !!saved && /\/storage\/v1\/object\/public\/brand\/posters\/.*club-qr\.png$/.test(saved.payments.qr_url) && saved.payments.link === LINK, saved ? saved.payments.qr_url : 'not saved');
    await sleep(400);
    rec('Settings shows the saved QR picture with Replace and Remove', (await page.locator('#payQrBox img').count()) === 1 && (await page.locator('#payQrRemove').count()) === 1 && /Payment QR code saved/.test(await t('#toast')), await t('#toast'));
    // ---------- G2. Settings: the UPI ID, saved on its own
    rec('Settings shows "No UPI ID is saved yet" and a Save UPI ID button', /No UPI ID is saved yet/.test(await t('#payUpiSaved')) && (await page.locator('#payUpiSave').count()) === 1, await t('#payUpiSaved'));
    await page.fill('#s_upi_id', 'bad id'); await page.click('#payUpiSave'); await sleep(500);
    const badCfg = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
    rec('a text that is not a UPI ID is refused, nothing saved', !(badCfg.payments && badCfg.payments.upi_id) && /UPI ID/.test(await t('#toast')), await t('#toast'));
    await page.fill('#s_upi_id', '9999900001@fampay'); await sleep(200);
    rec('typing without saving shows the "Not saved yet" warning', /Not saved yet/.test(await t('#payUpiSaved')), await t('#payUpiSaved'));
    await page.click('#payUpiSave');
    const upiSaved = await until(async () => { const c = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config; return c.payments && c.payments.upi_id ? c : null; }, 10000);
    rec('the UPI ID is saved by itself (payments.upi_id); the link and the QR picture are kept', !!upiSaved && upiSaved.payments.upi_id === '9999900001@fampay' && upiSaved.payments.link === LINK && upiSaved.payments.qr_url === saved.payments.qr_url, upiSaved ? JSON.stringify(upiSaved.payments).slice(0, 200) : 'not saved');
    await sleep(300);
    rec('the note now shows the saved UPI ID without the warning', /Saved UPI ID: 9999900001@fampay/.test(await t('#payUpiSaved')) && !/Not saved yet/.test(await t('#payUpiSaved')), await t('#payUpiSaved'));
    const other = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config;
    rec('nothing else in the settings changed', JSON.stringify({ ...other, payments: undefined }) === JSON.stringify({ ...(await (async () => { const c = JSON.parse(JSON.stringify(other)); return c; })()), payments: undefined }) && other.payments.link === LINK, 'link kept');

    // ---------- H. Inbox: the Payment QR button attaches the picture with a caption; Send delivers it
    await page.evaluate(() => go('inbox')); await sleep(600);
    await page.evaluate((k) => selectChat(k), PHONE); await sleep(1200);
    const btn = await page.evaluate(() => { const b = document.getElementById('inboxQrBtn'); return b ? !b.classList.contains('hidden') : null; });
    rec('the Inbox composer shows a "Payment QR" button once a QR code is saved', btn === true, String(btn));
    await page.click('#inboxQrBtn'); await sleep(400);
    const att = await page.evaluate(() => ({ img: INBOX_ATTACHED_IMAGE, text: document.getElementById('inboxReplyInput').value, prev: document.getElementById('inboxAttachPreview').textContent }));
    rec('the button attaches the QR picture and writes the caption with the UPI ID and without a payment link', att.img === saved.payments.qr_url && /Scan this QR code/.test(att.text) && att.text.includes('UPI ID: 9999900001@fampay') && !/https?:|pay online/i.test(att.text) && /club-qr\.png/.test(att.prev), JSON.stringify(att).slice(0, 200));
    const o0 = Number((await q(`select coalesce(max(id),0)::int n from public.stg_outbox`))[0].n);
    await page.evaluate(() => submitComposer());
    const sent = await until(async () => (await q(`select payload, wamid from public.stg_outbox where kind='meta_message' and id > $1 order by id desc limit 1`, [o0]))[0], 15000);
    const sentRow = sent ? await outRow(sent.wamid) : {};
    rec('Send delivers the QR as an image message with the caption, stored for the Inbox with the picture', !!sent && sent.payload.type === 'image' && sent.payload.image.link === saved.payments.qr_url && /Scan this QR code/.test(sent.payload.image.caption) && sentRow.media_url === saved.payments.qr_url, sent ? JSON.stringify(sent.payload).slice(0, 160) : 'nothing sent');

    // ---------- I. remove the QR code
    await page.evaluate(() => go('settings')); await sleep(800);
    const d0 = issues.dialogs.length;
    await page.click('#payQrRemove');
    const gone = await until(async () => { const c = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config; return !(c.payments && c.payments.qr_url) ? c : null; }, 10000);
    rec('Remove asks first, then clears only the QR code (the payment link stays)', !!gone && issues.dialogs.slice(d0).some((x) => /Remove the saved payment QR code/.test(x)) && gone.payments.link === LINK, gone ? JSON.stringify(gone.payments) : 'still saved');
    await page.evaluate(() => go('inbox')); await sleep(400);
    await page.evaluate((k) => selectChat(k), PHONE); await sleep(800);
    const vis = await page.evaluate(() => !document.getElementById('inboxQrBtn').classList.contains('hidden'));
    await page.click('#inboxQrBtn'); await sleep(400);
    const att2 = await page.evaluate(() => ({ img: INBOX_ATTACHED_IMAGE, text: document.getElementById('inboxReplyInput').value }));
    rec('with only the UPI ID saved the button stays and writes the UPI ID as text, with no picture', vis && att2.img === null && att2.text.includes('UPI ID: 9999900001@fampay') && /Pay Shakti Sports Club by UPI/.test(att2.text), JSON.stringify(att2).slice(0, 200));
    await page.evaluate(() => { clearInboxAttachment(); document.getElementById('inboxReplyInput').value = ''; });
    await page.evaluate(() => go('settings')); await sleep(800);
    const d1 = issues.dialogs.length;
    await page.fill('#s_upi_id', ''); await page.click('#payUpiSave');
    const upiGone = await until(async () => { const c = (await q(`select bot_config from public.tenants where id=$1`, [T]))[0].bot_config; return !(c.payments && c.payments.upi_id) ? c : null; }, 10000);
    rec('clearing the UPI ID asks first, then removes only it (the link stays)', !!upiGone && issues.dialogs.slice(d1).some((x) => /Remove the saved UPI ID/.test(x)) && upiGone.payments.link === LINK, upiGone ? JSON.stringify(upiGone.payments) : 'still saved');
    await page.evaluate(() => go('inbox')); await sleep(400);
    await page.evaluate((k) => selectChat(k), PHONE); await sleep(800);
    rec('with neither a QR nor a UPI ID the Inbox button is hidden again', await page.evaluate(() => document.getElementById('inboxQrBtn').classList.contains('hidden')), 'hidden');
  } finally {
    rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
    rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
    rec('no live webhook was called', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
    fake.stop(); await browser.close();
  }
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1500));
}
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} media-and-QR checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
