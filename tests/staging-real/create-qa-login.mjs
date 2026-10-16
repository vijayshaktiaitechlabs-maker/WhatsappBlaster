// Creates (or resets) a QA owner login in the STAGING Supabase project and stores it in tools/qa-login.local.json (gitignored).
// STAGING ONLY: refuses to run against the live project.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LIVE_REF = 'ttpecupfolgbbdagkotc';
const c = JSON.parse(readFileSync(ROOT + 'tools/config.local.json', 'utf8')).staging;
const ref = (String(c.supabaseUrl).match(/https:\/\/([a-z0-9]{20})\.supabase\.co/) || [])[1];
if (!ref || ref === LIVE_REF) throw new Error('staging.supabaseUrl is missing or is the LIVE project: refusing');
const base = `https://${ref}.supabase.co`;
const H = { apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}`, 'Content-Type': 'application/json' };
const email = 'qa-bot@example.com';
const password = 'Qa-' + randomBytes(9).toString('base64url');
let r = await fetch(`${base}/auth/v1/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password, email_confirm: true }) });
let u = await r.json();
if (r.status >= 400) {
  const list = await (await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers: H })).json();
  u = (list.users || []).find((x) => x.email === email);
  if (!u) throw new Error('could not create or find the QA user: ' + JSON.stringify(u));
  await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ password, email_confirm: true }) });
}
const [t] = await (await fetch(`${base}/rest/v1/tenants?slug=eq.shakti&select=id`, { headers: H })).json();
r = await fetch(`${base}/rest/v1/app_admins?on_conflict=user_id,tenant_id`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: u.id, tenant_id: t.id, role: 'owner', email }) });
if (r.status >= 300) throw new Error('could not grant the owner role: HTTP ' + r.status);
writeFileSync(ROOT + 'tools/qa-login.local.json', JSON.stringify({ email, password }));
console.log(`QA owner login ready for staging project ${ref}; saved to tools/qa-login.local.json (gitignored).`);
