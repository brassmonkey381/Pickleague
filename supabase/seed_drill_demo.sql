-- Seed drill data for 9 of the 12 demo players (excluding Brian).
-- Today is 2026-05-07 (Thu); rolling window covers 5/07..5/13.

-- Helper: build a 48-slot bool array as jsonb, with `true` at the given slot indices.
create or replace function _drill_seed_day(slots int[]) returns jsonb
language plpgsql as $$
declare
  arr boolean[] := array_fill(false, array[48]);
  i int;
begin
  if slots is not null then
    foreach i in array slots loop
      arr[i+1] := true;  -- pg arrays are 1-indexed
    end loop;
  end if;
  return to_jsonb(arr);
end;
$$;

-- ── 1. Marcus Rivera (1084) — "The Coach" ────────────────────
-- Weeknight evenings 6-9pm + weekend mornings 9-11am
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[36,37,38,39,40,41]),
    '2026-05-08', _drill_seed_day(array[36,37,38,39,40,41]),
    '2026-05-09', _drill_seed_day(array[18,19,20,21]),
    '2026-05-10', _drill_seed_day(array[18,19,20,21]),
    '2026-05-11', _drill_seed_day(array[36,37,38,39,40,41]),
    '2026-05-12', _drill_seed_day(array[36,37,38,39,40,41]),
    '2026-05-13', _drill_seed_day(array[36,37,38,39,40,41])
  ),
  drill_shot_prefs    = array['dinks-cross','third-shot-drop','resets','volleys-kitchen','footwork'],
  drill_partner_prefs = array['similar-level','intense','regular','feedback','drills-only'],
  drill_custom_tags   = array['left-handed','former tennis player']
where username = 'marcusrivera';

-- ── 2. Sarah Chen (1048) — "Early Bird Grinder" ──────────────
-- Every morning 6:30-8:30am (consistent grinder)
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[13,14,15,16]),
    '2026-05-08', _drill_seed_day(array[13,14,15,16]),
    '2026-05-09', _drill_seed_day(array[13,14,15,16]),
    '2026-05-10', _drill_seed_day(array[13,14,15,16]),
    '2026-05-11', _drill_seed_day(array[13,14,15,16]),
    '2026-05-12', _drill_seed_day(array[13,14,15,16]),
    '2026-05-13', _drill_seed_day(array[13,14,15,16])
  ),
  drill_shot_prefs    = array['dinks-cross','dinks-straight','third-shot-drop','resets','footwork'],
  drill_partner_prefs = array['similar-level','intense','regular'],
  drill_custom_tags   = array['early bird','no smashing','iced coffee mandatory']
where username = 'sarahchen';

-- ── 3. Priya Patel (1034) — "The Strategist" ─────────────────
-- Weeknights 7-9pm + Sat afternoon 1-4pm
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[38,39,40,41]),
    '2026-05-08', _drill_seed_day(array[38,39,40,41]),
    '2026-05-09', _drill_seed_day(array[26,27,28,29,30,31]),
    '2026-05-10', _drill_seed_day(array[]::int[]),
    '2026-05-11', _drill_seed_day(array[38,39,40,41]),
    '2026-05-12', _drill_seed_day(array[38,39,40,41]),
    '2026-05-13', _drill_seed_day(array[38,39,40,41])
  ),
  drill_shot_prefs    = array['third-shot-drop','third-shot-drive','stacking','erne-atp','live-balls'],
  drill_partner_prefs = array['higher-level','feedback','mix','doubles-focus'],
  drill_custom_tags   = array['stack on left','loves cross-court battles']
where username = 'priyapatel';

-- ── 4. Derek Thompson (1020) — "The Volleyer" ────────────────
-- Weekends only 10am-2pm
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[]::int[]),
    '2026-05-08', _drill_seed_day(array[]::int[]),
    '2026-05-09', _drill_seed_day(array[20,21,22,23,24,25,26,27]),
    '2026-05-10', _drill_seed_day(array[20,21,22,23,24,25,26,27]),
    '2026-05-11', _drill_seed_day(array[]::int[]),
    '2026-05-12', _drill_seed_day(array[]::int[]),
    '2026-05-13', _drill_seed_day(array[]::int[])
  ),
  drill_shot_prefs    = array['volleys-kitchen','volleys-transit','lobs-defense','returns-deep'],
  drill_partner_prefs = array['similar-level','casual','mix','drills-only'],
  drill_custom_tags   = array['knee surgery — no diving','prefer hard courts']
where username = 'derekthompson';

-- ── 5. Kevin Okafor (1009) — "Power Player" ──────────────────
-- Tue/Thu 6-8pm + Sat 8-10am
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[36,37,38,39]),
    '2026-05-08', _drill_seed_day(array[]::int[]),
    '2026-05-09', _drill_seed_day(array[16,17,18,19]),
    '2026-05-10', _drill_seed_day(array[]::int[]),
    '2026-05-11', _drill_seed_day(array[]::int[]),
    '2026-05-12', _drill_seed_day(array[36,37,38,39]),
    '2026-05-13', _drill_seed_day(array[]::int[])
  ),
  drill_shot_prefs    = array['serves','third-shot-drive','lobs-offense','fitness','live-balls'],
  drill_partner_prefs = array['similar-level','intense'],
  drill_custom_tags   = array['high-energy only','competitive','let''s sweat']
where username = 'kevinokafor';

-- ── 6. Ashley Nguyen (992) — "All-Rounder" ───────────────────
-- MWF lunch 11:30am-1pm + Sat 9-11am
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[]::int[]),
    '2026-05-08', _drill_seed_day(array[23,24,25]),
    '2026-05-09', _drill_seed_day(array[18,19,20,21]),
    '2026-05-10', _drill_seed_day(array[]::int[]),
    '2026-05-11', _drill_seed_day(array[23,24,25]),
    '2026-05-12', _drill_seed_day(array[]::int[]),
    '2026-05-13', _drill_seed_day(array[23,24,25])
  ),
  drill_shot_prefs    = array['dinks-cross','third-shot-drop','volleys-kitchen','shadow','footwork'],
  drill_partner_prefs = array['similar-level','casual','regular','mix'],
  drill_custom_tags   = array['lunch break drills','can bring extra paddles']
where username = 'ashleynguyen';

-- ── 7. Lauren Summers (965) — "The Learner" ──────────────────
-- Saturday all-day 9am-5pm
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[]::int[]),
    '2026-05-08', _drill_seed_day(array[]::int[]),
    '2026-05-09', _drill_seed_day(array[18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33]),
    '2026-05-10', _drill_seed_day(array[]::int[]),
    '2026-05-11', _drill_seed_day(array[]::int[]),
    '2026-05-12', _drill_seed_day(array[]::int[]),
    '2026-05-13', _drill_seed_day(array[]::int[])
  ),
  drill_shot_prefs    = array['dinks-cross','dinks-straight','third-shot-drop','resets','returns-deep'],
  drill_partner_prefs = array['higher-level','feedback','casual','drills-only'],
  drill_custom_tags   = array['newer player — patient please','want to improve','I bring snacks']
where username = 'laurensummers';

-- ── 8. Carlos Mendez (943) — "Weekend Warrior" ───────────────
-- Sat 9am-12pm + 2-5pm; Sun 10am-12pm + 2-4pm
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[]::int[]),
    '2026-05-08', _drill_seed_day(array[]::int[]),
    '2026-05-09', _drill_seed_day(array[18,19,20,21,22,23,28,29,30,31,32,33]),
    '2026-05-10', _drill_seed_day(array[20,21,22,23,28,29,30,31]),
    '2026-05-11', _drill_seed_day(array[]::int[]),
    '2026-05-12', _drill_seed_day(array[]::int[]),
    '2026-05-13', _drill_seed_day(array[]::int[])
  ),
  drill_shot_prefs    = array['serves','returns-deep','third-shot-drive','live-balls','fitness'],
  drill_partner_prefs = array['similar-level','casual','one-off','mix'],
  drill_custom_tags   = array['weekends only','bring water','open to driving 30min']
where username = 'carlosmendez';

-- ── 9. Megan Foster (923) — "Afternoon Improver" ─────────────
-- Weekday afternoons 2-4pm (kids napping)
update public.profiles set
  drilling_enabled = true,
  drill_availability = jsonb_build_object(
    '2026-05-07', _drill_seed_day(array[28,29,30,31]),
    '2026-05-08', _drill_seed_day(array[28,29,30,31]),
    '2026-05-09', _drill_seed_day(array[]::int[]),
    '2026-05-10', _drill_seed_day(array[]::int[]),
    '2026-05-11', _drill_seed_day(array[28,29,30,31]),
    '2026-05-12', _drill_seed_day(array[28,29,30,31]),
    '2026-05-13', _drill_seed_day(array[28,29,30,31])
  ),
  drill_shot_prefs    = array['dinks-cross','dinks-straight','resets','shadow','footwork'],
  drill_partner_prefs = array['similar-level','lower-level','casual','regular','drills-only'],
  drill_custom_tags   = array['stay-at-home parent','nap-time drills','quiet courts only']
where username = 'meganfoster';

-- Tyler Brooks, Rachel Kim, Jordan Williams remain drilling_enabled=false (default)

drop function _drill_seed_day(int[]);
