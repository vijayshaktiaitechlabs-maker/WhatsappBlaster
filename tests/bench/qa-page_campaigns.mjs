// Regression checks for the QA findings fixed in the Campaigns page and the custom template manager
// (admin-panel/index.html). Staging-built page in Edge on the local bench; nothing external is called.
//   templates-1  "{{ 1 }}" is normalised to "{{1}}" before it is stored or sent to Meta
//   templates-2  closing the composer closes the template editor; a new campaign never inherits it
//   templates-3  a dropped connection during Submit can be retried (no false "already exists")
//   templates-4  a removed template's name can be used again
//   templates-5  "+ New template" / "Edit" ask before discarding unsaved changes
//   templates-6  changing an approved template's variable default is used by new campaigns
//   templates-7  the editor shows the category Meta approved; an unchanged save stays Approved
//   templates-8  a template's WhatsApp name is never written into the card's click handler as code
//   campaigns-02 sheet rows of CRM members who are not opted in are flagged before sending
//   campaigns-03 no col_N copies in sheet rows; an open report of a tracked campaign doesn't re-read the row
//   campaigns-05 "Paid & current" leaves out members with no paid-till date (same rule as the server)
//   campaigns-06 sheet headers / sample values are text in the variable dropdown; a quote keeps its column
import { benchDb, openBrowser, watch, login, sleep, PHONE } from './browser-setup.mjs';

const results = [];
const rec = (id, test, ok, evidence = '') => { results.push({ id, test, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${id} | ${test} | ${String(evidence).slice(0, 240)}`); };
const { q, T, users, db } = await benchDb();
const { browser, context, fake } = await openBrowser(db, users);
const page = await context.newPage();
const issues = watch(page);
const t = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const waitFor = async (fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const row = async (name) => (await q(`select * from public.wa_custom_templates where tenant_id=$1 and name=$2`, [T, name]))[0];
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const asked = (d0, re = /unsaved changes/) => issues.dialogs.slice(d0).some((x) => re.test(x));
const newTpl = async (name, body, open) => {
  await page.evaluate(() => { if (CT_EDIT) CT_EDIT._snap = null; ctNew(); }); await sleep(250);
  await page.fill('#ct_name', name); if (open !== undefined) await page.fill('#ct_open', open);
  await page.fill('#ct_body', body); await sleep(250);
};
const reloadGrid = () => page.evaluate(async () => { await ctReload(); renderTemplates(); });

/* test-only switches for the webhook: drop the next template submission, or answer a status check */
let dropSubmit = false, statusAnswer = null;
await page.route('**/webhook/stg-broadcast-send', async (route) => {
  const body = route.request().postData() || '';
  if (dropSubmit && /"tpl_submit":true/.test(body)) { dropSubmit = false; return route.abort('connectionreset'); }
  if (statusAnswer && /"tpl_status":true/.test(body)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusAnswer) });
  return route.fallback();
});

try {
  await login(page, 'qa-owner@club.test');
  await page.evaluate(() => { go('broadcasts'); newCampaign(); }); await sleep(800);

  // ---------- templates-1: spaces inside the braces
  await newTpl('QA Spaces', 'Your court {{ 2 }} booking is confirmed.', 'Hi {{ 1 }},');
  await page.locator('#ctVarRows .var-row').nth(1).locator('input').nth(1).fill('Court 5'); await sleep(200);
  const ed = await page.evaluate(() => ({ composed: ctCompose(ctDraft()), issues: ctIssues(ctDraft()), keys: ctVarKeys(ctCompose(ctDraft())) }));
  const sub0 = (await q(`select count(*)::int n from public.stg_outbox where kind='meta_template_submit'`))[0].n;
  await page.click('#ctSubmitBtn');
  let r = await until(async () => { const x = await row('QA Spaces'); return x && x.meta_status === 'PENDING' ? x : null; });
  await waitFor(() => CT_EDIT === null && document.getElementById('ctSubmitBtn').textContent.startsWith('Submit to'));
  const [sp] = await q(`select payload from public.stg_outbox where kind='meta_template_submit' order by id desc limit 1`);
  const sentText = sp ? JSON.stringify(sp.payload) : '';
  rec('templates-1', '"{{ 1 }}" / "{{ 2 }}" are stored and submitted to Meta as {{1}} / {{2}}',
    /^Hi \{\{1\}\},/.test(ed.composed) && !ed.issues.length && ed.keys.join() === '1,2' && !!r && /^Hi \{\{1\}\},[\s\S]*\{\{2\}\} booking/.test(r.pending.text)
      && (await q(`select count(*)::int n from public.stg_outbox where kind='meta_template_submit'`))[0].n === sub0 + 1 && /\{\{1\}\}/.test(sentText) && !/\{\{\s+\d/.test(sentText),
    `editor "${ed.composed.slice(0, 40)}"; stored "${r && r.pending.text.slice(0, 40)}"; Meta got spaces: ${/\{\{\s+\d/.test(sentText)}`);

  // ---------- templates-5: unsaved changes are not discarded silently
  await newTpl('QA Unsaved A', 'Important text that is not saved yet.');
  let d0 = issues.dialogs.length;
  await page.click('#tplGrid .tpl-card:has-text("New template")'); await sleep(300);
  const askNew = asked(d0);
  await page.fill('#ct_name', 'QA Unsaved B'); await page.fill('#ct_body', 'Second unsaved text.'); await sleep(150);
  d0 = issues.dialogs.length;
  await page.locator('#tplGrid .tpl-card', { hasText: 'QA Spaces' }).locator('button:has-text("Edit")').click(); await sleep(300);
  const askEdit = asked(d0);
  rec('templates-5', '"+ New template" and "✎ Edit" of another template ask before discarding unsaved changes', askNew && askEdit, `asked on New ${askNew}, on Edit ${askEdit}`);
  await page.evaluate(() => { if (CT_EDIT) { CT_EDIT._snap = null; ctCancel(); } });

  // ---------- templates-2: leaving the composer with the editor open
  await newTpl('QA Left open', 'Left open when leaving the composer.');
  d0 = issues.dialogs.length;
  await page.click('button.cmp-back'); await sleep(300);
  const askBack = asked(d0);
  const afterBack = await page.evaluate(() => ({ open: CT_EDIT !== null, list: !document.getElementById('bcList').classList.contains('hidden') }));
  await page.evaluate(() => newCampaign()); await sleep(500);
  await page.evaluate(() => ctNew()); await sleep(200);
  await page.evaluate(() => newCampaign()); await sleep(500); /* a composer opened with the editor still open (e.g. via navigation) */
  let s = await page.evaluate(() => ({ open: CT_EDIT !== null, visible: !document.getElementById('ctEditor').classList.contains('hidden'), varBoxHidden: document.getElementById('varBox').classList.contains('hidden'), blocked: msgIssues().filter((x) => /Close the template editor/.test(x)).length }));
  rec('templates-2', '"← All campaigns" asks about the unsaved template and closes it; a new campaign starts without the editor', askBack && !afterBack.open && afterBack.list && !s.open && !s.visible && !s.varBoxHidden && !s.blocked,
    `asked ${askBack}; after back ${JSON.stringify(afterBack)}; next campaign ${JSON.stringify(s)}`);

  // ---------- templates-3: dropped connection during Submit, then Submit again
  await newTpl('QA Net fail', 'Network test.');
  const pe0 = issues.page.length;
  dropSubmit = true;
  await page.click('#ctSubmitBtn'); await sleep(1500);
  const t1 = await t('#toast');
  const b1 = await page.evaluate(() => ({ btn: ctSubmitBtn.textContent, dis: ctSubmitBtn.disabled, id: CT_EDIT && CT_EDIT.id }));
  await page.click('#ctSubmitBtn');
  r = await until(async () => { const x = await row('QA Net fail'); return x && x.meta_status === 'PENDING' ? x : null; });
  await waitFor(() => CT_EDIT === null && document.getElementById('ctSubmitBtn').textContent.startsWith('Submit to'));
  const t2 = await t('#toast');
  const nNet = (await q(`select count(*)::int n from public.wa_custom_templates where tenant_id=$1 and name='QA Net fail'`, [T]))[0].n;
  rec('templates-3', 'after a dropped connection during Submit, the page says so and pressing Submit again submits the same row', !!r && nNet === 1 && !/already exists/.test(t2) && /Couldn't reach the server/.test(t1) && !b1.dis && !!b1.id && issues.page.length === pe0,
    `first toast "${t1.slice(0, 60)}"; second "${t2.slice(0, 50)}"; rows ${nNet}; status ${r && r.meta_status}; page errors ${JSON.stringify(issues.page.slice(pe0))}`);

  // ---------- templates-4: a removed template's name can be used again
  await newTpl('QA Dup', 'Pool timings changed.');
  await page.click('#ctDraftBtn'); await sleep(800);
  const dupId = (await row('QA Dup')).id;
  await page.locator('#tplGrid .tpl-card', { hasText: 'QA Dup' }).locator('button.danger').click(); await sleep(900);
  await newTpl('QA Dup', 'A fresh template with the old name.');
  await page.click('#ctDraftBtn'); await sleep(900);
  const reuseToast = await t('#toast');
  const dups = await q(`select id, name, status from public.wa_custom_templates where tenant_id=$1 and name like 'QA Dup%' order by created_at`, [T]);
  rec('templates-4', 'after removing "QA Dup", a new template named "QA Dup" can be saved (the archived row gave its name up)',
    !/already exists/.test(reuseToast) && dups.length === 2 && dups.find((x) => x.id === dupId).status === 'archived' && /^QA Dup \(removed /.test(dups.find((x) => x.id === dupId).name) && dups.some((x) => x.name === 'QA Dup' && x.status === 'active'),
    `toast "${reuseToast}"; rows ${JSON.stringify(dups.map((x) => x.name + ':' + x.status))}`);

  // ---------- approved templates written straight into the database (as Meta approval would leave them)
  const ver = (meta, text, cat, vars) => JSON.stringify([{ meta_name: meta, category: cat, lang: 'en', text, vars, has_image: false, image_url: null, approved_at: new Date().toISOString() }]);
  const v1 = [{ k: '1', label: 'Locker', def: 'custom', example: 'L-12' }];
  await q(`insert into public.wa_custom_templates (tenant_id, name, opening, body, signature, use_signature, category, vars, meta_status, versions)
    values ($1,'QA Var default','','Your locker {{1}} is ready.','',false,'MARKETING',$2,'APPROVED',$3),
           ($1,'QA Reclass','','Your booking {{1}} is confirmed.','',false,'UTILITY',$2,'APPROVED',$4),
           ($1,'QA Evil name','','Hello there.','',false,'MARKETING','[]','APPROVED',$5),
           ($1,'QA Pending','','Pending text {{1}} here.','',false,'UTILITY',$2,'PENDING','[]')`,
  [T, JSON.stringify(v1), ver('qa_var_default_x1', 'Your locker {{1}} is ready.', 'MARKETING', v1), ver('qa_reclass_x1', 'Your booking {{1}} is confirmed.', 'MARKETING', v1), ver("x');window.__pwnMeta=1;//", 'Hello there.', 'MARKETING', [])]);
  await q(`update public.wa_custom_templates set pending=$2, submitted_at=now() where tenant_id=$1 and name='QA Pending'`, [T, JSON.stringify({ meta_name: 'qa_pending_x1', category: 'UTILITY', lang: 'en', text: 'Pending text {{1}} here.', vars: v1, has_image: false })]);
  await reloadGrid(); await sleep(300);

  // ---------- templates-6: an approved template's variable default
  const vd = await row('QA Var default');
  await page.evaluate((id) => ctEditTpl(id), vd.id); await sleep(300);
  await page.locator('#ctVarRows .var-row').nth(0).locator('select').selectOption('membership_no'); await sleep(150);
  await page.click('#ctDraftBtn'); await sleep(900);
  r = await row('QA Var default');
  await page.evaluate(() => pickTpl('qa_var_default_x1')); await sleep(300);
  s = await page.evaluate(() => CMP.vars['1']);
  rec('templates-6', 'a changed variable default on an approved template (same text) is saved into the approved version and used by new campaigns', r.meta_status === 'APPROVED' && r.versions[0].vars[0].def === 'membership_no' && s && s.src === 'membership_no',
    `status ${r.meta_status}; approved var ${JSON.stringify(r.versions[0].vars[0])}; campaign gets ${JSON.stringify(s)}`);

  // ---------- templates-7: Meta reclassified UTILITY as MARKETING
  const rc = await row('QA Reclass');
  await page.evaluate((id) => ctEditTpl(id), rc.id); await sleep(300);
  const catShown = await page.inputValue('#ct_cat');
  await page.click('#ctDraftBtn'); await sleep(900);
  r = await row('QA Reclass');
  const pd = await row('QA Pending');
  statusAnswer = { ok: true, found: true, status: 'APPROVED', category: 'MARKETING' };
  await page.evaluate((id) => ctCheck(id), pd.id); await sleep(900);
  statusAnswer = null;
  const pd2 = await row('QA Pending');
  rec('templates-7', 'the editor shows the category Meta approved, an unchanged save stays Approved, and an approval stores Meta\'s category on the template',
    catShown === 'MARKETING' && r.meta_status === 'APPROVED' && pd2.meta_status === 'APPROVED' && pd2.category === 'MARKETING' && pd2.versions[0].category === 'MARKETING',
    `editor "${catShown}"; after save ${r.meta_status}; checked: ${pd2.meta_status} ${pd2.category}`);

  // ---------- templates-8: a crafted WhatsApp name in a stored version
  await reloadGrid(); await sleep(200);
  await page.locator('#tplGrid .tpl-card', { hasText: 'QA Evil name' }).click(); await sleep(300);
  s = await page.evaluate(() => ({ pwn: window.__pwnMeta === 1, tpl: CMP.tpl }));
  rec('templates-8', 'a stored WhatsApp name with quotes and script is passed as data, never run', !s.pwn && s.tpl === "x');window.__pwnMeta=1;//", JSON.stringify(s));
  await page.evaluate(() => pickTpl('club_custom_broadcast'));

  // ---------- campaigns-05: "Paid & current" and members with no paid-till date
  s = await page.evaluate(() => {
    setAudSource('crm');
    const m = { id: 'qa-nodate', full_name: 'No Date (QA)', phone: '919812345678', status: 'active', wa_opt_in: true, dues_amount: null, maintenance_paid_till: null, membership_tier: 'Gold' };
    MEMBERS.push(m);
    const paid = resolveAudience({ status: '', dues: 'paid', tiers: [] }).some((x) => x === m);
    const any = resolveAudience({ status: '', dues: '', tiers: [] }).some((x) => x === m);
    MEMBERS.pop();
    return { paid, any };
  });
  rec('campaigns-05', '"Paid & current" leaves out a member with no paid-till date (the server does too); "Any" keeps them', !s.paid && s.any, JSON.stringify(s));

  // ---------- campaigns-06 + campaigns-03 (col_N): sheet headers with markup and a quote
  await page.evaluate(() => { closeComposer(); newCampaign(); }); await sleep(500);
  await page.evaluate(() => setAudSource('sheet')); await sleep(200);
  const evilHdr = '</select><img src=x onerror=window.__pwnHdr=1>';
  await page.setInputFiles('#sheetFile', { name: 'evil.csv', mimeType: 'text/csv', buffer: Buffer.from(`Name,Mobile,"Due ""Amt""",${evilHdr}\nRahul Shah,${PHONE},₹500,</select><hr>\n`) }); await sleep(1200);
  await page.evaluate(() => pickTpl('dues_reminder')); await sleep(400);
  const sel3 = page.locator('#varBox select:not(.var-insert)').nth(2);   /* the blank's own dropdown, not the "Insert a field" picker */
  await sel3.selectOption('col:Due "Amt"'); await sleep(300);
  s = await page.evaluate(() => ({ pwn: window.__pwnHdr === 1, imgs: document.querySelectorAll('#varBox img').length, hrs: document.querySelectorAll('#varBox hr').length,
    stray: document.querySelectorAll('#varBox option:not(select option)').length, v3: CMP.vars['3'], selVal: document.querySelectorAll('#varBox select:not(.var-insert)')[2].value,
    pickTxt: [...document.querySelectorAll('#varBox select.var-insert option')].map((o) => o.textContent).filter((x) => /onerror/.test(x)).length, pickEls: document.querySelectorAll('#varBox select.var-insert *:not(option)').length,
    colKeys: Object.keys(CMP.customRecipients[0].row_cols).filter((k) => /^col_\d+$/.test(k)).length, due: CMP.customRecipients[0].row_cols['Due "Amt"'] }));
  rec('campaigns-06', 'markup in a sheet header / sample value is shown as text, and a header with a double quote maps to its column', !s.pwn && !s.imgs && !s.hrs && !s.stray && s.pickTxt >= 1 && s.pickEls === 0 && s.v3.src === 'col:Due "Amt"' && s.selVal === 'col:Due "Amt"',
    JSON.stringify(s));
  rec('campaigns-03', 'sheet rows keep each column once, by header (no col_N copies)', s.colKeys === 0 && s.due === '₹500', `col_N keys ${s.colKeys}; Due "Amt" = ${s.due}`);

  // ---------- campaigns-02: a sheet row of a CRM member who is not opted in (Ananya, seeded with wa_opt_in=false)
  await page.evaluate(() => { closeComposer(); newCampaign(); }); await sleep(500);
  await page.evaluate(() => setAudSource('sheet')); await sleep(200);
  await page.setInputFiles('#sheetFile', { name: 'optout.csv', mimeType: 'text/csv', buffer: Buffer.from(`Name,Mobile,Due\nRahul Shah,${PHONE},₹500\nAnanya Iyer,910000000004,₹900\n`) }); await sleep(1200);
  const info = await t('#sheetInfoBox');
  await page.evaluate(() => { pickTpl('dues_reminder'); setVarSrc('3', 'col:Due'); setVarText('2', '2026-27'); setVarText('4', 'Please clear your dues at the office.'); setVarSrc('5', 'nothing'); }); await sleep(400);
  await page.fill('#c_name', 'QA opt-out sheet');
  d0 = issues.dialogs.length;
  await page.click('#cmpSendBtn');
  await waitFor(() => /Sent to|Nothing was sent|⚠️/.test(document.getElementById('cmpResult').textContent), null, 30000);
  const conf = issues.dialogs.slice(d0).find((x) => /recipient\(s\) now\?/.test(x)) || '';
  rec('campaigns-02', 'the sheet info and the send confirmation both flag the row of a CRM member who is not opted in', /1 row\(s\) have the number of a CRM member who is not opted in/.test(info) && /Ananya Iyer/.test(info) && /1 of them has the number of a CRM member who is NOT opted in/.test(conf),
    `info "${info.slice(info.indexOf('row(s) have') - 3, info.indexOf('row(s) have') + 90)}"; confirm "${conf.replace(/\n+/g, ' / ').slice(0, 160)}"; result "${await t('#cmpResult')}"; toast "${await t('#toast')}"`);

  // ---------- campaigns-03: an open report of a sent, tracked campaign doesn't download the campaign row every 15 s
  const [bc] = await q(`select id, status, body from public.broadcasts where tenant_id=$1 and title='QA opt-out sheet'`, [T]);
  /* Meta's "delivered" status as the status workflow records it */
  const sentRec = (JSON.parse(bc.body).recipients || []).find((x) => x.wamid);
  if (sentRec) await q(`insert into public.wa_message_status (wamid, tenant_id, broadcast_id, phone, status, sent_at, delivered_at) values ($1,$2,$3,$4,'delivered',now(),now()) on conflict (wamid) do nothing`, [sentRec.wamid, T, bc.id, String(sentRec.phone || '')]);
  const tracked = (await q(`select count(*)::int n from public.wa_message_status where broadcast_id=$1`, [bc.id]))[0].n;
  await page.evaluate(() => refresh(['broadcasts'])); await sleep(500);
  let rowReads = 0;
  const onReq = (rq) => { if (/\/rest\/v1\/broadcasts\?/.test(rq.url()) && /id=eq\./.test(rq.url())) rowReads++; };
  page.on('request', onReq);
  await page.evaluate((id) => { if (CMP) closeComposer(); openReport(id); }, bc.id);
  await sleep(16500);
  page.off('request', onReq);
  const repTxt = await t('#reportBody');
  rec('campaigns-03', 'an open report of a sent campaign with status rows refreshes from the status table only (no full campaign re-read)', bc.status === 'sent' && tracked > 0 && rowReads === 0 && /Rahul/.test(repTxt),
    `status ${bc.status}; status rows ${tracked}; campaign re-reads in 16 s: ${rowReads}`);
  await page.evaluate(() => closeReport());
} catch (e) {
  rec('run', 'finished without a script error', false, e.stack || e.message);
}
rec('run', 'no script errors on the page', !issues.page.length, issues.page.join(' | ') || 'none');
rec('run', 'every database request was supported by the stand-in', !fake.log.unsupported.length, fake.log.unsupported.slice(0, 5).join(' | ') || 'all supported');
rec('run', 'no live webhook was called', !fake.log.webhooks.some((w) => /BLOCKED/.test(w)), 'ok');
fake.stop(); await browser.close();
const bad = results.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} page_campaigns checks passed on the local bench.`);
process.exit(bad.length ? 1 : 0);
