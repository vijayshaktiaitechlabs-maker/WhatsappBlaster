// Everything a member can send on WhatsApp reaches staff: contact cards, locations, orders, form answers, voice notes,
// videos, stickers, office documents, forwarded messages, messages from an ad, and the kinds WhatsApp does not pass on.
// Local bench: the staging-built bot and page, simulated Meta; nothing external is called.
import { world, metaItem, cfg, benchCode, STG } from './harness.mjs';
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';

const results = [];
const rec = (test, ok, evidence = '') => { results.push({ test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${test} | ${String(evidence).replace(/\n/g, ' ⏎ ').slice(0, 300)}`); };
const { db, q, T, users } = await benchDb();
const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
const PNID = cfg.whatsapp.phoneNumberId;
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFn('$input', 'Buffer', 'setTimeout', benchCode('wa_bot_wf.json', 'Bot Engine'));
const run = async (body) => { const w = world(db); const item = metaItem(w, body); const out = await engine.call({ helpers: w.helpers }, { first: () => item }, Buffer, setTimeout); return { out: out[0].json, w }; };
let seq = 0; const now = () => String(Math.floor(Date.now() / 1000));
const ev = (msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: msg.from }], messages: [msg] } }] }] });
const base = (extra = {}) => ({ from: PHONE, id: `wamid.QATYPES.${++seq}`, timestamp: now(), ...extra });
const row = async (wamid) => (await q(`select body, media_url, msg_type from public.wa_messages where tenant_id=$1 and wamid=$2`, [T, wamid]))[0] || {};
const lastOut = async () => (await q(`select * from public.stg_outbox where kind='meta_message' order by id desc limit 1`))[0];
const send = async (msg) => { const r = await run(ev(msg)); return { row: await row(msg.id), out: await lastOut(), store: [...r.w.helpers.storage.entries()].map(([k, v]) => ({ key: k, mime: v.mime })), res: (r.out.results || [])[0] || {} }; };
const replyText = (o) => (o && o.payload && o.payload.text && o.payload.text.body) || '';

try {
  // ---------- 1. a contact card (the user's case)
  let m = base({ type: 'contacts', contacts: [{ name: { formatted_name: 'Ravi Shah', first_name: 'Ravi', last_name: 'Shah' }, org: { company: 'Shah Traders' }, phones: [{ phone: '+91 98765 43210', type: 'CELL', wa_id: '919876543210' }, { phone: '0265 2345678', type: 'WORK' }], emails: [{ email: 'ravi@example.org', type: 'WORK' }] }] });
  let r = await send(m);
  rec('a contact card is stored with the name, company, every phone number and the email', r.row.body === '[contact]\nRavi Shah, Shah Traders\nPhone: +91 98765 43210 (cell), 0265 2345678 (work)\nEmail: ravi@example.org' && r.row.msg_type === 'contacts', r.row.body);
  rec('the member gets the usual "our team will look" reply, and nothing is fetched from Meta', /team will look/.test(replyText(r.out)) && r.store.length === 0 && r.res.media == null, replyText(r.out).slice(0, 60));
  m = base({ type: 'contacts', contacts: [{ name: { first_name: 'Asha', last_name: 'Patel' }, phones: [{ phone: '9000000001' }] }, { name: { formatted_name: 'Club Office' }, phones: [] }] });
  r = await send(m);
  rec('two contact cards in one message are both listed; a card with no phone shows just the name', r.row.body === '[contact]\nAsha Patel\nPhone: 9000000001\n\nClub Office', r.row.body);
  m = base({ type: 'contacts', contacts: [] });
  r = await send(m);
  rec('an empty contact message does not break anything', r.row.body === '[contact]' && /team will look/.test(replyText(r.out)), r.row.body);

  // ---------- 2. a location
  m = base({ type: 'location', location: { latitude: 22.3072, longitude: 73.1812, name: 'Shakti Sports Club', address: 'Vadodara, Gujarat' } });
  r = await send(m);
  rec('a location is stored with its name, address and a Google Maps link', r.row.body === '[location]\nShakti Sports Club\nVadodara, Gujarat\nhttps://maps.google.com/?q=22.3072,73.1812', r.row.body);
  m = base({ type: 'location', location: { latitude: 'abc', longitude: 999 } });
  r = await send(m);
  rec('a location with impossible coordinates gets no link', r.row.body === '[location]', r.row.body);

  // ---------- 3. an order and a form
  m = base({ type: 'order', order: { catalog_id: 'C1', text: 'please deliver by evening', product_items: [{ product_retailer_id: 'RACKET-1', quantity: 2, item_price: 1500, currency: 'INR' }, { product_retailer_id: 'BALLS-3', quantity: 1, item_price: 300, currency: 'INR' }] } });
  r = await send(m);
  rec('an order lists the items, quantities, prices and the note', r.row.body === '[order]\n2 item(s): RACKET-1 x2 @ 1500 INR; BALLS-3 x1 @ 300 INR\nNote: please deliver by evening', r.row.body);
  m = base({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"sport":"Tennis","slot":"6 PM"}' } } });
  r = await send(m);
  rec('form answers (a WhatsApp Flow) are stored for staff and are not treated as a greeting', r.row.body === '[form]\nForm answers: {"sport":"Tennis","slot":"6 PM"}' && /team will look/.test(replyText(r.out)), `${r.row.body} | ${replyText(r.out).slice(0, 40)}`);

  // ---------- 4. kinds WhatsApp does not pass on
  m = base({ type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] });
  r = await send(m);
  rec('an unsupported message (poll, view-once, deleted...) is explained to staff', /^\[unsupported message\]\nWhatsApp does not pass this kind of message to businesses/.test(r.row.body) && /WhatsApp says: Message type unknown\./.test(r.row.body), r.row.body.slice(0, 200));
  rec('and the member is told to send it as text, a photo or a document', /could not pass that message to us/.test(replyText(r.out)), replyText(r.out));

  // ---------- 5. files: voice note, video, sticker, Word document, a type that is not allowed
  m = base({ type: 'audio', audio: { id: 'SIM-AUDIO-1', mime_type: 'audio/ogg; codecs=opus', voice: true } });
  r = await send(m);
  rec('a voice note is kept as .ogg', r.row.body === '[audio]' && /\.ogg$/.test(r.row.media_url || '') && r.store[0] && r.store[0].mime === 'audio/ogg', `${r.row.media_url} | ${JSON.stringify(r.store)}`);
  m = base({ type: 'video', video: { id: 'SIM-VIDEO-2', mime_type: 'video/mp4', caption: 'my serve' } });
  r = await send(m);
  rec('a video is kept as .mp4 with its caption', r.row.body === '[video] my serve' && /\.mp4$/.test(r.row.media_url || ''), `${r.row.body} | ${r.row.media_url}`);
  m = base({ type: 'sticker', sticker: { id: 'SIM-STICKER-3', mime_type: 'image/webp' } });
  r = await send(m);
  rec('a sticker is kept as a picture', r.row.body === '[sticker]' && /\/wa-media\//.test(r.row.media_url || ''), `${r.row.body} | ${r.row.media_url}`);
  m = base({ type: 'document', document: { id: 'SIM-DOCX-4', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'form.docx' } });
  r = await send(m);
  rec('a Word document is kept as .docx with its name', r.row.body === '[document] form.docx' && /\.docx$/.test(r.row.media_url || ''), `${r.row.body} | ${r.row.media_url}`);

  // ---------- 6. forwarded, and from an ad
  m = base({ type: 'text', text: { body: 'see this notice' }, context: { forwarded: true } });
  r = await send(m);
  rec('a forwarded text is marked "[forwarded]" for staff', r.row.body === '[forwarded] see this notice', r.row.body);
  m = base({ type: 'text', text: { body: 'I want to join' }, referral: { source_url: 'https://fb.me/abc123', source_type: 'ad', headline: 'Join Shakti Sports Club', body: 'x' } });
  r = await send(m);
  rec('a message that came from an ad carries the ad headline and link', r.row.body === 'I want to join\n[came from an ad: Join Shakti Sports Club https://fb.me/abc123]', r.row.body);
  m = base({ type: 'text', text: { body: 'what are your timings?' } });
  r = await send(m);
  rec('an ordinary text is stored exactly as written', r.row.body === 'what are your timings?', r.row.body);
  m = base({ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } });
  r = await send(m);
  rec('a reaction is still stored as before', r.row.body === '[reaction 👍]', r.row.body);

  // ---------- 7. the Inbox shows all of it
  const seed = (dir, body, type, media) => q(`insert into public.wa_messages (tenant_id, phone, direction, body, msg_type, media_url, sender_kind) values ($1,$2,$3,$4,$5,$6,'member')`, [T, PHONE, dir, body, type, media]);
  await seed('in', '<img src=x onerror=alert(1)> visit https://evil.example.org/"onmouseover="alert(1) now', 'text', null);
  const { browser, context, fake } = await openBrowser(db, users);
  const page = await context.newPage();
  const issues = watch(page);
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  try {
    await login(page, 'qa-owner@club.test');
    await page.evaluate(() => go('inbox')); await sleep(800);
    await page.evaluate((k) => selectChat(k), PHONE);
    const view = await until(() => page.evaluate(() => {
      const box = document.getElementById('inboxMessageScroll'); if (!box) return null;
      const audio = [...box.querySelectorAll('audio.inbox-bubble-audio')].map((a) => a.src);
      const video = [...box.querySelectorAll('video')].map((v) => v.src);
      if (!audio.some((s) => /\/object\/sign\/wa-media\/.*\.ogg\?token=/.test(s)) || !video.some((s) => /\.mp4\?token=/.test(s))) return null;
      const texts = [...box.querySelectorAll('.inbox-bubble-text')].map((x) => x.textContent);
      const links = [...box.querySelectorAll('.inbox-bubble-text a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel }));
      return { audio: audio.length, video: video.length, texts, links, injected: box.querySelectorAll('.inbox-bubble-text img, .inbox-bubble-text [onmouseover], .inbox-bubble-text script').length,
        files: [...box.querySelectorAll('a.inbox-bubble-file')].map((a) => a.href), imgs: [...box.querySelectorAll('img.inbox-bubble-img')].length, broken: [...box.querySelectorAll('.inbox-failed-why')].map((x) => x.textContent) };
    }), 15000);
    rec('the voice note has a player and the video has a player, both through signed links', !!view && view.audio === 1 && view.video === 1, view ? `audio ${view.audio}, video ${view.video}` : 'players not found');
    rec('the contact card shows its name and numbers as text', !!view && view.texts.some((x) => /Ravi Shah, Shah Traders/.test(x) && /Phone: \+91 98765 43210 \(cell\)/.test(x) && /Email: ravi@example\.org/.test(x)), view ? (view.texts.find((x) => /Ravi/.test(x)) || '').slice(0, 120) : '');
    rec('the location\'s Google Maps link can be clicked and opens in a new tab', !!view && view.links.some((l) => l.href === 'https://maps.google.com/?q=22.3072,73.1812' && l.target === '_blank' && /noopener/.test(l.rel)), view ? JSON.stringify(view.links).slice(0, 220) : '');
    rec('the Word document shows an "Open document" link, the sticker a picture; nothing failed to open', !!view && view.files.some((h) => /\.docx\?token=/.test(h)) && view.imgs >= 1 && !view.broken.length, view ? `files ${view.files.length}, pictures ${view.imgs}, broken ${view.broken.length}` : '');
    rec('markup typed by a member stays text: no picture, no script, no event handler is created from it', !!view && view.injected === 0 && view.texts.some((x) => x.includes('<img src=x onerror=alert(1)>')) && view.links.every((l) => /^https?:\/\//.test(l.href) && !/["<>]/.test(l.href)), view ? `injected ${view.injected}; ${JSON.stringify(view.links.find((l) => /evil/.test(l.href)) || {})}` : '');
    rec('the unsupported message is explained in the thread', !!view && view.texts.some((x) => /WhatsApp does not pass this kind of message/.test(x)), '');
  } finally {
    rec('no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
    rec('every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
    fake.stop(); await browser.close();
  }

  // ---------- 8. a file type that is not allowed is refused by the relay's own rule
  const relay = benchCode('file_upload_relay_wf.json', 'Check request');
  const check = async (mime, name) => { const fn = new AsyncFn('$input', 'Buffer', relay); const confirm = (relay.match(/const CONFIRM='([^']+)'/) || [])[1]; const out = await fn.call({ helpers: world(db).helpers }, { first: () => ({ json: { body: { confirm, target_url: `${STG}/storage/v1/object/wa-media/${T}/${PHONE}/x.${name}`, mime, file_base64: 'AAAA' } } }) }, Buffer); return out[0].json; };
  const okDoc = await check('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'), bad = await check('application/x-msdownload', 'exe'), html = await check('text/html', 'html');
  rec('the upload relay accepts an Excel file, and refuses a program (.exe) and a web page (.html)', okDoc.ok === true && bad.ok === false && html.ok === false && /cannot be stored/.test(bad.error), `xlsx ${okDoc.ok} | exe ${bad.error} | html ${html.error}`);
} catch (e) {
  rec('finished without a script error', false, e.stack || e.message);
  console.log(String(e.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1500));
}
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} message-type checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
