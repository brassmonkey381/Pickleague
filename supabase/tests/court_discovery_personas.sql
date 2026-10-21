-- ============================================================
-- Court discovery Phase 1 persona tests (state/court-discovery-plan.md,
-- supabase/migration_court_discovery_p1.sql): list_courts_nearby, get_court,
-- the point index and the grants.
--
-- NOT runnable on its own: build-court-discovery-p1-test.mjs wraps it as
--   begin; <this file up to the marker> <migration_venue_data_guards.sql
--   (Phase 0, which this phase relies on)> <migration_court_discovery_p1.sql,
--   twice (re-runnable)> <migration_rls_hardening_2026q3.sql re-run>
--   <the rest of this file> rollback;
-- and the last statement selects the results. Run (from the linked checkout):
--   node supabase/tests/build-court-discovery-p1-test.mjs <out.sql>
--   supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Self-contained: every test court sits in the open Pacific near 31 N, 141 W,
-- far from any real venue (T0 checks), and is deleted by the rollback. Three
-- temporary accounts (auth.users inserts; the signup trigger makes the
-- profiles): M belongs to a private league, S is a stranger, O owns the test
-- leagues. Distances: 0.001 deg of latitude = 111 m.
-- ============================================================

-- @@MIGRATIONS@@


-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The pickleball list around the test centre, as the current caller.
create function pg_temp.near(p_limit int default 50, p_after_m float8 default null, p_after_id text default null)
returns jsonb language sql as $$
  select public.list_courts_nearby(31.0, -141.0, 8047, array['pickleball'], p_limit, p_after_m, p_after_id)
$$;

-- Ids in the list (test rows only), in order.
create function pg_temp.ids(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(e->>'id' order by o), '{}') from jsonb_array_elements(p) with ordinality as t(e, o)
   where e->>'id' like 'test:p1-%'
$$;

create function pg_temp.row_of(p jsonb, p_id text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(p) e where e->>'id' = p_id limit 1
$$;

-- The pl:<code> a call raised, or 'none'.
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
declare v_hint text;
begin
  execute p_sql;
  return 'none';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return coalesce(nullif(v_hint, ''), 'sqlstate ' || sqlstate);
end $$;

-- T0: the test area is empty, so nothing real joins a test cluster or the list.
select pg_temp.ok('T0 no real venue near 31 N 141 W',
  not exists (select 1 from public.venues v
               where v.lat between 30.9 and 31.2 and v.lng between -141.2 and -140.8));

insert into auth.users (id, email, raw_user_meta_data) values
  ('b1000000-0000-4000-8000-0000000000a1', 'p1-member@pickleague.test',   '{"full_name":"Mia Member"}'),
  ('b1000000-0000-4000-8000-0000000000a2', 'p1-stranger@pickleague.test', '{"full_name":"Sam Stranger"}'),
  ('b1000000-0000-4000-8000-0000000000a3', 'p1-owner@pickleague.test',    '{"full_name":"Oli Owner"}');

-- Test courts, nearest first from (31.0, -141.0).
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, confirmation_status, address, lit) values
  -- T1 Lincoln Park: a Google child POI 108 m from its parent (Phase 0 links them)
  ('test:p1-lp-child',   array['pickleball'], 'Pickleball Courts | Lincoln Park', 'court', 31.000,    -141.0, 'google', 100, 'confirmed', null, null),
  ('test:p1-lp-parent',  array['pickleball'], 'Lincoln Park',                     'court', 31.000971, -141.0, 'google', 100, 'confirmed', null, null),
  -- T3 a blank canonical row and the alias that fills it (linked after the dedupe)
  ('test:p1-fill',       array['pickleball'], 'Fairway Fill Courts',     'court', 31.010,  -141.0, 'osm',    120, 'confirmed', '  ', null),
  ('test:p1-fill-alias', array['pickleball'], 'Zephyr Alias Spot',       'court', 31.0106, -141.0, 'google', 100, 'confirmed', '9 Alias Way', true),
  -- T2 a tennis-only facility whose alias is tagged pickleball
  ('test:p1-ten-canon',  array['tennis'],     'Harbor Tennis Center',    'court', 31.020,  -141.0, 'osm',    100, 'confirmed', null, null),
  ('test:p1-ten-alias',  array['pickleball'], 'Quayside Paddle Lines',   'court', 31.0207, -141.0, 'google', 100, 'confirmed', null, null),
  -- T2 hidden: rejected, tennis only, and a rejected alias doesn't qualify its court
  ('test:p1-rejected',   array['pickleball'], 'Rejected Pickle Court',   'court', 31.030,  -141.0, 'user',   100, 'rejected',  null, null),
  ('test:p1-tennis',     array['tennis'],     'Solo Tennis Courts West', 'court', 31.040,  -141.0, 'osm',    100, 'confirmed', null, null),
  ('test:p1-ten2',       array['tennis'],     'Bayview Tennis Club',     'court', 31.050,  -141.0, 'osm',    100, 'confirmed', null, null),
  ('test:p1-ten2-rej',   array['pickleball'], 'Bayview Rejected Alias',  'court', 31.0506, -141.0, 'user',   100, 'rejected',  null, null),
  -- T5 more plain courts for paging
  ('test:p1-page-a',     array['pickleball'], 'Alder Grove Courts',      'court', 31.060,  -141.0, 'osm',    100, 'unconfirmed', null, null),
  ('test:p1-page-b',     array['pickleball'], 'Beacon Hill Courts',      'court', 31.061,  -141.0, 'osm',    100, 'confirmed', null, null),
  -- Outside the 8,047 m radius (about 11 km)
  ('test:p1-far',        array['pickleball'], 'Faraway Pickle Courts',   'court', 31.100,  -141.0, 'osm',    100, 'confirmed', null, null);


-- ════ T1 Lincoln Park comes back as one row ══════════════════════════════
do $$
declare v jsonb; n int;
begin
  perform public._pl_dedupe_venues(array['pickleball']);
  -- Hand links for T2 / T3 (after the dedupe, which rewrites canonical_id).
  update public.venues set canonical_id = 'test:p1-fill'      where id = 'test:p1-fill-alias';
  update public.venues set canonical_id = 'test:p1-ten-canon' where id = 'test:p1-ten-alias';
  update public.venues set canonical_id = 'test:p1-ten2'      where id = 'test:p1-ten2-rej';

  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  v := pg_temp.near();
  select count(*) into n from unnest(pg_temp.ids(v)) i where i like 'test:p1-lp-%';
  perform pg_temp.ok('T1 the Lincoln Park pair is one row', n = 1, array_to_string(pg_temp.ids(v), ', '));
  perform pg_temp.ok('T1 ...and that row counts its alias',
    (select (e->>'alias_count')::int = 1 from jsonb_array_elements(v) e where e->>'id' like 'test:p1-lp-%'));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T1 block crashed', false, sqlerrm);
end $$;


-- ════ T2 Rejected rows hidden; sport matched through an alias ════════════
do $$
declare v jsonb; ids text[];
begin
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  v := pg_temp.near();
  ids := pg_temp.ids(v);
  perform pg_temp.ok('T2 a rejected court is hidden', not ('test:p1-rejected' = any(ids)), array_to_string(ids, ', '));
  perform pg_temp.ok('T2 aliases never show as their own rows',
    not ('test:p1-fill-alias' = any(ids)) and not ('test:p1-ten-alias' = any(ids)) and not ('test:p1-ten2-rej' = any(ids)));
  perform pg_temp.ok('T2 a tennis-only facility with a pickleball alias is listed', 'test:p1-ten-canon' = any(ids));
  perform pg_temp.ok('T2 a tennis-only court is not', not ('test:p1-tennis' = any(ids)));
  perform pg_temp.ok('T2 a rejected pickleball alias does not qualify its tennis court', not ('test:p1-ten2' = any(ids)));
  perform pg_temp.ok('T2 a court beyond the radius is not listed', not ('test:p1-far' = any(ids)));
  perform pg_temp.ok('T2 nearest first, with the expected rows',
    ids[2:] = array['test:p1-fill', 'test:p1-ten-canon', 'test:p1-page-a', 'test:p1-page-b'],
    array_to_string(ids, ', '));
  perform pg_temp.ok('T2 distance_m is haversine from the centre',
    abs((pg_temp.row_of(v, 'test:p1-fill')->>'distance_m')::float8 - public.haversine_meters(31.0, -141.0, 31.010, -141.0)) < 0.01);
  perform pg_temp.ok('T2 unconfirmed rows show, flagged',
    (pg_temp.row_of(v, 'test:p1-page-a')->>'unconfirmed')::boolean
    and not (pg_temp.row_of(v, 'test:p1-page-b')->>'unconfirmed')::boolean);
  perform pg_temp.ok('T2 the tennis sport list picks the tennis courts instead',
    'test:p1-tennis' = any(pg_temp.ids(public.list_courts_nearby(31.0, -141.0, 8047, array['tennis']))));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 block crashed', false, sqlerrm);
end $$;


-- ════ T3 Blank attributes filled from aliases ════════════════════════════
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  r := pg_temp.row_of(pg_temp.near(), 'test:p1-fill');
  perform pg_temp.ok('T3 a blank address comes from the alias', r->>'address' = '9 Alias Way', r::text);
  perform pg_temp.ok('T3 an unknown lights value comes from the alias', (r->>'lit')::boolean is true);
  perform pg_temp.ok('T3 the canonical row keeps its own name and point',
    r->>'name' = 'Fairway Fill Courts' and (r->>'lat')::float8 = 31.010);
  perform pg_temp.ok('T3 catalog fields only (no crowd, no star)',
    not (r ? 'here_now') and not (r ? 'starred') and r ? 'has_boundary' and r ? 'league_count');
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 block crashed', false, sqlerrm);
end $$;


-- ════ T4 A private league is not counted (unless you're in it) ═══════════
insert into public.leagues (id, name, is_open, created_by, home_venue_id) values
  ('b1000000-0000-4000-8000-000000000001', 'P1 Disc Open',     true,  'b1000000-0000-4000-8000-0000000000a3', 'test:p1-fill'),
  ('b1000000-0000-4000-8000-000000000002', 'P1 Disc Private',  false, 'b1000000-0000-4000-8000-0000000000a3', 'test:p1-fill'),
  -- Named with the alias id: the leagues trigger stores the canonical one.
  ('b1000000-0000-4000-8000-000000000003', 'P1 Disc Alias',    true,  'b1000000-0000-4000-8000-0000000000a3', 'test:p1-fill-alias'),
  ('b1000000-0000-4000-8000-000000000004', 'P1 Disc Inactive', true,  'b1000000-0000-4000-8000-0000000000a3', 'test:p1-fill');
update public.leagues set is_active = false where id = 'b1000000-0000-4000-8000-000000000004';
insert into public.league_members (league_id, user_id, role) values
  ('b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-0000000000a1', 'member')
on conflict do nothing;

do $$
declare s jsonb; m jsonb;
begin
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  s := pg_temp.row_of(pg_temp.near(), 'test:p1-fill');
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a1');
  m := pg_temp.row_of(pg_temp.near(), 'test:p1-fill');
  perform pg_temp.ok('T4 a stranger counts the open leagues only (one set through the alias id too; not the inactive one)',
    (s->>'league_count')::int = 2, s->>'league_count');
  perform pg_temp.ok('T4 a member of the private league counts it as well', (m->>'league_count')::int = 3, m->>'league_count');

  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  s := public.get_court('test:p1-fill');
  perform pg_temp.ok('T4 get_court lists the stranger''s visible leagues by name',
    (select array_agg(e->>'name' order by o) from jsonb_array_elements(s->'leagues') with ordinality t(e, o))
      = array['P1 Disc Alias', 'P1 Disc Open'],
    s->>'leagues');
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a1');
  m := public.get_court('test:p1-fill');
  perform pg_temp.ok('T4 ...and the member''s include the private one',
    jsonb_array_length(m->'leagues') = 3 and (m->'leagues') @> '[{"name":"P1 Disc Private"}]', m->>'leagues');
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 block crashed', false, sqlerrm);
end $$;


-- ════ T5 get_court follows canonical_id; refusals ════════════════════════
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b1000000-0000-4000-8000-0000000000a2');
  r := public.get_court('test:p1-fill-alias');
  perform pg_temp.ok('T5 get_court(alias) returns the canonical court',
    r->>'id' = 'test:p1-fill' and r->>'requested_id' = 'test:p1-fill-alias', r->>'id');
  perform pg_temp.ok('T5 ...with its aliases, outline and fence',
    (r->'aliases') @> '[{"id":"test:p1-fill-alias"}]' and r ? 'boundary' and (r->>'geofence_radius_m')::int = 120
    and (r->>'address') = '9 Alias Way');
  perform pg_temp.ok('T5 a court that is not there: pl:court.gone',
    pg_temp.refusal($q$select public.get_court('test:p1-nope')$q$) = 'pl:court.gone');
  perform pg_temp.ok('T5 a rejected court: pl:court.gone',
    pg_temp.refusal($q$select public.get_court('test:p1-rejected')$q$) = 'pl:court.gone');
  perform pg_temp.ok('T5 no id: pl:request.bad',
    pg_temp.refusal($q$select public.get_court(null)$q$) = 'pl:request.bad'
    and pg_temp.refusal($q$select public.get_court('  ')$q$) = 'pl:request.bad');
  perform pg_temp.ok('T5 no coordinates: pl:request.bad',
    pg_temp.refusal($q$select public.list_courts_nearby(null, -141.0, 8047, array['pickleball'])$q$) = 'pl:request.bad');
  perform pg_temp.ok('T5 no sports: pl:request.bad',
    pg_temp.refusal($q$select public.list_courts_nearby(31.0, -141.0, 8047, null)$q$) = 'pl:request.bad'
    and pg_temp.refusal($q$select public.list_courts_nearby(31.0, -141.0, 8047, '{}'::text[])$q$) = 'pl:request.bad');

  -- Keyset paging: two pages of 2 add up to the first 4 rows, no repeats.
  declare all4 text[]; p1 jsonb; p2 jsonb; last jsonb;
  begin
    all4 := (pg_temp.ids(pg_temp.near(50)))[1:4];
    -- Real courts can't be in the test area (T0), so every row here is a test row.
    p1 := pg_temp.near(2);
    last := p1->-1;
    p2 := pg_temp.near(2, (last->>'distance_m')::float8, last->>'id');
    perform pg_temp.ok('T5 keyset paging: page 2 continues page 1',
      pg_temp.ids(p1) || pg_temp.ids(p2) = all4,
      array_to_string(pg_temp.ids(p1) || pg_temp.ids(p2), ', ') || ' vs ' || array_to_string(all4, ', '));
  end;
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 block crashed', false, sqlerrm);
end $$;


-- ════ T6 Signed out is refused ═══════════════════════════════════════════
select pg_temp.ok('T6 anon may not execute list_courts_nearby / get_court; authenticated may',
  not has_function_privilege('anon', 'public.list_courts_nearby(double precision, double precision, double precision, text[], int, double precision, text)', 'execute')
  and not has_function_privilege('anon', 'public.get_court(text)', 'execute')
  and has_function_privilege('authenticated', 'public.list_courts_nearby(double precision, double precision, double precision, text[], int, double precision, text)', 'execute')
  and has_function_privilege('authenticated', 'public.get_court(text)', 'execute'));
select pg_temp.ok('T6 the row builder is closed to clients',
  not has_function_privilege('authenticated', 'public._pl_court_catalog_json(text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public._pl_court_catalog_json(text, uuid)', 'execute'));
do $$
declare v_code text;
begin
  perform pg_temp.as_anon();
  v_code := pg_temp.refusal($q$select public.get_court('test:p1-fill')$q$);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 an anon call to get_court is denied', v_code = 'sqlstate 42501', v_code);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 block crashed', false, sqlerrm);
end $$;
do $$
begin
  -- A definer call with no signed-in user (the service role, a script).
  perform pg_temp.ok('T6 no caller: pl:auth.signed_out',
    pg_temp.refusal($q$select public.get_court('test:p1-fill')$q$) = 'pl:auth.signed_out');
end $$;


-- ════ T7 The point index serves the prefilter ════════════════════════════
-- On ~4,400 rows the planner may pick a seq scan on its own; with seq scans
-- off it must be able to use the index (so the expression matches).
do $$
declare v_line text; v_plan text := '';
begin
  set local enable_seqscan = off;
  for v_line in execute $q$
    explain select c.id from public.venues c
     where extensions.st_dwithin(
             (extensions.st_setsrid(extensions.st_makepoint(c.lng, c.lat), 4326))::extensions.geography,
             (extensions.st_setsrid(extensions.st_makepoint(-141.0::float8, 31.0::float8), 4326))::extensions.geography,
             8152.0)
  $q$ loop
    v_plan := v_plan || v_line || ' | ';
  end loop;
  set local enable_seqscan = on;
  perform pg_temp.ok('T7 venues_point_geog_idx is used under enable_seqscan = off',
    v_plan like '%venues_point_geog_idx%', v_plan);
exception when others then
  set local enable_seqscan = on;
  perform pg_temp.ok('T7 block crashed', false, sqlerrm);
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
