-- ============================================================
-- Court schedules, San Francisco (Brian 2026-11-07: outside events and
-- schedules cover the city). Data only; needs migration_court_schedules.sql.
--
-- From marketing-studio's research/pickleague-events/sources.md, "Repeating
-- sessions, San Francisco": times on the organizer's or the city's own page.
-- Directory-only times are left out. Thursday 2026-11-26 is skipped at the rec
-- centers: the city's pages don't show Thanksgiving hours.
--
-- Weekly check: dinksf.com and the city's rec center pages (robots.txt allows
-- them, neither site's home page links terms, 2026-11-07). Star of the Sea's
-- link is dated and Reclub is a platform, so a person checks those. Eventbrite,
-- Bounce, USA Pickleball and the like stay off the list: platforms aren't read.
--
-- Addresses and points: OpenStreetMap Nominatim, 2026-11-07.
-- Safe to re-run.
-- Run: supabase db query --linked -f supabase/migration_court_sessions_sf.sql
-- ============================================================

insert into public.venues (id, sport, name, kind, lat, lng, address, city, source, indoor)
values
  ('curated:star-of-the-sea-gym-sf', array['pickleball'], 'Star of the Sea Gym', 'court',
   37.78121, -122.46702, '4420 Geary Blvd, San Francisco, CA 94118', 'San Francisco', 'curated', true),
  ('curated:mission-rec-center-sf', array['pickleball'], 'Mission Rec Center', 'court',
   37.75821, -122.41253, '2450 Harrison St, San Francisco, CA', 'San Francisco', 'curated', true),
  ('curated:glen-canyon-rec-center-sf', array['pickleball'], 'Glen Canyon Park Rec Center', 'court',
   37.73632, -122.43982, '70 Elk St, San Francisco, CA 94131', 'San Francisco', 'curated', true),
  ('curated:minnie-lovie-ward-rec-center-sf', array['pickleball'], 'Minnie & Lovie Ward Rec Center', 'court',
   37.71619, -122.45896, '650 Capitol Ave, San Francisco, CA', 'San Francisco', 'curated', true),
  ('curated:richmond-rec-center-sf', array['pickleball'], 'Richmond Rec Center', 'court',
   37.78332, -122.47811, '251 18th Ave, San Francisco, CA 94121', 'San Francisco', 'curated', true)
on conflict (id) do nothing;

insert into public.court_schedule_sources (name, url, url_key, method, terms_checked_at, notes)
select v.name, v.url, public._pl_outside_url_key(v.url), v.method, v.terms::timestamptz, v.notes
  from (values
    ('DinkSF', 'https://dinksf.com', 'fetch', '2026-11-07', 'Calendar page, so it changes often. Also the best source of dated clinics.'),
    ('SF Rec & Park: Upper Noe', 'https://sfrecpark.org/Facilities/Facility/Details/Upper-Noe-Rec-Center-112', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Mission', 'https://sfrecpark.org/Facilities/Facility/Details/Mission-Rec-Center-100', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Moscone', 'https://sfrecpark.org/facilities/facility/details/Moscone-Rec-Center-101', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Glen Canyon', 'https://sfrecpark.org/facilities/facility/details/Glen-Park-Rec-Center-89', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Minnie & Lovie Ward', 'https://sfrecpark.org/696/Minnie-Love-Ward-Recreation-Center', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Eureka Valley', 'https://sfrecpark.org/Facilities/Facility/Details/Eureka-Valley-Rec-Center-86', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Richmond', 'https://sfrecpark.org/Facilities/Facility/Details/Richmond-Rec-Center-105', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('SF Rec & Park: Potrero Hill', 'https://sfrecpark.org/Facilities/Facility/Details/Potrero-Hill-Rec-Center-275', 'fetch', '2026-11-07', 'Fall schedule.'),
    ('Star of the Sea Parish', 'https://starparish.com/event/pickleball-for-all-levels/2026-11-11/', 'manual', null, 'Dated link: a person checks it.'),
    ('Fog City Pickleball', 'https://reclub.co/m/OTMM3S', 'manual', null, 'A platform page: a person checks it.')
  ) as v(name, url, method, terms, notes)
on conflict (url_key) do nothing;

insert into public.court_sessions (
  venue_id, title, days, start_time, end_time, level, note, organizer_name,
  source_name, source_url, source_id, valid_to, skip_dates, last_verified_at)
select v.venue_id, v.title, v.days, v.start_time::time, v.end_time::time, v.level, v.note, v.organizer,
       s.name, v.source_url, s.id, v.valid_to::date, v.skip_dates::date[], '2026-11-07'::timestamptz
  from (values
    -- DinkSF
    ('g:ChIJx_pVtMmHhYARpJ_I0M1i0uo', 'Open play', 64, '14:00', '17:30', 'All levels', null, 'DinkSF', 'https://dinksf.com', null, '{}'),
    ('g:ChIJx_pVtMmHhYARpJ_I0M1i0uo', 'Competitive open play', 5, '17:00', '21:00', 'Competitive', null, 'DinkSF', 'https://dinksf.com', null, '{}'),
    ('g:ChIJx_pVtMmHhYARpJ_I0M1i0uo', 'Beginner open play', 8, '18:00', '21:00', 'Beginner, advanced beginner', null, 'DinkSF', 'https://dinksf.com', null, '{}'),
    ('g:ChIJx_pVtMmHhYARpJ_I0M1i0uo', 'Drillmania', 32, '08:30', '10:00', 'Level changes by week', null, 'DinkSF', 'https://dinksf.com', null, '{}'),
    ('g:ChIJx_pVtMmHhYARpJ_I0M1i0uo', 'Next Level Play & Critique', 32, '10:00', '11:30', null, null, 'DinkSF', 'https://dinksf.com', null, '{}'),
    -- Parish and club
    ('curated:star-of-the-sea-gym-sf', 'Pickleball for all levels', 4, '19:00', '21:00', 'All levels', 'With lessons and coaching.', 'Star of the Sea Parish',
     'https://starparish.com/event/pickleball-for-all-levels/2026-11-11/', null, '{}'),
    ('g:ChIJ-RyMqmp9j4AR1Zt8tcS6DOA', 'Fixed partner round robin', 4, '07:00', '09:00', null, null, 'Fog City Pickleball', 'https://reclub.co/m/OTMM3S', null, '{}'),
    -- SF Rec & Park gym drop-ins, fall schedule
    ('g:ChIJv79V5Gh-j4AR2HqHsxbxKHw', 'Gym drop-in', 10, '09:00', '13:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Upper-Noe-Rec-Center-112', '2026-12-31', '{2026-11-26}'),
    ('curated:mission-rec-center-sf', 'Gym drop-in', 2, '11:00', '13:00', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Mission-Rec-Center-100', '2026-12-29', '{}'),
    ('g:ChIJNxP1xp2BhYARkfloln2kY14', 'Gym drop-in', 10, '13:00', '15:00', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/facilities/facility/details/Moscone-Rec-Center-101', '2026-12-31', '{2026-11-26}'),
    ('curated:glen-canyon-rec-center-sf', 'Gym drop-in', 12, '12:30', '14:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/facilities/facility/details/Glen-Park-Rec-Center-89', '2026-12-31', '{2026-11-26}'),
    ('curated:glen-canyon-rec-center-sf', 'Gym drop-in', 16, '16:30', '19:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/facilities/facility/details/Glen-Park-Rec-Center-89', '2026-12-18', '{}'),
    ('curated:minnie-lovie-ward-rec-center-sf', 'Gym drop-in', 4, '16:00', '18:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/696/Minnie-Love-Ward-Recreation-Center', '2026-12-30', '{}'),
    ('g:ChIJ_R532wR-j4ARvUDkjlL7CHk', 'Gym drop-in', 24, '12:00', '15:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Eureka-Valley-Rec-Center-86', '2026-12-31', '{2026-11-26}'),
    ('g:ChIJ_R532wR-j4ARvUDkjlL7CHk', 'Gym drop-in', 16, '17:00', '20:00', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Eureka-Valley-Rec-Center-86', '2026-12-18', '{}'),
    ('curated:richmond-rec-center-sf', 'Gym drop-in', 8, '10:30', '13:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Richmond-Rec-Center-105', '2026-12-31', '{2026-11-26}'),
    ('curated:richmond-rec-center-sf', 'Gym drop-in', 32, '09:30', '13:30', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Richmond-Rec-Center-105', '2026-12-26', '{}'),
    ('g:ChIJzX3PObR_j4ARCM18KXQf8Qk', 'Gym drop-in', 8, '10:00', '12:00', null, 'In the rec center gym.', 'SF Rec & Park',
     'https://sfrecpark.org/Facilities/Facility/Details/Potrero-Hill-Rec-Center-275', '2026-12-31', '{2026-11-26}')
  ) as v(venue_id, title, days, start_time, end_time, level, note, organizer, source_url, valid_to, skip_dates)
  join public.court_schedule_sources s on s.url_key = public._pl_outside_url_key(v.source_url)
 where exists (select 1 from public.venues c where c.id = v.venue_id)
   and not exists (
     select 1 from public.court_sessions x
      where x.venue_id = v.venue_id and x.title = v.title and x.days = v.days);

notify pgrst, 'reload schema';
