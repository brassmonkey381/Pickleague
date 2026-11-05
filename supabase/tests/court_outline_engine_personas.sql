-- ============================================================
-- Court check-ins by the outline (persona tests for
-- migration_court_outline_engine.sql).
--
-- NOT runnable on its own: build-court-outline-engine-test.mjs puts, at the
-- marker line below, migration_court_outline_engine.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep list_nearby_wake_courts online). Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-court-outline-engine-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- The test courts sit in the open Pacific (0.3 N, 140 W), so no real court
-- is within 5 km of them. At that latitude 0.001 degrees is about 111 m.
--
-- Personas (temporary accounts created inside the transaction):
--   OA stars Home (outlined) and Bare (no outline)
--   OB stars nothing
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('OA', 'a8000000-0000-4000-8000-000000000001'), ('OB', 'a8000000-0000-4000-8000-000000000002');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
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

-- A square outline (GeoJSON, lng before lat) of half-side h degrees.
create function pg_temp.sq(lat double precision, lng double precision, h double precision) returns jsonb
language sql immutable as $$
  select jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(jsonb_build_array(
    jsonb_build_array(lng - h, lat - h), jsonb_build_array(lng + h, lat - h),
    jsonb_build_array(lng + h, lat + h), jsonb_build_array(lng - h, lat + h),
    jsonb_build_array(lng - h, lat - h))))
$$;

-- The venue ids in a list_nearby_wake_courts answer, in order.
create function pg_temp.ids(a jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(e ->> 'venue_id' order by o), '{}') from jsonb_array_elements(a) with ordinality t(e, o)
$$;

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'oe-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Outline ' || k)
  from _p;

-- venue_geom_biu derives boundary_geom and area_sqm from boundary.
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, boundary) values
  ('test:oe-home',  array['pickleball'], 'OE Home Courts',  'court', 0.300, -140.0, 'osm', 100, pg_temp.sq(0.300, -140.0, 0.0005)),
  ('test:oe-n1',    array['pickleball'], 'OE Near One',     'court', 0.310, -140.0, 'osm', 100, pg_temp.sq(0.310, -140.0, 0.0003)),
  ('test:oe-n1dup', array['pickleball'], 'OE Near One',     'court', 0.3095, -140.0, 'google', 100, pg_temp.sq(0.3095, -140.0, 0.0002)),
  ('test:oe-n2',    array['pickleball'], 'OE Near Two',     'court', 0.320, -140.0, 'osm', 100, pg_temp.sq(0.320, -140.0, 0.0003)),
  ('test:oe-far',   array['pickleball'], 'OE Far',          'court', 0.370, -140.0, 'osm', 100, pg_temp.sq(0.370, -140.0, 0.0003)),
  ('test:oe-hoops', array['basketball'], 'OE Hoops',        'court', 0.306, -140.0, 'osm', 100, pg_temp.sq(0.306, -140.0, 0.0003));
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, boundary, confirmation_status) values
  ('test:oe-rej',   array['pickleball'], 'OE Rejected',     'court', 0.305, -140.0, 'osm', 100, pg_temp.sq(0.305, -140.0, 0.0003), 'rejected');
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:oe-bare',  array['pickleball'], 'OE Bare',         'court', 0.302, -140.0, 'osm', 100);
-- A duplicate row of Near One, as _pl_dedupe_venues marks one.
update public.venues set canonical_id = 'test:oe-n1' where id = 'test:oe-n1dup';

-- @@MIGRATION@@

-- OA stars Home and Bare.
do $$
begin
  perform pg_temp.as_user(pg_temp.p('OA'));
  perform public.set_presence_settings(p_consent_seen => true);
  perform public.set_court_favorite('test:oe-home', true);
  perform public.set_court_favorite('test:oe-bare', true);
  perform pg_temp.as_admin();
end $$;

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  a    jsonb;
  home jsonb;
  bare jsonb;
  e    jsonb;
begin
  -- O1 the starred list carries each court's outline (null without one)
  perform pg_temp.as_user(pg_temp.p('OA'));
  a := public.list_starred_court_geofences();
  select x into home from jsonb_array_elements(a) x where x ->> 'venue_id' = 'test:oe-home';
  select x into bare from jsonb_array_elements(a) x where x ->> 'venue_id' = 'test:oe-bare';
  perform pg_temp.as_admin();
  perform pg_temp.ok('O1 outlined court has a Polygon outline', home -> 'outline' ->> 'type' = 'Polygon', home::text);
  perform pg_temp.ok('O1 ... with its ring', jsonb_array_length(home -> 'outline' -> 'coordinates' -> 0) >= 4);
  perform pg_temp.ok('O1 ... and the old fields unchanged',
    home ? 'radius_m' and home ? 'auto_checkin' and (home ->> 'radius_m')::int > 0, home::text);
  perform pg_temp.ok('O1 court with no outline: null', bare ? 'outline' and jsonb_typeof(bare -> 'outline') = 'null', bare::text);

  -- O2 nearby for OA: outlined, unstarred, pickleball, not rejected, within 5 km, nearest first, each facility once
  perform pg_temp.as_user(pg_temp.p('OA'));
  a := public.list_nearby_wake_courts(0.300, -140.0, 19);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O2 OA nearby: Near One, then Near Two',
    (select array_agg(i) from unnest(pg_temp.ids(a)) i where i like 'test:oe-%') = array['test:oe-n1', 'test:oe-n2'],
    pg_temp.ids(a)::text);
  select x into home from jsonb_array_elements(a) x where x ->> 'venue_id' = 'test:oe-n1';
  perform pg_temp.ok('O2 duplicate row measured, canonical id returned',
    (home ->> 'distance_m')::numeric between 900 and 1050, home::text);
  perform pg_temp.ok('O2 ... with an outline and a circle of at least 100 m',
    home -> 'outline' ->> 'type' = 'Polygon' and (home ->> 'radius_m')::int >= 100, home::text);

  -- O3 nearby for OB (no stars): Home first, at 0 (inside it)
  perform pg_temp.as_user(pg_temp.p('OB'));
  a := public.list_nearby_wake_courts(0.300, -140.0, 19);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O3 OB nearby: Home, Near One, Near Two',
    (select array_agg(i) from unnest(pg_temp.ids(a)) i where i like 'test:oe-%') = array['test:oe-home', 'test:oe-n1', 'test:oe-n2'],
    pg_temp.ids(a)::text);
  perform pg_temp.ok('O3 inside Home: distance 0', (a -> 0 ->> 'distance_m')::numeric = 0, (a -> 0)::text);

  -- O4 the limit is honoured (and capped at 19)
  perform pg_temp.as_user(pg_temp.p('OB'));
  a := public.list_nearby_wake_courts(0.300, -140.0, 1);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O4 limit 1: one court', jsonb_array_length(a) = 1 and pg_temp.ids(a) = array['test:oe-home'], a::text);

  -- O5 bad input refused, without coordinates in the message
  perform pg_temp.as_user(pg_temp.p('OB'));
  e := pg_temp.err($q$ select public.list_nearby_wake_courts(null, -140.0, 5) $q$);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O5 missing latitude refused', e ->> 'hint' = 'pl:request.bad', e::text);
  perform pg_temp.as_user(pg_temp.p('OB'));
  e := pg_temp.err($q$ select public.list_nearby_wake_courts(95, -140.0, 5) $q$);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O5 latitude out of range refused', e ->> 'hint' = 'pl:request.bad', e::text);

  -- O6 signed out: no execute
  perform pg_temp.as_anon();
  e := pg_temp.err($q$ select public.list_nearby_wake_courts(0.3, -140.0, 5) $q$);
  -- Back to admin first: anon can't write the results table.
  perform pg_temp.as_admin();
  perform pg_temp.ok('O6 anon refused', e is not null, e::text);

  -- O7 grants survive the hardening re-run; the helper stays internal
  perform pg_temp.ok('O7 authenticated can list nearby',
    has_function_privilege('authenticated', 'public.list_nearby_wake_courts(double precision, double precision, integer)', 'execute'));
  perform pg_temp.ok('O7 anon cannot',
    not has_function_privilege('anon', 'public.list_nearby_wake_courts(double precision, double precision, integer)', 'execute'));
  perform pg_temp.ok('O7 authenticated can still list starred',
    has_function_privilege('authenticated', 'public.list_starred_court_geofences()', 'execute'));
  perform pg_temp.ok('O7 the outline helper is internal',
    not has_function_privilege('authenticated', 'public._pl_outline_json(extensions.geometry)', 'execute'));
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
