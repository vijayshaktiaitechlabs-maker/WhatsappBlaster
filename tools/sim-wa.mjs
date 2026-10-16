// Sends WhatsApp events to the STAGING bot the way Meta does (signed with the staging Meta app secret),
// so the bot can be tested without Meta, and shows what the bot would have sent (stg_outbox) and what
// was stored (wa_messages). It only ever posts to /webhook/stg-wa-bot.
//
//   npm run staging:wa -- --text "What are your timings?"      a member message (from the first test phone)
//   npm run staging:wa -- --tap menu:facilities                a tap on a menu item or button
//   npm run staging:wa -- --image                              a photo (with --caption "...")
//   npm run staging:wa -- --contact "Ravi Shah:+91 98765 43210"   a contact card
//   npm run staging:wa -- --location "22.3072,73.1812"           a shared location
//   npm run staging:wa -- --status read --wamid wamid.XXX      a delivery status for a sent message
//   extra options: --from 91XXXXXXXXXX  --name "Rahul"  --unsigned (no signature)  --bad-signature
//   --wait 20 (seconds to wait for the bot)  --id <wamid> (reuse a message id, to test Meta's retries)
import { createHmac, randomBytes } from 'node:crypto';
import { TARGETS, fail, say, main, isMain, loadConfig } from './lib.mjs';
import { stagingSettings } from './build-staging.mjs';

export function simContext() {
  const cfg = loadConfig(['staging.supabaseUrl', 'staging.serviceKey', 'staging.testPhones']);
  const S = stagingSettings(cfg);
  if (!S.wa.phoneNumberId) fail('staging.whatsapp.phoneNumberId is empty: the bot finds the club by it.');
  return { S, hook: `${TARGETS.publicBase}/webhook/stg-wa-bot` };
}

/* one Meta-shaped webhook body */
export function metaEvent(S, { from, name = 'Test Member', text, tap, image, caption, status, wamid, id, reaction, contact, location } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const value = { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: S.wa.phoneNumberId } };
  if (status) {
    value.statuses = [{ id: wamid, status, timestamp: ts, recipient_id: from,
      ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Simulated failure from sim-wa' } }] } : {}) }];
  } else {
    const msg = { from, id: id || `wamid.SIMIN.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}`, timestamp: ts };
    if (tap) Object.assign(msg, { type: 'interactive', interactive: { type: /^act:|^menu:/.test(tap) ? 'list_reply' : 'button_reply', [/^act:|^menu:/.test(tap) ? 'list_reply' : 'button_reply']: { id: tap, title: tap } } });
    else if (image) Object.assign(msg, { type: 'image', image: { id: 'SIM-MEDIA-1', mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } });
    else if (reaction) Object.assign(msg, { type: 'reaction', reaction: { message_id: 'wamid.X', emoji: reaction } });
    else if (contact) { const [cn, cp] = String(contact).split(':'); Object.assign(msg, { type: 'contacts', contacts: [{ name: { formatted_name: cn.trim() || 'Contact', first_name: cn.trim().split(' ')[0] }, phones: cp ? [{ phone: cp.trim(), type: 'CELL', wa_id: cp.replace(/\D/g, '') }] : [] }] }); }
    else if (location) { const [la, lo] = String(location).split(',').map(Number); Object.assign(msg, { type: 'location', location: { latitude: la, longitude: lo, name: 'Shared location' } }); }
    else Object.assign(msg, { type: 'text', text: { body: text == null ? 'hi' : String(text) } });
    value.contacts = [{ profile: { name }, wa_id: from }];
    value.messages = [msg];
  }
  return { object: 'whatsapp_business_account', entry: [{ id: S.wa.wabaId || 'SIM-WABA', changes: [{ field: 'messages', value }] }] };
}

export async function postEvent(ctx, body, { unsigned = false, badSignature = false } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (!unsigned) {
    const sig = createHmac('sha256', badSignature ? 'wrong-secret' : ctx.S.wa.appSecret).update(raw).digest('hex');
    headers['X-Hub-Signature-256'] = `sha256=${sig}`;
  }
  if (!/\/webhook\/stg-wa-bot$/.test(ctx.hook)) fail('sim-wa only posts to the staging bot.');
  const res = await fetch(ctx.hook, { method: 'POST', headers, body: raw });
  return { status: res.status, text: await res.text() };
}

const sdb = async (S, path) => {
  const r = await fetch(`${S.url}/rest/v1/${path}`, { headers: { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}` } });
  return r.ok ? r.json() : null;
};
export const outboxSince = (S, since) => sdb(S, `stg_outbox?created_at=gt.${encodeURIComponent(since)}&order=id.asc&select=kind,phone,msg_type,wamid,payload,created_at`);
export const messagesSince = (S, phoneKey, since) => sdb(S, `wa_messages?phone_key=eq.${phoneKey}&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&select=direction,body,msg_type,wamid,status,sender_kind,error_title,created_at`);

/* waits until the bot has stored its answer (or the time runs out) */
export async function waitForBot(S, phoneKey, since, seconds = 25, wantOut = 1) {
  const until = Date.now() + seconds * 1000;
  let msgs = [];
  while (Date.now() < until) {
    msgs = (await messagesSince(S, phoneKey, since)) || [];
    if (msgs.filter((m) => m.direction === 'out').length >= wantOut) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { messages: msgs, outbox: (await outboxSince(S, since)) || [] };
}

/* Options that take a value always take the next argument as text (even "" or "--help me");
   the others are on/off switches. A missing value or an unknown option stops with a clear message. */
const VALUE_OPTS = ['text', 'from', 'name', 'caption', 'tap', 'id', 'wamid', 'status', 'reaction', 'wait', 'contact', 'location'];
const FLAG_OPTS = ['image', 'unsigned', 'bad-signature'];
export function parseSimArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const k = String(args[i]).replace(/^--/, '');
    if (!String(args[i]).startsWith('--') || ![...VALUE_OPTS, ...FLAG_OPTS].includes(k)) fail(`Unknown option "${args[i]}". Options: ${[...VALUE_OPTS, ...FLAG_OPTS].map((x) => `--${x}`).join(' ')}`);
    if (FLAG_OPTS.includes(k)) { o[k] = true; continue; }
    if (i + 1 >= args.length) fail(`--${k} needs a value, e.g. --${k} ${k === 'wait' ? '20' : '"..."'}`);
    o[k] = String(args[++i]);
  }
  if (o.wait !== undefined && !(Number.isFinite(Number(o.wait)) && Number(o.wait) > 0 && o.wait.trim() !== '')) fail(`--wait needs a number of seconds (got "${o.wait}").`);
  return o;
}

if (isMain(import.meta.url)) {
  main(async () => {
    const parsed = parseSimArgs(process.argv.slice(2));
    const opt = (k) => parsed[k];
    const ctx = simContext();
    const from = String(opt('from') || ctx.S.phones[0]).replace(/\D/g, '');
    if (!ctx.S.phones.includes(from)) say(`note: ${from} is not a test phone, so the bot's reply to it will be refused (shows as failed).`);
    const since = new Date(Date.now() - 1000).toISOString();
    const body = metaEvent(ctx.S, { from, name: opt('name') || 'Test Member', text: opt('text'), tap: opt('tap'), image: !!opt('image'), caption: opt('caption'),
      status: opt('status'), wamid: opt('wamid'), id: opt('id'), reaction: opt('reaction'), contact: opt('contact'), location: opt('location') });
    const r = await postEvent(ctx, body, { unsigned: !!opt('unsigned'), badSignature: !!opt('bad-signature') });
    say(`posted to ${ctx.hook}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
    if (opt('status')) return;
    const key = from.length === 10 ? `91${from}` : from;
    const { messages, outbox } = await waitForBot(ctx.S, key, since, Number(opt('wait') || 25));
    say('\nStored in wa_messages:');
    for (const m of messages) say(`  ${m.direction.padEnd(3)} ${String(m.sender_kind || '').padEnd(8)} ${String(m.status || '').padEnd(9)} ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    say('\nWhat the test copy would have sent (stg_outbox):');
    for (const o of outbox) say(`  ${o.kind.padEnd(20)} ${o.phone || ''} ${o.msg_type || ''} ${JSON.stringify(o.payload).slice(0, 160)}`);
  });
}
