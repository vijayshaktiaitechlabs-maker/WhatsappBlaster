// Shared setup for browser tests on the local bench: in-memory staging database (real SQL + test data),
// two staff logins, extra conversations for paging, and the staging-built admin page in Edge.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { makeDb, cfg, B } from './harness.mjs';
import { fakeSupabase, prepareRealtime } from './fakesupa.mjs';

export const PAGE_FILE = B + 'web/admin/index.html';
export const APP = 'http://qa.local';
export const PHONE = String(cfg.testPhones[0]).replace(/\D/g, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function benchDb() {
  const db = await makeDb();
  await prepareRealtime(db);
  const q = async (s, p) => (await db.query(s, p)).rows;
  const [{ id: T }] = await q(`select id from public.tenants where slug='shakti'`);
  const staff = await q(`insert into auth.users (email) values ('qa-owner@club.test'),('qa-desk@club.test'),('qa-accounts@club.test') returning id, email`);
  await q(`insert into public.app_admins (user_id, tenant_id, role, email) values ($1,$4,'owner','qa-owner@club.test'),($2,$4,'front_desk','qa-desk@club.test'),($3,$4,'accounts','qa-accounts@club.test')`, [staff[0].id, staff[1].id, staff[2].id, T]);
  const users = Object.fromEntries(staff.map((s) => [s.email, { id: s.id, password: 'bench-pass' }]));
  return { db, q, T, users, staff };
}

export async function openBrowser(db, users, { width = 1440, height = 950, context: ctxOpts = {} } = {}) {
  const fake = fakeSupabase(db, { users, pageFile: () => readFileSync(PAGE_FILE, 'utf8'), appOrigin: APP });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, ...ctxOpts });
  await fake.attach(context);
  return { browser, context, fake };
}

export function watch(page) {
  const issues = { console: [], page: [], network: [], dialogs: [] };
  page.on('console', (m) => { if (m.type() === 'error') issues.console.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => issues.page.push(String(e.message || e).slice(0, 240)));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon|storage\/v1/.test(r.url())) issues.network.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`); });
  page.on('dialog', async (d) => { issues.dialogs.push(d.message()); await d.accept(); });
  return issues;
}

export async function login(page, email) {
  await page.goto(APP + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#email', email); await page.fill('#password', 'bench-pass'); await page.click('#authBtn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  await page.waitForFunction(() => typeof INBOX_READY !== 'undefined' && INBOX_READY !== null, null, { timeout: 30000 }).catch(() => {});
  await sleep(800);
}
