-- Shakti's WhatsApp bot texts, for the bot release of 2026-09-30.
-- DATA change for ONE club (slug 'shakti'); it touches no other club and no table structure.
-- Run it in the staging SQL Editor first; on live only with approval, BEFORE deploying the new bot.
-- Part 1 is REQUIRED before the new bot goes live (without it the AI loses facts it has today).
--
-- Part 1 keeps the AI's wording exactly as today. The old bot had these three sentences written into its
-- code for every club (so TCS and Orena were also called "a premium sports club in Vadodara"). The new bot
-- reads them from each club's own settings instead, so Shakti's settings need them.
-- Part 2 is the new timings asked for on 2026-09-30. They can also be typed in Settings after go-live
-- (Settings > Sports & facilities timings, Maintenance timings, Opening hours); skip Part 2 if you prefer that.
-- Safe to run more than once. Nothing else in the settings changes.

-- Part 1: the AI's description of the club (text copied from the old bot's code)
update public.tenants
set bot_config = jsonb_set(
      coalesce(bot_config, '{}'::jsonb)
        || jsonb_build_object(
             'about', 'A world-class sports & fitness hub for everyone - families, casual players and professional athletes.',
             'membership_access', 'Both the Family and the Individual membership include full access to ALL of the 12+ sporting facilities listed below - not a subset. The only difference between the two is who is covered (Family vs one person) and the annual maintenance fee. Coaching is a separate, optional program.'),
      '{brand,descriptor}', to_jsonb('a premium sports club in Vadodara, India'::text), true)
where slug = 'shakti'
  and coalesce(bot_config->'brand'->>'descriptor', '') = '';

-- Part 2: new timings (Strength & Conditioning 6 AM - 8 PM, Shooting 4 PM - 9 PM, maintenance 12 PM - 3 PM)
update public.tenants t
set bot_config = jsonb_set(
      jsonb_set(t.bot_config, '{facilities}',
        (select coalesce(jsonb_agg(case f->>'name'
                  when 'Strength & Conditioning' then f || '{"timings":"6 AM–8 PM"}'
                  when 'Shooting' then f || jsonb_build_object('timings', '4 PM–9 PM',
                                               'detail', trim(both ' ' from coalesce(nullif(f->>'detail', ''), '10 m range (with coach present)') || ', members only'))
                  else f end order by ord), t.bot_config->'facilities')
         from jsonb_array_elements(t.bot_config->'facilities') with ordinality as x(f, ord))),
      '{maintenance}', '"12 PM – 3 PM"', true)
where t.slug = 'shakti'
  and jsonb_typeof(t.bot_config->'facilities') = 'array'
  and jsonb_array_length(t.bot_config->'facilities') > 0
  and coalesce(t.bot_config->>'maintenance', '') = '';

-- Opening hours line: today it says "Gym from 5:00 AM", which would contradict the new gym timings.
update public.tenants
set bot_config = jsonb_set(bot_config, '{contact,hours}',
      to_jsonb(replace(bot_config->'contact'->>'hours', 'Gym from 5:00 AM', 'Strength & Conditioning 6:00 AM – 8:00 PM')), false)
where slug = 'shakti'
  and bot_config->'contact'->>'hours' like '%Gym from 5:00 AM%';

-- Check (read-only): what the bot will use
select bot_config->'brand'->>'descriptor' as descriptor,
       bot_config->>'maintenance' as maintenance,
       bot_config->'contact'->>'hours' as hours,
       (select string_agg((f->>'name') || ': ' || coalesce(f->>'timings', ''), ' | ')
          from jsonb_array_elements(bot_config->'facilities') f
         where f->>'name' in ('Strength & Conditioning', 'Shooting')) as changed_facilities
from public.tenants where slug = 'shakti';
