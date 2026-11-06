-- ============================================================
-- Outside events (persona tests for migration_outside_events.sql).
--
-- NOT runnable on its own: build-outside-events-test.mjs puts, at the marker
-- line below, migration_home_location.sql and migration_outside_events.sql
-- twice each (they must be re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must keep the events RPCs
-- online). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-outside-events-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction, emails
-- @outside-events.example so they aren't test accounts):
--   OA home location in Alameda (near the events)
--   OB home location in Alameda, reports too
--   OC home location in Sacramento (~110 km away)
--   OD no home location (sets one, then clears it: H4)
--   OE deleted at the end (its RSVP goes with it)
-- GM: the godmode account (is_godmode_user), used for the admin RPCs only;
-- everything it writes is rolled back.
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('OA', 'ab000000-0000-4000-8000-000000000001'), ('OB', 'ab000000-0000-4000-8000-000000000002'),
  ('OC', 'ab000000-0000-4000-8000-000000000003'), ('OD', 'ab000000-0000-4000-8000-000000000004'),
  ('OE', 'ab000000-0000-4000-8000-000000000005');
grant select on _p to authenticated;

create temp table _ev (k text primary key, id uuid);
grant select, insert, update on _ev to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$
  select case when $1 = 'GM' then '252a36e1-5d89-4ad2-8a3e-b786579f019a'::uuid else (select id from _p where k = $1) end
$$;
create function pg_temp.ev(text) returns uuid language sql stable as $$ select id from _ev where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql; null if it went through, else the error's message and hint.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg  text;
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint);
end $$;

-- The ids in a list_outside_events answer.
create function pg_temp.ids(j jsonb) returns uuid[] language sql immutable as $$
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') from jsonb_array_elements(coalesce(j, '[]'::jsonb)) x
$$;

-- An admin save as the godmode account (as_admin afterwards).
create function pg_temp.save(p_key text, p_title text, p_starts timestamptz, p_kinds text[],
                             p_url text, p_lat double precision default 37.7652, p_lng double precision default -122.2416,
                             p_ends timestamptz default null)
returns void language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user(pg_temp.p('GM'));
  v_id := public.admin_save_outside_event(null, p_title, p_starts, p_ends, p_kinds, 'Our own one-line summary.',
            'Alameda Rec', 'Alameda Rec', p_url, 'Test Courts', '2250 Shoreline Dr, Alameda, CA 94501',
            p_lat, p_lng, null);
  perform pg_temp.as_admin();
  insert into _ev values (p_key, v_id) on conflict (k) do update set id = excluded.id;
end $$;

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'oe-' || lower(k) || '@outside-events.example', jsonb_build_object('full_name', 'Event' || k || ' Test')
  from _p;


-- A court about 95 m from the events' point, one about 400 m away.
insert into public.venues (id, sport, name, lat, lng, source)
values ('curated:oe-test-near', '{pickleball}', 'OE Test Near Courts', 37.7660, -122.2420, 'curated'),
       ('curated:oe-test-far',  '{pickleball}', 'OE Test Far Courts',  37.7688, -122.2416, 'curated');

-- @@MIGRATION@@

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  r      jsonb;
  e      jsonb;
  v_id   uuid;
  v_n    integer;
  v_bal  integer;
  v_xp   integer;
  v_k    text;
begin
  -- H1 home locations, set through the RPC (GM's too, for this test only)
  foreach v_k in array array['OA', 'OB', 'OE', 'GM'] loop
    perform pg_temp.as_user(pg_temp.p(v_k));
    r := public.set_my_home_location(37.7700, -122.2500, '2250 Shoreline Dr, Alameda, CA 94501, USA');
    perform pg_temp.as_admin();
  end loop;
  perform pg_temp.ok('H1 a neighborhood like "Alameda, CA"', r ->> 'neighborhood' ~ '^[^,]+, [A-Z]{2}$', r::text);
  perform pg_temp.ok('H1 it is the only part on the profile',
    (select home_neighborhood from public.profiles where id = pg_temp.p('OA')) = r ->> 'neighborhood');
  perform pg_temp.as_user(pg_temp.p('OC'));
  perform public.set_my_home_location(38.5816, -121.4944, null);
  r := public.get_my_home_location();
  perform pg_temp.as_admin();
  perform pg_temp.ok('H2 the owner reads the exact point back',
    (r ->> 'lat')::double precision = 38.5816 and (r ->> 'lng')::double precision = -121.4944, r::text);
  perform pg_temp.as_user(pg_temp.p('OA'));
  e := pg_temp.err(format('select lat from public.profile_home_locations where profile_id = %L', pg_temp.p('OC')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('H3 nobody else can read the point', e is not null, coalesce(e::text, 'read it'));
  perform pg_temp.as_user(pg_temp.p('OD'));
  perform public.set_my_home_location(38.5816, -121.4944, null);
  perform pg_temp.ok('H4 clearing it', public.clear_my_home_location() and public.get_my_home_location() is null);
  e := pg_temp.err('select public.set_my_home_location(95, 0)');
  perform pg_temp.as_admin();
  perform pg_temp.ok('H4 a bad point is refused', e ->> 'hint' = 'pl:home_location.point', e::text);
  perform pg_temp.ok('H4 cleared: no neighborhood', (select home_neighborhood from public.profiles where id = pg_temp.p('OD')) is null);

  -- E1 the launch switch starts off
  perform pg_temp.ok('E1 switch defaults off',
    (select value = 'false'::jsonb from public.app_settings where key = 'outside_events_live'));

  -- E2 admin only
  perform pg_temp.as_user(pg_temp.p('OA'));
  e := pg_temp.err($q$select public.admin_save_outside_event(null, 'X', now() + interval '1 day', null, '{open_play}',
         null, null, 'X', 'https://example.com/x', null, null, null, null, null)$q$);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E2 a player cannot add one', e ->> 'hint' = 'pl:events.admin_only', e::text);

  -- E3 save: kinds tidied, court pinned within 150 m
  perform pg_temp.save('open', 'Saturday open play', date_trunc('hour', now()) + interval '2 days',
                       array['Open_Play', 'open_play ', 'social'], 'https://alameda.example/open-play/');
  select jsonb_build_object('kinds', kinds, 'venue', venue_id, 'by', created_by) into r
    from public.outside_events where id = pg_temp.ev('open');
  perform pg_temp.ok('E3 kinds deduped, order kept', r -> 'kinds' = '["open_play", "social"]'::jsonb, r::text);
  perform pg_temp.ok('E3 pinned to the court within 150 m', r ->> 'venue' = 'curated:oe-test-near', r::text);

  -- E4 refusals
  perform pg_temp.as_user(pg_temp.p('GM'));
  e := pg_temp.err($q$select public.admin_save_outside_event(null, 'Three', now() + interval '1 day', null,
         '{open_play,clinic,ladder}', null, null, 'X', 'https://example.com/three', null, null, null, null, null)$q$);
  perform pg_temp.ok('E4 three kinds refused', e ->> 'hint' = 'pl:events.kinds', e::text);
  e := pg_temp.err($q$select public.admin_save_outside_event(null, 'Odd', now() + interval '1 day', null,
         '{pickleparty}', null, null, 'X', 'https://example.com/odd', null, null, null, null, null)$q$);
  perform pg_temp.ok('E4 unknown kind refused', e ->> 'hint' = 'pl:events.kinds', e::text);
  e := pg_temp.err(format($q$select public.admin_save_outside_event(null, 'Long', now() + interval '1 day', null,
         '{clinic}', %L, null, 'X', 'https://example.com/long', null, null, null, null, null)$q$, repeat('a', 161)));
  perform pg_temp.ok('E4 summary over 160 refused', e ->> 'hint' = 'pl:events.summary', e::text);
  e := pg_temp.err($q$select public.admin_save_outside_event(null, 'Link', now() + interval '1 day', null,
         '{clinic}', null, null, 'X', 'example.com/no-scheme', null, null, null, null, null)$q$);
  perform pg_temp.ok('E4 a link needs https://', e ->> 'hint' = 'pl:events.link', e::text);
  e := pg_temp.err(format($q$select public.admin_save_outside_event(null, 'Dup', %L::timestamptz, null,
         '{clinic}', null, null, 'X', 'HTTPS://alameda.example/open-play', null, null, null, null, null)$q$,
         date_trunc('hour', now()) + interval '2 days'));
  perform pg_temp.ok('E4 same page + start refused', e ->> 'hint' = 'pl:events.duplicate', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E4 the importer skips a duplicate',
    public._pl_save_outside_event(null, 'Dup', date_trunc('hour', now()) + interval '2 days', null, '{clinic}', null, null,
      'X', 'https://alameda.example/open-play', null, null, null, null, null, null, true) is null);

  -- More events: a clinic, one far away, one with no point, past ones.
  perform pg_temp.save('clinic', 'Beginner clinic', now() + interval '3 days', '{clinic}', 'https://club.example/clinic');
  perform pg_temp.ok('E3 the nearest court wins',
    (select venue_id from public.outside_events where id = pg_temp.ev('clinic')) = 'curated:oe-test-near');
  perform pg_temp.save('far', 'Sacramento ladder', now() + interval '3 days', '{ladder}', 'https://sac.example/ladder',
                       38.5800, -121.4900);
  perform pg_temp.ok('E3 no court near: venue null',
    (select venue_id from public.outside_events where id = pg_temp.ev('far')) is null);
  perform pg_temp.save('nopoint', 'Online-listed social', now() + interval '4 days', '{social}', 'https://club.example/social',
                       null, null);
  insert into public.outside_events (title, starts_at, ends_at, kinds, source_name, source_url, lat, lng)
  values ('Ended', now() - interval '3 hours', now() - interval '1 minute', '{open_play}', 'X', 'https://x.example/ended', 37.7652, -122.2416)
  returning id into v_id;
  insert into _ev values ('ended', v_id);
  insert into public.outside_events (title, starts_at, kinds, source_name, source_url, lat, lng)
  values ('Started 2 h ago', now() - interval '2 hours', '{open_play}', 'X', 'https://x.example/two', 37.7652, -122.2416)
  returning id into v_id;
  insert into _ev values ('two_ago', v_id);
  insert into public.outside_events (title, starts_at, kinds, source_name, source_url, lat, lng)
  values ('Started 30 min ago', now() - interval '30 minutes', '{open_play}', 'X', 'https://x.example/thirty', 37.7652, -122.2416)
  returning id into v_id;
  insert into _ev values ('thirty_ago', v_id);

  -- E5 switch off: players see none; godmode sees them
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E5 switch off: a player sees none', jsonb_array_length(r) = 0, r::text);
  perform pg_temp.as_user(pg_temp.p('GM'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E5 switch off: godmode sees them', pg_temp.ev('open') = any (pg_temp.ids(r)));

  update public.app_settings set value = 'true'::jsonb where key = 'outside_events_live';

  -- E6 near / far / no home court / no point; past ones drop out
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E6 Alameda player: the near ones',
    pg_temp.ids(r) @> array[pg_temp.ev('open'), pg_temp.ev('clinic'), pg_temp.ev('nopoint'), pg_temp.ev('thirty_ago')]
    and not pg_temp.ev('far') = any (pg_temp.ids(r)), r::text);
  perform pg_temp.ok('E6 past ones drop out',
    not pg_temp.ids(r) && array[pg_temp.ev('ended'), pg_temp.ev('two_ago')]);
  perform pg_temp.ok('E6 soonest first', (r -> 0 ->> 'id')::uuid = pg_temp.ev('thirty_ago'), r::text);
  perform pg_temp.ok('E6 a row says where it comes from',
    (select x ->> 'source_name' = 'Alameda Rec' and x ->> 'source_url' = 'https://alameda.example/open-play/'
            and x ->> 'venue_name' = 'OE Test Near Courts' and x ->> 'place_name' = 'Test Courts'
            and (x ->> 'seen')::boolean = false and x -> 'my_status' = 'null'::jsonb
       from jsonb_array_elements(r) x where (x ->> 'id')::uuid = pg_temp.ev('open')));
  perform pg_temp.as_user(pg_temp.p('OC'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E6 Sacramento player: the far one and the pointless one only',
    pg_temp.ids(r) @> array[pg_temp.ev('far'), pg_temp.ev('nopoint')] and not pg_temp.ev('open') = any (pg_temp.ids(r)), r::text);
  perform pg_temp.as_user(pg_temp.p('OD'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E6 no home location: all of them',
    pg_temp.ids(r) @> array[pg_temp.ev('open'), pg_temp.ev('far'), pg_temp.ev('nopoint')]);

  -- E7 kinds filter: any of the kinds given
  perform pg_temp.as_user(pg_temp.p('OD'));
  r := public.list_outside_events(array['social']);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E7 social: open (2 kinds) and the social',
    pg_temp.ids(r) @> array[pg_temp.ev('open'), pg_temp.ev('nopoint')]
    and not pg_temp.ids(r) && array[pg_temp.ev('clinic'), pg_temp.ev('far')], r::text);
  perform pg_temp.as_user(pg_temp.p('OD'));
  r := public.list_outside_events(array['clinic', 'ladder']);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E7 clinic or ladder',
    pg_temp.ids(r) @> array[pg_temp.ev('clinic'), pg_temp.ev('far')] and not pg_temp.ev('open') = any (pg_temp.ids(r)), r::text);

  -- E8 Interested: an RSVP maybe, nothing paid; p_mine is the feed's list
  select coalesce(pickles, 0) into v_bal from public.profiles where id = pg_temp.p('OA');
  select count(*) into v_xp from public.reward_track_xp_events where profile_id = pg_temp.p('OA');
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.set_outside_event_rsvp(pg_temp.ev('open'), 'maybe');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 Interested', r = '{"my_status": "maybe", "going_count": 0, "interested_count": 1}'::jsonb, r::text);
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.list_outside_events(null, true);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 the feed list has it', pg_temp.ids(r) = array[pg_temp.ev('open')], r::text);
  perform pg_temp.as_user(pg_temp.p('OB'));
  r := public.list_outside_events(null, true);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 not in someone else''s feed list', jsonb_array_length(r) = 0, r::text);
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.set_outside_event_rsvp(pg_temp.ev('open'), 'going');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 Going', r = '{"my_status": "going", "going_count": 1, "interested_count": 0}'::jsonb, r::text);
  perform pg_temp.ok('E8 no pickles, no pickleballs',
    (select coalesce(pickles, 0) from public.profiles where id = pg_temp.p('OA')) = v_bal
    and (select count(*) from public.reward_track_xp_events where profile_id = pg_temp.p('OA')) = v_xp);
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.set_outside_event_rsvp(pg_temp.ev('open'), null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 cleared', r = '{"my_status": null, "going_count": 0, "interested_count": 0}'::jsonb, r::text);
  perform pg_temp.as_user(pg_temp.p('OA'));
  e := pg_temp.err(format('select public.set_outside_event_rsvp(%L, %L)', pg_temp.ev('ended'), 'maybe'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 a past event can''t be RSVPed', e ->> 'hint' = 'pl:events.gone', e::text);
  perform pg_temp.as_user(pg_temp.p('OC'));
  e := pg_temp.err(format('select public.set_outside_event_rsvp(%L, %L)', pg_temp.ev('open'), 'maybe'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 an event not listed for me can''t be RSVPed', e ->> 'hint' = 'pl:events.gone', e::text);

  -- E9 reports: 2 people hide it, the admins hear each one
  perform pg_temp.as_user(pg_temp.p('OA'));
  perform public.set_outside_event_rsvp(pg_temp.ev('clinic'), 'maybe');
  r := public.report_outside_event(pg_temp.ev('clinic'), 'wrong_time');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 one report: still listed', r ->> 'status' = 'reported' and (r ->> 'hidden')::boolean = false, r::text);
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.report_outside_event(pg_temp.ev('clinic'), 'cancelled');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 the same person again: updated, still 1', r ->> 'status' = 'updated' and (r ->> 'reports')::int = 1, r::text);
  perform pg_temp.as_user(pg_temp.p('OB'));
  r := public.report_outside_event(pg_temp.ev('clinic'), 'cancelled');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 two people: hidden as cancelled',
    (r ->> 'hidden')::boolean and r ->> 'hidden_reason' = 'reported: cancelled', r::text);
  perform pg_temp.ok('E9 each report pushed the admins',
    (select count(*) from public.push_outbox where push_data ->> 'event_id' = pg_temp.ev('clinic')::text
        and recipient_id = pg_temp.p('GM')) = 3);
  perform pg_temp.as_user(pg_temp.p('OB'));
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 hidden: off the list', not pg_temp.ev('clinic') = any (pg_temp.ids(r)));
  perform pg_temp.as_user(pg_temp.p('OA'));
  r := public.get_outside_event(pg_temp.ev('clinic'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 its screen tells the Interested player why',
    r ->> 'hidden_reason' = 'reported: cancelled' and r ->> 'my_report' = 'cancelled', r::text);
  perform pg_temp.as_user(pg_temp.p('OB'));
  r := public.get_outside_event(pg_temp.ev('clinic'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 ...and nobody else', r is null, coalesce(r::text, 'null'));
  perform pg_temp.as_user(pg_temp.p('OB'));
  e := pg_temp.err(format('select public.report_outside_event(%L, %L)', pg_temp.ev('open'), 'spam'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 an unknown reason is refused', e ->> 'hint' = 'pl:events.reason', e::text);

  -- E10 shown again: reports so far are cleared
  perform pg_temp.as_user(pg_temp.p('GM'));
  perform public.admin_set_outside_event_hidden(pg_temp.ev('clinic'), null);
  perform pg_temp.as_admin();
  perform pg_temp.as_user(pg_temp.p('OB'));
  r := public.report_outside_event(pg_temp.ev('clinic'), 'wrong_place');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E10 after showing again, one new report doesn''t hide it',
    (r ->> 'hidden')::boolean = false and (r ->> 'reports')::int = 1, r::text);

  -- E11 takedown: every date from the page, and no re-adding
  perform pg_temp.save('open2', 'Saturday open play', date_trunc('hour', now()) + interval '9 days',
                       '{open_play}', 'https://alameda.example/open-play');
  perform pg_temp.as_user(pg_temp.p('GM'));
  v_n := public.admin_set_outside_event_hidden(pg_temp.ev('open'), 'organizer asked');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 organizer asked: both dates hidden', v_n = 2
    and (select count(*) from public.outside_events where id in (pg_temp.ev('open'), pg_temp.ev('open2'))
                                                     and hidden_reason = 'organizer asked') = 2, v_n::text);
  perform pg_temp.as_user(pg_temp.p('GM'));
  e := pg_temp.err(format($q$select public.admin_save_outside_event(null, 'Again', %L::timestamptz, null,
         '{open_play}', null, null, 'X', 'https://ALAMEDA.example/open-play/', null, null, null, null, null)$q$,
         now() + interval '20 days'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 the page can''t be added again', e ->> 'hint' = 'pl:events.taken_down', e::text);
  perform pg_temp.as_user(pg_temp.p('GM'));
  e := pg_temp.err(format('select public.admin_set_outside_event_hidden(%L, %L)', pg_temp.ev('far'), 'because'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 admin reasons are fixed', e ->> 'hint' = 'pl:events.reason', e::text);

  -- E12 NEW count
  perform pg_temp.as_user(pg_temp.p('OD'));
  v_n := public.count_new_outside_events();
  perform public.mark_outside_events_seen(array[pg_temp.ev('far'), gen_random_uuid()]);
  perform pg_temp.ok('E12 seeing one takes 1 off the count', public.count_new_outside_events() = v_n - 1, v_n::text);
  perform pg_temp.ok('E12 a second mark adds nothing', public.mark_outside_events_seen(array[pg_temp.ev('far')]) = 0);
  r := public.list_outside_events();
  perform pg_temp.as_admin();
  perform pg_temp.ok('E12 the row says seen',
    (select (x ->> 'seen')::boolean from jsonb_array_elements(r) x where (x ->> 'id')::uuid = pg_temp.ev('far')));

  -- E13 the weekly post's view
  perform pg_temp.ok('E13 view: listed, next 7 days',
    exists (select 1 from public.upcoming_outside_events where id = pg_temp.ev('far') and court_name is null)
    and not exists (select 1 from public.upcoming_outside_events where id in (pg_temp.ev('open'), pg_temp.ev('ended'))));
  perform pg_temp.ok('E13 view: the city from the address',
    (select city from public.upcoming_outside_events where id = pg_temp.ev('nopoint')) = 'Alameda');

  -- E14 an account deleted: its RSVP goes
  perform pg_temp.as_user(pg_temp.p('OE'));
  perform public.set_outside_event_rsvp(pg_temp.ev('far'), 'maybe');
  perform pg_temp.as_admin();
  delete from auth.users where id = pg_temp.p('OE');
  perform pg_temp.ok('E14 deleted account: RSVP gone',
    not exists (select 1 from public.outside_event_rsvps where profile_id = pg_temp.p('OE')));

  -- E15 grants survive the hardening re-run; helpers and tables stay internal
  perform pg_temp.ok('E15 authenticated can call the client RPCs',
    has_function_privilege('authenticated', 'public.list_outside_events(text[], boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.get_outside_event(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.set_outside_event_rsvp(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.report_outside_event(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.mark_outside_events_seen(uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.count_new_outside_events()', 'execute')
    and has_function_privilege('authenticated', 'public.admin_list_outside_events()', 'execute'));
  perform pg_temp.ok('E15 anon cannot',
    not has_function_privilege('anon', 'public.list_outside_events(text[], boolean)', 'execute')
    and not has_function_privilege('anon', 'public.report_outside_event(uuid, text)', 'execute'));
  perform pg_temp.ok('E15 helpers are internal',
    not has_function_privilege('authenticated', 'public._pl_save_outside_event(uuid, text, timestamptz, timestamptz, text[], text, text, text, text, text, text, double precision, double precision, text, uuid, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_outside_event_listed(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_outside_event_json(uuid, uuid)', 'execute'));
  perform pg_temp.ok('E15 home location RPCs callable, its table is not',
    has_function_privilege('authenticated', 'public.set_my_home_location(double precision, double precision, text)', 'execute')
    and has_function_privilege('authenticated', 'public.get_my_home_location()', 'execute')
    and not has_function_privilege('anon', 'public.get_my_home_location()', 'execute')
    and not has_table_privilege('authenticated', 'public.profile_home_locations', 'select')
    and not has_function_privilege('authenticated', 'public._pl_neighborhood_for(double precision, double precision, text)', 'execute'));
  perform pg_temp.ok('E15 tables and the view are RPC-only',
    not has_table_privilege('authenticated', 'public.outside_events', 'select')
    and not has_table_privilege('authenticated', 'public.outside_event_rsvps', 'select')
    and not has_table_privilege('authenticated', 'public.upcoming_outside_events', 'select')
    and has_table_privilege('service_role', 'public.upcoming_outside_events', 'select'));
end $$;

-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;

rollback;
