// Builds the TEST copy of the product into .staging-build/ from the live source files.
// The source files are never edited for testing: every live-vs-test difference is applied
// here at build time, so branches only ever contain real product changes.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { TARGETS, BUILD_DIR, at, fail, say, main, isMain, loadConfig, readWorkflow, apiBody, run, jwtClaims } from './lib.mjs';
export { jwtClaims };

const LIVE_REF = TARGETS.supabaseRef;
const LIVE_SUPABASE = `https://${LIVE_REF}.supabase.co`;
const JWT = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const WEBHOOK_URL = /(https?:\/\/[^\s'"`<>\\]+?\/webhook(?:-test)?\/)(?!stg-)/g;
const LIVE_WEBHOOK = /\/webhook(?:-test)?\/(?!stg-)/g;
const WHATSAPP_TOKEN = /\bEAA[A-Za-z0-9]{30,}/g;
const GEMINI_KEY = /AIza[0-9A-Za-z_-]{35}/g;
/* placeholder that puts the staging guard in "AI stand-in" mode when no staging Gemini key is configured */
const NO_GEMINI = 'STAGING-NO-GEMINI-KEY';
/* the live EspoCRM (sales CRM): staging has none, so its address and key are replaced by ones that go nowhere */
const ESPO_URL = /https?:\/\/(?:orena\.solutions\/espo|espo\.orenanow\.com)/gi;
const ESPO_HOST = /orena\.solutions\/espo|espo\.orenanow\.com/gi;
const NO_ESPO_URL = 'https://espo.staging.invalid';
const NO_ESPO_KEY = 'STAGING-NO-ESPO-KEY';

export function stagingSettings(cfg) {
  const s = cfg.staging;
  const m = String(s.supabaseUrl).trim().match(/^https:\/\/([a-z0-9]{20})\.supabase\.co(?:\/.*)?$/);
  if (!m) fail(`staging.supabaseUrl should look like https://abcdefghijklmnopqrst.supabase.co (got "${String(s.supabaseUrl).trim()}").`);
  if (m[1] === LIVE_REF) fail('staging.supabaseUrl is the LIVE database. Create a separate Supabase project for testing (see STAGING.md).');
  const ref = m[1];
  const url = `https://${ref}.supabase.co`;
  for (const [field, role] of [['anonKey', 'anon'], ['serviceKey', 'service_role']]) {
    const claims = jwtClaims(String(s[field]).trim());
    if (!claims) fail(`staging.${field} is not a legacy key. In the staging project open Project Settings > API Keys > "Legacy API keys" and copy the ${role} key.`);
    if (claims.ref !== ref) fail(`staging.${field} belongs to a different Supabase project than staging.supabaseUrl.`);
    if (claims.role !== role) fail(`staging.${field} is the ${claims.role} key; it should be the ${role} key.`);
  }
  const phones = s.testPhones.map((p) => String(p).replace(/\D/g, ''));
  for (const p of phones) if (p.length < 11 || p.length > 15) fail(`Test phone "${p}" needs the country code, e.g. 919876543210.`);
  const email = String(s.adminEmail).trim().toLowerCase();
  if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) fail(`staging.adminEmail "${email}" doesn't look like an email address.`);
  const wa = s.whatsapp || {};
  const serviceKey = String(s.serviceKey).trim();
  const geminiKey = String(s.geminiKey || '').trim();
  /* Google AI Studio keys: the older "AIza…" form and the newer "AQ.…" form */
  if (geminiKey && !/^(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_-]{20,200})$/.test(geminiKey)) fail('staging.geminiKey does not look like a Google AI Studio key (AIza… or AQ.…). Leave it empty to run the bot with a stand-in AI in staging.');
  return {
    url, ref, host: `${ref}.supabase.co`,
    anonKey: String(s.anonKey).trim(),
    serviceKey,
    confirmToken: createHash('sha256').update(`staging-confirm:${serviceKey}`).digest('base64url').slice(0, 24),
    inviteSecret: createHash('sha256').update(`staging-invite:${serviceKey}`).digest('base64url').slice(0, 24),
    phones, email,
    wa: { phoneNumberId: String(wa.phoneNumberId || '').trim(), wabaId: String(wa.wabaId || '').trim(), token: String(wa.token || '').trim(),
          appSecret: String(wa.appSecret || '').trim(), verifyToken: String(wa.verifyToken || '').trim() || 'shakti-staging-verify',
          simulate: wa.simulate === true },
    geminiKey,
  };
}

// Secrets that live code carries as plain strings, so each copy of them can be swapped.
export function collectLiveSecrets(texts) {
  const confirms = new Set();
  const geminis = new Set();
  const espoKeys = new Set();
  const invites = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(GEMINI_KEY)) geminis.add(m[0]);
    for (const m of t.matchAll(/\bCONFIRM\s*=\s*(['"])([^'"\s]{12,})\1/g)) confirms.add(m[2]);
    for (const m of t.matchAll(/\bconfirm\s*:\s*(['"])([A-Za-z0-9_-]{12,})\1/g)) confirms.add(m[2]);
    /* EspoCRM API keys: an X-Api-Key header or an ESPO_KEY / ESPO_API_KEY constant written as text */
    for (const m of t.matchAll(/X-Api-Key['"]?\s*:\s*(['"])([A-Za-z0-9_-]{16,})\1/gi)) espoKeys.add(m[2]);
    for (const m of t.matchAll(/\bESPO_(?:API_)?KEY\s*=\s*(['"])([A-Za-z0-9_-]{16,})\1/gi)) espoKeys.add(m[2]);
    /* the staff-invite webhook's shared secret, if the page or a workflow carries one */
    for (const m of t.matchAll(/\bINVITE_(?:WEBHOOK_)?SECRET\s*=\s*(['"])([^'"\s]{12,})\1/gi)) invites.add(m[2]);
    for (const m of t.matchAll(/['"]?\b(?:x-invite-secret|invite_secret|inviteSecret)['"]?\s*:\s*(['"])([A-Za-z0-9_-]{12,})\1/gi)) invites.add(m[2]);
  }
  return { confirms: [...confirms], geminis: [...geminis], espoKeys: [...espoKeys], invites: [...invites] };
}

export function swapEnvironment(text, S, live) {
  /* this product copy carries placeholders instead of keys: fill them with the staging values
     (the confirm placeholder is found by collectLiveSecrets like any CONFIRM constant) */
  let out = text.split('__SUPABASE_URL__').join(S.url).split('__SUPABASE_SERVICE_KEY__').join(S.serviceKey).split('__SUPABASE_ANON_KEY__').join(S.anonKey)
    .split('__GEMINI_KEY__').join(S.geminiKey || NO_GEMINI);
  out = out.replace(JWT, (token) => {
    const claims = jwtClaims(token);
    if (!claims || claims.ref !== LIVE_REF) return token;
    if (claims.role === 'anon') return S.anonKey;
    if (claims.role === 'service_role') return S.serviceKey;
    return token;
  });
  out = out.split(LIVE_SUPABASE).join(S.url);
  for (const secret of live.confirms) out = out.split(secret).join(S.confirmToken);
  /* the live Gemini (AI) key never reaches staging: the staging key, or the stand-in placeholder */
  for (const key of live.geminis || []) out = out.split(key).join(S.geminiKey || NO_GEMINI);
  /* the live EspoCRM: its key and address are replaced by ones that reach nothing */
  for (const key of live.espoKeys || []) out = out.split(key).join(NO_ESPO_KEY);
  out = out.replace(ESPO_URL, NO_ESPO_URL);
  for (const secret of live.invites || []) out = out.split(secret).join(S.inviteSecret || 'STAGING-INVITE-SECRET');
  return out.replace(WEBHOOK_URL, '$1stg-');
}

export function scan(label, text, live, { allowWhatsAppToken = false, webPage = false } = {}) {
  const problems = [];
  const where = (index) => `${label} (line ${text.slice(0, index).split('\n').length})`;
  const each = (re, why) => { for (const m of text.matchAll(re)) problems.push(`${where(m.index)}: ${why}`); };
  each(new RegExp(LIVE_REF, 'g'), 'still points at the live database');
  each(/__(?:SUPABASE_URL|SUPABASE_SERVICE_KEY|SUPABASE_ANON_KEY|GEMINI_KEY|CONFIRM_TOKEN)__/g, 'has a key placeholder that was not filled');
  for (const m of text.matchAll(JWT)) {
    const claims = jwtClaims(m[0]);
    if (claims && claims.ref === LIVE_REF) problems.push(`${where(m.index)}: contains a live database key (${claims.role})`);
    /* a web page is readable by anyone who opens it: a service_role key there opens the whole database */
    else if (claims && webPage && claims.role === 'service_role') problems.push(`${where(m.index)}: a web page contains a service_role database key (${claims.ref})`);
  }
  each(ESPO_HOST, 'calls the live EspoCRM');
  for (const [list, why] of [[live.espoKeys, 'contains the live EspoCRM API key'], [live.invites, 'contains the live staff-invite secret']]) {
    for (const secret of list || []) {
      for (let i = text.indexOf(secret); i !== -1; i = text.indexOf(secret, i + 1)) problems.push(`${where(i)}: ${why}`);
    }
  }
  for (const secret of live.confirms) {
    for (let i = text.indexOf(secret); i !== -1; i = text.indexOf(secret, i + 1)) problems.push(`${where(i)}: contains the live broadcast confirm token`);
  }
  each(LIVE_WEBHOOK, 'calls a live n8n webhook');
  for (const key of live.geminis || []) {
    for (let i = text.indexOf(key); i !== -1; i = text.indexOf(key, i + 1)) problems.push(`${where(i)}: contains the live Gemini (AI) key`);
  }
  if (!allowWhatsAppToken) each(WHATSAPP_TOKEN, 'contains a WhatsApp access token');
  return problems;
}

const BANNER = [
  '<div data-staging-banner style="position:fixed;left:0;right:0;top:0;height:3px;z-index:2147483647;pointer-events:none;background:#FFD23F"></div>',
  '<div data-staging-banner style="position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;background:#FFD23F;color:#1B1B1B;border:1px solid #1B1B1B;border-radius:999px;padding:4px 12px;font:600 12px/1.4 system-ui,sans-serif">TEST COPY &middot; staging data, not the live club</div>',
].join('\n');

function stagingPage(html, label, S) {
  if (!/<body(\s[^>]*)?>/i.test(html)) fail(`${label} has no <body> tag.`);
  const banner = S && S.wa.simulate ? BANNER.replace('staging data, not the live club', 'staging data, not the live club &middot; WhatsApp simulated') : BANNER;
  return html
    .replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n<meta name="robots" content="noindex, nofollow">`)
    .replace(/<title>/i, '<title>[TEST] ')
    .replace(/<body(\s[^>]*)?>/i, (tag) => `${tag}\n${banner}`);
}

// Meta's own sample templates, approved on every Meta test account. The test copy of the admin page lists
// them after the club's templates, so sending, posters, reports and replies can be tested while Meta is
// still reviewing the club's templates on the test account. Never added to live.
const META_SAMPLE_TEMPLATES = [
  { name: 'jaspers_market_image_cta_v1', label: 'Meta sample: poster + button', cat: 'MARKETING', lang: 'en_US', has_image: true,
    body: "Free delivery for all online orders with Jasper's Market\n\ndevelopers.facebook.com", vars: [] },
  { name: 'jaspers_market_order_confirmation_v1', label: 'Meta sample: order confirmation (2 free-text blanks)', cat: 'UTILITY', lang: 'en_US',
    body: "*Order confirmed*\n\nHi {{1}},\n\nThank you for your purchase! Your order number is {{2}}.\n\nWe'll start getting your farm fresh groceries ready to ship.\n\nEstimated delivery:  {{3}}.\n\nWe will let you know when your order ships.\n\ndevelopers.facebook.com",
    vars: [{ k: '1', label: 'Member name', def: 'first_name' }, { k: '2', label: 'Order number', def: 'custom', ph: 'SSC-1042' }, { k: '3', label: 'Estimated delivery', def: 'custom', ph: 'Friday, 3 Oct' }] },
  { name: 'hello_world', label: 'Meta sample: Hello World', cat: 'UTILITY', lang: 'en_US',
    body: '*Hello World*\n\nWelcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.\n\nWhatsApp Business Platform sample message', vars: [] },
  { name: 'jaspers_market_plain_text_v1', label: 'Meta sample: plain text', cat: 'MARKETING', lang: 'en_US',
    body: 'Welcome to Jasper’s Market, your local grocery store providing farm-fresh produce and high-quality goods!', vars: [] },
];
function withMetaSampleTemplates(html, label) {
  const start = html.indexOf('const TPL=[');
  const end = start === -1 ? -1 : html.indexOf('\n];', start);
  if (end === -1) fail(`${label}: the template list (const TPL=[ ... ];) was not found, so Meta's sample templates could not be added to the test copy.`);
  const after = end + 3;
  return `${html.slice(0, after)}
/* STAGING ONLY, added by tools/build-staging.mjs: Meta's sample templates (already approved on the Meta test
   account), so sending can be tested while Meta reviews the club's own templates. Not on live. */
TPL.push(...${JSON.stringify(META_SAMPLE_TEMPLATES)});
const __stgSampleNames = ${JSON.stringify(Object.fromEntries(META_SAMPLE_TEMPLATES.map((t) => [t.name, t.label])))};
const __stgPrettyTpl = prettyTpl;
prettyTpl = (n) => __stgSampleNames[n] || __stgPrettyTpl(n);${html.slice(after)}`;
}

// Runs in front of every n8n Code node in the test copy. It wraps this.helpers.httpRequest so a
// test workflow can only reach the staging database and can only message the configured test phones.
// The server's poster upload helper writes to live storage, so the test copy stores posters in the
// staging project's public "brand" bucket instead (through the staging File Upload Relay, because a
// Code node here can't send a binary body), and answers the way the helper does.
// Other staging stand-ins, all recorded in the staging-only table stg_outbox (staging/db/stg-sim.sql):
//  * the bot's lead posts (the Client Lead Intake workflow, which writes to EspoCRM, is not in staging);
//  * the AI (Gemini): every request is recorded so tests can read the prompt; without a staging Gemini
//    key (staging.geminiKey) the AI answers with a clearly marked stand-in and embeddings are refused;
//  * "simulated Meta" (staging.whatsapp.simulate = true): nothing reaches Meta. Outgoing messages and
//    template submissions are recorded and get fake ids, and the template list is the club's catalog.
//    Messages to numbers that are not test phones are still refused (they show as failed).
const RELAY_PATH = 'file-upload-relay';
export function guardSource(S, meta = {}, simTemplates = []) {
  return `// ---- STAGING GUARD: added by tools/build-staging.mjs, never present on live ----
const __stg = { allow: ${JSON.stringify(S.phones)}, db: ${JSON.stringify(S.host)}, testWaba: ${JSON.stringify(S.wa.wabaId && S.wa.wabaId !== TARGETS.liveWabaId ? S.wa.wabaId : '')},
  storageKey: ${JSON.stringify(S.serviceKey)}, confirm: ${JSON.stringify(S.confirmToken)}, relay: ${JSON.stringify(`${TARGETS.publicBase}/webhook/stg-${RELAY_PATH}`)},
  sim: ${JSON.stringify(!!S.wa.simulate)}, noAi: ${JSON.stringify(NO_GEMINI)}, wf: ${JSON.stringify(meta.wf || '')}, node: ${JSON.stringify(meta.node || '')},
  n8n: ${JSON.stringify(new URL(TARGETS.publicBase).host.toLowerCase())},
  templates: ${JSON.stringify(simTemplates)} };
const __stgReal = this.helpers;
const __stgStop = (why) => { throw new Error('STAGING GUARD: ' + why); };
const __stgBody = (opts) => { try { return typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {}); } catch (e) { return {}; } };
/* an 8x8 picture: what simulated Meta hands over for any media id (a '…PDF…' id is a document, '…BIG…' is too large, '…FAIL…' is missing) */
const __stgPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=", 'base64');
const __stgFake = (opts, code, body) => {
  if (opts && opts.returnFullResponse) return { statusCode: code, headers: {}, body };
  if (code >= 400) throw new Error('STAGING SIMULATION: ' + JSON.stringify(body).slice(0, 300));
  return body;
};
const __stgRecord = async (row) => {
  try {
    const r = await __stgReal.httpRequest({ method: 'POST', url: 'https://' + __stg.db + '/rest/v1/stg_outbox',
      headers: { apikey: __stg.storageKey, Authorization: 'Bearer ' + __stg.storageKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(Object.assign({ workflow: __stg.wf, node: __stg.node }, row)), returnFullResponse: true, ignoreHttpStatusErrors: true });
    return r.statusCode < 300;
  } catch (e) { return false; }
};
const __stgUpload = async (opts) => {
  let b = {};
  try { b = typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {}); } catch (e) {}
  const name = String(b.filename || 'poster').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/\\.{2,}/g, '.').replace(/^[-.]+|-+$/g, '').slice(-60) || 'poster';
  const key = 'posters/' + Date.now() + '-' + name;
  const res = await __stgReal.httpRequest({ method: 'POST', url: __stg.relay, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: __stg.confirm, target_url: 'https://' + __stg.db + '/storage/v1/object/brand/' + key,
      headers: { apikey: __stg.storageKey, Authorization: 'Bearer ' + __stg.storageKey, 'x-upsert': 'true' },
      mime: String(b.mime || 'image/jpeg'), file_base64: String(b.file_base64 || '') }),
    returnFullResponse: true, ignoreHttpStatusErrors: true });
  let r = res.body;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || ('the staging upload relay answered HTTP ' + res.statusCode) };
  return { ok: true, publicUrl: 'https://' + __stg.db + '/storage/v1/object/public/brand/' + key, path: key };
};
const __stgHelpers = new Proxy(__stgReal, { get(target, prop) {
  if (prop !== 'httpRequest') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; }
  return async (opts) => {
    const url = String((opts && (opts.url || opts.uri)) || '');
    const hm = url.match(/^https?:\\/\\/([^\\/?#]+)/i);
    const host = hm ? hm[1].toLowerCase() : '';
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (host.endsWith('.supabase.co') && host !== __stg.db) __stgStop('a request to a non-staging database was stopped');
    if (/^172\\.16\\.|:5055$/.test(host)) return __stgUpload(opts);
    if (new RegExp('/webhook(?:-test)?/(?!stg-)').test(url)) __stgStop('a call to a live n8n webhook was stopped');
    if (/\\/webhook\\/stg-client-lead(\\?|$)/.test(url)) {
      await __stgRecord({ kind: 'lead', target: 'client-lead', payload: __stgBody(opts) });
      return __stgFake(opts, 200, { ok: true, simulated: true });
    }
    if (host === 'generativelanguage.googleapis.com') {
      const key = (url.match(/[?&]key=([^&]+)/) || [])[1] || '';
      const b = __stgBody(opts);
      const said = (((b.contents || [])[0] || {}).parts || [{}])[0].text || ((((b.content || {}).parts || [])[0] || {}).text) || '';
      await __stgRecord({ kind: /:embedContent/.test(url) ? 'ai_embed' : 'ai_prompt', target: url.split('?')[0].split('/').pop(), payload: { text: String(said).slice(0, 30000) } });
      if (key === __stg.noAi) {
        if (/:batchEmbedContents/.test(url)) return __stgFake(opts, 200, { embeddings: (b.requests || []).map((x, i) => ({ values: Array.from({ length: 768 }, (y, k) => (((i + 1) * (k % 7 + 1)) % 10) / 10) })) });
        if (/^KB-FILE-EXTRACT/.test(said)) return __stgFake(opts, 200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ summary: '[TEST] stand-in reading: a club notice', facts: [
          { topic: 'Pool', fact: 'The swimming pool is closed every Monday for cleaning.' },
          { topic: 'Fees', fact: 'The annual maintenance charge is Rs 29,500 including GST.' },
          { topic: 'Contact', fact: 'Call the front desk on 98765 43210 for court bookings.' },
          { topic: 'Guests', fact: 'Guests must carry a photo identity card and be accompanied by a member.' },
          { topic: 'Payment', fact: 'Pay online at https://pay.example.org/club before the due date.' },
          { topic: 'Lockers', fact: 'Member ICM004 Sarah Patel has locker number 12.' },
          { topic: 'Refunds', fact: 'Write to office@club.example.org to ask about refunds.' },
          { topic: 'Coaching', fact: 'Tennis coaching runs from Tuesday to Saturday, 6 AM to 8 AM.' },
          { topic: 'Bank', fact: 'Transfer to bank account 1234567890123 with IFSC HDFC0001234.' },
          { topic: 'Dress', fact: 'Non-marking shoes are compulsory on all indoor courts.' }] }) }] } }] });
        if (/:embedContent/.test(url)) return __stgFake(opts, 503, { error: { message: 'STAGING: no Gemini key, so no embedding (the bot uses its built-in club text)' } });
        return __stgFake(opts, 200, { candidates: [{ content: { parts: [{ text: '[TEST] AI stand-in: the AI is switched off in staging (no staging Gemini key). The real answer would appear here. [[KB:HIT]]' }] } }] });
      }
    }
    if (host === 'graph.facebook.com' && /\\/message_templates|\\/uploads(\\?|$)|\\/upload:|\\/v[0-9.]+\\/app(\\?|$)/.test(url)) {
      if (!__stg.testWaba) __stgStop('template submission is switched off: staging needs a Meta TEST WhatsApp account (see STAGING.md step 5), never the club\\'s real one');
      if (/\\/message_templates/.test(url) && url.indexOf('/' + __stg.testWaba + '/') === -1) __stgStop('template requests may only go to the staging test WhatsApp account');
    }
    if (host === 'graph.facebook.com' && /\\/messages(\\?|$)/.test(url)) {
      let to = '';
      try { const b = typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {}); to = String(b.to || '').replace(/\\D/g, ''); } catch (e) {}
      if (!__stg.allow.includes(to)) {
        const msg = 'STAGING GUARD: ' + (to ? to.slice(0, 2) + '******' + to.slice(-2) : 'this number') + ' is not a test phone, so no message was sent';
        if (opts.returnFullResponse) return { statusCode: 403, headers: {}, body: { error: { message: msg, code: 'STAGING_GUARD' } } };
        throw new Error(msg);
      }
    }
    if (__stg.sim && host === 'graph.facebook.com') {
      const p = url.replace(/^https?:\\/\\/[^/]+\\/v[0-9.]+\\//, '').split('?')[0];
      const b = __stgBody(opts);
      if (method === 'POST' && /(^|\\/)messages$/.test(p)) {
        const to = String(b.to || '').replace(/\\D/g, '');
        const wamid = 'wamid.STAGING.' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10);
        await __stgRecord({ kind: 'meta_message', target: p, phone: to, msg_type: String(b.type || ''), wamid, payload: b });
        return __stgFake(opts, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] });
      }
      if (/message_templates$/.test(p)) {
        if (method === 'POST') {
          await __stgRecord({ kind: 'meta_template_submit', target: p, payload: b });
          return __stgFake(opts, 200, { id: 'SIM-TPL-' + Date.now(), status: 'PENDING', category: b.category || null });
        }
        const name = decodeURIComponent((url.match(/[?&]name=([^&]+)/) || [])[1] || '');
        return __stgFake(opts, 200, { data: __stg.templates.filter((x) => !name || x.name === name) });
      }
      if (method === 'GET' && /[?&]fields=url/.test(url)) {
        if (/FAIL/.test(p)) return __stgFake(opts, 404, { error: { message: 'STAGING SIMULATION: media not found', code: 100 } });
        return __stgFake(opts, 200, { url: 'https://graph.facebook.com/v20.0/__stg_media_bytes/' + p, mime_type: /PDF/.test(p) ? 'application/pdf' : /AUDIO/.test(p) ? 'audio/ogg; codecs=opus' : /VIDEO/.test(p) ? 'video/mp4' : /DOCX/.test(p) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /EXE/.test(p) ? 'application/x-msdownload' : 'image/png', file_size: /BIG/.test(p) ? 99 * 1024 * 1024 : __stgPng.length, id: p });
      }
      if (method === 'GET' && /^__stg_media_bytes\\//.test(p)) return __stgFake(opts, 200, __stgPng);
      if (p === 'app') return __stgFake(opts, 200, { id: 'SIMAPP' });
      if (/^SIMAPP\\/uploads$/.test(p)) return __stgFake(opts, 200, { id: 'upload:SIMULATED' });
      __stgStop('simulated Meta: ' + method + ' ' + p + ' is not simulated in staging');
    }
    if (__stg.sim && url === __stg.relay && /upload:SIMULATED/.test(String(__stgBody(opts).target_url || ''))) {
      return __stgFake(opts, 200, { ok: true, status: 200, body: { h: 'SIM-HANDLE' } });
    }
    /* deny by default: only these may leave the test copy */
    const path = url.replace(/^https?:\\/\\/[^\\/?#]+/i, '');
    const pass = () => target.httpRequest.call(target, opts);
    if (host === __stg.db) return pass();
    if (host === 'graph.facebook.com') return pass();
    if (host === 'generativelanguage.googleapis.com' && ((url.match(/[?&]key=([^&]+)/) || [])[1] || __stg.noAi) !== __stg.noAi) return pass();
    if (host === __stg.n8n && /^\\/webhook(?:-test)?\\/stg-/.test(path)) return pass();
    /* reading a public image (a poster template's example picture), never a live service */
    if (method === 'GET' && opts && opts.encoding === 'arraybuffer' && opts.body == null && /^https:/i.test(url)
        && host && !host.endsWith('.supabase.co') && host !== __stg.n8n && !/(^|\\.)orena(now)?\\.|espo/.test(host)) return pass();
    __stgStop('a request to ' + (host || 'an unknown address') + ' was stopped: the test copy may only reach the staging database, Meta, the staging AI key and stg- webhooks');
  };
} });
// ---- end of staging guard ----
`;
}

const uuidFrom = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function stagingWorkflow(source, S, live, problems, simTemplates = []) {
  const wf = structuredClone(readWorkflow(source));
  wf.name = `[STAGING] ${wf.name}`;
  for (const node of wf.nodes) {
    const label = `${source} > node "${node.name}"`;
    const params = node.parameters || {};
    if (node.type === 'n8n-nodes-base.webhook') {
      if (!String(params.path).startsWith('stg-')) params.path = `stg-${params.path}`;
      node.webhookId = uuidFrom(`staging:${node.webhookId || node.id || node.name}`);
    }
    if (typeof params.jsCode === 'string') {
      /* Meta's webhook handshake must work before the staging database has its webhook table */
      params.jsCode = params.jsCode.replace("const VERIFY_FALLBACK='';", `const VERIFY_FALLBACK=${JSON.stringify(S.wa.verifyToken)};`);
      /* the test copy's upload relay may also write posters into the staging project's storage */
      params.jsCode = params.jsCode.replace('const ALLOW_STORAGE=false;', 'const ALLOW_STORAGE=true;');
      params.jsCode = guardSource(S, { wf: wf.name, node: node.name }, simTemplates) + params.jsCode.replaceAll('this.helpers', '__stgHelpers');
    } else if (node.type === 'n8n-nodes-base.code') {
      problems.push(`${label}: only JavaScript Code nodes can carry the test-phone guard`);
    }
    if (node.credentials) {
      problems.push(`${label}: uses saved n8n credentials (${Object.keys(node.credentials).join(', ')}), which are the LIVE accounts`);
    }
    if (node.type !== 'n8n-nodes-base.code' && /graph\.facebook\.com/.test(JSON.stringify(params))) {
      problems.push(`${label}: talks to WhatsApp outside a Code node, where the test-phone guard can't check it`);
    }
    /* an HTTP Request node is outside the guard: only the upload relay's, whose address its own Check
       request step limits (Meta upload sessions, and in the test copy the staging storage), is allowed */
    if (node.type === 'n8n-nodes-base.httpRequest' && !(path.basename(source) === 'file_upload_relay_wf.json' && node.name === 'Send bytes')) {
      problems.push(`${label}: an HTTP Request node sends outside the staging guard; only the upload relay's "Send bytes" node is allowed`);
    }
  }
  return swapEnvironment(JSON.stringify(apiBody(wf), null, 2), S, live);
}

const LIVE_GUARD_SQL = () => `do $$ begin
  if to_regclass('public.tenants') is not null then
    if exists (select 1 from public.tenants where id = '${TARGETS.liveTenantId}') then
      raise exception 'STOP: this is the LIVE database. Run this only in the staging Supabase project.';
    end if;
  end if;
end $$;
`;

function structureSql() {
  const files = readFileSync(at('staging', 'db', 'schema-files.txt'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const parts = [
    '-- STAGING DATABASE STRUCTURE. Generated by tools/build-staging.mjs; do not edit by hand.',
    '-- Same structure as the live database, built from the sql/ files in staging/db/schema-files.txt.',
    '-- Run it once in the STAGING project: Supabase > SQL Editor > paste > Run.',
    '',
    LIVE_GUARD_SQL(),
  ];
  for (const file of files) {
    let body = readFileSync(at('sql', file), 'utf8');
    body = body.split(/\r?\n/).map((line) =>
      /^\s*(alter table|create index)[^;]*\b(contacts|leads)\b/i.test(line) ? `-- [left out of staging: sales-CRM table] ${line}` : line).join('\n');
    body = body.replace(/^([ \t]*)create policy\s+("[^"]+"|\w+)\s+on\s+([\w.]+)/gim, '$1drop policy if exists $2 on $3;\n$1create policy $2 on $3');
    parts.push(`-- ================= sql/${file} =================`, body, '');
  }
  /* staging only, never in sql/: where the test copy records what it would have sent */
  parts.push('-- ================= staging/db/stg-sim.sql (staging only) =================', readFileSync(at('staging', 'db', 'stg-sim.sql'), 'utf8'), '');
  return parts.join('\n');
}

/* The club's template catalog (the admin page's TPL list) plus Meta's samples, shaped the way Meta's API
   lists templates. "Simulated Meta" answers template lists with it. */
export function simTemplateCatalog(adminHtml) {
  const start = adminHtml.indexOf('const TPL=[');
  const end = start === -1 ? -1 : adminHtml.indexOf('\n];', start);
  if (end === -1) return [];
  const list = vm.runInNewContext(adminHtml.slice(start + 'const TPL='.length, end + 2));
  return [...list, ...META_SAMPLE_TEMPLATES].map((t) => ({
    name: t.name, language: t.lang || 'en', status: 'APPROVED', category: t.cat || 'MARKETING', parameter_format: 'POSITIONAL',
    components: [...(t.has_image ? [{ type: 'HEADER', format: 'IMAGE' }] : []), { type: 'BODY', text: t.body }],
  }));
}

const q = (v) => (v ? `'${String(v).replace(/'/g, "''")}'` : 'null');

function testDataSql(S) {
  const fake = [
    ['Aarav Mehta (Test)', '910000000001', 'TST-101', 'Gold', 'active', true, 120, 0],
    ['Diya Sharma (Test)', '910000000002', 'TST-102', 'Silver', 'active', true, -20, 29500],
    ['Kabir Patel (Test)', '910000000003', 'TST-103', 'Platinum', 'active', true, 200, 0],
    ['Ananya Iyer (Test)', '910000000004', 'TST-104', 'Gold', 'active', false, -5, 12000],
    ['Rohan Desai (Test)', '910000000005', 'TST-105', 'Silver', 'expired', true, -90, 8000],
    ['Ishita Rao (Test)', '910000000006', 'TST-106', 'Gold', 'active', true, 30, 0],
    ['Vivaan Joshi (Test)', '910000000007', 'TST-107', 'Silver', 'active', true, -1, 4500],
    ['Meera Nair (Test)', '910000000008', 'TST-108', 'Platinum', 'active', true, 365, 0],
  ];
  const mine = S.phones.map((p, i) => [`Test Phone ${i + 1}`, p, `TST-00${i + 1}`, 'Gold', 'active', true, -10, 1500]);
  const rows = [...mine, ...fake].map(([name, phone, no, tier, status, optIn, days, dues], i) =>
    `  (${q(name)}, ${q(phone)}, ${i === 0 ? q(S.email) : 'null'}, ${q(no)}, ${q(tier)}, ${q(status)}, ${optIn}, ${days}, ${dues}, ${i % 3})`);
  const first = S.phones[0];
  /* the club's look as on live (staging/db/branding.json), with the logo served from staging storage */
  const branding = { ...JSON.parse(readFileSync(at('staging', 'db', 'branding.json'), 'utf8')),
                     logo_url: `${S.url}/storage/v1/object/public/brand/shakti/logo.png` };
  /* the bot's club texts as on live (staging/db/bot-config-shakti.json), with the banner from staging storage */
  const botConfig = JSON.parse(readFileSync(at('staging', 'db', 'bot-config-shakti.json'), 'utf8'));
  if (botConfig.brand) botConfig.brand.banner_url = `${S.url}/storage/v1/object/public/brand/shakti/logo.png`;
  return `-- STAGING TEST DATA. Generated by tools/build-staging.mjs; do not edit by hand.
-- Run AFTER 1-structure.sql, in the STAGING project only. Safe to run again.
-- The first member row uses YOUR email, so the same login works in the test portal too.

${LIVE_GUARD_SQL()}
-- Club branding as on live: name, logo, colours, menu. 1-structure.sql resets it to the original
-- colours only, so it is put back here every time. The public "brand" storage bucket holds the logo
-- and the posters uploaded from the test copy.
insert into storage.buckets (id, name, public) values ('brand', 'brand', true)
on conflict (id) do update set public = true;
update public.tenants
   set branding = coalesce(branding, '{}'::jsonb) || ${q(JSON.stringify(branding))}::jsonb
 where slug = 'shakti';

-- The bot's club texts as on live (menu, facilities, coaching, FAQ, hours...), from
-- staging/db/bot-config-shakti.json, with the banner image from staging storage. Put back every time
-- this file runs, so changes made in the test Settings page last until the next run.
update public.tenants
   set bot_config = ${q(JSON.stringify(botConfig))}::jsonb
 where slug = 'shakti';

-- An open event with one seat, to test registration and the waitlist from WhatsApp.
insert into public.events (tenant_id, title, kind, starts_at, capacity, fee, is_open)
select t.id, 'QA test event (1 seat)', 'workshop', now() + interval '10 days', 1, 0, true
  from public.tenants t
 where t.slug = 'shakti'
   and not exists (select 1 from public.events e where e.tenant_id = t.id and e.title = 'QA test event (1 seat)');

-- WhatsApp sender for the test club (from tools/config.local.json; empty = sending switched off)
update public.tenants
   set wa_phone_number_id = ${q(S.wa.phoneNumberId)}, wa_waba_id = ${q(S.wa.wabaId)}, wa_token = ${q(S.wa.token)}
 where slug = 'shakti';

-- Webhook secrets for status tracking (Meta app secret + the verify token you type into Meta)
insert into public.wa_webhook_config (tenant_id, app_secret, verify_token)
select id, ${q(S.wa.appSecret)}, ${q(S.wa.verifyToken)} from public.tenants where slug = 'shakti'
on conflict (tenant_id) do update set app_secret = excluded.app_secret, verify_token = excluded.verify_token, updated_at = now();

-- Your admin login: an owner invite (used when you click "Create your login" in the test admin panel),
-- plus a direct grant in case that login already exists.
insert into public.app_admin_invites (tenant_id, email, role)
select id, ${q(S.email)}, 'owner' from public.tenants where slug = 'shakti'
on conflict (tenant_id, email) do nothing;
insert into public.app_admins (user_id, tenant_id, role, email)
select u.id, t.id, 'owner', u.email from auth.users u, public.tenants t
 where lower(u.email) = ${q(S.email)} and t.slug = 'shakti'
on conflict (user_id, tenant_id) do nothing;

-- Members: your test phones first, then made-up members whose numbers can't receive WhatsApp.
insert into public.members (tenant_id, full_name, phone, email, membership_no, membership_tier, status, wa_opt_in,
                            maintenance_paid_till, dues_amount, guest_passes_remaining)
select t.id, v.full_name, v.phone, v.email, v.membership_no, v.tier, v.status, v.opt_in, current_date + v.days, v.dues, v.passes
from public.tenants t, (values
${rows.join(',\n')}
) as v(full_name, phone, email, membership_no, tier, status, opt_in, days, dues, passes)
where t.slug = 'shakti'
on conflict (tenant_id, phone) do nothing;

-- A sample draft template, so the "+ New template" feature has content to try.
insert into public.wa_custom_templates (tenant_id, name, opening, body, signature, use_signature, category, vars, has_image, meta_status, created_by)
select id, 'Court maintenance notice',
  'Announcement from Shakti Sports Club' || chr(10) || chr(10) || 'Hi {{1}},',
  'Court {{2}} will be closed on {{3}} for maintenance. All other courts stay open as usual.',
  'Regards,' || chr(10) || 'Shakti Sports Club Team',
  true, 'UTILITY',
  '[{"k":"1","label":"Member name","def":"first_name","example":"Rahul"},{"k":"2","label":"Court","def":"custom","example":"No. 3"},{"k":"3","label":"Date","def":"custom","example":"Sunday 5 Oct"}]'::jsonb,
  false, 'DRAFT', 'seed'
from public.tenants where slug = 'shakti'
on conflict (tenant_id, name) do update
  set opening = excluded.opening, body = excluded.body, signature = excluded.signature,
      use_signature = excluded.use_signature, category = excluded.category, vars = excluded.vars
  where public.wa_custom_templates.created_by = 'seed' and public.wa_custom_templates.meta_status = 'DRAFT';

-- Some activity so every screen has something to show (added once).
do $$
declare t uuid; m uuid;
begin
  select id into t from public.tenants where slug = 'shakti';
  if exists (select 1 from public.audit_log where tenant_id = t and action = 'seeded') then return; end if;
  select id into m from public.members where tenant_id = t and phone = ${q(first)};

  insert into public.bookings (tenant_id, member_id, kind, resource, booking_date, slot, party_size, status)
  values (t, m, 'court', 'Court 1', current_date + 1, '18:00-19:00', null, 'confirmed'),
         (t, m, 'cafe', 'Cafe table', current_date + 2, '20:00-21:00', 4, 'confirmed');
  insert into public.payments (tenant_id, member_id, amount, method, purpose, note, receipt_no, paid_at, created_by)
  values (t, m, 15000, 'upi', 'membership', 'test payment', 'TST-R-001', now() - interval '40 days', 'seed'),
         (t, m, 2500, 'cash', 'cafe', 'test payment', 'TST-R-002', now() - interval '3 days', 'seed');
  insert into public.attendance (tenant_id, member_id, kind, checked_in_at, created_by)
  values (t, m, 'visit', now() - interval '1 day', 'seed');
  insert into public.broadcasts (tenant_id, title, template_name, audience, status)
  values (t, 'Test campaign (draft)', 'dues_reminder', 'all', 'draft');
  insert into public.wa_messages (tenant_id, phone, member_id, direction, body, msg_type, intent, created_at)
  values (t, ${q(first)}, m, 'in', 'Hi, what time does the club open tomorrow?', 'text', null, now() - interval '2 hours'),
         (t, ${q(first)}, m, 'out', 'Hello! We open at 6 AM tomorrow.', 'text', 'reply', now() - interval '119 minutes');
  insert into public.audit_log (tenant_id, actor_email, action, entity, entity_id, detail)
  values (t, 'seed', 'seeded', 'staging', '', '{}'::jsonb);
end $$;

-- Two more Inbox conversations (added once): Kabir last wrote 2 days ago, so only a template can be sent;
-- Diya writes from a number that is not a test phone, so replies to her show FAILED (the staging guard).
do $$
declare t uuid;
begin
  select id into t from public.tenants where slug = 'shakti';
  if exists (select 1 from public.wa_messages where tenant_id = t and phone in ('910000000003', '910000000002')) then return; end if;
  insert into public.wa_messages (tenant_id, phone, direction, body, msg_type, created_at)
  values (t, '910000000003', 'in', 'Is there a family discount on the annual maintenance?', 'text', now() - interval '2 days'),
         (t, '910000000002', 'in', 'Hi, is the pool open this evening?', 'text', now() - interval '20 minutes');
end $$;
`;
}

/* The staging copy of one page, in memory only. Tests use it for pages the build leaves out of the test
   copy (a page that embeds a service_role key is never written to disk or uploaded). */
export function stagingPageText(name) {
  const cfg = loadConfig(['staging.supabaseUrl', 'staging.anonKey', 'staging.serviceKey', 'staging.adminEmail', 'staging.testPhones']);
  const S = stagingSettings(cfg);
  const web = TARGETS.web.map((w) => ({ ...w, html: readFileSync(at(w.source), 'utf8') }));
  const codeTexts = TARGETS.workflows.flatMap((w) => readWorkflow(w.source).nodes.map((n) => n.parameters && n.parameters.jsCode).filter(Boolean));
  const live = collectLiveSecrets([...web.map((w) => w.html), ...codeTexts]);
  const w = web.find((x) => x.name === name);
  if (!w) fail(`No page named "${name}" in tools/targets.json.`);
  const text = swapEnvironment(stagingPage(w.html, w.source, S), S, live);
  /* every live-key/live-address check applies; the page's own STAGING service key is accepted here only
     because this copy stays in memory (the build never writes or uploads it) */
  const problems = scan(`web/${name}/index.html`, text, live, { webPage: false });
  if (problems.length) fail(`The staging copy of ${name} could still touch the live system:\n${problems.map((p) => `    - ${p}`).join('\n')}`);
  return text;
}

export function buildStaging() {
  const cfg = loadConfig(['staging.supabaseUrl', 'staging.anonKey', 'staging.serviceKey', 'staging.adminEmail', 'staging.testPhones']);
  const S = stagingSettings(cfg);
  const web = TARGETS.web.map((w) => ({ ...w, html: readFileSync(at(w.source), 'utf8') }));
  const codeTexts = TARGETS.workflows.flatMap((w) => readWorkflow(w.source).nodes.map((n) => n.parameters && n.parameters.jsCode).filter(Boolean));
  const live = collectLiveSecrets([...web.map((w) => w.html), ...codeTexts]);

  const problems = [];
  const outputs = [];
  /* a page marked "staging": false in tools/targets.json (a page that embeds a service_role key) is left out */
  for (const w of web.filter((x) => x.staging !== false)) {
    const html = w.name === 'admin' ? withMetaSampleTemplates(w.html, w.source) : w.html;
    outputs.push({ file: `web/${w.name}/index.html`, text: swapEnvironment(stagingPage(html, w.source, S), S, live) });
  }
  const adminPage = web.find((w) => w.name === 'admin');
  const simTemplates = S.wa.simulate && adminPage ? simTemplateCatalog(adminPage.html) : [];
  if (S.geminiKey && live.geminis.includes(S.geminiKey)) fail('staging.geminiKey is the LIVE Gemini key. Use a separate key for staging (Google AI Studio), or leave it empty for the stand-in AI.');
  for (const w of TARGETS.workflows) outputs.push({ file: `n8n/${path.basename(w.source)}`, text: stagingWorkflow(w.source, S, live, problems, simTemplates) });
  /* the release's own settings changes (sql/data/*.sql) run at the end of the test data, so re-running
     2-test-data.sql (which puts the club's texts back as on live) always ends with the settings the release sets */
  const dataDir = at('sql', 'data');
  const dataFiles = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => f.endsWith('.sql')).sort() : [];
  const releaseData = dataFiles.map((f) => `\n-- ================= sql/data/${f} (the release's settings change, as on live after go-live)\n${readFileSync(path.join(dataDir, f), 'utf8')}`).join('\n');
  outputs.push({ file: 'db/1-structure.sql', text: structureSql() }, { file: 'db/2-test-data.sql', text: testDataSql(S) + releaseData });
  for (const o of outputs) problems.push(...scan(o.file, o.text, live, { allowWhatsAppToken: o.file.startsWith('db/'), webPage: o.file.startsWith('web/') }));

  rmSync(BUILD_DIR, { recursive: true, force: true });
  if (problems.length) {
    fail(`The test copy was NOT built, because it could still touch the live system:\n${problems.map((p) => `    - ${p}`).join('\n')}`);
  }
  for (const o of outputs) {
    const file = path.join(BUILD_DIR, o.file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, o.text);
  }
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).stdout.trim();
  writeFileSync(path.join(BUILD_DIR, 'build-info.json'), JSON.stringify({ builtAt: new Date().toISOString(), branch, commit, stagingProject: S.ref }, null, 2));
  return { S, cfg, outputs, branch, commit };
}

if (isMain(import.meta.url)) {
  main(() => {
    const { outputs, branch, commit, S } = buildStaging();
    say(`Test copy built from branch "${branch}" (${commit}) for staging project ${S.ref}:`);
    for (const o of outputs) say(`  .staging-build/${o.file}`);
    say('Safety check passed: nothing in it points at the live database, live webhooks or live keys.');
  });
}
