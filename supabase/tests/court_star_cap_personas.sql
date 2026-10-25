-- ============================================================
-- Court stars capped at 3, and Doggle's "replace one" (persona tests for
-- migration_court_star_cap_three.sql).
--
-- NOT runnable on its own: build-court-star-cap-test.mjs puts, at
-- the marker line below, migration_court_star_cap_three.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep replace_court_favorite online). Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-court-star-cap-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction) on temporary
-- courts near 40.5 N, 100.0 W, far from every real venue:
--   SA stars up to the cap, is refused a 4th, replaces
--   SO another player with a star SA tries to drop
--   ST a TestFlight tester with 5 stars from before the cap (the trim keeps 3)
--   SN 2 stars from before (the trim leaves them alone)
--   SE exactly 3 stars from before (the trim leaves them alone)
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('SA', 'a5000000-0000-4000-8000-000000000001'), ('SO', 'a5000000-0000-4000-8000-000000000002'),
  ('ST', 'a5000000-0000-4000-8000-000000000003'), ('SN', 'a5000000-0000-4000-8000-000000000004'),
  ('SE', 'a5000000-0000-4000-8000-000000000005');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
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

-- persona k's starred courts, by venue id (read as admin, so any persona).
create function pg_temp.stars(k text) returns text language sql stable as $$
  select coalesce(string_agg(venue_id, ',' order by venue_id), '')
    from public.court_favorites where user_id = pg_temp.p(k)
$$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'sc-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Star Cap ' || k)
  from _p;

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:sc-1', array['pickleball'], 'SC Test Courts One',   'court', 40.50, -100.0, 'google', 100),
  ('test:sc-2', array['pickleball'], 'SC Test Courts Two',   'court', 40.51, -100.0, 'google', 100),
  ('test:sc-3', array['pickleball'], 'SC Test Courts Three', 'court', 40.52, -100.0, 'google', 100),
  ('test:sc-4', array['pickleball'], 'SC Test Courts Four',  'court', 40.53, -100.0, 'google', 100),
  ('test:sc-5', array['pickleball'], 'SC Test Courts Five',  'court', 40.54, -100.0, 'google', 100),
  ('test:sc-6', array['pickleball'], 'SC Test Courts Six',   'court', 40.55, -100.0, 'google', 100);
-- Duplicate rows of One and Five (an OSM point of the same facility).
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, canonical_id) values
  ('test:sc-1-osm', array['pickleball'], 'SC Test Courts One',  'court', 40.50005, -100.0, 'osm', 100, 'test:sc-1'),
  ('test:sc-5-osm', array['pickleball'], 'SC Test Courts Five', 'court', 40.54005, -100.0, 'osm', 100, 'test:sc-5');

-- Stars from before the cap (1.0.4 TestFlight allowed 5), oldest first.
insert into public.court_favorites (user_id, venue_id, created_at) values
  (pg_temp.p('ST'), 'test:sc-1', now() - interval '5 days'),
  (pg_temp.p('ST'), 'test:sc-2', now() - interval '4 days'),
  (pg_temp.p('ST'), 'test:sc-3', now() - interval '3 days'),
  (pg_temp.p('ST'), 'test:sc-4', now() - interval '2 days'),
  (pg_temp.p('ST'), 'test:sc-5', now() - interval '1 day'),
  (pg_temp.p('SN'), 'test:sc-1', now() - interval '2 days'),
  (pg_temp.p('SN'), 'test:sc-2', now() - interval '1 day'),
  (pg_temp.p('SE'), 'test:sc-4', now() - interval '3 days'),
  (pg_temp.p('SE'), 'test:sc-5', now() - interval '2 days'),
  (pg_temp.p('SE'), 'test:sc-6', now() - interval '1 day'),
  (pg_temp.p('SO'), 'test:sc-6', now() - interval '1 day');

-- @@MIGRATION@@


-- ════ S1 the one-time trim ═══════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 a tester with 5 stars keeps 3: the 3 oldest (as Doggle 0047 kept showing)',
    pg_temp.stars('ST') = 'test:sc-1,test:sc-2,test:sc-3', pg_temp.stars('ST'));
  perform pg_temp.ok('S1 2 stars are left alone', pg_temp.stars('SN') = 'test:sc-1,test:sc-2', pg_temp.stars('SN'));
  perform pg_temp.ok('S1 exactly 3 stars are left alone (and a second run of the file trimmed nothing)',
    pg_temp.stars('SE') = 'test:sc-4,test:sc-5,test:sc-6', pg_temp.stars('SE'));
  perform pg_temp.ok('S1 nobody is over 3',
    not exists (select 1 from public.court_favorites group by user_id having count(*) > 3));
end $$;


-- ════ S2 grants and attributes ═══════════════════════════════════════════
do $$
declare
  f regprocedure := 'public.replace_court_favorite(text,text)'::regprocedure;
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('S2 replace_court_favorite: authenticated may call it (after the hardening re-run)',
    has_function_privilege('authenticated', f, 'execute'));
  perform pg_temp.ok('S2 replace_court_favorite: anon may not', not has_function_privilege('anon', f, 'execute'));
  perform pg_temp.ok('S2 replace_court_favorite: security definer, search_path ''''',
    (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = f));
  perform pg_temp.ok('S2 set_court_favorite: still callable by authenticated, not anon',
    has_function_privilege('authenticated', 'public.set_court_favorite(text,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.set_court_favorite(text,boolean)', 'execute'));
end $$;


-- ════ S3 the cap is 3 ════════════════════════════════════════════════════
do $$
declare
  e jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform pg_temp.ok('S3 three stars go through',
    public.set_court_favorite('test:sc-1', true)
    and public.set_court_favorite('test:sc-2', true)
    and public.set_court_favorite('test:sc-3', true));
  e := pg_temp.err($q$select public.set_court_favorite('test:sc-4', true)$q$);
  perform pg_temp.ok('S3 a 4th star is refused with pl:court.favorites_full', e ->> 'hint' = 'pl:court.favorites_full', e::text);
  perform pg_temp.ok('S3 its message says 3', e ->> 'msg' = 'You can star up to 3 courts. Unstar one to add this one.', e ->> 'msg');
  perform pg_temp.ok('S3 re-starring one of the 3 at the cap is fine', public.set_court_favorite('test:sc-1', true));
  perform pg_temp.ok('S3 list_my_court_favorites shows 3', (select count(*) from public.list_my_court_favorites()) = 3);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S3 still 3 rows', pg_temp.stars('SA') = 'test:sc-1,test:sc-2,test:sc-3', pg_temp.stars('SA'));
end $$;


-- ════ S4 replace ═════════════════════════════════════════════════════════
do $$
declare
  g jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('SA'));
  -- Two per-court switches off; Two is about to be replaced, Three stays.
  perform public.set_starred_court_auto_checkin('test:sc-2', false);
  perform public.set_starred_court_auto_checkin('test:sc-3', false);
  perform pg_temp.ok('S4 replace Two with Four returns true', public.replace_court_favorite('test:sc-2', 'test:sc-4'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 Two is gone, Four is starred, still 3',
    pg_temp.stars('SA') = 'test:sc-1,test:sc-3,test:sc-4', pg_temp.stars('SA'));
  perform pg_temp.ok('S4 the new star checks in on arrival (the column default), as a plain star does',
    (select auto_checkin from public.court_favorites where user_id = pg_temp.p('SA') and venue_id = 'test:sc-4'));
  perform pg_temp.ok('S4 a kept star keeps its switch',
    not (select auto_checkin from public.court_favorites where user_id = pg_temp.p('SA') and venue_id = 'test:sc-3'));
  perform pg_temp.as_user(pg_temp.p('SA'));
  g := public.list_starred_court_geofences();
  perform pg_temp.ok('S4 the phone''s fence list follows: Four in (on), Two out',
    jsonb_array_length(g) = 3
    and exists (select 1 from jsonb_array_elements(g) x where x ->> 'venue_id' = 'test:sc-4' and (x ->> 'auto_checkin')::boolean)
    and not exists (select 1 from jsonb_array_elements(g) x where x ->> 'venue_id' = 'test:sc-2'), g::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 an arrival at the dropped court no longer counts as starred',
    public._pl_court_arrival_off(pg_temp.p('SA'), 'test:sc-2') = 'not_starred');

  -- Duplicate rows: the court to drop matches its facility, the new one is stored canonical.
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform pg_temp.ok('S4 replace by duplicate ids works', public.replace_court_favorite('test:sc-1-osm', 'test:sc-5-osm'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 ... and stores the new court canonical',
    pg_temp.stars('SA') = 'test:sc-3,test:sc-4,test:sc-5', pg_temp.stars('SA'));
end $$;


-- ════ S5 refusals, and nothing changes when refused ══════════════════════
do $$
declare
  e jsonb;
begin
  -- A court that isn't one of mine (SO's star, or nobody's).
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err($q$select public.replace_court_favorite('test:sc-6', 'test:sc-2')$q$);
  perform pg_temp.ok('S5 dropping a court I haven''t starred: pl:court.not_starred', e ->> 'hint' = 'pl:court.not_starred', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 ... my stars unchanged', pg_temp.stars('SA') = 'test:sc-3,test:sc-4,test:sc-5', pg_temp.stars('SA'));
  perform pg_temp.ok('S5 ... and another player''s star on that court untouched', pg_temp.stars('SO') = 'test:sc-6', pg_temp.stars('SO'));

  -- Atomic: the new court is already starred, so the drop is rolled back.
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err($q$select public.replace_court_favorite('test:sc-3', 'test:sc-4')$q$);
  perform pg_temp.ok('S5 the new court already starred: pl:court.already_starred', e ->> 'hint' = 'pl:court.already_starred', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 ... Three is still starred, with its switch still off (the same row, not re-made)',
    pg_temp.stars('SA') = 'test:sc-3,test:sc-4,test:sc-5'
    and not (select auto_checkin from public.court_favorites where user_id = pg_temp.p('SA') and venue_id = 'test:sc-3'),
    pg_temp.stars('SA'));

  -- Atomic: the new court isn't in Pickleague.
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err($q$select public.replace_court_favorite('test:sc-3', 'test:sc-nope')$q$);
  perform pg_temp.ok('S5 the new court is gone: pl:court.gone', e ->> 'hint' = 'pl:court.gone', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 ... Three is still starred', pg_temp.stars('SA') = 'test:sc-3,test:sc-4,test:sc-5', pg_temp.stars('SA'));

  -- An incomplete request, and no user.
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err($q$select public.replace_court_favorite(null, 'test:sc-1')$q$);
  perform pg_temp.ok('S5 a missing court to drop: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err($q$select public.replace_court_favorite('test:sc-3', '')$q$);
  perform pg_temp.ok('S5 a blank court to add: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  perform pg_temp.as_signed_out();
  e := pg_temp.err($q$select public.replace_court_favorite('test:sc-3', 'test:sc-1')$q$);
  perform pg_temp.ok('S5 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 ... still the same 3', pg_temp.stars('SA') = 'test:sc-3,test:sc-4,test:sc-5', pg_temp.stars('SA'));

  -- Unstar, then a plain star fits again.
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform pg_temp.ok('S5 unstar then star: room again',
    not public.set_court_favorite('test:sc-5', false) and public.set_court_favorite('test:sc-1', true));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 ... 3 stars', pg_temp.stars('SA') = 'test:sc-1,test:sc-3,test:sc-4', pg_temp.stars('SA'));
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
