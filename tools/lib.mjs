// Shared helpers for the staging and live-deploy tooling. Node 18+ only, no npm packages.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline/promises';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const at = (...parts) => path.join(ROOT, ...parts);
export const TARGETS = JSON.parse(readFileSync(at('tools', 'targets.json'), 'utf8'));
export const BUILD_DIR = at('.staging-build');

export class Stop extends Error {}
export const fail = (message) => { throw new Stop(message); };
export const say = (message = '') => console.log(message ? `  ${message}` : '');

export const isMain = (metaUrl) => process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;

export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Stop) {
      console.error(`\n  STOPPED: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export function loadConfig(required = []) {
  const file = process.env.OPS_CONFIG || at('tools', 'config.local.json');
  if (!existsSync(file)) {
    fail('tools/config.local.json is missing. Copy tools/config.example.json to tools/config.local.json and fill it in (see STAGING.md).');
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const blank = (v) => v == null || v === '' || String(v).startsWith('PASTE_');
  const missing = required.filter((key) => {
    const value = key.split('.').reduce((obj, k) => (obj == null ? obj : obj[k]), cfg);
    return Array.isArray(value) ? value.length === 0 || value.some(blank) : blank(value);
  });
  if (missing.length) fail(`Fill in ${missing.map((k) => `"${k}"`).join(', ')} in tools/config.local.json (see STAGING.md).`);
  return cfg;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function run(cmd, args, { allowFail = false, input, binary = false } = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, input, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) fail(`Could not run "${cmd}": ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    const out = `${res.stderr || ''}${res.stdout || ''}`.trim();
    if (/UNPROTECTED PRIVATE KEY|bad permissions|are too open/i.test(out)) {
      fail(`Windows refused the SSH key because its file permissions are too open. Run this once in PowerShell, then try again:\n    icacls "${sshKeyPath()}" /inheritance:r /grant:r "\${env:USERNAME}:(R)"`);
    }
    fail(`"${cmd} ${args.filter((a) => !a.startsWith('-')).slice(-1)}" failed:\n${out}`);
  }
  return res;
}

export const git = (...args) => run('git', args).stdout.trim();

export function gitFile(commit, file) {
  return run('git', ['show', `${commit}:${file}`], { binary: true }).stdout;
}

let configuredKey = null;
export function useSshKey(cfg) { configuredKey = cfg && cfg.sshKey ? cfg.sshKey : null; }
export function sshKeyPath() {
  const p = configuredKey || TARGETS.sshKey;
  return path.isAbsolute(p) ? p : at(p);
}
function sshOptions() {
  if (!existsSync(sshKeyPath())) fail(`SSH key not found at ${sshKeyPath()}. Set "sshKey" in tools/config.local.json.`);
  return ['-i', sshKeyPath(), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20'];
}

export function ssh(command, opts) {
  return run('ssh', [...sshOptions(), TARGETS.server, command], opts);
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Writes to a temp name first, then renames, so the web server never serves a half-written file.
export function uploadFile(content, remoteFile) {
  const dir = path.posix.dirname(remoteFile);
  ssh(`mkdir -p ${shq(dir)} && cat > ${shq(remoteFile + '.uploading')} && mv -f ${shq(remoteFile + '.uploading')} ${shq(remoteFile)}`, { input: content });
  const remoteHash = ssh(`sha256sum ${shq(remoteFile)}`).stdout.trim().split(/\s+/)[0];
  if (remoteHash !== sha256(content)) fail(`Upload of ${remoteFile} did not arrive intact.`);
}

export async function fetchPublic(urlPath) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const res = await fetch(`${TARGETS.publicBase}${urlPath}${sep}nocache=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

export async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`  ${question} `)).trim();
  } finally {
    rl.close();
  }
}

export function n8nApi(cfg) {
  if (!cfg.n8nApiKey) return null;
  const base = `${TARGETS.publicBase}/api/v1`;
  return async (method, apiPath, body) => {
    const res = await fetch(base + apiPath, {
      method,
      headers: { 'X-N8N-API-KEY': cfg.n8nApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : data.message || JSON.stringify(data);
      const err = new Error(`n8n ${method} ${apiPath} returned HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

export async function listWorkflows(api) {
  const all = [];
  let cursor = '';
  do {
    const page = await api('GET', `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    all.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

export function parseWorkflow(text) {
  const raw = JSON.parse(text);
  return Array.isArray(raw) ? raw[0] : raw;
}
export const readWorkflow = (file) => parseWorkflow(readFileSync(at(file), 'utf8'));

const SETTINGS_KEYS = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution',
  'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy', 'callerIds'];

// The n8n public API only accepts these fields when creating or updating a workflow.
export function apiBody(wf) {
  const settings = Object.fromEntries(Object.entries(wf.settings || {}).filter(([k]) => SETTINGS_KEYS.includes(k)));
  return { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, ...(wf.staticData ? { staticData: wf.staticData } : {}) };
}

const stable = (value) => JSON.stringify(value, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

/* n8n's own defaults for a workflow setting: an absent key and its default behave the same */
const SETTING_DEFAULTS = { executionTimeout: -1, callerPolicy: 'workflowsFromSameOwner' };
const isDefaultSetting = (k, v) => v == null || v === '' || v === 'DEFAULT' || SETTING_DEFAULTS[k] === v;
/* the workflow settings that change how it runs (error workflow, timeout, what run history keeps...) */
export function workflowSettings(wf, onlyKeys = null) {
  const keys = onlyKeys ? SETTINGS_KEYS.filter((k) => onlyKeys.includes(k)) : SETTINGS_KEYS;
  return Object.fromEntries(Object.entries((wf && wf.settings) || {})
    .filter(([k, v]) => keys.includes(k) && !isDefaultSetting(k, v)).sort(([a], [b]) => a.localeCompare(b)));
}
/* node options set outside "parameters" (on error, retry on fail...); the defaults count as absent */
function nodeOptions(n) {
  const o = {};
  if (n.onError && n.onError !== 'stopWorkflow') o.onError = n.onError;
  if (n.continueOnFail) o.continueOnFail = true;
  if (n.retryOnFail) Object.assign(o, { retryOnFail: true, maxTries: n.maxTries ?? null, waitBetweenTries: n.waitBetweenTries ?? null });
  if (n.alwaysOutputData) o.alwaysOutputData = true;
  if (n.executeOnce) o.executeOnce = true;
  return o;
}

/* n8n 2.x keeps an edited-but-unpublished draft in "nodes"; what actually runs is "activeVersion".
   Everything that compares, records or restores live workflows uses the version that runs. */
export function runningVersion(wf) {
  const av = wf && wf.active && wf.activeVersion;
  if (!av || !Array.isArray(av.nodes)) return wf;
  return { ...wf, nodes: av.nodes, connections: av.connections || {} };
}
export const hasUnpublishedDraft = (wf) => Boolean(wf && wf.active && wf.activeVersionId && wf.versionId && wf.activeVersionId !== wf.versionId);

// Two workflows with the same fingerprint behave the same: same nodes, parameters and options of each node,
// wiring, and workflow settings. onlySettings limits the settings compared (a deploy checks only the ones
// its file sets, because n8n may add its own). Pass the running version (runningVersion) of a live workflow.
export function workflowFingerprint(wf, { onlySettings = null } = {}) {
  const nodes = [...wf.nodes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => [n.name, n.type, n.typeVersion, stable(n.parameters), stable(n.credentials || null), Boolean(n.disabled), stable(nodeOptions(n))]);
  return sha256(stable({ nodes, connections: wf.connections, settings: workflowSettings(wf, onlySettings) }));
}

export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/* Signs that a file is a TEST copy (made by tools/build-staging.mjs) rather than the live source:
   a live deploy refuses any file that has one. */
export function stagingMarkers(text, { stagingRef = '' } = {}) {
  const found = [];
  const has = (re, why) => { if (re.test(text)) found.push(why); };
  has(/data-staging-banner/, 'the yellow TEST COPY label');
  has(/<title>\s*\[TEST\]/i, 'a "[TEST]" page title');
  has(/STAGING GUARD/, 'the staging guard code');
  has(/\[STAGING\] /, 'a "[STAGING]" workflow name');
  has(/\/webhook(?:-test)?\/stg-/, 'a staging (stg-) webhook address');
  has(/stg_outbox/, 'the staging-only stg_outbox table');
  has(/STAGING-NO-GEMINI-KEY|STAGING-NO-ESPO-KEY|espo\.staging\.invalid/, 'a staging stand-in key or address');
  if (stagingRef && text.includes(stagingRef)) found.push(`the staging database (${stagingRef})`);
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    const c = jwtClaims(m[0]);
    if (c && c.ref && c.ref !== TARGETS.supabaseRef) { found.push(`a database key of another Supabase project (${c.ref})`); break; }
  }
  return found;
}

/* deploy backups are named by their time stamp; anything else in the backup folders is not a deploy */
export const isDeployStamp = (name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(String(name));
