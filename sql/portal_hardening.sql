-- ============================================================
--  MEMBER PORTAL HARDENING  (QA fixes, run after shakti_portal.sql)
--  Safe to run more than once. Changes only row-level security
--  policies: no table, column or data is touched.
--
--  1. A signed-in member can no longer update their own member row.
--     The old "member updates own" policy let a member set their own
--     dues, paid-till date, guest passes, tier, notes, flag and even
--     move the row to another club. The portal never updates members
--     (it only reads its own row), so nothing in the portal changes.
--     Staff keep editing members through "admin manages members".
--  2. A member can only create bookings in the club of their own
--     member row, as 'confirmed', with no negative guests, a party of
--     at least 1 and a date from today on.
--  3. A member can only register for an OPEN event of their own club,
--     under their own name and phone, as 'registered' (the capacity
--     trigger may still turn it into 'waitlist').
--  Staff inserts go through the "admin manages ..." policies and are
--  not affected. n8n uses the service role key, which bypasses RLS.
-- ============================================================

-- ---------- 1. members: no self-update ----------
drop policy if exists "member updates own" on public.members;

-- ---------- 2. bookings: own club, confirmed, sane numbers ----------
drop policy if exists "own bookings insert" on public.bookings;
create policy "own bookings insert" on public.bookings
  for insert with check (
    exists (select 1 from public.members m
             where m.id = bookings.member_id
               and m.user_id = auth.uid()
               and m.tenant_id = bookings.tenant_id)
    and status = 'confirmed'
    and kind in ('court', 'cafe')
    and coalesce(guests, 0) >= 0
    and (party_size is null or party_size >= 1)
    and booking_date >= current_date
  );

-- ---------- 3. event registrations: own club, open event, own name ----------
drop policy if exists "own regs insert" on public.event_registrations;
create policy "own regs insert" on public.event_registrations
  for insert with check (
    exists (select 1 from public.members m
             where m.id = event_registrations.member_id
               and m.user_id = auth.uid()
               and m.tenant_id = event_registrations.tenant_id
               and m.full_name is not distinct from event_registrations.name
               -- the same number in any format (10 digits, +91, 91…): the portal stores it as 91 + 10 digits like the bot
               and public.wa_phone_key(m.phone) = public.wa_phone_key(event_registrations.phone))
    and exists (select 1 from public.events e
                 where e.id = event_registrations.event_id
                   and e.tenant_id = event_registrations.tenant_id
                   and e.is_open)
    and status in ('registered', 'waitlist')
  );
