// "setup": one-time, adds the test-site container on the server.
// "deploy": builds the test copy, uploads it to /staging/..., and updates the [STAGING] n8n workflows.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildStaging } from './build-staging.mjs';
import { TARGETS, BUILD_DIR, at, fail, say, main, ask, ssh, uploadFile, fetchPublic, sha256, loadConfig, useSshKey, n8nApi, listWorkflows } from './lib.mjs';

const ST = TARGETS.staging;
const containerRunning = () => ssh(`docker ps --format '{{.Names}}' | grep -x ${ST.container} || true`).stdout.trim() === ST.container;

async function setup() {
  useSshKey(loadConfig());
  say(`This adds ONE new container (${ST.container}) on the server, serving the test copy at ${TARGETS.publicBase}${ST.urlPath}/admin/.`);
  say('Nothing already running (live admin panel, orena-admin, n8n) is changed or restarted.');
  const state = ssh(`docker network inspect n8n_default >/dev/null 2>&1 && echo NETWORK_OK; docker ps -a --format '{{.Names}}' | grep -x ${ST.container} || true`).stdout;
  if (!state.includes('NETWORK_OK')) fail('The n8n_default Docker network was not found on the server, so nothing was set up.');
  if (state.split('\n').map((l) => l.trim()).includes(ST.container)) {
    say('The test-site container already exists. Nothing to do; run: npm run staging:deploy');
    return;
  }
  if ((await ask('Type YES to add the test-site container:')) !== 'YES') fail('Cancelled. Nothing was changed.');
  uploadFile(readFileSync(at('staging', 'server', 'docker-compose.yml')), `${ST.serverDir}/docker-compose.yml`);
  uploadFile(readFileSync(at('staging', 'server', 'nginx.conf')), `${ST.serverDir}/nginx.conf`);
  ssh(`mkdir -p ${ST.serverDir}/web && cd ${ST.serverDir} && if docker compose version >/dev/null 2>&1; then docker compose -p ${ST.container} up -d; else docker-compose -p ${ST.container} up -d; fi`);
  if (!containerRunning()) fail('The container was created but is not running. Check it with: docker logs shakti-staging');
  say('Test-site container is running. Next: npm run staging:deploy');
}

/* 2-test-data.sql points the test club's logo at brand/shakti/logo.png in STAGING storage;
   this puts the file there (and the public "brand" bucket) when a staging project doesn't have it yet */
async function ensureStagingLogo(S) {
  const publicUrl = `${S.url}/storage/v1/object/public/brand/shakti/logo.png`;
  if ((await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }))).ok) return;
  const auth = { apikey: S.serviceKey, Authorization: `Bearer ${S.serviceKey}` };
  await fetch(`${S.url}/storage/v1/bucket`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'brand', name: 'brand', public: true }) }).catch(() => null); /* "already exists" is fine */
  const up = await fetch(`${S.url}/storage/v1/object/brand/shakti/logo.png`, { method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: readFileSync(at('staging', 'assets', 'shakti-logo.png')) }).catch((e) => ({ ok: false, status: e.message }));
  say(up.ok ? 'test logo      uploaded to the staging storage' : `test logo      could not be uploaded to the staging storage (${up.status}); the sidebar shows a broken image until it is`);
}

async function deploy() {
  const { cfg, branch, commit, S } = buildStaging();
  await ensureStagingLogo(S);
  /* The shared test link lives on the production server, so it is opt-in: without --pages this
     command never opens an SSH connection, and only talks to the n8n API. */
  const wantPages = process.argv.includes('--pages');
  let pagesOnServer = false;
  if (wantPages) {
    useSshKey(cfg);
    pagesOnServer = containerRunning();
    if (!pagesOnServer) fail('The test site is not set up on the server. Run once: npm run staging:setup-server');
  } else {
    say('Pages stay on this PC (npm run staging:preview). Add --pages to also upload them to the shared test link.');
  }

  /* pages left out of the test copy (tools/targets.json "staging": false, e.g. orena-admin, which embeds a
     service_role key) are never uploaded, and a copy uploaded by an older version of this tool is removed */
  for (const w of pagesOnServer ? TARGETS.web.filter((x) => x.staging === false && /^[a-z0-9-]+$/.test(x.name)) : []) {
    ssh(`rm -f '${ST.serverDir}/web/${w.name}/index.html'`);
    say(`test ${w.name.padEnd(12)} not in the test copy (removed from the shared test link if it was there)`);
  }
  for (const w of pagesOnServer ? TARGETS.web.filter((x) => x.staging !== false) : []) {
    const content = readFileSync(path.join(BUILD_DIR, 'web', w.name, 'index.html'));
    uploadFile(content, `${ST.serverDir}/web/${w.name}/index.html`);
    const page = await fetchPublic(`${ST.urlPath}/${w.name}/`);
    if (page.status !== 200 || sha256(page.body) !== sha256(content)) {
      fail(`Uploaded the test ${w.name} page, but ${TARGETS.publicBase}${ST.urlPath}/${w.name}/ is not serving it (HTTP ${page.status}).`);
    }
    say(`test ${w.name.padEnd(12)} ${TARGETS.publicBase}${ST.urlPath}/${w.name}/`);
  }

  const api = n8nApi(cfg);
  if (!api) {
    say('');
    say('"n8nApiKey" is empty in tools/config.local.json, so the [STAGING] n8n workflows were not updated.');
    say('The pages work, but sending test broadcasts needs them. See STAGING.md, step 5.');
    return;
  }
  const liveIds = new Set(TARGETS.workflows.map((w) => w.id));
  const existing = await listWorkflows(api);
  for (const w of TARGETS.workflows) {
    const body = JSON.parse(readFileSync(path.join(BUILD_DIR, 'n8n', path.basename(w.source)), 'utf8'));
    if (!body.name.startsWith('[STAGING] ')) fail(`Refusing to upload ${w.source}: it is not a staging build.`);
    const matches = existing.filter((x) => x.name === body.name);
    if (matches.length > 1) fail(`n8n has ${matches.length} workflows named "${body.name}". Delete the extra ones in n8n, then run this again.`);
    if (matches.length && liveIds.has(matches[0].id)) fail(`"${body.name}" has the id of a LIVE workflow. Nothing was changed.`);
    const id = matches.length ? (await api('PUT', `/workflows/${matches[0].id}`, body), matches[0].id) : (await api('POST', '/workflows', body)).id;
    try {
      await api('POST', `/workflows/${id}/activate`);
      say(`test workflow  ${body.name} (switched on)`);
    } catch (err) {
      say(`test workflow  ${body.name} uploaded, but could not be switched on: ${err.message}`);
      say('               Open it in n8n and switch it on by hand.');
    }
  }
  say('');
  say(`Test copy of "${branch}" (${commit}) is up. Share the links above for approval.`);
}

const command = process.argv[2];
main(async () => {
  if (TARGETS.deployEnabled !== true) fail('Deploys are switched off in this WhatsApp Blaster copy (tools/targets.json deployEnabled is false). It has no server of its own yet; see README.md. Build, preview and the bench work as usual.');
  if (command === 'setup') return setup();
  if (command === 'deploy') return deploy();
  fail('Use "npm run staging:setup-server" or "npm run staging:deploy".');
});
