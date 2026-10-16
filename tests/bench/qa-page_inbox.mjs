// QA fixes, group page_inbox: WhatsApp Inbox behaviour and the phone/tablet layout of the admin page.
// Local bench only (in-memory database with the staging SQL, staging-built page in Edge, simulated WhatsApp).
// Run after `node tools/build-staging.mjs`:  node tests/bench/qa-page_inbox.mjs
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { benchDb, openBrowser, watch, login, sleep, PHONE } from './browser-setup.mjs';

const OUT = fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (area, test, ok, evidence = '') => { results.push({ area, test, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${area} | ${test} | ${String(evidence).slice(0, 240)}`); };
const { db, q, T, users, staff } = await benchDb();
const desk = staff.find((s) => s.email === 'qa-desk@club.test');
const DIYA = '910000000002', KABIR = '910000000003', LEAD_NEW = '919812344444', LEAD_OLD = '919812366666', GUJ = '919812377777';

// ---- seed: two leads (no member), a member with a very long tier and name, large dues for the KPI cards
const ins = (phone, dir, body, at) => q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values ($1,$2,$3,$4, coalesce($5::timestamptz, now()))`, [T, phone, dir, body, at || null]);
await ins(LEAD_NEW, 'in', 'I want to become a member');
await ins(LEAD_OLD, 'in', 'Lead, 2 days ago', new Date(Date.now() - 2 * 86400000).toISOString());
await q(`insert into public.members (tenant_id, full_name, phone, membership_no, membership_tier, status, wa_opt_in, dues_amount)
  values ($1, 'જયેશભાઈ રમણલાલ પટેલ ચંદ્રકાંત', $2, 'QA-GUJ', 'Platinum Lifetime Family Plus', 'active', true, 12355500)`, [T, GUJ]);
await ins(GUJ, 'in', 'નમસ્તે');

const { browser, context, fake } = await openBrowser(db, users, { width: 1280, height: 900 });
const outRows = async (key) => Number((await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and phone_key=$2 and direction='out'`, [T, key]))[0].n);
const conv = async (key) => (await q(`select * from public.wa_conversations where tenant_id=$1 and phone_key=$2`, [T, key]))[0];
const txt = async (p, sel) => ((await p.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const waitFor = (p, fn, arg, ms = 8000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const openChat = async (p, key) => { await p.evaluate((k) => { go('inbox'); return selectChat(k); }, key); await sleep(900); };
const pickTpl = async (p, prefix) => {
  await waitFor(p, () => !!document.querySelector('#inboxTplSelect'), null, 10000);
  const v = await p.$$eval('#inboxTplSelect option', (els, pre) => (els.map((e) => e.value).find((x) => x.startsWith(pre)) || ''), prefix);
  await p.selectOption('#inboxTplSelect', v); await sleep(400);
  return v;
};
const check = async (area, test, fn) => { try { await fn(); } catch (e) { rec(area, test, false, 'script error: ' + e.message.split('\n')[0]); } };

const page = await context.newPage();
const issues = watch(page);
await login(page, 'qa-owner@club.test');

// ---------- inbox-01: a member added from the Inbox is shown at once (header, Customer 360, list), also after a reload
await check('Member link', 'a member added from Customer 360 shows in the open chat at once', async () => {
  await openChat(page, LEAD_NEW);
  await page.click('#ctxProfileContent button:has-text("Add as")'); await sleep(400);
  await page.fill('#f_full_name', 'Late Joiner QA'); await page.click('#mSave'); await sleep(1800);
  const h = await txt(page, '#activeChatName'), ctx = await txt(page, '#ctxProfileContent'), li = await txt(page, '.inbox-item.active .inbox-item-name');
  rec('Member link', 'a member added from Customer 360 shows in the open chat at once', h === 'Late Joiner QA' && !/Not in the/.test(ctx) && /Late Joiner QA/.test(ctx) && li === 'Late Joiner QA', `header "${h}", list "${li}", 360 "${ctx.slice(0, 70)}"`);
});
await check('Member link', 'after a reload the chat still shows the member (matched by phone)', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await fake.attach(ctx2);
  const p2 = await ctx2.newPage(); watch(p2); await login(p2, 'qa-owner@club.test');
  await openChat(p2, LEAD_NEW);
  const h = await txt(p2, '#activeChatName'), ctx = await txt(p2, '#ctxProfileContent');
  rec('Member link', 'after a reload the chat still shows the member (matched by phone)', h === 'Late Joiner QA' && !/Add as/.test(ctx), `header "${h}", 360 "${ctx.slice(0, 60)}"`);
  await ctx2.close();
});

// ---------- inbox-02: no member -> the name blank stays empty, never "+91"
await check('Templates', 'a chat without a member: the name blank stays empty (no "+91")', async () => {
  await openChat(page, LEAD_OLD);
  await pickTpl(page, 'dues_reminder|');
  const first = await page.locator('#inboxTplPanel .inbox-tpl-grid input, #inboxTplPanel .inbox-tpl-grid textarea').first().inputValue();
  const pv = await txt(page, '#inboxTplPreview');
  rec('Templates', 'a chat without a member: the name blank stays empty (no "+91")', first === '' && !/\+91/.test(pv), `first blank "${first}", preview "${pv.slice(0, 60)}"`);
});

// ---------- inbox-03: typing in a template blank survives the 30-second refresh and live updates
await check('Composer', 'typing in a template blank survives the 30-second refresh and a live update', async () => {
  await openChat(page, KABIR);
  await pickTpl(page, 'dues_reminder|');
  const box = page.locator('#inboxTplPanel .inbox-tpl-grid input, #inboxTplPanel .inbox-tpl-grid textarea').nth(3);
  await box.click(); await page.keyboard.type('Please clear the dues ');
  await page.evaluate(() => { update24hWindowBanner(); onConversationChange({ ...ACTIVE_CHAT }); });
  await sleep(300);
  await page.keyboard.type('at the office.');
  const r = await page.evaluate(() => { const els = document.querySelectorAll('#inboxTplPanel .inbox-tpl-grid input, #inboxTplPanel .inbox-tpl-grid textarea'); return { v: els[3] && els[3].value, focus: document.activeElement === els[3], p: INBOX_TPL && INBOX_TPL.params[3] }; });
  rec('Composer', 'typing in a template blank survives the 30-second refresh and a live update', r.v === 'Please clear the dues at the office.' && r.focus && r.p === r.v, JSON.stringify(r));
});

// ---------- inbox-04 / inbox-05: text longer than WhatsApp allows is refused before sending, nothing is cut silently
await check('Long text', 'a reply over 4,096 characters (1,024 with an image) and a note over 4,000 are refused', async () => {
  await openChat(page, DIYA);
  const before = await outRows(DIYA);
  const [{ n: notesBefore }] = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and direction='note'`, [T]);
  await page.fill('#inboxReplyInput', 'a'.repeat(5000)); await page.click('#inboxSendBtn'); await sleep(700);
  const t1 = await txt(page, '#toast'); const kept1 = (await page.inputValue('#inboxReplyInput')).length;
  await page.evaluate(() => { INBOX_ATTACHED_IMAGE = 'https://example.test/qa.jpg'; });
  await page.fill('#inboxReplyInput', 'b'.repeat(2000)); await page.click('#inboxSendBtn'); await sleep(700);
  const t2 = await txt(page, '#toast');
  await page.evaluate(() => clearInboxAttachment());
  await page.evaluate(() => setComposerMode('note'));
  await page.fill('#inboxReplyInput', 'n'.repeat(4500)); await page.click('#inboxSendBtn'); await sleep(700);
  const t3 = await txt(page, '#toast');
  await page.fill('#inboxReplyInput', ''); await page.evaluate(() => setComposerMode('reply'));
  const after = await outRows(DIYA);
  const [{ n: notesAfter }] = await q(`select count(*)::int n from public.wa_messages where tenant_id=$1 and direction='note'`, [T]);
  rec('Long text', 'a reply over 4,096 characters is refused, the text stays in the box', /4,096/.test(t1) && kept1 === 5000, `toast "${t1}"`);
  rec('Long text', 'a reply with an image over 1,024 characters is refused', /1,024/.test(t2), `toast "${t2}"`);
  rec('Long text', 'an internal note over 4,000 characters is refused', /4,000/.test(t3) && notesAfter === notesBefore, `toast "${t3}"`);
  rec('Long text', 'nothing was sent or stored for the refused texts', after === before && notesAfter === notesBefore, `out ${before}->${after}, notes ${notesBefore}->${notesAfter}`);
});

// ---------- inbox-06: after a reconnect every missed message of the open chat is loaded
await check('Live updates', 'after a reconnect all 70 missed messages appear, newest last', async () => {
  await openChat(page, DIYA);
  await page.evaluate(() => { try { sb.removeChannel(THREAD_SUB); } catch (e) {} THREAD_SUB = null; });
  await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) select $1, $2, 'in', 'burst ' || g, now() + make_interval(secs => g) from generate_series(1, 70) g`, [T, DIYA]);
  await page.evaluate(() => syncThreadNewest()); await sleep(1500);
  const b = await page.$$eval('#inboxMessageScroll .inbox-bubble-text', (els) => els.map((e) => e.textContent.trim()).filter((x) => /^burst \d+$/.test(x)));
  rec('Live updates', 'after a reconnect all 70 missed messages appear, newest last', b.length === 70 && b[b.length - 1] === 'burst 70', `${b.length} shown; newest "${(b[b.length - 1] || '').slice(0, 30)}"`);
  await page.evaluate(() => { THREAD_SUB_KEY = null; subscribeThread(ACTIVE_KEY); });
});

// ---------- inbox-07: Customer 360 "Conversation" card follows assignment
await check('Customer 360', 'the Conversation card shows the new assignee at once', async () => {
  await openChat(page, DIYA);
  await page.evaluate((id) => assignActiveChat(id), desk.id); await sleep(1000);
  const c = await txt(page, '#ctxProfileContent');
  rec('Customer 360', 'the Conversation card shows the new assignee at once', /Assigned to\s*qa-desk/.test(c), c.slice(c.indexOf('Conversation'), c.indexOf('Conversation') + 80));
});

// ---------- inbox-08: coming back to the Inbox with the chat open marks the new message read
await check('Unread', 'returning to the Inbox with the chat open marks the new message read', async () => {
  await openChat(page, DIYA); await sleep(500);
  await page.evaluate(() => go('members')); await sleep(300);
  await ins(DIYA, 'in', 'Message while staff are on Members'); await sleep(1500);
  const seen = await page.evaluate(() => ACTIVE_CHAT.unread_count);
  await page.evaluate(() => go('inbox')); await sleep(1500);
  const c = await conv(DIYA);
  rec('Unread', 'returning to the Inbox with the chat open marks the new message read', seen >= 1 && c.unread_count === 0, `unread seen by page ${seen}, in database after return ${c.unread_count}`);
});

// ---------- mobile_a11y-08: Escape closes the Inbox menus; conversation rows can be reached with the keyboard
await check('Keyboard', 'Escape closes the Bot menu; conversation rows are focusable and open with Enter', async () => {
  await openChat(page, DIYA);
  await page.click('#activeChatBotBtn'); await sleep(200);
  const open = await page.isVisible('#inboxBotMenu');
  await page.keyboard.press('Escape'); await sleep(200);
  const closed = !(await page.isVisible('#inboxBotMenu'));
  const row = page.locator(`.inbox-item:has-text("Kabir")`).first();
  const tab = await row.getAttribute('tabindex');
  await row.focus(); await page.keyboard.press('Enter'); await sleep(900);
  const k = await page.evaluate(() => ACTIVE_KEY);
  rec('Keyboard', 'Escape closes the Bot menu; conversation rows are focusable and open with Enter', open && closed && tab === '0' && k === '910000000003', `menu open ${open}, closed ${closed}, tabindex ${tab}, opened ${k}`);
});

// ---------- inbox-09: server says the window closed -> the banner says "more than 24 hours ago"
await check('24h window', 'window closed between opening and sending: the banner names the real reason', async () => {
  await openChat(page, DIYA);
  await page.evaluate(() => { window.__post = inboxPost; inboxPost = async (b) => (b.inbox_reply ? { ok: false, window_closed: true, error: 'The 24-hour window has closed.' } : window.__post(b)); });
  await page.fill('#inboxReplyInput', 'Hello'); await page.click('#inboxSendBtn'); await sleep(900);
  const s = await page.evaluate(() => ({ banner: document.getElementById('inboxWindowNoticeText').textContent, tpl: document.getElementById('chkSendAsTemplate').checked, at: ACTIVE_CHAT.last_inbound_at }));
  await page.evaluate(() => { inboxPost = window.__post; });
  rec('24h window', 'window closed between opening and sending: the banner names the real reason', /more than 24 hours/.test(s.banner) && s.tpl && !!s.at, JSON.stringify(s).slice(0, 200));
});

// ---------- mobile_a11y-04: Customer 360 opens and closes at 1024x768
await check('Tablet', 'Customer 360 opens and closes at 1024x768', async () => {
  await page.setViewportSize({ width: 1024, height: 768 }); await sleep(400);
  await openChat(page, DIYA);
  const w = async () => page.evaluate(() => { const el = document.getElementById('inboxRightPanel'); const r = el.getBoundingClientRect(); return getComputedStyle(el).display === 'none' ? 0 : Math.round(r.width); });
  const w0 = await w(); await page.click('#btnToggleContext'); await sleep(400); const w1 = await w(); await page.click('#btnToggleContext'); await sleep(400); const w2 = await w();
  const chat = await page.evaluate(() => Math.round(document.getElementById('inboxMain').getBoundingClientRect().width));
  rec('Tablet', 'Customer 360 opens and closes at 1024x768', w0 === 0 && w1 >= 280 && w2 === 0 && chat > 400, `panel ${w0} / ${w1} / ${w2}, chat ${chat}px`);
  await page.setViewportSize({ width: 1280, height: 900 });
});
rec('Page health', 'desktop session: no script errors', !issues.page.length, issues.page.join(' | ') || 'none');

// ---------- phones
async function phone(width, height, fn) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true }); await fake.attach(ctx);
  const p = await ctx.newPage(); const iss = watch(p);
  await login(p, 'qa-owner@club.test');
  try { await fn(p); } finally { rec('Page health', `${width}x${height}: no script errors`, !iss.page.length, iss.page.join(' | ') || 'none'); await ctx.close(); }
}
const sendReach = (p) => p.evaluate(() => {
  window.scrollTo(0, document.documentElement.scrollHeight);
  const b = document.getElementById('inboxSendBtn'), card = document.getElementById('composerCard');
  const r = b.getBoundingClientRect(), c = card.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: innerHeight, vw: innerWidth,
    hit: !!hit && b.contains(hit), inCard: r.left >= c.left - 1 && r.right <= c.right + 1, footerFits: (() => { const f = document.querySelector('.inbox-comp-footer'); return f.scrollWidth <= f.clientWidth + 1; })(),
    body: Math.round(document.getElementById('inboxMessageScroll').getBoundingClientRect().height) };
});
const fillDues = async (p) => {
  await pickTpl(p, 'dues_reminder|');
  const inputs = p.locator('#inboxTplPanel .inbox-tpl-grid input, #inboxTplPanel .inbox-tpl-grid textarea');
  await inputs.nth(1).fill('2nd year (2026-27)'); await inputs.nth(2).fill('₹29,500'); await inputs.nth(3).fill('Please clear the dues at the office.');
};

await check('Phone', '360x740: Send template is on screen and sends', () => phone(360, 740, async (p) => {
  await openChat(p, KABIR); await fillDues(p);
  const r = await sendReach(p);
  const before = await outRows(KABIR);
  if (r.hit) { await p.mouse.click((r.left + r.right) / 2, (r.top + r.bottom) / 2); await sleep(1800); }
  const after = await outRows(KABIR);
  await p.screenshot({ path: OUT + 'qa-inbox-360-template.png' });
  rec('Phone', '360x740: Send template is on screen and sends', r.hit && r.bottom <= r.vh && after === before + 1 && r.body >= 100, `send ${r.top}-${r.bottom} of ${r.vh}, hit ${r.hit}, messages area ${r.body}px, sent ${after - before}`);
  rec('Phone', '360x740: the composer footer fits; Send is fully inside the composer', r.footerFits && r.inCard, JSON.stringify({ footerFits: r.footerFits, inCard: r.inCard }));
  // reply mode (window open)
  await openChat(p, DIYA);
  const r2 = await sendReach(p);
  rec('Phone', '360x740: reply Send is on screen and fully inside the composer', r2.hit && r2.bottom <= r2.vh && r2.inCard && r2.footerFits, JSON.stringify(r2));
  // mobile_a11y-10: fields are 16px so iOS does not zoom
  const fs = await p.evaluate(() => ['#inboxReplyInput', '#activeChatAssignee'].map((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize)));
  rec('Phone', 'text fields are at least 16px on phones', fs.every((x) => x >= 16), fs.join(', '));
  // mobile_a11y-09: touch targets in the Inbox
  const tgt = await p.evaluate(() => ({ mode: Math.round(document.getElementById('tabNoteMode').getBoundingClientRect().height), chk: Math.round(document.getElementById('chkSendAsTemplate').getBoundingClientRect().height) }));
  rec('Phone', 'Inbox touch targets: mode buttons 30px+, template checkbox 20px', tgt.mode >= 30 && tgt.chk >= 20, JSON.stringify(tgt));
  // mobile_a11y-05: Payments fits the screen
  await p.evaluate(() => go('payments')); await sleep(800);
  const pw = await p.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth }));
  rec('Phone', '360: Payments and Dues fits the screen (no sideways scroll)', pw.iw === 360 && pw.sw <= 361, JSON.stringify(pw));
}));

await check('Phone', '390x844 with the bot paused: Send template is on screen and sends', async () => {
  await q(`update public.wa_conversations set bot_paused=true where tenant_id=$1 and phone_key=$2`, [T, KABIR]);
  await phone(390, 844, async (p) => {
    await openChat(p, KABIR); await fillDues(p);
    const r = await sendReach(p);
    const before = await outRows(KABIR);
    if (r.hit) { await p.mouse.click((r.left + r.right) / 2, (r.top + r.bottom) / 2); await sleep(1800); }
    const after = await outRows(KABIR);
    rec('Phone', '390x844 with the bot paused: Send template is on screen and sends', r.hit && r.bottom <= r.vh && after === before + 1, `send ${r.top}-${r.bottom} of ${r.vh}, hit ${r.hit}, sent ${after - before}`);
    // mobile_a11y-03: Customer 360 opens as a full-screen sheet and closes again; the chat stays full width
    const chatW = await p.evaluate(() => Math.round(document.getElementById('inboxMain').getBoundingClientRect().width));
    await p.click('#inboxThreadView .inbox-ctx-btn'); await sleep(400);
    const open = await p.evaluate(() => { const el = document.getElementById('inboxRightPanel'); const r = el.getBoundingClientRect(); const x = document.elementFromPoint(r.left + r.width / 2, r.top + 40); return { w: Math.round(r.width), vis: getComputedStyle(el).display !== 'none', top: !!x && el.contains(x), txt: el.textContent.includes('Kabir') }; });
    await p.click('#inboxRightPanel .inbox-context-h button'); await sleep(400);
    const closed = await p.evaluate(() => getComputedStyle(document.getElementById('inboxRightPanel')).display === 'none');
    const chatW2 = await p.evaluate(() => Math.round(document.getElementById('inboxMain').getBoundingClientRect().width));
    rec('Phone', '390: Customer 360 opens full screen over the chat and closes; the chat stays full width', open.vis && open.w >= 380 && open.top && open.txt && closed && chatW === 390 && chatW2 === 390, JSON.stringify({ chatW, open, closed, chatW2 }));
    // mobile_a11y-13: a long tier and name stay inside the header
    await openChat(p, GUJ);
    const hd = await p.evaluate(() => ['#activeChatTier', '#activeChatPhone', '#activeChatName'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().right)));
    rec('Phone', '390: a long tier and name stay inside the chat header', hd.every((x) => x <= 390), hd.join(', '));
    await p.click('.inbox-back'); await sleep(300);
    const back = await p.isVisible('.inbox-sidebar');
    rec('Phone', '390: Back returns to the list', back, String(back));
    // mobile_a11y-06: KPI amounts in crores fit their cards
    await p.evaluate(() => go('dash')); await sleep(800);
    const kpi = await p.evaluate(() => [...document.querySelectorAll('.stat .v')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    rec('Phone', '390: KPI amounts fit their cards', !kpi.length, kpi.join(' | ') || 'all fit');
    // mobile_a11y-11: the top bar is not hidden under the sticky nav bar
    await p.evaluate(() => go('members')); await sleep(500);
    await p.evaluate(() => window.scrollTo(0, 500)); await sleep(300);
    const tb = await p.evaluate(() => { const b = document.getElementById('logout'); const r = b.getBoundingClientRect(); if (r.bottom <= 0) return 'scrolled away'; const x = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return x && b.contains(x) ? 'visible' : 'covered'; });
    rec('Phone', '390: the top bar is not covered by the nav bar when scrolled', tb !== 'covered', tb);
    // mobile_a11y-12: Settings "Save changes" is reachable at the bottom of the page
    await p.evaluate(() => go('settings')); await sleep(800);
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(300);
    const sv = await p.evaluate(() => { const b = document.getElementById('setSave'); const r = b.getBoundingClientRect(); const x = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { top: Math.round(r.top), hit: !!x && b.contains(x) }; });
    rec('Phone', '390: Settings "Save changes" is on screen at the bottom of the page', sv.hit && sv.top >= 0 && sv.top < 844, JSON.stringify(sv));
  });
});

await check('Tablet', '768x1024: Send template is on screen', () => phone(768, 1024, async (p) => {
  await openChat(p, KABIR); await fillDues(p);
  const r = await sendReach(p);
  rec('Tablet', '768x1024: Send template is on screen', r.hit && r.bottom <= r.vh, `send ${r.top}-${r.bottom} of ${r.vh}`);
}));

rec('Bench', 'every database request was one the stand-in supports', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('Bench', 'no request went to a live (non-staging) webhook', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
const failed = results.filter((r) => !r.ok);
fake.stop(); await browser.close();
if (failed.length) { console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`); process.exit(1); }
console.log(`\nAll ${results.length} page_inbox checks passed.`);
process.exit(0);
