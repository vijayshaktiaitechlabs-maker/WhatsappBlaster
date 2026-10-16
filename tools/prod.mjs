// Live deploys. Ships only committed code on "main" that differs from the "live" git tag, after checking
// nobody changed live by hand since the last deploy, with a backup first and a verified result.
//   check     read-only: what would go live, and whether live still matches the last deploy
//   deploy    put main live (asks you to type DEPLOY)
//   rollback  put back what was live before the last deploy (asks you to type ROLLBACK)
//   pull      record changes someone made directly on live into git, on a branch you can merge
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  TARGETS, at, fail, say, main, ask, run, git, gitFile, ssh, uploadFile, fetchPublic, sha256, loadConfig, useSshKey,
  n8nApi, parseWorkflow, readWorkflow, apiBody, workflowFingerprint, isMain, Stop, runningVersion, hasUnpublishedDraft,
  stagingMarkers, isDeployStamp, listWorkflows,
} from './lib.mjs';

const LIVE_TAG = 'live';
const LIVE_WEB = TARGETS.web.filter((w) => w.live);
const LIVE_PATHS = [...TARGETS.web.map((w) => w.source), ...TARGETS.workflows.map((w) => w.source), 'sql/'];
const pendingCommits = (liveCommit) => git('log', '--oneline', `${liveCommit}..HEAD`, '--', ...LIVE_PATHS);
const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

function repo() {
  const liveCommit = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${LIVE_TAG}^{commit}`], { allowFail: true }).stdout.trim();
  if (!liveCommit) fail(`The "${LIVE_TAG}" git tag is missing, so there is no record of what is live.`);
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no'),
    liveCommit,
  };
}

function changedSince(commit) {
  const files = new Set(git('diff', '--name-only', commit, 'HEAD').split('\n').filter(Boolean));
  return {
    web: LIVE_WEB.filter((w) => files.has(w.source)),
    workflows: TARGETS.workflows.filter((w) => files.has(w.source)),
    notDeployable: TARGETS.web.filter((w) => !w.live && files.has(w.source)),
    sql: [...files].filter((f) => f.startsWith('sql/')),
  };
}

function notes(c) {
  for (const w of c.notDeployable) say(`not deployed: ${w.source} (${w.note})`);
  if (c.sql.length) {
    say(`database scripts changed: ${c.sql.join(', ')}`);
    say('  These are NOT run automatically. Run them on the live database yourself BEFORE deploying, after they worked on staging.');
  }
}

/* the live page's public database key, in whatever quoting or key format the page writes it */
export function liveAnonKey(html) {
  return (String(html).match(/SUPABASE_ANON_KEY\s*=\s*['"`]([^'"`\s]+)['"`]/) || [])[1] || null;
}

/* Read-only: are the tables that this release's SQL files create already on the live database?
   Uses the live page's own public (anon) key, the same access every visitor of the live page has.
   It never answers "ready" without having asked: no key, or an answer it can't read, stops it. */
export async function liveDbMissing(c, liveCommit, { pageHtml = null, fetchFn = fetch } = {}) {
  if (!c.sql.length) return [];
  const anon = liveAnonKey(pageHtml ?? gitFile(liveCommit, 'admin-panel/index.html').toString('utf8'));
  if (!anon) fail('Could not find the live database key (SUPABASE_ANON_KEY) in admin-panel/index.html, so the live database could not be checked.');
  const missing = [];
  const probe = async (path) => {
    let res;
    try {
      res = await fetchFn(`https://${TARGETS.supabaseRef}.supabase.co/rest/v1/${path}`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
    } catch (err) {
      fail(`Could not reach the live database to check it (${err.message}).`);
    }
    /* 404: no such table; 400: no such column; 200/401/403: it exists (a permission answer means it was found) */
    if (![200, 206, 400, 401, 403, 404].includes(res.status)) fail(`The live database answered HTTP ${res.status} to ${path.split('?')[0]}, so it could not be checked.`);
    return res;
  };
  for (const file of c.sql) {
    if (!existsSync(at(file))) continue;
    const sql = readFileSync(at(file), 'utf8');
    const tables = [...sql.matchAll(/create table if not exists (?:public\.)?([a-z_]+)/gi)].map((m) => m[1]);
    for (const t of tables) {
      const res = await probe(`${t}?select=*&limit=0`);
      if (res.status === 404) missing.push({ file, table: t });
    }
    /* columns added to existing tables: "alter table X add column if not exists Y, …" (a missing one answers 400) */
    for (const stmt of sql.split(';')) {
      const m = stmt.match(/alter table (?:if exists )?(?:public\.)?([a-z_]+)/i);
      if (!m) continue;
      for (const col of [...stmt.matchAll(/add column if not exists ([a-z_]+)/gi)].map((x) => x[1])) {
        const res = await probe(`${m[1]}?select=${col}&limit=0`);
        if (res.status === 400 || res.status === 404) missing.push({ file, table: `${m[1]}.${col}` });
      }
    }
  }
  return missing;
}

/* files about to go live that are TEST copies (from .staging-build) instead of the live source */
export function stagingContentProblems(files, cfg = {}) {
  const ref = (String((cfg.staging && cfg.staging.supabaseUrl) || '').match(/https:\/\/([a-z0-9]{20})\.supabase\.co/) || [])[1] || '';
  const problems = [];
  for (const { source, text } of files) {
    const found = stagingMarkers(text, { stagingRef: ref });
    if (found.length) problems.push(`${source}: ${found.join(', ')}`);
  }
  return problems;
}

/* a deploy whose backup exists but which neither finished (release-<stamp> tag) nor was undone */
function unfinishedDeploys() {
  const dir = at('deploy-backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isDeployStamp)
    .filter((s) => !run('git', ['rev-parse', '-q', '--verify', `refs/tags/release-${s}`], { allowFail: true }).stdout.trim());
}

async function webDrift(w, liveCommit) {
  const page = await fetchPublic(w.url);
  if (page.status !== 200) return `live ${w.url} answered HTTP ${page.status}`;
  return sha256(page.body) === sha256(gitFile(liveCommit, w.source)) ? null : `the live ${w.name} page differs from the last deployed version`;
}

async function liveWorkflow(api, id) {
  if (!id) return null; // a workflow that has never been deployed (targets.json id: null)
  try {
    return await api('GET', `/workflows/${id}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/* A workflow file as recorded at a commit, or null when that commit doesn't have it yet: a workflow that
   already runs on live but was never captured into the repo (e.g. the WhatsApp bot, added 2026-09-30). */
function recordedWorkflow(commit, source) {
  const r = run('git', ['show', `${commit}:${source}`], { binary: true, allowFail: true });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  return parseWorkflow(r.stdout.toString('utf8'));
}

async function workflowDrift(api, w, liveCommit) {
  if (!w.id) return null; // not on live yet: nothing can have drifted
  const current = await liveWorkflow(api, w.id);
  if (!current) return `workflow ${w.id} (${w.source}) does not exist on live n8n; import it there by hand once`;
  const recorded = recordedWorkflow(liveCommit, w.source);
  if (!recorded) return `"${current.name}" runs on live but was never recorded in the repo: run npm run prod:pull first`;
  /* compare what RUNS on live (not an unpublished draft) with what was recorded */
  return workflowFingerprint(runningVersion(current)) === workflowFingerprint(recorded) ? null : `"${current.name}" was edited in n8n since the last deploy`;
}
const draftNote = (wf) => `"${wf.name}" has an unpublished draft in n8n (edited but not published). Only the published version counts; the draft is kept in the backup and replaced by this deploy.`;

// n8n 2.x keeps drafts: a change only runs once the active version is the latest one.
const runsLatest = (wf) => !('activeVersionId' in wf && 'versionId' in wf) || !wf.active || wf.activeVersionId === wf.versionId;

const createdNote = (w) => (w.activate === false ? 'it is created switched OFF, see tools/targets.json' : 'it is created switched on');

async function check() {
  const cfg = loadConfig();
  const r = repo();
  for (const s of unfinishedDeploys()) say(`WARNING: an unfinished deploy was found (deploy-backups/${s}, no release-${s} tag). Run npm run prod:rollback before anything else.`);
  say(`Branch: ${r.branch}${r.dirty ? ' (has uncommitted changes)' : ''}`);
  const pending = pendingCommits(r.liveCommit);
  say(pending ? `Commits here that change live files and are not live yet:\n${indent(pending)}` : 'Everything on this branch is already live.');
  const c = changedSince(r.liveCommit);
  for (const w of c.web) say(`would update web page  ${w.name}`);
  for (const w of c.workflows) say(w.id ? `would update workflow  ${w.source}` : `would CREATE workflow  ${w.source} (new on live; ${createdNote(w)})`);
  notes(c);
  const test = stagingContentProblems([...c.web, ...c.workflows].map((w) => ({ source: w.source, text: readFileSync(at(w.source), 'utf8') })), cfg);
  for (const p of test) say(`NOT DEPLOYABLE (a test copy, not the live source): ${p}`);
  try {
    const missing = await liveDbMissing(c, r.liveCommit);
    if (c.sql.length) say(missing.length
      ? `Live database NOT ready: ${missing.map((x) => `${x.table.includes('.') ? 'column' : 'table'} ${x.table} (${x.file})`).join(', ')} missing. Run those SQL files on live first.`
      : 'Live database ready: every table this release needs already exists.');
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    say(`Live database NOT checked: ${err.message}`);
  }
  say('');
  say('Does live still match the last deploy?');
  for (const w of LIVE_WEB) {
    const d = await webDrift(w, r.liveCommit);
    say(`  ${w.name.padEnd(12)} ${d ? `NO: ${d}` : 'yes'}`);
  }
  const api = n8nApi(cfg);
  if (!api) { say('  workflows    not checked (add "n8nApiKey" to tools/config.local.json)'); return; }
  for (const w of TARGETS.workflows) {
    if (!w.id) { say(`  ${path.basename(w.source).padEnd(12)} not on live yet (created by the next deploy)`); continue; }
    const d = await workflowDrift(api, w, r.liveCommit);
    say(`  ${path.basename(w.source).padEnd(12)} ${d ? `NO: ${d}` : 'yes'}`);
    const current = d ? null : await liveWorkflow(api, w.id);
    if (current && hasUnpublishedDraft(current)) say(`               note: ${draftNote(current)}`);
  }
}
/* records the id n8n gave a newly created workflow, so later deploys update it in place. Only that
   entry's line changes (the rest of the file keeps its layout and notes); an undone deploy puts the
   whole file back as it was (targetsBefore). */
let targetsBefore = null;
export function setWorkflowIdInText(text, source, id) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(`"source": ${JSON.stringify(source)}`));
  if (i === -1 || !/"id":\s*(null|"[^"]*")/.test(lines[i])) {
    /* unexpected layout: rewrite the file as JSON */
    const t = JSON.parse(text);
    const entry = t.workflows.find((w) => w.source === source);
    if (entry) { entry.id = id; if (id) delete entry.note; }
    return `${JSON.stringify(t, null, 2)}\n`;
  }
  let line = lines[i].replace(/"id":\s*(null|"[^"]*")/, `"id": ${JSON.stringify(id)}`);
  /* the "not on live yet" note is wrong once the workflow exists */
  if (id) line = line.replace(/,\s*"note":\s*"(?:[^"\\]|\\.)*"/, '');
  lines[i] = line;
  JSON.parse(lines.join('\n'));
  return lines.join('\n');
}
function rememberWorkflowId(source, id) {
  const file = at('tools', 'targets.json');
  const text = readFileSync(file, 'utf8');
  if (targetsBefore === null) targetsBefore = text;
  writeFileSync(file, setWorkflowIdInText(text, source, id));
}

async function restore(steps, remoteDir, wfBackups, api) {
  const problems = [];
  for (const step of [...steps].reverse()) {
    try {
      if (step.kind === 'web') {
        ssh(`cp -p '${remoteDir}/${step.w.name}.html' '${step.w.serverFile}.restoring' && mv -f '${step.w.serverFile}.restoring' '${step.w.serverFile}'`);
        say(`restored ${step.w.name}`);
      } else if (step.created) {
        /* already gone (removed by hand, or by an earlier attempt) counts as removed */
        const gone = await api('DELETE', `/workflows/${step.w.id}`).then(() => false, (err) => { if (err.status === 404) return true; throw err; });
        rememberWorkflowId(step.w.source, null);
        say(gone ? `the new workflow "${step.w.source}" was already removed` : `removed the newly created workflow "${step.w.source}" again`);
      } else {
        const b = wfBackups[step.w.id];
        /* put back the version that RAN before (the published one), not an unpublished draft */
        await api('PUT', `/workflows/${step.w.id}`, apiBody(runningVersion(b)));
        if (b.active) await api('POST', `/workflows/${step.w.id}/activate`);
        say(`restored workflow "${b.name}"`);
      }
    } catch (err) {
      problems.push(`${step.w.name || step.w.source}: ${err.message}`);
    }
  }
  if (problems.length) {
    fail(`Could not restore everything automatically:\n${problems.map((p) => `    - ${p}`).join('\n')}\n  The backup is in ${remoteDir} on the server and deploy-backups/ on this PC.`);
  }
}

async function deploy() {
  const cfg = loadConfig();
  useSshKey(cfg);
  const r = repo();
  if (r.branch !== 'main') fail(`You are on "${r.branch}". Only approved code on "main" goes live: merge it into main first (see STAGING.md).`);
  if (r.dirty) fail('There are uncommitted changes. Commit or undo them first, so what goes live is exactly what is in git.');
  /* what is recorded as live (e.g. a prod:pull capture) must be part of main, or deploying main would undo it */
  if (run('git', ['merge-base', '--is-ancestor', r.liveCommit, 'HEAD'], { allowFail: true }).status !== 0) {
    fail(`main does not contain what is recorded as live (the "live" git tag, ${r.liveCommit.slice(0, 7)}), e.g. changes recorded by prod:pull that were never merged. Run "git merge ${r.liveCommit.slice(0, 7)}" on main first, then deploy again.`);
  }
  const unfinished = unfinishedDeploys();
  if (unfinished.length) fail(`An earlier deploy did not finish (deploy-backups/${unfinished.join(', deploy-backups/')}). Run npm run prod:rollback first, so live is back to a known version.`);
  const c = changedSince(r.liveCommit);
  if (!c.web.length && !c.workflows.length) {
    say('Nothing to deploy: live already runs this version.');
    notes(c);
    return;
  }
  /* a TEST copy (from .staging-build) committed over a live file must never go live */
  const test = stagingContentProblems([...c.web, ...c.workflows].map((w) => ({ source: w.source, text: readFileSync(at(w.source), 'utf8') })), cfg);
  if (test.length) fail(`Not deployed: these files are test copies, not the live source:\n${test.map((p) => `    - ${p}`).join('\n')}\n  Put the real source file back (git checkout the version from main before the test copy was copied in).`);
  const api = c.workflows.length ? n8nApi(cfg) : null;
  if (c.workflows.length && !api) fail('This deploy changes n8n workflows, which needs "n8nApiKey" in tools/config.local.json.');

  say('Checking that nobody changed live by hand since the last deploy...');
  const drift = [];
  for (const w of c.web) { const d = await webDrift(w, r.liveCommit); if (d) drift.push(d); }
  for (const w of c.workflows) { const d = await workflowDrift(api, w, r.liveCommit); if (d) drift.push(d); }
  if (drift.length) {
    fail(`Not deployed, because live changed outside this process:\n${drift.map((d) => `    - ${d}`).join('\n')}\n  Run "npm run prod:pull" to record those changes in git, then deploy again.`);
  }
  const missing = await liveDbMissing(c, r.liveCommit);
  if (missing.length) {
    fail(`Not deployed: the live database is missing ${missing.map((x) => `${x.table.includes('.') ? 'column' : 'table'} ${x.table}`).join(', ')}.\n  Run ${[...new Set(missing.map((x) => x.file))].join(' and ')} in the LIVE Supabase SQL Editor first, then deploy again.`);
  }

  say('');
  say('About to put this live:');
  say(indent(pendingCommits(r.liveCommit)));
  for (const w of c.web) say(`  web page  ${w.name}  (${TARGETS.publicBase}${w.url})`);
  for (const w of c.workflows) say(`  workflow  ${readWorkflow(w.source).name}${w.id ? '' : `  (NEW: will be created ${w.activate === false ? 'and left switched OFF' : 'and switched on'})`}`);
  notes(c);
  for (const w of c.workflows.filter((x) => x.id)) {
    const current = await liveWorkflow(api, w.id);
    if (current && hasUnpublishedDraft(current)) say(`  note: ${draftNote(current)}`);
  }
  if ((await ask('Type DEPLOY to continue:')) !== 'DEPLOY') fail('Cancelled. Nothing was changed.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const remoteDir = `${TARGETS.backupDir}/${stamp}`;
  const localDir = at('deploy-backups', stamp);
  mkdirSync(localDir, { recursive: true });
  /* workflows = ones that existed (backed up below); created = new ones this deploy adds, which a rollback deletes */
  const meta = { stamp, previousLive: r.liveCommit, deployed: r.head, web: c.web.map((w) => w.name),
                 workflows: c.workflows.filter((w) => w.id).map((w) => w.id), created: c.workflows.filter((w) => !w.id).map((w) => w.source) };
  writeFileSync(path.join(localDir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (c.web.length) {
    ssh(`mkdir -p '${remoteDir}' && ${c.web.map((w) => `cp -p '${w.serverFile}' '${remoteDir}/${w.name}.html'`).join(' && ')}`);
    uploadFile(Buffer.from(JSON.stringify(meta, null, 2)), `${remoteDir}/meta.json`);
  }
  const wfBackups = {};
  for (const w of c.workflows.filter((x) => x.id)) {
    wfBackups[w.id] = await api('GET', `/workflows/${w.id}`);
    writeFileSync(path.join(localDir, `workflow-${w.id}.json`), JSON.stringify(wfBackups[w.id], null, 2));
  }
  say(`Backup saved (server: ${remoteDir}; this PC: deploy-backups/${stamp}).`);

  const done = [];
  try {
    /* workflows first: a new page may call backend actions that only the new workflow understands */
    for (const w of c.workflows) {
      const wf = readWorkflow(w.source);
      /* n8n may add settings of its own: compare only the settings the file sets */
      const same = (now) => workflowFingerprint(runningVersion(now), { onlySettings: Object.keys(wf.settings || {}) }) === workflowFingerprint(wf, { onlySettings: Object.keys(wf.settings || {}) });
      if (!w.id) {
        const created = await api('POST', '/workflows', apiBody(wf));
        w.id = created.id;
        rememberWorkflowId(w.source, created.id);
        done.push({ kind: 'workflow', w, created: true });
        /* "activate": false in tools/targets.json: created switched off, to be switched on only after approval */
        const switchOn = w.activate !== false;
        if (switchOn) await api('POST', `/workflows/${w.id}/activate`);
        const now = await api('GET', `/workflows/${w.id}`);
        if (Boolean(now.active) !== switchOn || !same(now)) throw new Error(`n8n did not end up ${switchOn ? 'running' : 'holding'} the new "${wf.name}"`);
        say(`live  workflow "${wf.name}" created ${switchOn ? 'and switched on' : 'and left switched OFF'} (id ${w.id} saved in tools/targets.json: commit that file)`);
        continue;
      }
      const wasActive = Boolean(wfBackups[w.id].active);
      done.push({ kind: 'workflow', w });
      await api('PUT', `/workflows/${w.id}`, apiBody(wf));
      if (wasActive) await api('POST', `/workflows/${w.id}/activate`);
      const now = await api('GET', `/workflows/${w.id}`);
      if (Boolean(now.active) !== wasActive || !same(now) || !runsLatest(now)) {
        throw new Error(`n8n did not end up running the new "${wf.name}"`);
      }
      say(`live  workflow "${wf.name}" updated and verified${wasActive ? ' (switched on)' : ' (left switched off, as before)'}`);
    }
    for (const w of c.web) {
      const content = readFileSync(at(w.source));
      done.push({ kind: 'web', w });
      uploadFile(content, w.serverFile);
      const page = await fetchPublic(w.url);
      if (page.status !== 200 || sha256(page.body) !== sha256(content)) throw new Error(`${TARGETS.publicBase}${w.url} is not serving the new version (HTTP ${page.status})`);
      say(`live  ${w.name} updated and verified`);
    }
  } catch (err) {
    say('');
    say(`Problem: ${err.message}`);
    say('Putting the previous version back...');
    await restore(done, remoteDir, wfBackups, api);
    /* tools/targets.json exactly as before the deploy (layout and notes included), so the tree is clean again */
    if (targetsBefore !== null) writeFileSync(at('tools', 'targets.json'), targetsBefore);
    /* this backup was already used: a later prod:rollback must go back to the deploy before it */
    try { renameSync(localDir, `${localDir}${ROLLED_BACK}`); } catch { /* keep going: live is restored */ }
    if (c.web.length) { try { ssh(`[ -d '${remoteDir}' ] && mv '${remoteDir}' '${remoteDir}${ROLLED_BACK}' || true`); } catch { /* live is restored either way */ } }
    fail('The deploy was undone; live is back to the previous version.');
  }

  git('tag', '-f', LIVE_TAG, 'HEAD');
  git('tag', `release-${stamp}`, 'HEAD');
  say('');
  say(`Done. Live now runs ${r.head.slice(0, 7)} (git tag release-${stamp}). To undo: npm run prod:rollback`);
}

const ROLLED_BACK = '-rolled-back';

async function rollback() {
  const cfg = loadConfig();
  useSshKey(cfg);
  const onServer = ssh(`ls -1 '${TARGETS.backupDir}' 2>/dev/null || true`).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const onPc = existsSync(at('deploy-backups')) ? readdirSync(at('deploy-backups')) : [];
  const stamps = [...new Set([...onServer, ...onPc])].filter(isDeployStamp).sort();
  const stamp = stamps[stamps.length - 1];
  if (!stamp) fail('There is no deploy to roll back.');

  const localMeta = at('deploy-backups', stamp, 'meta.json');
  const metaText = existsSync(localMeta) ? readFileSync(localMeta, 'utf8') : ssh(`cat '${TARGETS.backupDir}/${stamp}/meta.json' 2>/dev/null || true`).stdout.trim();
  if (!metaText) fail(`The backup ${stamp} has no meta.json, so it can't be restored automatically.`);
  const meta = JSON.parse(metaText);
  const webs = meta.web.map((name) => TARGETS.web.find((w) => w.name === name));
  const flows = meta.workflows.filter(Boolean).map((id) => TARGETS.workflows.find((w) => w.id === id) || fail(`Workflow ${id} from this backup is not in tools/targets.json any more.`));
  /* workflows the deploy created: their ids were saved in tools/targets.json when they were created */
  const created = (meta.created || []).map((source) => TARGETS.workflows.find((w) => w.source === source)).filter((w) => w && w.id);
  const api = flows.length || created.length ? n8nApi(cfg) : null;
  if ((flows.length || created.length) && !api) fail('This rollback includes n8n workflows, which needs "n8nApiKey" in tools/config.local.json.');

  say(`This puts back what was live before the deploy of ${stamp} (version ${meta.previousLive.slice(0, 7)}):`);
  for (const w of webs) say(`  web page  ${w.name}`);
  for (const w of flows) say(`  workflow  ${w.source}`);
  for (const w of created) say(`  and removes the new workflow  ${w.source}`);
  const unknownCreated = (meta.created || []).filter((x) => !created.some((w) => w.source === x));
  if (unknownCreated.length) {
    /* an undone deploy may already have removed them: only ask for a manual delete when one still exists */
    const all = n8nApi(cfg) ? await listWorkflows(n8nApi(cfg)) : null;
    for (const source of unknownCreated) {
      const name = readWorkflow(source).name;
      const still = all ? all.filter((x) => x.name === name && !TARGETS.workflows.some((t) => t.id === x.id)) : null;
      if (still && !still.length) say(`  note: that deploy created "${source}"; it is no longer in n8n, so there is nothing to remove.`);
      else say(`  note: that deploy created "${source}", but its id is not in tools/targets.json, so it can't be removed automatically. Delete it by hand in n8n${still ? ` (id ${still.map((x) => x.id).join(', ')})` : ''}.`);
    }
  }

  const remoteDir = `${TARGETS.backupDir}/${stamp}`;
  const wfBackups = {};
  for (const w of flows) {
    const file = at('deploy-backups', stamp, `workflow-${w.id}.json`);
    if (!existsSync(file)) fail(`The workflow backup ${file} is missing on this PC.`);
    wfBackups[w.id] = JSON.parse(readFileSync(file, 'utf8'));
  }

  /* Has live changed since that deploy (a hot-fix in n8n, a page edited on the server)? Rolling back
     would overwrite it, so it is listed, needs an extra confirmation, and is saved first. A copy that is
     still what the deploy put live, or already the backed-up version (an undone deploy), is no change. */
  const liveNow = [];
  const changed = [];
  for (const w of webs) {
    const page = await fetchPublic(w.url);
    liveNow.push({ file: `${w.name}.html`, body: page.body });
    const deployed = run('git', ['show', `${meta.deployed}:${w.source}`], { binary: true, allowFail: true });
    let backedUp = null;
    try { backedUp = ssh(`sha256sum '${remoteDir}/${w.name}.html'`).stdout.trim().split(/\s+/)[0]; } catch (err) { if (!(err instanceof Stop)) throw err; }
    const now = sha256(page.body);
    if (page.status !== 200 || ((deployed.status !== 0 || now !== sha256(deployed.stdout)) && now !== backedUp)) changed.push(`the live ${w.name} page differs from what that deploy put live`);
  }
  for (const w of [...flows, ...created]) {
    const current = await liveWorkflow(api, w.id);
    if (!current) continue;
    liveNow.push({ file: `workflow-${w.id}.json`, body: Buffer.from(JSON.stringify(current, null, 2)) });
    const deployed = recordedWorkflow(meta.deployed, w.source);
    const now = workflowFingerprint(runningVersion(current));
    const asDeployed = deployed && now === workflowFingerprint(deployed);
    const asBackup = wfBackups[w.id] && now === workflowFingerprint(runningVersion(wfBackups[w.id]));
    if (!asDeployed && !asBackup) changed.push(`"${current.name}" was changed in n8n after that deploy`);
    if (hasUnpublishedDraft(current)) changed.push(`"${current.name}" has an unpublished draft in n8n`);
  }
  if (changed.length) {
    say('');
    say('WARNING: live changed after that deploy. Rolling back overwrites these changes:');
    for (const d of changed) say(`    - ${d}`);
    say('  They are saved on this PC first (deploy-backups/before-rollback-...), so nothing is lost.');
    if ((await ask('Type OVERWRITE to roll back anyway:')) !== 'OVERWRITE') fail('Cancelled. Nothing was changed.');
  }
  if ((await ask('Type ROLLBACK to continue:')) !== 'ROLLBACK') fail('Cancelled. Nothing was changed.');
  /* always keep what is live right now, before overwriting it */
  const keep = at('deploy-backups', `before-rollback-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  mkdirSync(keep, { recursive: true });
  for (const x of liveNow) writeFileSync(path.join(keep, x.file), x.body);
  say(`Current live copies saved in deploy-backups/${path.basename(keep)}.`);

  await restore([...webs.map((w) => ({ kind: 'web', w })), ...flows.map((w) => ({ kind: 'workflow', w })), ...created.map((w) => ({ kind: 'workflow', w, created: true }))], remoteDir, wfBackups, api);
  for (const w of webs) {
    const expected = ssh(`sha256sum '${remoteDir}/${w.name}.html'`).stdout.trim().split(/\s+/)[0];
    const page = await fetchPublic(w.url);
    if (sha256(page.body) !== expected) fail(`${w.name} was restored on the server, but ${TARGETS.publicBase}${w.url} is not serving it.`);
  }

  if (onServer.includes(stamp)) ssh(`mv '${remoteDir}' '${remoteDir}${ROLLED_BACK}'`);
  if (onPc.includes(stamp)) renameSync(at('deploy-backups', stamp), at('deploy-backups', `${stamp}${ROLLED_BACK}`));
  git('tag', '-f', LIVE_TAG, meta.previousLive);
  say('');
  say(`Live is back to ${meta.previousLive.slice(0, 7)}.`);
  if (created.length) say('tools/targets.json changed: the removed workflows are marked as not on live. Commit that file now, or the next deploy stops.');
  say('The undone change is still on main. Fix it (or "git revert" it) on a branch, test on staging, and deploy again.');
}

async function pull() {
  const cfg = loadConfig();
  const r = repo();
  if (r.dirty) fail('Commit or undo your current changes first.');
  const captured = new Map();
  for (const w of LIVE_WEB) {
    const page = await fetchPublic(w.url);
    if (page.status !== 200) fail(`Could not read live ${w.url} (HTTP ${page.status}).`);
    if (sha256(page.body) !== sha256(gitFile(r.liveCommit, w.source))) captured.set(w.source, page.body);
  }
  const api = n8nApi(cfg);
  if (api) {
    for (const w of TARGETS.workflows) {
      const current = await liveWorkflow(api, w.id);
      if (!current) continue;
      const recorded = recordedWorkflow(r.liveCommit, w.source);
      /* what RUNS on live is recorded, never an unpublished draft */
      const running = runningVersion(current);
      if (hasUnpublishedDraft(current)) say(`note: "${current.name}" has an unpublished draft in n8n; the published version that runs is what gets recorded.`);
      /* never recorded yet (first capture), or edited on live since the last deploy */
      if (!recorded || workflowFingerprint(running) !== workflowFingerprint(recorded)) captured.set(w.source, Buffer.from(`${JSON.stringify([running], null, 2)}\n`));
    }
  } else {
    say('Workflows were not checked (add "n8nApiKey" to tools/config.local.json).');
  }
  if (!captured.size) {
    say('Live matches the last deploy. Nothing to record.');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branch = `live-capture-${stamp}`;
  git('switch', '-c', branch, r.liveCommit);
  for (const [file, content] of captured) writeFileSync(at(file), content);
  git('add', ...captured.keys());
  git('commit', '-m', `Record changes made directly on live (${stamp})`);
  git('tag', '-f', LIVE_TAG, 'HEAD');
  git('switch', r.branch);
  say(`Recorded live changes to ${[...captured.keys()].join(', ')} on branch "${branch}".`);
  say(`Bring them into your branch with:  git merge ${branch}`);
}

const command = process.argv[2];
if (isMain(import.meta.url)) {
  main(async () => {
    if (TARGETS.deployEnabled !== true) fail('Deploys are switched off in this WhatsApp Blaster copy (tools/targets.json deployEnabled is false). It has no server of its own yet; see README.md. Build, preview and the bench work as usual.');
    if (command === 'check') return check();
    if (command === 'deploy') return deploy();
    if (command === 'rollback') return rollback();
    if (command === 'pull') return pull();
    fail('Use one of: npm run prod:check | prod:deploy | prod:rollback | prod:pull');
  });
}
