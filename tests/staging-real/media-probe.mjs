// STAGING probe: one real picture through Meta's test number into the staging bot; prints the bot's own "media" note from the n8n run.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simContext, metaEvent, postEvent } from '../../tools/sim-wa.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const C = JSON.parse(readFileSync(HERE + '../../tools/config.local.json', 'utf8')).staging;
const ctx = simContext(); const S = ctx.S;
if (/ttpecupfolgbbdagkotc/.test(S.url)) throw new Error('refusing: live project');
const PHONE = S.phones[0], PNID = S.wa.phoneNumberId, TOKEN = C.whatsapp.token;
if (PNID !== '1395815933604771') throw new Error('not the Meta TEST number: refusing');
const H = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}` };
const PNG = readFileSync(HERE + '../../staging/test-sheets/poster-test.png');
const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', 'image/png'); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'probe.png');
const up = await (await fetch(`https://graph.facebook.com/v20.0/${PNID}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd })).json();
if (!up.id) throw new Error('upload failed ' + JSON.stringify(up).slice(0, 120));
const stamp = Date.now().toString(36), wamid = 'wamid.STGPROBE.' + stamp;
const body = metaEvent(S, { from: PHONE, image: true, id: wamid });
body.entry[0].changes[0].value.messages[0].image = { id: String(up.id), mime_type: 'image/png', caption: 'probe ' + stamp };
const t0 = Date.now();
await postEvent(ctx, body);
const { loadConfig, n8nApi } = await import(pathToFileURL(HERE + '../../tools/lib.mjs').href);
const api = n8nApi(loadConfig([]));
let note = null, row = null;
for (let i = 0; i < 30 && !note; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const list = await api('GET', '/executions?workflowId=eqgnaQfEaOvJ2fXX&limit=5');
  for (const e of list.data || []) {
    if (new Date(e.startedAt).getTime() < t0 - 5000) continue;
    const full = await api('GET', `/executions/${e.id}?includeData=true`);
    const run = (((full.data || {}).resultData || {}).runData || {}); const n = run['Bot Engine'] && run['Bot Engine'][0];
    const out = n && n.data && n.data.main[0][0].json; const res = ((out || {}).results || []).find((x) => x.kind === 'media');
    if (res) { note = { exec: e.id, status: e.status, ms: n.executionTime, media: res.media, stored: res.stored, err: (full.data.resultData || {}).error && full.data.resultData.error.message }; }
  }
}
const [r] = await (await fetch(`${S.url}/rest/v1/wa_messages?wamid=eq.${encodeURIComponent(wamid)}&select=body,media_url`, { headers: H })).json();
console.log('bot run:', JSON.stringify(note));
console.log('row:', JSON.stringify(r));
if (r && r.media_url) { const o = await fetch(r.media_url, { headers: H }); const b = Buffer.from(await o.arrayBuffer()); console.log('stored object: HTTP', o.status, b.length, 'bytes (sent', PNG.length + ')', o.headers.get('content-type')); }
