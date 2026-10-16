// A stand-in for the STAGING Supabase project, for browser tests of the staging-built admin page:
// REST (PostgREST subset, run as the signed-in user so the real RLS policies apply), auth (email + password
// against a local list), realtime (Phoenix websocket protocol, fed by triggers on the tables), storage (none).
// Workflow webhooks are answered by the staging-built n8n Code nodes (runNode), with simulated Meta.
import { STG, world, runNode } from './harness.mjs';

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw Object.assign(new Error('bad identifier ' + s), { code: 'PGRST100' }); return '"' + s + '"'; };
function splitTop(s) { const out = []; let depth = 0, cur = '', quote = false; for (const ch of s) { if (ch === '"') quote = !quote; if (!quote && ch === '(') depth++; if (!quote && ch === ')') depth--; if (!quote && depth === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; }
const unq = (v) => v.replace(/^"(.*)"$/s, '$1');
function condSql(col, expr, params) {
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.'); const op = expr.slice(0, dot); const val = unq(expr.slice(dot + 1));
  const c = ident(col);
  const p = (v) => { params.push(v); return '$' + params.length; };
  let sql;
  if (op === 'eq') sql = `${c}::text = ${p(val)}`;
  else if (op === 'neq') sql = `${c}::text <> ${p(val)}`;
  else if (['gt', 'gte', 'lt', 'lte'].includes(op)) { const o = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]; sql = `${c} ${o} ${p(val)}`; }
  else if (op === 'like' || op === 'ilike') sql = `${c}::text ${op} ${p(val.replace(/\*/g, '%'))}`;
  else if (op === 'is') sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
  else if (op === 'in') { const items = splitTop(val.replace(/^\(|\)$/g, '')).map(unq); sql = items.length ? `${c}::text in (${items.map((x) => p(x)).join(',')})` : 'false'; }
  else if (op === 'cs') sql = `${c} @> ${p(val.startsWith('{') ? val : val)}`;
  else throw Object.assign(new Error('unsupported operator ' + op), { code: 'PGRST100' });
  return neg ? `not (${sql})` : sql;
}
function logicSql(list, params, joiner) {
  return '(' + splitTop(list.replace(/^\(|\)$/g, '')).map((part) => {
    if (part.startsWith('and(')) return logicSql(part.slice(3), params, ' and ');
    if (part.startsWith('or(')) return logicSql(part.slice(2), params, ' or ');
    const d = part.indexOf('.'); return condSql(part.slice(0, d), part.slice(d + 1), params);
  }).join(joiner) + ')';
}
function whereFrom(sp, params) {
  const conds = [];
  for (const [k, v] of sp) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or') conds.push(logicSql(v, params, ' or ')); else if (k === 'and') conds.push(logicSql(v, params, ' and ')); else conds.push(condSql(k, v, params));
  }
  return conds.length ? ' where ' + conds.join(' and ') : '';
}
const plain = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = v instanceof Date ? v.toISOString() : v; return o; };
const val = (v) => (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
function selectList(sel) {
  return splitTop(sel || '*').map((c) => c.trim()).filter(Boolean).map((c) => {
    if (c === '*') return '*';
    if (c.includes('(')) throw Object.assign(new Error('embedded resources are not emulated: ' + c), { code: 'PGRST100' });
    const [a, b] = c.includes(':') ? c.split(':') : [null, c];
    const col = b.replace(/::.*$/, '');
    return a ? `${ident(col)} as ${ident(a)}` : ident(col);
  }).join(', ');
}

async function restQuery(q, method, u, bodyText, headers) {
  const path = decodeURIComponent(u.pathname.replace(/^\/rest\/v1\//, ''));
  const sp = [...u.searchParams.entries()];
  const params = [];
  const prefer = String(headers['prefer'] || '');
  const accept = String(headers['accept'] || '');
  const wantsOne = /vnd\.pgrst\.object/.test(accept);
  const ret = (status, body, extra = {}) => ({ status, body, headers: extra });
  if (path.startsWith('rpc/')) {
    const fn = path.slice(4);
    const args = method === 'GET' ? Object.fromEntries(sp) : (bodyText ? JSON.parse(bodyText) : {});
    const info = (await q(`select p.proretset, t.typname, t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1`, [fn]))[0];
    if (!info) return ret(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    const names = Object.keys(args);
    const call = `public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(', ')})`;
    const vals = names.map((n) => val(args[n]));
    if (info.typtype === 'c' || (info.typtype === 'p' && info.typname === 'record')) {
      const rows = (await q(`select * from ${call}`, vals)).map(plain);
      if (info.proretset) return ret(200, rows);
      return ret(200, rows[0] && Object.values(rows[0]).some((x) => x !== null) ? rows[0] : null);
    }
    if (info.proretset) { const rows = await q(`select ${call} as r`, vals); return ret(200, rows.map((x) => x.r instanceof Date ? x.r.toISOString() : x.r)); }
    const rows = await q(`select ${call} as r`, vals);
    const v = rows[0] ? rows[0].r : null;
    return info.typname === 'void' ? ret(204, '') : ret(200, v instanceof Date ? v.toISOString() : v);
  }
  const table = ident(path);
  if (method === 'GET' || method === 'HEAD') {
    let sql = `select ${selectList(u.searchParams.get('select'))} from public.${table}${whereFrom(sp, params)}`;
    const order = u.searchParams.get('order');
    if (order) sql += ' order by ' + order.split(',').map((o) => { const [c, dir, nulls] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`; }).join(', ');
    let count = null;
    if (/count=(exact|planned|estimated)/.test(prefer)) { const p2 = []; const w = whereFrom(sp, p2); count = Number((await q(`select count(*)::int n from public.${table}${w}`, p2))[0].n); }
    const lim = u.searchParams.get('limit'), off = u.searchParams.get('offset');
    if (lim) sql += ` limit ${Number(lim)}`;
    if (off) sql += ` offset ${Number(off)}`;
    const rows = (await q(sql, params)).map(plain);
    const extra = count !== null ? { 'content-range': `${off || 0}-${Number(off || 0) + rows.length - 1}/${count}` } : {};
    if (method === 'HEAD') return ret(200, '', extra);
    if (wantsOne) return rows.length === 1 ? ret(200, rows[0], extra) : ret(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
    return ret(200, rows, extra);
  }
  if (method === 'POST') {
    const body = JSON.parse(bodyText || '{}');
    const rows = Array.isArray(body) ? body : [body];
    const out = [];
    const conflict = u.searchParams.get('on_conflict');
    const merge = /resolution=merge-duplicates/.test(prefer), ignore = /resolution=ignore-duplicates/.test(prefer);
    for (const row of rows) {
      const cols = Object.keys(row);
      let sql = `insert into public.${table} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`;
      if (merge || ignore) {
        const target = conflict ? `(${conflict.split(',').map(ident).join(', ')})` : '';
        sql += ignore ? ` on conflict ${target} do nothing` : ` on conflict ${target} do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
      }
      out.push(...(await q(sql + ' returning *', cols.map((c) => val(row[c])))).map(plain));
    }
    if (!/return=representation/.test(prefer)) return ret(201, '');
    if (wantsOne) return out.length === 1 ? ret(201, out[0]) : ret(406, { code: 'PGRST116', message: 'multiple rows' });
    return ret(201, out);
  }
  if (method === 'PATCH' || method === 'DELETE') {
    let sql;
    if (method === 'PATCH') {
      const body = JSON.parse(bodyText || '{}');
      const cols = Object.keys(body);
      cols.forEach((c) => params.push(val(body[c])));
      sql = `update public.${table} set ${cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ')}${whereFrom(sp, params)} returning *`;
    } else sql = `delete from public.${table}${whereFrom(sp, params)} returning *`;
    const rows = (await q(sql, params)).map(plain);
    if (!/return=representation/.test(prefer)) return ret(204, '');
    if (wantsOne) return rows.length === 1 ? ret(200, rows[0]) : ret(406, { code: 'PGRST116', message: 'multiple rows' });
    return ret(200, rows);
  }
  return ret(405, { message: 'method not emulated' });
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (user) => b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 * 8, iat: Math.floor(Date.now() / 1000) }) + '.sig';

export async function prepareRealtime(db) {
  await db.exec(`create table if not exists public._rt_log (id bigserial primary key, tbl text, op text, rec jsonb, old jsonb);
    create or replace function public._rt_capture() returns trigger language plpgsql as $$
    begin insert into public._rt_log (tbl, op, rec, old) values (tg_table_name, tg_op, to_jsonb(new), case when tg_op = 'UPDATE' then to_jsonb(old) else null end); return null; end $$;
    drop trigger if exists _rt_msg on public.wa_messages; create trigger _rt_msg after insert or update on public.wa_messages for each row execute function public._rt_capture();
    drop trigger if exists _rt_conv on public.wa_conversations; create trigger _rt_conv after insert or update on public.wa_conversations for each row execute function public._rt_capture();
    drop trigger if exists _rt_mstat on public.wa_message_status; create trigger _rt_mstat after insert or update on public.wa_message_status for each row execute function public._rt_capture();`);
}

// users: { email: { id, password } }; appOrigin: where the page is served; pageFile: the built page
export function fakeSupabase(db, { users, pageFile, appOrigin = 'http://qa.local' }) {
  const log = { unsupported: [], rest: 0, webhooks: [], sockets: 0, pushed: 0 };
  const byToken = {};
  const userOfToken = (auth) => byToken[String(auth || '').replace(/^Bearer /, '')] || null;
  const sockets = new Set();
  let lastRt = 0, draining = null;
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      const rows = (await db.query(`select * from public._rt_log where id > $1 order by id`, [lastRt])).rows;
      for (const r of rows) {
        lastRt = Number(r.id);
        for (const s of sockets) s.deliver(r);
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  const timer = setInterval(() => { drain().catch(() => {}); }, 250);

  async function asUser(user, fn) {
    return db.transaction(async (tx) => {
      const q = async (sql, p) => (await tx.query(sql, p)).rows;
      if (user) {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
        await tx.query('set local role authenticated');
      } else await tx.query('set local role anon');
      return fn(q);
    });
  }

  async function attach(context) {
    await context.route(appOrigin + '/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin/' || url.pathname === '/admin/index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageFile() });
      return route.fulfill({ status: 404, body: 'not found' });
    });
    await context.route(STG + '/rest/v1/**', async (route) => {
      const req = route.request();
      const h = req.headers();
      const u = new URL(req.url());
      const user = userOfToken(h['authorization']);
      log.rest++;
      let res;
      try { res = await asUser(user, (q) => restQuery(q, req.method(), u, req.postData() || '', h)); }
      catch (e) {
        const code = e.code === '42501' ? 403 : e.code === '23505' ? 409 : e.code === 'PGRST100' ? 400 : (e.code === '42703' || e.code === '42P01' || e.code === '22P02') ? 400 : 400;
        if (e.code === 'PGRST100') log.unsupported.push(req.method() + ' ' + u.pathname + u.search + ' :: ' + e.message);
        res = { status: code, body: { code: e.code, message: e.message, details: null, hint: null }, headers: {} };
      }
      drain().catch(() => {});
      return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json', 'access-control-expose-headers': 'content-range', ...res.headers }, body: res.body === '' ? '' : JSON.stringify(res.body) });
    });
    await context.route(STG + '/auth/v1/**', async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.pathname.endsWith('/token')) {
        const body = JSON.parse(req.postData() || '{}');
        let email = body.email;
        if (u.searchParams.get('grant_type') === 'refresh_token') email = Object.keys(users).find((e) => users[e].refresh === body.refresh_token);
        const rec = email && users[email.toLowerCase()];
        if (!rec || (u.searchParams.get('grant_type') === 'password' && rec.password !== body.password)) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
        const user = { id: rec.id, email: email.toLowerCase(), aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-01T00:00:00Z' };
        const token = fakeJwt(user); byToken[token] = user; rec.refresh = 'r-' + rec.id + '-' + Date.now();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 28800, expires_at: Math.floor(Date.now() / 1000) + 28800, refresh_token: rec.refresh, user }) });
      }
      if (u.pathname.endsWith('/user')) {
        const user = userOfToken(req.headers()['authorization']);
        return route.fulfill({ status: user ? 200 : 401, contentType: 'application/json', body: JSON.stringify(user || { message: 'invalid token' }) });
      }
      if (u.pathname.endsWith('/logout')) return route.fulfill({ status: 204, body: '' });
      log.unsupported.push('auth ' + u.pathname);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    /* storage: a signed-in user gets a signed link for the private wa-media store (as the real policy allows staff of the club);
       the link, and any public brand picture, serves a small picture */
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjAxIYFQOjxwADZQBHSQe7eUAAAAASUVORK5CYII=", 'base64');
    await context.route(STG + '/storage/v1/**', async (route) => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname.replace(/^\/storage\/v1/, '');
      if (req.method() === 'POST' && p.startsWith('/object/sign/wa-media/')) {
        if (!userOfToken(req.headers()['authorization'])) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"statusCode":"400","error":"Unauthorized","message":"new row violates row-level security policy"}' });
        log.signed = (log.signed || 0) + 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedURL: p + '?token=bench-' + log.signed }) });
      }
      if (req.method() === 'GET' && p.startsWith('/object/sign/wa-media/') && /^bench-/.test(u.searchParams.get('token') || '')) return route.fulfill({ status: 200, contentType: /\.pdf$/i.test(p) ? 'application/pdf' : 'image/png', body: PNG });
      if (req.method() === 'GET' && p.startsWith('/object/public/brand/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      log.unsupported.push('storage ' + req.method() + ' ' + p);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not in the test bench"}' });
    });
    await context.route('https://n8n.example.com/webhook/**', async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (!/\/webhook\/stg-/.test(u.pathname)) { log.webhooks.push('BLOCKED non-staging ' + u.pathname); return route.fulfill({ status: 599, body: 'blocked' }); }
      log.webhooks.push(u.pathname);
      if (u.pathname.endsWith('/stg-broadcast-send')) {
        const body = JSON.parse(req.postData() || '{}');
        const w = world(db, { users: Object.fromEntries(Object.entries(byToken).map(([t, x]) => [t, { id: x.id, email: x.email }])) });
        let out; try { out = await runNode('broadcast_wf_vps.json', 'Broadcast Send', { json: { body } }, w, { setTimeout: (fn) => setImmediate(fn) }); }
        catch (e) { out = { ok: false, error: 'bench: ' + e.message }; }
        drain().catch(() => {});
        /* n8n "respond: when last node finishes" answers with the first item's JSON (an object) */
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
      }
      if (u.pathname.endsWith('/stg-kb-files')) {
        const body = JSON.parse(req.postData() || '{}');
        const w = world(db, { users: Object.fromEntries(Object.entries(byToken).map(([t, x]) => [t, { id: x.id, email: x.email }])) });
        let out; try { out = await runNode('kb_files_wf.json', 'KB Files', { json: { body } }, w, { setTimeout: (fn) => setImmediate(fn) }); }
        catch (e) { out = { ok: false, error: 'bench: ' + e.message }; }
        drain().catch(() => {});
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"workflow not in the test bench"}' });
    });
    await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
      log.sockets++;
      const channels = new Map(); /* topic -> { bindings:[{id,event,schema,table,filter}], join_ref, arr } */
      let arrayMode = false;
      const send = (join_ref, ref, topic, event, payload) => ws.send(JSON.stringify(arrayMode ? [join_ref, ref, topic, event, payload] : { join_ref, ref, topic, event, payload }));
      const sock = {
        ws,
        deliver(r) {
          for (const [topic, ch] of channels) {
            const ids = ch.bindings.filter((b) => b.table === r.tbl && (b.event === '*' || b.event === r.op) && (!b.filter || (() => { const m = /^(\w+)=eq\.(.+)$/.exec(b.filter); return !m || String((r.rec || {})[m[1]]) === m[2]; })())).map((b) => b.id);
            if (!ids.length) continue;
            log.pushed++;
            const rec = r.rec || {};
            send(null, null, topic, 'postgres_changes', { ids, data: { schema: 'public', table: r.tbl, commit_timestamp: new Date().toISOString(), type: r.op, record: rec, old_record: r.old || {}, columns: Object.keys(rec).map((name) => ({ name, type: 'text' })), errors: null } });
          }
        },
      };
      sockets.add(sock);
      ws.onClose(() => sockets.delete(sock));
      let nextId = 1000;
      ws.onMessage((raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        let join_ref, ref, topic, event, payload;
        if (Array.isArray(m)) { arrayMode = true; [join_ref, ref, topic, event, payload] = m; } else ({ join_ref, ref, topic, event, payload } = m);
        if (topic === 'phoenix' && event === 'heartbeat') return send(null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} });
        if (event === 'phx_join') {
          const pc = ((payload && payload.config && payload.config.postgres_changes) || []).map((b) => ({ id: nextId++, event: b.event, schema: b.schema, table: b.table, ...(b.filter ? { filter: b.filter } : {}) }));
          channels.set(topic, { bindings: pc, join_ref });
          send(join_ref, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } });
          if (pc.length) send(join_ref, null, topic, 'system', { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: topic.replace(/^realtime:/, '') });
          return;
        }
        if (event === 'phx_leave') { channels.delete(topic); return send(join_ref, ref, topic, 'phx_reply', { status: 'ok', response: {} }); }
        if (event === 'access_token') return;
        if (ref) send(join_ref, ref, topic, 'phx_reply', { status: 'ok', response: {} });
      });
    });
  }
  /* closes every live connection, like a network drop; the page reconnects by itself */
  const dropSockets = () => { for (const s of [...sockets]) { try { s.ws.close(); } catch {} sockets.delete(s); } };
  return { attach, log, drain, dropSockets, stop: () => clearInterval(timer), asUser };
}
