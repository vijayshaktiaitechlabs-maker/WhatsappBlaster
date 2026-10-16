// QA regression checks for the Bookings, Check-in, Events, Registrations, Dashboard and Reports code of the
// admin page (group page_ops). Real staging-built page in Edge (India time zone), in-memory staging database
// with real RLS, and Supabase's 1,000-rows-per-request limit emulated.
//   node tests/bench/qa-page_ops.mjs        (after node tools/build-staging.mjs)
import { readFileSync } from 'node:fs';
import { benchDb, openBrowser, watch, login, sleep, PHONE } from './browser-setup.mjs';

let n = 0; const fails = [];
const ok = (cond, what, ev = '') => { n++; console.log(`${cond ? 'PASS' : 'FAIL'} | ${what}${ev !== '' ? ' | ' + String(ev).slice(0, 240) : ''}`); if (!cond) fails.push(what); };

const { db, q, T, users } = await benchDb();
const one = async (s, p) => (await q(s, p))[0];

// ---------- seed
const [{ id: M1 }] = await q(`select id from public.members where tenant_id=$1 and phone=$2`, [T, PHONE]);
await q(`insert into public.members (tenant_id, full_name, phone, membership_no, status, wa_opt_in, dues_amount)
  values ($1,'QA Form Phone','+91 98250 12345','QA-201','active',true,0),
         ($1,'QA No Phone','','QA-202','active',true,0),
         ($1,'QA Crore Dues','919812300001','QA-203','active',false,25000000.10)`, [T]);
// more than 1,000 payments and check-ins (one request returns at most 1,000)
await q(`insert into public.payments (tenant_id, member_id, amount, method, purpose, paid_at, created_by)
  select $1, $2, 100, 'cash', 'cafe', now() - make_interval(hours => g*6), 'qa' from generate_series(1,1050) g`, [T, M1]);
await q(`insert into public.attendance (tenant_id, member_id, kind, checked_in_at, created_by)
  select $1, $2, 'visit', now() - make_interval(mins => g*25), 'qa' from generate_series(1,1100) g`, [T, M1]);
// events: 1 seat held by an old-bot 'confirmed' row, one on the waitlist; a finished event still open
const [{ id: EV }] = await q(`insert into public.events (tenant_id,title,kind,starts_at,capacity,fee,is_open) values ($1,'QA Seats','workshop',now()+interval '5 days',1,250000,true) returning id`, [T]);
const [{ id: EV2 }] = await q(`insert into public.events (tenant_id,title,kind,starts_at,capacity,fee,is_open) values ($1,'QA Other','workshop',now()+interval '6 days',10,0,true) returning id`, [T]);
await q(`insert into public.events (tenant_id,title,kind,starts_at,capacity,fee,is_open) values ($1,'QA Past open','workshop',now()-interval '3 days',10,0,true)`, [T]);
await q(`insert into public.event_registrations (tenant_id,event_id,name,phone,status,source) values ($1,$2,'QA legacy','919900000001','confirmed','whatsapp')`, [T, EV]);
await q(`insert into public.event_registrations (tenant_id,event_id,name,phone,status,source) values ($1,$2,'QA wait','919900000002','waitlist','whatsapp')`, [T, EV]);
await q(`insert into public.event_registrations (tenant_id,event_id,name,phone,status,source) values ($1,$2,'QA other reg','919900000003','registered','admin')`, [T, EV2]);
// bookings: one court booking to clash with, plus cancelled / cafe rows that must not count as court use
await q(`insert into public.bookings (tenant_id,member_id,kind,resource,booking_date,slot,status) values
  ($1,$2,'court','Court 5','2026-12-15','18:00-19:00','confirmed'),
  ($1,$2,'court','Court 5','2026-12-14','18:00-19:00','cancelled'),
  ($1,$2,'cafe','Cafe table','2026-12-14','20:00-21:00','confirmed'),
  ($1,null,'court','=HYPERLINK("http://evil.test","Court")','2026-12-20','+1-2','confirmed')`, [T, M1]);
// a campaign: recipient A saved without 91 replies while the campaign is still sending; B wrote before its own message
const now = Date.now(), iso = (ms) => new Date(now - ms * 60000).toISOString();
const body = JSON.stringify({ recipients: [
  { name: 'QA A', phone: '9876500001', wamid: 'wamid.QA.1', status: 'sent', sent_at: iso(40) },
  { name: 'QA B', phone: '919876500002', wamid: 'wamid.QA.2', status: 'sent', sent_at: iso(38) }] });
const [{ id: BC }] = await q(`insert into public.broadcasts (tenant_id,title,template_name,body,status,sent_count,sent_at,created_at) values ($1,'QA Report','t',$2,'sent',2,$3,$4) returning id`, [T, body, iso(30), iso(45)]);
await q(`insert into public.wa_message_status (wamid,tenant_id,broadcast_id,phone,status,sent_at,read_at)
  select 'wamid.QA.' || g, $1, $2, case g when 1 then '919876500001' when 2 then '919876500002' else '9198' || lpad(g::text,8,'0') end, 'read', now()-interval '40 minutes', now()-interval '20 minutes' from generate_series(1,1200) g`, [T, BC]);
await q(`insert into public.wa_messages (tenant_id, phone, direction, body, created_at) values ($1,'919876500001','in','yes please',$2),($1,'919876500002','in','hi',$3)`, [T, iso(35), iso(45)]);

// ---------- browser: India time, Supabase's 1,000-row cap, a switch to make payments reads fail
const { browser, context, fake } = await openBrowser(db, users, { width: 1366, height: 900, context: { timezoneId: 'Asia/Kolkata' } });
let failPayments = false;
const capRoute = (ctx) => ctx.route('**/rest/v1/**', async (route) => {
  const req = route.request(); const u = new URL(req.url());
  if (failPayments && /\/rest\/v1\/payments$/.test(u.pathname) && ['GET', 'HEAD'].includes(req.method())) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"bench: payments unavailable"}' });
  if (['GET', 'HEAD'].includes(req.method()) && !u.pathname.includes('/rpc/')) {
    const lim = u.searchParams.get('limit');
    if (!lim || Number(lim) > 1000) { u.searchParams.set('limit', '1000'); return route.fallback({ url: u.toString() }); }
  }
  return route.fallback();
});
await capRoute(context);
/* another staff login needs its own browser session (a page in the same context shares the login) */
const otherPage = async () => { const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata', acceptDownloads: true }); await fake.attach(ctx); await capRoute(ctx); const p = await ctx.newPage(); p.__ctx = ctx; return p; };
const page = await context.newPage();
const issues = watch(page);
const ev = (fn, arg) => page.evaluate(fn, arg);
const txt = async (sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const download = async (fn, arg) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), ev(fn, arg)]); return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') }; };

try {
  await login(page, 'qa-owner@club.test');

  // ---- dates in India time (bookings_checkin-3, dashboard_reports-14)
  let s = await ev(() => ({ at0200: toISODate(new Date('2026-09-29T20:30:00Z')), today: toISODate(new Date()), local: new Date().toLocaleDateString('en-CA') }));
  ok(s.at0200 === '2026-09-30' && s.today === s.local, 'toISODate gives the India calendar date (02:00 IST on 30 Sep is 30 Sep, not 29 Sep)', JSON.stringify(s));
  await ev(() => { go('bookings'); openBooking(); });
  ok(await page.inputValue('#bk_date') === s.local, 'New booking defaults to today in India time', await page.inputValue('#bk_date'));

  // ---- paging past the 1,000-row cap (bookings_checkin-6, dashboard_reports-02, events_regs-15)
  const dbPay = (await one(`select count(*)::int n from public.payments where tenant_id=$1`, [T])).n;
  const dbAtt = (await one(`select count(*)::int n from public.attendance where tenant_id=$1`, [T])).n;
  s = await ev(() => ({ pay: PAYMENTS.length, att: ATTEND.length, total: ATTEND_TOTAL }));
  ok(s.pay === dbPay && s.att === dbAtt && s.total === dbAtt, 'payments and check-ins load every row past the 1,000-row limit', `page ${JSON.stringify(s)}, database payments ${dbPay}, check-ins ${dbAtt}`);
  await ev(() => go('checkin')); await sleep(300);
  ok((await txt('#ciKpis')).includes('All-time' + dbAtt), 'Check-in All-time shows the database count', await txt('#ciKpis'));

  // ---- court clash on normalised court / slot text and on overlapping times (bookings_checkin-1)
  const tryBook = async (res, date, slot, extra = {}) => {
    await ev(() => { go('bookings'); openBooking(); });
    await page.fill('#bk_resource', res); await page.fill('#bk_date', date); await page.fill('#bk_slot', slot);
    if (extra.guests != null) await page.fill('#bk_guests', String(extra.guests));
    await page.click('#bkSave'); await sleep(900);
    return txt('#bkConflict');
  };
  const court5 = async () => (await one(`select count(*)::int n from public.bookings where tenant_id=$1 and lower(resource)='court 5' and booking_date='2026-12-15' and status='confirmed'`, [T])).n;
  for (const [res, slot] of [['court 5', '18:00-19:00'], ['Court 5', '6:00–7:00 PM'], ['Court 5', '18:00 - 19:00'], ['Court 5', '18:30-19:30'], ['Court 5', '6-7 pm']]) {
    const c = await tryBook(res, '2026-12-15', slot);
    ok(/already booked/.test(c) && await court5() === 1, `"${res}" "${slot}" clashes with Court 5 18:00-19:00 and is not saved`, c);
  }
  await tryBook('Court 5', '2026-12-15', '19:00-20:00');
  ok(await court5() === 2, 'a free slot on the same court is saved', await txt('#toast'));
  let c = await tryBook('Court 5', '2026-12-15', '7-8 PM');
  ok(/already booked/.test(c) && await court5() === 2, '"7-8 PM" clashes with the 19:00-20:00 booking just made', c);
  await tryBook('Court 6', '2026-12-15', '7:00–8:00 PM');
  const c6 = await one(`select slot from public.bookings where tenant_id=$1 and resource='Court 6'`, [T]);
  ok(c6 && c6.slot === '19:00-20:00', 'a 12-hour slot is stored in the portal\'s 24-hour form', c6 && c6.slot);
  // validation (bookings_checkin-7)
  const before = (await one(`select count(*)::int n from public.bookings where tenant_id=$1`, [T])).n;
  c = await tryBook('Court 7', '2026-12-16', '');
  ok(/Pick a court and a slot/.test(c), 'a court booking needs a slot', c);
  c = await tryBook('Court 7', '2026-12-16', '21:00-22:00', { guests: -3 });
  ok(/Guests must be/.test(c), 'negative guests are refused', c);
  c = await tryBook('Court 7', '2026-12-16', '21:00-22:00', { guests: 99999999999 });
  ok(/Guests must be/.test(c), 'an absurd guest count is refused with a clear message (not a database error)', c);
  ok((await one(`select count(*)::int n from public.bookings where tenant_id=$1`, [T])).n === before, 'none of the refused bookings was stored');
  await ev(() => closeModal());
  // walk-in label (bookings_checkin-4, cheap part)
  await ev(() => { $('#bKind').value = ''; $('#bWhen').value = 'all'; if ($('#bDate')) $('#bDate').value = '2026-12-20'; renderBookings(); });
  ok((await txt('#bkTbl tbody')).includes('Walk-in'), 'a booking without a member shows "Walk-in"', await txt('#bkTbl tbody'));
  await ev(() => { if ($('#bDate')) $('#bDate').value = ''; renderBookings(); });

  // ---- CSV exports: BOM, formula-safe cells (bookings_checkin-12, events_regs-10, dashboard_reports-16)
  let d = await download(() => exportCsv('bookings'));
  ok(d.text.charCodeAt(0) === 0xFEFF, 'bookings CSV starts with the UTF-8 marker', d.text.slice(0, 20));
  ok(d.text.includes(`"'=HYPERLINK(""http://evil.test"",""Court"")"`) && d.text.includes(",'+1-2,") && !/,=HYPERLINK/.test(d.text), 'bookings CSV: cells starting with = or + are exported as text', d.text.split('\n').find((l) => l.includes('HYPERLINK')));
  ok(/(^|\n)Walk-in,/.test(d.text), 'bookings CSV names walk-ins');
  d = await download(() => exportReport());
  const today = await ev(() => toISODate(new Date()));
  ok(d.name === `shakti_report_${today}.csv` && d.text.charCodeAt(0) === 0xFEFF, 'summary CSV is named after the club and today (India date)', d.name);
  ok(!/\d\.\d{3,}/.test(d.text) && /Outstanding dues \(INR\),\d+(\.\d{1,2})?\r?\n/.test(d.text), 'summary CSV money has at most 2 decimals', (d.text.match(/Outstanding[^\n]*/) || [''])[0]);
  ok(d.text.includes('Check-ins all-time,' + (dbAtt)), 'summary CSV check-ins all-time is the database count', (d.text.match(/Check-ins[^\n]*/) || [''])[0]);

  // ---- check-in search by phone, expired member, last check-in (bookings_checkin-5, -8, -13)
  await ev(() => go('checkin'));
  for (const [qry, who] of [['98250 12345', 'QA Form Phone'], ['9825012345', 'QA Form Phone'], ['+919825012345', 'QA Form Phone'], [PHONE.slice(-10, -5) + ' ' + PHONE.slice(-5), 'Test Phone 1'], ['+91 ' + PHONE.slice(-10, -5) + ' ' + PHONE.slice(-5), 'Test Phone 1'], ['0' + PHONE.slice(-10), 'Test Phone 1']]) {
    await page.fill('#ciSearch', qry); await sleep(150);
    ok((await txt('#ciResults')).includes(who), `check-in search "${qry}" finds ${who}`, await txt('#ciResults'));
  }
  await page.fill('#ciSearch', 'tst-105'); await sleep(150);
  const dialogs0 = issues.dialogs.length;
  await page.click('#ciResults .ci-row'); await sleep(1200);
  ok(issues.dialogs.length === dialogs0 + 1 && /expired/.test(issues.dialogs[dialogs0] || ''), 'checking in an expired member asks first', issues.dialogs[dialogs0]);
  ok(/membership expired/.test(await txt('#toast')), 'the check-in message says the membership is expired', await txt('#toast'));
  s = await ev(() => MEMBERS.find((m) => m.membership_no === 'TST-105').last_checkin_at);
  ok(!!s, 'the member\'s "Last check-in" updates at once (no reload)', s);

  // ---- events: seats, 'confirmed' rows, waitlist, past, fee format (events_regs-01, -02, -08, -12, dashboard_reports-07)
  await ev(() => go('events'));
  let row = await txt(`#evtTbl tr:has-text("QA Seats")`);
  ok(/1 \/ 1 FULL \+1 waitlist/.test(row), 'Events: an old-bot "confirmed" registration holds the seat (1 / 1 FULL +1 waitlist)', row);
  ok(row.includes('₹2,50,000'), 'Events: fee shown with Indian digit grouping', row);
  ok(/Past/.test(await txt(`#evtTbl tr:has-text("QA Past open")`)), 'Events: a finished event that is still open is marked Past');
  const firstEvt = await txt('#evtTbl tbody tr:first-child td:first-child');
  ok(!/QA Past open/.test(firstEvt), 'Events: upcoming events are listed before finished ones', firstEvt);
  await ev(() => go('dash'));
  row = await txt(`#upEvtTbl tr:has-text("QA Seats")`);
  ok(/1\/1/.test(row) && /\+1 waitlist/.test(row) && !/2\/1/.test(row), 'Dashboard: seats count registered only, waitlist shown apart', row);
  // opt-ins reachable (dashboard_reports-17)
  const reach = (await one(`select count(*)::int n from public.members where tenant_id=$1 and wa_opt_in and coalesce(phone,'')<>''`, [T])).n;
  s = await ev(() => [...document.querySelectorAll('#kpis .stat')].map((e) => e.textContent.replace(/\s+/g, ' ')).find((t) => /opt-ins/.test(t)));
  ok(s && s.includes('opt-ins' + reach), 'Dashboard: WhatsApp opt-ins counts members a campaign can reach', `${s} (database ${reach})`);
  // KPI tiles keep long amounts inside (dashboard_reports-01)
  const spill = async () => ev(() => [...document.querySelectorAll('#kpis .stat .v, #repKpis .stat .v')].filter((v) => v.offsetParent).map((v) => { const r = v.getBoundingClientRect(), p = v.parentElement.getBoundingClientRect(); return { t: v.textContent, over: v.scrollWidth > v.clientWidth + 1 || r.right > p.right + 1 }; }));
  s = await spill();
  ok(s.length >= 5 && s.every((x) => !x.over), 'Dashboard tiles at 1366 px: every amount fits inside its tile', JSON.stringify(s));
  await ev(() => go('reports')); await sleep(400);
  s = await spill();
  ok(s.length >= 4 && s.every((x) => !x.over), 'Reports tiles at 1366 px: every amount fits inside its tile', JSON.stringify(s));
  // reports numbers (bookings_checkin-14, dashboard_reports-08, -07)
  const dow = await q(`select extract(dow from booking_date)::int d, count(*)::int n from public.bookings where tenant_id=$1 and kind='court' and status<>'cancelled' group by 1`, [T]);
  const want = [0, 0, 0, 0, 0, 0, 0]; dow.forEach((r) => { want[r.d] = r.n; });
  s = await ev(() => CHARTS.rUtil && CHARTS.rUtil.data.datasets[0].data);
  ok(JSON.stringify(s) === JSON.stringify(want), 'Reports court utilisation: confirmed court bookings only', `page ${JSON.stringify(s)} database ${JSON.stringify(want)}`);
  const regSeat = (await one(`select count(*)::int n from public.event_registrations where tenant_id=$1 and status in ('registered','confirmed')`, [T])).n;
  ok((await txt('#repKpis')).includes('Event registrations' + regSeat), 'Reports: registrations count seats held (no waitlist)', await txt('#repKpis'));

  // ---- registrations: export follows the filter; promote, cancel (asked, logged), restore (events_regs-09, -04, -13, -07)
  await ev((id) => { go('regs'); $('#rEvent').value = id; renderRegs(); }, EV);
  d = await download(() => exportCsv('regs'));
  const lines = d.text.replace(/^\uFEFF/, '').trim().split('\n');
  ok(lines.length === 3 && d.name.includes('regs_QA_Seats'), 'Registrations CSV has only the rows of the chosen event', `${d.name}: ${lines.length - 1} rows`);
  let dl = issues.dialogs.length;
  await page.click(`#regTbl tr:has-text("QA wait") button:has-text("Move to registered")`); await sleep(900);
  let st = (await one(`select status from public.event_registrations where name='QA wait'`)).status;
  ok(st === 'registered' && /full/.test(issues.dialogs[dl] || ''), 'staff can move a waitlisted person to registered (asked when the event is full)', `${st}; ${issues.dialogs[dl]}`);
  dl = issues.dialogs.length;
  await page.click(`#regTbl tr:has-text("QA legacy") button:has-text("Cancel")`); await sleep(900);
  st = (await one(`select status from public.event_registrations where name='QA legacy'`)).status;
  const aud = (await one(`select count(*)::int n from public.audit_log where tenant_id=$1 and entity='registration' and action='cancelled'`, [T])).n;
  ok(st === 'cancelled' && /Cancel QA legacy/.test(issues.dialogs[dl] || '') && aud === 1, 'cancelling a registration asks first and is logged', `${st}; dialog "${issues.dialogs[dl]}"; audit rows ${aud}`);
  row = await ev(() => { const r = [...document.querySelectorAll('#evtTbl tr')].find((t) => t.textContent.includes('QA Seats')); return r && r.textContent.replace(/\s+/g, ' '); });
  ok(/1 \/ 1 FULL/.test(row) && !/waitlist/.test(row), 'the Events page seat count follows a cancel without a reload', row);
  await page.click(`#regTbl tr:has-text("QA legacy") button:has-text("Restore")`); await sleep(900);
  st = (await one(`select status from public.event_registrations where name='QA legacy'`)).status;
  ok(st === 'waitlist', 'restoring a cancelled registration when the event is full puts it on the waitlist', st);

  // ---- event capacity / fee validation (events_regs-11)
  const evCount = async () => (await one(`select count(*)::int n from public.events where tenant_id=$1 and title like 'QA Bad%'`, [T])).n;
  for (const [cap, fee, msg] of [['0', '', /Capacity must be/], ['-5', '', /Capacity must be/], ['', '-100', /Fee must be/]]) {
    await ev(() => openEvent());
    await page.fill('#e_title', 'QA Bad ' + cap + fee); await page.fill('#e_capacity', cap); await page.fill('#e_fee', fee);
    await page.click('#eSave'); await sleep(600);
    ok(msg.test(await txt('#toast')) && await evCount() === 0, `event with capacity "${cap}" fee "${fee}" is refused`, await txt('#toast'));
  }
  await ev(() => closeModal());

  // ---- campaign report: every status row, replies by phone key, during sending (dashboard_reports-03, -04, -05, -06)
  s = await ev(async (id) => { const b = BROADCASTS.find((x) => x.id === id); const dt = await loadReportData(b); const m = reportModel(b, dt); return { rows: dt.rows.length, replied: m.n.replied, read: m.n.read, a: m.list.find((x) => x.name === 'QA A'), b: m.list.find((x) => x.name === 'QA B') }; }, BC);
  ok(s.rows === 1200 && s.read === 1200, 'campaign report reads all 1,200 status rows (past the 1,000-row limit)', `rows ${s.rows}, read ${s.read}`);
  ok(s.a.replied && s.a.phone === '919876500001' && !s.b.replied && s.replied === 1, 'Replied: a member saved without 91 who wrote back while sending counts; a message sent before the campaign does not', JSON.stringify({ replied: s.replied, a: [s.a.phone, s.a.replied], b: [s.b.phone, s.b.replied] }));
  await ev((id) => { go('broadcasts'); return openReport(id); }, BC); await sleep(500);
  const live0 = await ev(() => !!REPORT_LIVE);
  await page.keyboard.press('Escape'); await sleep(200);
  ok(live0 && await ev(() => REPORT_LIVE === null), 'closing the campaign report with Escape stops its live refresh');
  d = await download((id) => exportCampaignReport(id), BC);
  ok(d.text.charCodeAt(0) === 0xFEFF && /sent_at \(IST\)/.test(d.text) && /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(d.text), 'campaign CSV: UTF-8 marker and India times', d.text.split('\n')[1]);

  // ---- data older than a minute is re-read when the Dashboard opens (dashboard_reports-09)
  await q(`insert into public.payments (tenant_id, member_id, amount, method, purpose, note, paid_at, created_by) values ($1,$2,777,'cash','cafe','QA stale',now(),'other-staff')`, [T, M1]);
  await ev(() => { Object.keys(FRESH).forEach((k) => { FRESH[k] = 1; }); go('reports'); go('dash'); });
  await page.waitForFunction(() => PAYMENTS.some((p) => p.note === 'QA stale'), null, { timeout: 15000 }).catch(() => {});
  ok(await ev(() => PAYMENTS.some((p) => p.note === 'QA stale')), 'Dashboard re-reads payments recorded by other staff when its data is old');

  // ---- a failed read keeps the numbers and says so (dashboard_reports-10)
  const payN = await ev(() => PAYMENTS.length);
  failPayments = true;
  await ev(() => refresh(['payments'])); await sleep(300);
  ok(await ev(() => PAYMENTS.length) === payN && /Could not refresh payments/.test(await txt('#toast')), 'a failed payments refresh keeps the loaded payments and shows an error', `${await ev(() => PAYMENTS.length)} vs ${payN}; ${await txt('#toast')}`);
  const p2 = await otherPage(); const iss2 = watch(p2);
  await login(p2, 'qa-owner@club.test');
  s = await p2.evaluate(() => ({ note: !$('#setupNote').classList.contains('hidden') && $('#setupNote').textContent, has: HAS.payments, fail: [...LOAD_FAIL], tile: [...document.querySelectorAll('#kpis .stat')].map((e) => e.textContent.replace(/\s+/g, ' ')).find((t) => /Collected today/.test(t)) }));
  ok(!s.note && s.has && s.fail.includes('payments') && /—/.test(s.tile || ''), 'payments unreachable at login: no "run setup SQL" note, the tile shows — and the page says it could not load', JSON.stringify(s));
  failPayments = false; await p2.__ctx.close();
  ok(!iss2.page.length, 'no script errors in the failed-load session', iss2.page.join(' | '));

  // ---- roles: accounts gets no booking / check-in quick actions; front desk gets no money amounts (bookings_checkin-10, dashboard_reports-11, -12)
  const p3 = await otherPage(); watch(p3);
  await login(p3, 'qa-accounts@club.test');
  s = await p3.evaluate(() => { openBooking(); return { qa: $('#quickActions').innerHTML, modal: !$('#bookModal').classList.contains('hidden') && $('#overlay').classList.contains('show') }; });
  ok(!/go\('bookings'\)|go\('checkin'\)/.test(s.qa) && !s.modal, 'accounts: no New booking / Check-in quick actions, and the booking form does not open', s.qa.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  await p3.__ctx.close();
  const p4 = await otherPage(); watch(p4);
  await login(p4, 'qa-desk@club.test');
  s = await p4.evaluate(() => $('#kpis').innerHTML);
  ok(!s.includes('₹') && /opt-ins/.test(s), 'front desk: no rupee amounts in the Dashboard tiles (not only hidden)', s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  await p4.__ctx.close();
} catch (e) {
  ok(false, 'the QA run finished without a script error', e.stack || e.message);
}
ok(!issues.page.length, 'owner session: no script errors on the page', issues.page.join(' | ') || 'none');
ok(!fake.log.unsupported.length, 'every database request was one the bench supports', fake.log.unsupported.slice(0, 5).join(' | '));
fake.stop(); await browser.close();
if (fails.length) { console.log(`\n${fails.length} of ${n} page_ops checks FAILED`); process.exit(1); }
console.log(`\nAll ${n} page_ops checks passed.`);
process.exit(0);
