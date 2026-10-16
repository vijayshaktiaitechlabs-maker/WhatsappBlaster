// Local test bench for the n8n Code nodes: runs the STAGING-BUILT workflow code (guard included)
// against an in-memory Postgres (PGlite) that has the full staging structure + test data, through a
// small PostgREST emulator. Meta's Graph API is never reached: in "simulated Meta" mode the staging
// guard answers it (and records to stg_outbox); anything else that tries to leave is refused.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { simTemplateCatalog } from '../../tools/build-staging.mjs';
const CRM = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');

export const B = CRM + '.staging-build/';
export const cfg = JSON.parse(readFileSync(process.env.OPS_CONFIG || CRM + 'tools/config.local.json', 'utf8')).staging;
let SIM_CATALOG = null;
const simCatalog = () => SIM_CATALOG || (SIM_CATALOG = simTemplateCatalog(readFileSync(CRM + 'admin-panel/index.html', 'utf8')));
export const STG = cfg.supabaseUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');

export async function makeDb() {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
    create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false);
    grant usage on schema public to anon, authenticated, service_role; grant usage on schema auth to anon, authenticated, service_role;
    -- as on Supabase: new tables, sequences and functions in public are usable by these roles unless the SQL revokes it
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    grant select on auth.users to authenticated, service_role;`);
  await db.exec(readFileSync(B + 'db/1-structure.sql', 'utf8'));
  await db.exec(readFileSync(B + 'db/2-test-data.sql', 'utf8'));
  return db;
}

// ---------------- PostgREST emulator (the subset the workflows use) ----------------
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('bad identifier ' + s); return '"' + s + '"'; };
function splitTop(s) { const out = []; let depth = 0, cur = '', quote = false; for (const ch of s) { if (ch === '"') quote = !quote; if (!quote && ch === '(') depth++; if (!quote && ch === ')') depth--; if (!quote && depth === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; }
function condSql(col, expr, params) {
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.'); const op = expr.slice(0, dot); const val = expr.slice(dot + 1);
  const c = ident(col);
  const p = (v) => { params.push(v); return '$' + params.length; };
  let sql;
  if (op === 'eq') sql = `${c}::text = ${p(val)}`;
  else if (op === 'neq') sql = `${c}::text <> ${p(val)}`;
  else if (['gt', 'gte', 'lt', 'lte'].includes(op)) { const o = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]; sql = `${c} ${o} ${p(val)}`; }
  else if (op === 'like' || op === 'ilike') sql = `${c}::text ${op === 'like' ? 'like' : 'ilike'} ${p(val.replace(/\*/g, '%'))}`;
  else if (op === 'is') sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
  else if (op === 'in') { const items = splitTop(val.replace(/^\(|\)$/g, '')).map((x) => x.replace(/^"|"$/g, '')); sql = `${c}::text in (${items.map((x) => p(x)).join(',')})`; }
  else throw new Error('unsupported operator ' + op);
  return neg ? `not (${sql})` : sql;
}
function orSql(list, params, joiner = ' or ') {
  return '(' + splitTop(list.replace(/^\(|\)$/g, '')).map((part) => {
    if (part.startsWith('and(')) return orSql(part.slice(3), params, ' and ');
    if (part.startsWith('or(')) return orSql(part.slice(2), params, ' or ');
    const d = part.indexOf('.'); return condSql(part.slice(0, d), part.slice(d + 1), params);
  }).join(joiner) + ')';
}
function whereFrom(sp, params) {
  const conds = [];
  for (const [k, v] of sp) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    if (k === 'or') conds.push(orSql(v, params)); else if (k === 'and') conds.push(orSql(v, params, ' and ')); else conds.push(condSql(k, v, params));
  }
  return conds.length ? ' where ' + conds.join(' and ') : '';
}
const plain = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = v instanceof Date ? v.toISOString() : v; return o; };
export async function rest(db, method, url, bodyText, headers = {}) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/rest\/v1\//, '');
  const sp = [...u.searchParams.entries()];
  const params = [];
  const prefer = String(headers.Prefer || headers.prefer || '');
  try {
    if (path.startsWith('rpc/')) {
      const fn = path.slice(4);
      const args = bodyText ? JSON.parse(bodyText) : {};
      const names = Object.keys(args);
      const info = (await db.query(`select p.proretset, t.typname from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1`, [fn])).rows[0];
      if (!info) return { statusCode: 404, body: { message: 'function not found ' + fn } };
      const call = `public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(', ')})`;
      const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
      if (info.proretset) { const r = await db.query(`select * from ${call}`, vals); return { statusCode: 200, body: r.rows.map(plain) }; }
      const r = await db.query(`select ${call} as r`, vals);
      const v = r.rows[0] ? r.rows[0].r : null;
      return { statusCode: info.typname === 'void' ? 204 : 200, body: v instanceof Date ? v.toISOString() : v };
    }
    const table = ident(path);
    if (method === 'GET') {
      const sel = (u.searchParams.get('select') || '*').split(',').map((c) => c.trim()).filter(Boolean).map((c) => c === '*' ? '*' : ident(c)).join(', ');
      let sql = `select ${sel} from public.${table}${whereFrom(sp, params)}`;
      const order = u.searchParams.get('order');
      if (order) sql += ' order by ' + order.split(',').map((o) => { const [c, dir, nulls] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`; }).join(', ');
      if (u.searchParams.get('limit')) sql += ` limit ${Number(u.searchParams.get('limit'))}`;
      if (u.searchParams.get('offset')) sql += ` offset ${Number(u.searchParams.get('offset'))}`;
      const r = await db.query(sql, params);
      return { statusCode: 200, body: r.rows.map(plain) };
    }
    if (method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      const rows = Array.isArray(body) ? body : [body];
      const out = [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object') ? JSON.stringify(row[c]) : row[c]);
        const r = await db.query(`insert into public.${table} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) returning *`, vals);
        out.push(...r.rows.map(plain));
      }
      return { statusCode: 201, body: /return=representation/.test(prefer) ? out : '' };
    }
    if (method === 'PATCH') {
      const body = JSON.parse(bodyText || '{}');
      const cols = Object.keys(body);
      cols.forEach((c) => params.push((body[c] !== null && typeof body[c] === 'object') ? JSON.stringify(body[c]) : body[c]));
      const set = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
      const r = await db.query(`update public.${table} set ${set}${whereFrom(sp, params)} returning *`, params);
      return { statusCode: /return=representation/.test(prefer) ? 200 : 204, body: /return=representation/.test(prefer) ? r.rows.map(plain) : '' };
    }
    if (method === 'DELETE') {
      const where = whereFrom(sp, params);
      if (!where.trim()) return { statusCode: 400, body: { message: 'TEST BENCH: a delete needs a filter' } };
      const r = await db.query(`delete from public.${table}${where} returning *`, params);
      return { statusCode: /return=representation/.test(prefer) ? 200 : 204, body: /return=representation/.test(prefer) ? r.rows.map(plain) : '' };
    }
    return { statusCode: 405, body: { message: 'method' } };
  } catch (e) {
    const code = e.code === '23505' ? 409 : (e.code === '42703' || e.code === '42P01' || e.code === '22P02') ? 400 : 500;
    return { statusCode: code, body: { code: e.code, message: e.message } };
  }
}

// ---------------- fake outside world ----------------
export function world(db, { users = {}, meta = {} } = {}) {
  const calls = [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || o.uri);
      const method = String(o.method || 'GET').toUpperCase();
      const bodyText = Buffer.isBuffer(o.body) ? ('<' + o.body.length + ' bytes>') : typeof o.body === 'string' ? o.body : (o.body === undefined ? '' : JSON.stringify(o.body));
      calls.push({ method, url, body: bodyText });
      let res;
      if (url.startsWith(STG + '/rest/v1/')) res = await rest(db, method, url, bodyText, o.headers || {});
      else if (url.startsWith(STG + '/auth/v1/user')) {
        const tok = String((o.headers && (o.headers.Authorization || o.headers.authorization)) || '').replace(/^Bearer /, '');
        res = users[tok] ? { statusCode: 200, body: users[tok] } : { statusCode: 401, body: { message: 'invalid token' } };
      }
      else if (url.startsWith(STG + '/storage/v1/object/')) {
        /* the private store: an upload is kept in memory for the test to look at */
        const p = url.slice((STG + '/storage/v1/object/').length);
        if (method === 'POST' || method === 'PUT') { helpers.storage.set(p, { bytes: Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body || '')), mime: (o.headers || {})['Content-Type'] || '' }); res = { statusCode: 200, body: { Key: p } }; }
        else res = helpers.storage.has(p) ? { statusCode: 200, body: helpers.storage.get(p).bytes } : { statusCode: 404, body: { message: 'not found' } };
      }
      else if (/\/webhook\/stg-[a-z-]*relay(\?|$)/.test(url)) {
        /* the upload relay: a file for the store is kept in memory for the test to look at (as the real relay's HTTP Request node would send it) */
        let b = {}; try { b = JSON.parse(bodyText || '{}'); } catch (e) {}
        const target = String(b.target_url || '');
        if (target.startsWith(STG + '/storage/v1/object/')) helpers.storage.set(target.slice((STG + '/storage/v1/object/').length), { bytes: Buffer.from(String(b.file_base64 || ''), 'base64'), mime: String(b.mime || '') });
        res = { statusCode: 200, body: { ok: true, status: 200, body: {} } };
      }
      else if (url.startsWith('https://graph.facebook.com/') && meta.handler) res = await meta.handler(method, url, bodyText);
      else if (url.startsWith('https://graph.facebook.com/')) res = { statusCode: 599, body: { error: { message: 'TEST BENCH: a real Meta call was attempted (simulation should have answered)' } } };
      else throw new Error('TEST BENCH: unexpected outside request ' + method + ' ' + url);
      if (o.returnFullResponse) return { statusCode: res.statusCode, headers: {}, body: res.body };
      if (res.statusCode >= 400 && !o.ignoreHttpStatusErrors) { const e = new Error('Request failed with status code ' + res.statusCode); e.httpCode = res.statusCode; throw e; }
      return res.body;
    },
    async getBinaryDataBuffer() { return helpers._raw; },
    storage: new Map(),
  };
  return { calls, helpers };
}

// fake timers: every sleep is recorded and returns at once (the code's pacing can be checked without waiting)
export function fakeTimers() { const waits = []; const st = (fn, ms) => { waits.push(ms); return setImmediate(fn); }; return { waits, setTimeout: st }; }

/* the Code of one node of a staging-built workflow, as the bench runs it: WhatsApp always simulated and the
   simulated template catalog filled in, whatever the build was made with (the bench never talks to Meta) */
export function benchCode(file, nodeName) {
  const wf = JSON.parse(readFileSync(B + 'n8n/' + file, 'utf8'));
  const node = (Array.isArray(wf) ? wf[0] : wf).nodes.find((n) => n.name === nodeName);
  let code = node.parameters.jsCode;
  /* and never calls Google: a staging AI key in the build becomes the stand-in marker */
  if (cfg.geminiKey) code = code.split(String(cfg.geminiKey).trim()).join('STAGING-NO-GEMINI-KEY');
  return code
    .replace(/\bsim: false, noAi:/, 'sim: true, noAi:')
    .replace(/\btemplates: \[\] \};/, () => `templates: ${JSON.stringify(simCatalog())} };`);
}

// runs one Code node of a staging-built workflow with an input item
export async function runNode(file, nodeName, item, w, timers) {
  const code = benchCode(file, nodeName);
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFn('$input', 'Buffer', 'setTimeout', code);
  const out = await fn.call({ helpers: w.helpers }, { first: () => item }, Buffer, (timers && timers.setTimeout) || setTimeout);
  return out[0].json;
}

// a Meta webhook item exactly as n8n passes it with "Raw Body" on (signed with the staging app secret)
export function metaItem(w, body, { secret = cfg.whatsapp.appSecret, unsigned = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  w.helpers._raw = raw;
  const headers = { 'content-type': 'application/json' };
  if (!unsigned) headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  return { json: { headers, params: {}, query: {}, body }, binary: { data: { data: raw.toString('base64'), mimeType: 'application/json', id: 'filesystem-v2:x' } } };
}
