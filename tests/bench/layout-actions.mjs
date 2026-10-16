// Row buttons (Report / Duplicate, View / Edit / Delete) must be visible without sideways scrolling, at common window widths.
import { benchDb, openBrowser, watch, login, sleep } from './browser-setup.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const { db, q, T, users } = await benchDb();
await q(`insert into public.broadcasts (tenant_id, title, audience, template_name, status, sent_count, body)
  select $1, 'Maintenance_28Sept_T' || g, 'Sheet: Family Membership_Maintenance_Oct26.xlsx (158)', 'dues_reminder', case when g % 3 = 0 then 'draft' else 'sent' end, 158, '{}' from generate_series(1, 6) g`, [T]);
let fail = 0;
const say = (ok, what, ev) => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${what} | ${ev}`); };
for (const width of [1100, 1280, 1366, 1512, 1920]) {
  const { browser, context } = await openBrowser(db, users, { width, height: 850 });
  const page = await context.newPage(); const issues = watch(page);
  await login(page, 'qa-owner@club.test');
  for (const [view, tbl, labels] of [['members', '#memTbl', ['View', 'Edit', 'Delete']], ['broadcasts', '#bcTbl', ['Report', 'Duplicate']]]) {
    await page.evaluate((v) => go(v), view); await sleep(900);
    const r = await page.evaluate(({ tbl, labels }) => {
      const vw = document.documentElement.clientWidth;
      const row = [...document.querySelectorAll(tbl + ' tbody tr')].find((tr) => labels.every((l) => [...tr.querySelectorAll('.row-actions button')].some((b) => b.textContent.trim() === l)));
      if (!row) return { found: false };
      const wrap = row.closest('.tbl-wrap').getBoundingClientRect();
      const btns = [...row.querySelectorAll('.row-actions button')].map((b) => { const x = b.getBoundingClientRect(); const top = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2); return { l: b.textContent.trim(), right: Math.round(x.right), inside: x.right <= Math.min(vw, wrap.right) + 1 && x.left >= wrap.left, clickable: top === b }; });
      const w = row.closest('.tbl-wrap'); return { found: true, vw, pageScroll: document.documentElement.scrollWidth > vw, overflow: w.scrollWidth - w.clientWidth, btns };
    }, { tbl, labels });
    say(r.found && !r.pageScroll && r.btns.every((b) => b.inside && b.clickable), `${width}px ${view}: every row button is in view and clickable, no sideways page scroll`, (r.btns || []).map((b) => b.l + '@' + b.right).join(' '));
    if (width >= 1280) say(r.found && r.overflow <= 0, `${width}px ${view}: the whole row fits, nothing hidden behind the buttons`, 'table wider than its frame by ' + r.overflow + 'px');
    await page.screenshot({ path: `${OUT}layout-${view}-${width}.png` });
  }
  say(issues.page.length === 0, `${width}px: no script errors`, issues.page.join("; ") || "none");
  await browser.close();
}
console.log(fail ? `${fail} layout checks FAILED` : 'All layout checks passed.');
process.exit(fail ? 1 : 0);
