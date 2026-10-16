// QA regression checks for the staging / go-live tooling (tools/*.mjs). Offline: no network, no SSH, no n8n.
// Needs a fresh `npm run staging:build`. Prints no keys (only yes/no answers and masked values).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const CRM = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
const T = (f) => `file:///${CRM}tools/${f}`;
const lib = await import(T('lib.mjs'));
const build = await import(T('build-staging.mjs'));
const prod = await import(T('prod.mjs'));
const sim = await import(T('sim-wa.mjs'));
const { TARGETS, Stop, workflowFingerprint, runningVersion, hasUnpublishedDraft, stagingMarkers, isDeployStamp, readWorkflow } = lib;

let n = 0;
const ok = (label) => console.log(`ok ${++n}. ${label}`);
const assert = (c, m) => { if (!c) { console.log(`FAIL: ${m}`); process.exit(1); } };
const stops = async (fn) => { try { await fn(); return null; } catch (e) { if (e instanceof Stop) return e.message; throw e; } };
const B = `${CRM}.staging-build/`;
assert(existsSync(`${B}build-info.json`), 'run npm run staging:build first');

/* ---------- 1. the staging guard denies by default ---------- */
{
  const S = { phones: ['919000000001'], host: 'stagingstagingstagin.supabase.co', serviceKey: 'svc', confirmToken: 'c', wa: { wabaId: 'TESTWABA', simulate: false } };
  const reached = [];
  const helpers = { httpRequest: async (o) => { reached.push(`${o.method || 'GET'} ${o.url}`); return o.returnFullResponse ? { statusCode: 200, body: {} } : {}; } };
  const run = async (opts, sim = false) => {
    const src = `${build.guardSource({ ...S, wa: { ...S.wa, simulate: sim } }, { wf: 'x', node: 'y' }, [])}\nreturn await __stgHelpers.httpRequest(OPTS);`;
    const fn = new Function('OPTS', `return (async () => { ${src} }).call(this);`);
    reached.length = 0;
    try { await fn.call({ helpers }, opts); return { passed: reached.some((r) => r.endsWith(opts.url)) }; } catch (e) { return { stopped: /STAGING GUARD/.test(e.message), msg: e.message }; }
  };
  const base = TARGETS.publicBase;
  const stoppedCases = [
    ['live EspoCRM', { method: 'GET', url: 'https://orena.solutions/espo/api/v1/Lead?maxSize=1' }],
    ['EspoCRM (other host)', { method: 'POST', url: 'https://espo.orenanow.com/api/v1/Lead', body: '{}' }],
    ['an unknown outside host', { method: 'POST', url: 'https://example.com/collect', body: '{"a":1}' }],
    ['the n8n API', { method: 'GET', url: `${base}/api/v1/workflows` }],
    ['a live n8n webhook', { method: 'POST', url: `${base}/webhook/staff-invite` }],
    ['the live database', { method: 'GET', url: `https://${TARGETS.supabaseRef}.supabase.co/rest/v1/members` }],
    ['Gemini without any key', { method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent', body: {} }],
    ['an image download from EspoCRM', { method: 'GET', url: 'https://orena.solutions/espo/x.png', encoding: 'arraybuffer' }],
  ];
  /* only the staging record of the attempt (stg_outbox) may be written */
  for (const [label, o] of stoppedCases) { const r = await run(o); assert(r.stopped && reached.every((x) => /stagingstagingstagin\.supabase\.co\/rest\/v1\/stg_outbox$/.test(x)), `guard should stop ${label}: ${JSON.stringify(r)} ${reached.join(',')}`); }
  const passCases = [
    ['the staging database', { method: 'GET', url: 'https://stagingstagingstagin.supabase.co/rest/v1/members' }],
    ['a stg- webhook', { method: 'POST', url: `${base}/webhook/stg-broadcast-send`, body: '{}' }],
    ['Meta (message to a test phone)', { method: 'POST', url: 'https://graph.facebook.com/v21.0/123/messages', body: { to: '919000000001' } }],
    ['Gemini with a staging key', { method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=AIzaSTAGINGKEY', body: {} }],
    ['a public image download', { method: 'GET', url: 'https://images.example.org/poster.jpg', encoding: 'arraybuffer', returnFullResponse: true }],
  ];
  for (const [label, o] of passCases) { const r = await run(o); assert(r.passed, `guard should let through ${label}: ${JSON.stringify(r)}`); }
  const ai = await run({ method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=STAGING-NO-GEMINI-KEY', body: { contents: [{ parts: [{ text: 'hi' }] }] } });
  assert(!ai.stopped && reached.every((r) => /stg_outbox/.test(r)), 'the AI stand-in still answers without reaching Google');
  ok(`staging guard: ${stoppedCases.length} kinds of request stopped (EspoCRM, unknown hosts, n8n API, live webhooks/database), ${passCases.length} allowed ones pass, AI stand-in unchanged`);
}

/* ---------- 2. build output: no EspoCRM, no service_role key in pages, orena-admin left out ---------- */
{
  /* the page that was live until 2 Oct 2026 (commit 394f6e7) carried the EspoCRM key (the release removed it):
     the scanner must recognise it, and neither the new page nor its staging build may contain it */
  /* WhatsApp Blaster copy: the Shakti history is not here, so the old page is stood in for by one line carrying a made-up key */
  const livePage = "fetch(u, { headers: { 'X-Api-Key': 'OLDPAGEESPOKEY0123456789' } })";
  const adminSrc = readFileSync(`${CRM}admin-panel/index.html`, 'utf8');
  const adminOut = readFileSync(`${B}web/admin/index.html`, 'utf8');
  const live = build.collectLiveSecrets([livePage]);
  assert(live.espoKeys.length >= 1, 'the EspoCRM key in the live admin page is recognised');
  assert(live.espoKeys.every((k) => !adminSrc.includes(k)), 'the EspoCRM key is no longer in the admin page');
  assert(live.espoKeys.every((k) => !adminOut.includes(k)), 'the EspoCRM key is not in the staging admin page');
  assert(!/orena\.solutions\/espo/i.test(adminOut), 'no live EspoCRM API address in the staging admin page');
  assert(!existsSync(`${B}web/orena-admin`), 'orena-admin is not built into the test copy');
  for (const f of ['admin']) {
    const t = readFileSync(`${B}web/${f}/index.html`, 'utf8');
    for (const m of t.matchAll(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) assert((lib.jwtClaims(m[0]) || {}).role !== 'service_role', `web/${f} has a service_role key`);
  }
  const fakeSr = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref: 'abcdefghijklmnopqrst', role: 'service_role' })).toString('base64url')}.sig`;
  const empty = { confirms: [], geminis: [], espoKeys: [], invites: [] };
  assert(build.scan('web/x/index.html', `const K="${fakeSr}";`, empty, { webPage: true }).some((p) => /service_role/.test(p)), 'scan flags a service_role key in a page');
  assert(!build.scan('n8n/x.json', `const K="${fakeSr}";`, empty).length, 'a staging service key inside a workflow is still fine');
  assert(build.scan('web/x/index.html', 'fetch("https://orena.solutions/espo/api/v1/Lead")', empty, { webPage: true }).some((p) => /EspoCRM/.test(p)), 'scan flags the live EspoCRM');
  /* a staff-invite secret, if a page or workflow carries one, is swapped and never left in the output */
  const inviteSrc = 'const INVITE_SECRET="liveInviteSecret123456";\nfetch(u,{headers:{"x-invite-secret":"liveInviteSecret123456"}});';
  const inv = build.collectLiveSecrets([inviteSrc]);
  assert(inv.invites.length === 1, 'the staff-invite secret is recognised');
  const S = { anonKey: 'a', serviceKey: 's', url: 'https://abcdefghijklmnopqrst.supabase.co', confirmToken: 'c', inviteSecret: 'stagingInvite', geminiKey: '' };
  const swapped = build.swapEnvironment(inviteSrc, S, inv);
  assert(!swapped.includes('liveInviteSecret123456') && swapped.includes('stagingInvite'), 'the invite secret is swapped');
  assert(build.scan('web/x/index.html', inviteSrc, inv, { webPage: true }).filter((p) => /staff-invite secret/.test(p)).length === 2, 'scan flags a leftover invite secret');
  ok('build: live EspoCRM key and address swapped and scanned, staff-invite secret swapped and scanned, no service_role key in any test page, orena-admin left out');
}

/* ---------- 3. drift fingerprint sees settings and node options ---------- */
{
  const wf = readWorkflow('file_upload_relay_wf.json');
  const fp = (x) => workflowFingerprint(x);
  const clone = () => structuredClone(wf);
  const a = clone(); a.settings = { ...a.settings, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' };
  const b = clone(); b.settings = { ...b.settings, errorWorkflow: 'RqgN7bPZeO0Fh7ZK' };
  const c = clone(); c.settings = { ...c.settings, executionTimeout: 120 };
  const d = clone(); Object.assign(d.nodes[0], { retryOnFail: true, maxTries: 3 });
  const e = clone(); delete e.nodes.find((x) => x.name === 'Send bytes').onError;
  for (const [x, why] of [[a, 'run history switched on'], [b, 'an error workflow'], [c, 'a timeout'], [d, 'retry on fail'], [e, 'on-error option removed']]) assert(fp(x) !== fp(wf), `fingerprint misses: ${why}`);
  const same = clone(); same.settings = { ...same.settings, callerPolicy: 'workflowsFromSameOwner', executionTimeout: -1, binaryMode: 'separate', availableInMCP: false };
  same.nodes[0].onError = 'stopWorkflow'; same.nodes[0].continueOnFail = false;
  assert(fp(same) === fp(wf), 'n8n defaults must not count as a change');
  const extra = clone(); extra.settings = { ...extra.settings, callerPolicy: 'any' };
  assert(workflowFingerprint(extra, { onlySettings: Object.keys(wf.settings) }) === workflowFingerprint(wf, { onlySettings: Object.keys(wf.settings) }), 'post-deploy check ignores settings the file does not set');
  ok('drift fingerprint: error workflow, timeout, run history and node options (retry, on error) count; n8n defaults and extra settings after a deploy do not');
}

/* ---------- 4. the version that runs, not an unpublished draft ---------- */
{
  const wf = readWorkflow('broadcast_wf_vps.json');
  const published = structuredClone(wf.nodes);
  const live = { ...structuredClone(wf), id: 'X', active: true, versionId: 'draft', activeVersionId: 'pub', activeVersion: { versionId: 'pub', nodes: published, connections: structuredClone(wf.connections) } };
  live.nodes.find((x) => typeof (x.parameters || {}).jsCode === 'string').parameters.jsCode += '\n// unpublished draft';
  assert(hasUnpublishedDraft(live), 'draft detected');
  assert(workflowFingerprint(live) !== workflowFingerprint(wf), 'the draft differs');
  assert(workflowFingerprint(runningVersion(live)) === workflowFingerprint(wf), 'the running version is what gets compared');
  assert(runningVersion(live).nodes === published, 'restore and pull use the published nodes');
  const inactive = { ...structuredClone(wf), active: false, activeVersion: null };
  assert(runningVersion(inactive).nodes === inactive.nodes && !hasUnpublishedDraft(inactive), 'an inactive workflow is taken as it is');
  const src = readFileSync(`${CRM}tools/prod.mjs`, 'utf8');
  assert(/apiBody\(runningVersion\(b\)\)/.test(src) && /workflowFingerprint\(runningVersion\(current\)\)/.test(src) && /JSON\.stringify\(\[running\]/.test(src), 'prod.mjs restore/drift/pull use runningVersion');
  ok('n8n drafts: drift check, prod:pull and restore/rollback use the published version that runs; a draft is only reported');
}

/* ---------- 5. a test copy can never be deployed; the live sources are not mistaken for one ---------- */
{
  const cfg = JSON.parse(readFileSync(process.env.OPS_CONFIG || `${CRM}tools/config.local.json`, 'utf8'));
  const testFiles = [{ source: 'admin-panel/index.html', text: readFileSync(`${B}web/admin/index.html`, 'utf8') },
    { source: 'broadcast_wf_vps.json', text: readFileSync(`${B}n8n/broadcast_wf_vps.json`, 'utf8') },
    { source: 'wa_bot_wf.json', text: readFileSync(`${B}n8n/wa_bot_wf.json`, 'utf8') }];
  const p = prod.stagingContentProblems(testFiles, cfg);
  assert(p.length === 3 && /TEST COPY label/.test(p[0]) && /staging database/.test(p[0]) && /\[STAGING\]/.test(p[1]) && /stg-/.test(p[2]), `test copies flagged: ${p.map((x) => x.slice(0, 80)).join(' / ')}`);
  const liveFiles = [...TARGETS.web, ...TARGETS.workflows].map((w) => ({ source: w.source, text: readFileSync(`${CRM}${w.source}`, 'utf8') }));
  const fp = prod.stagingContentProblems(liveFiles, cfg);
  assert(!fp.length, `live sources wrongly flagged: ${fp.join(' / ')}`);
  assert(stagingMarkers('<title>[TEST] Shakti</title>').length === 1, 'a [TEST] title alone is caught');
  ok(`prod:deploy refuses test copies (page, workflow, bot); the ${liveFiles.length} live source files are not flagged`);
}

/* ---------- 6. the live database check never answers "ready" without asking ---------- */
{
  const k = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x';
  for (const form of [`SUPABASE_ANON_KEY = "${k}"`, `SUPABASE_ANON_KEY="${k}"`, `SUPABASE_ANON_KEY = '${k}'`, `SUPABASE_ANON_KEY=\`${k}\``]) assert(prod.liveAnonKey(`const ${form};`) === k, `key form not read: ${form.slice(0, 22)}`);
  assert(prod.liveAnonKey('const SUPABASE_ANON_KEY = "sb_publishable_abc123";') === 'sb_publishable_abc123', 'a publishable key is read');
  const c = { sql: ['sql/wa_inbox.sql'] };
  const noKey = await stops(() => prod.liveDbMissing(c, 'HEAD', { pageHtml: 'no key here', fetchFn: async () => { throw new Error('no network'); } }));
  assert(noKey && /could not be checked/.test(noKey), 'no key: stops instead of "ready"');
  const page = `const SUPABASE_ANON_KEY = "${k}";`;
  const calls = [];
  const missing = await prod.liveDbMissing(c, 'HEAD', { pageHtml: page, fetchFn: async (u) => { calls.push(u); return { status: /select=\*/.test(u) ? 404 : 400 }; } });
  assert(calls.length > 0 && calls.every((u) => u.startsWith(`https://${TARGETS.supabaseRef}.supabase.co/rest/v1/`)) && missing.length > 0, 'probes are sent and missing tables reported');
  const e500 = await stops(() => prod.liveDbMissing(c, 'HEAD', { pageHtml: page, fetchFn: async () => ({ status: 500 }) }));
  const eNet = await stops(() => prod.liveDbMissing(c, 'HEAD', { pageHtml: page, fetchFn: async () => { throw new Error('offline'); } }));
  assert(e500 && eNet, 'an unreadable answer or no connection stops the check');
  const ready = await prod.liveDbMissing(c, 'HEAD', { pageHtml: page, fetchFn: async () => ({ status: 200 }) });
  assert(Array.isArray(ready) && ready.length === 0, 'all present: ready');
  ok('live DB readiness: any key quoting/format is read; no key, HTTP 500 or no connection stop the deploy instead of "ready"');
}

/* ---------- 7. targets.json keeps its layout; the WhatsApp Status workflow is created switched off ---------- */
{
  /* the file as it was before the first deploy (445563e): the two new workflows had no id yet */
  /* WhatsApp Blaster copy: no Shakti history; every workflow id is null here, which is the same starting point */
  const text = readFileSync(`${CRM}tools/targets.json`, 'utf8');
  const withId = prod.setWorkflowIdInText(text, 'file_upload_relay_wf.json', 'NEWID123');
  const diff = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i]).length;
  assert(diff(text, withId) === 1 && text.split('\n').length === withId.split('\n').length, 'only the one entry line changes');
  const entry = JSON.parse(withId).workflows.find((w) => w.source === 'file_upload_relay_wf.json');
  assert(entry.id === 'NEWID123' && !entry.note, 'id set, stale note removed');
  assert(JSON.parse(withId).workflows.find((w) => w.source === 'wa_bot_wf.json').note, 'other notes kept');
  const back = prod.setWorkflowIdInText(withId, 'file_upload_relay_wf.json', null);
  assert(JSON.parse(back).workflows.find((w) => w.source === 'file_upload_relay_wf.json').id === null, 'id cleared again');
  const t = JSON.parse(readFileSync(`${CRM}tools/targets.json`, 'utf8'));
  assert(t.workflows.find((w) => w.source === 'wa_status_wf.json').activate === false, 'wa_status is created switched off');
  const src = readFileSync(`${CRM}tools/prod.mjs`, 'utf8');
  assert(/w\.activate !== false/.test(src) && /targetsBefore !== null\) writeFileSync/.test(src) && /unfinishedDeploys\(\)/.test(src) && /Type OVERWRITE/.test(src), 'prod.mjs: activate flag, targets restore on undo, unfinished-deploy check, rollback overwrite confirmation');
  assert(/'merge-base', '--is-ancestor', r\.liveCommit, 'HEAD'/.test(src) && /before-rollback-/.test(src), 'prod.mjs: deploy needs the live record inside main; rollback saves the current live copies first');
  assert(isDeployStamp('2026-09-30T10-17-02') && !isDeployStamp('2026-09-30T10-17-02-rolled-back') && !isDeployStamp('before-rollback-2026-09-30T10-17-02'), 'only deploy stamps count as deploys');
  const srv = readFileSync(`${CRM}tools/staging-server.mjs`, 'utf8');
  assert(/filter\(\(x\) => x\.staging !== false\)/.test(srv), 'staging:deploy --pages uploads only staging pages');
  ok('targets.json: a new id changes one line (notes and layout kept); WhatsApp Status created switched off; orena-admin never uploaded to /staging/');
}

/* ---------- 8. sim-wa options ---------- */
{
  assert(sim.parseSimArgs(['--text', '']).text === '', 'empty text kept as text');
  assert(sim.parseSimArgs(['--text', '--help me']).text === '--help me', 'text starting with -- kept');
  assert(sim.parseSimArgs(['--image', '--caption', 'receipt']).image === true, 'flags still work');
  assert(await stops(() => sim.parseSimArgs(['--wait', 'abc'])), '--wait abc refused');
  assert(await stops(() => sim.parseSimArgs(['--text'])), 'missing value refused');
  assert(await stops(() => sim.parseSimArgs(['--txt', 'hi'])), 'unknown option refused');
  const ev = sim.metaEvent({ wa: { phoneNumberId: '1', wabaId: '2' } }, { from: '919000000001', text: '' });
  assert(ev.entry[0].changes[0].value.messages[0].text.body === '', 'the event carries the text as a string');
  ok('sim-wa: --text "" and --text "--x" are sent as text, --wait abc / missing values / unknown options are refused');
}

/* ---------- 10. a second preview stops cleanly before rebuilding ---------- */
{
  const busy = http.createServer(() => {});
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const port = busy.address().port;
  const before = statSync(`${B}build-info.json`).mtimeMs;
  const r = spawnSync(process.execPath, [`${CRM}tools/preview.mjs`], { cwd: CRM, env: { ...process.env, PORT: String(port) }, encoding: 'utf8', timeout: 30000 });
  busy.close();
  const out = `${r.stdout}${r.stderr}`;
  assert(r.status === 1 && new RegExp(`Port ${port} is in use`).test(out) && !/Unhandled 'error'|EADDRINUSE/.test(out), `preview output: ${out.slice(0, 300)}`);
  assert(statSync(`${B}build-info.json`).mtimeMs === before, 'the test copy was not rebuilt');
  ok('staging:preview on a busy port: a plain message, exit 1, no rebuild, no stack trace');
}

console.log(`\nAll ${n} tools/docs checks passed.`);
