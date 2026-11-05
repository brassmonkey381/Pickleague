-- ============================================================
-- Check me in at other courts (persona tests for
-- migration_other_courts_auto_checkin.sql).
--
-- NOT runnable on its own: build-other-courts-auto-test.mjs puts, at the
-- marker line below, migration_other_courts_auto_checkin.sql twice (it must
-- be re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep set_court_arrival_settings online). Everything runs inside the begin
-- / rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-other-courts-auto-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction, all with
-- "who sees me" chosen):
--   XA stars Home
--   XB, XC, XD star nothing
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('XA', 'a9000000-0000-4000-8000-000000000001'), ('XB', 'a9000000-0000-4000-8000-000000000002'),
  ('XC', 'a9000000-0000-4000-8000-000000000003'), ('XD', 'a9000000-0000-4000-8000-000000000004');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

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

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'xo-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Other ' || k)
  from _p;

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:xo-home',  array['pickleball'], 'XO Home Courts', 'court', 0.400, -141.0, 'osm', 100),
  ('test:xo-other', array['pickleball'], 'XO Other',       'court', 0.410, -141.0, 'osm', 100),
  ('test:xo-two',   array['pickleball'], 'XO Two',         'court', 0.420, -141.0, 'osm', 100);

-- @@MIGRATION@@

do $$
declare
  k text;
begin
  foreach k in array array['XA', 'XB', 'XC', 'XD'] loop
    perform pg_temp.as_user(pg_temp.p(k));
    perform public.set_presence_settings(p_consent_seen => true);
  end loop;
  perform pg_temp.as_user(pg_temp.p('XA'));
  perform public.set_court_favorite('test:xo-home', true);
  perform pg_temp.as_admin();
end $$;

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  s jsonb;
  q jsonb;
begin
  -- X1 off by default, and in the settings answer
  perform pg_temp.as_user(pg_temp.p('XB'));
  s := public.get_court_arrival_settings();
  perform pg_temp.as_admin();
  perform pg_temp.ok('X1 other_court_auto defaults to false', s ? 'other_court_auto' and (s ->> 'other_court_auto')::boolean = false, s::text);

  -- X2 "Ask me at other courts" off: not_starred, as before
  perform pg_temp.as_user(pg_temp.p('XB'));
  q := public.queue_court_arrival('test:xo-other');
  perform pg_temp.as_admin();
  perform pg_temp.ok('X2 ask off: not_starred', q ->> 'reason' = 'not_starred', q::text);

  -- X3 ask on, auto off: still not_starred (the phone asks)
  perform pg_temp.as_user(pg_temp.p('XB'));
  perform public.set_court_arrival_settings(p_other_radius_m => 100);
  q := public.queue_court_arrival('test:xo-other');
  perform pg_temp.as_admin();
  perform pg_temp.ok('X3 ask on, auto off: not_starred', q ->> 'reason' = 'not_starred', q::text);

  -- X4 ask on, auto on: queued
  perform pg_temp.as_user(pg_temp.p('XB'));
  s := public.set_court_arrival_settings(p_other_auto => true);
  q := public.queue_court_arrival('test:xo-other');
  perform pg_temp.as_admin();
  perform pg_temp.ok('X4 the setter returns other_court_auto true', (s ->> 'other_court_auto')::boolean, s::text);
  perform pg_temp.ok('X4 ask on, auto on: queued', (q ->> 'queued')::boolean, q::text);

  -- X5 a 1.0.4 phone's call (four named arguments) leaves it as it is
  perform pg_temp.as_user(pg_temp.p('XB'));
  s := public.set_court_arrival_settings(p_radius_m => null, p_other_radius_m => null, p_auto => null, p_departure => true);
  perform pg_temp.as_admin();
  perform pg_temp.ok('X5 old call keeps other_court_auto', (s ->> 'other_court_auto')::boolean, s::text);

  -- X6 auto on but ask off: not_starred
  perform pg_temp.as_user(pg_temp.p('XB'));
  perform public.set_court_arrival_settings(p_other_radius_m => 0);
  q := public.queue_court_arrival('test:xo-two');
  perform public.set_court_arrival_settings(p_other_radius_m => 100);
  perform pg_temp.as_admin();
  perform pg_temp.ok('X6 auto on, ask off: not_starred', q ->> 'reason' = 'not_starred', q::text);

  -- X7 "Check me in when I arrive" off is about starred courts only
  perform pg_temp.as_user(pg_temp.p('XB'));
  perform public.set_court_arrival_settings(p_auto => false);
  q := public.queue_court_arrival('test:xo-two');
  perform pg_temp.as_admin();
  perform pg_temp.ok('X7 starred switch off: other courts still queue', (q ->> 'queued')::boolean, q::text);

  -- X8 starred courts unchanged with other auto on
  perform pg_temp.as_user(pg_temp.p('XA'));
  perform public.set_court_arrival_settings(p_other_radius_m => 100, p_other_auto => true);
  perform public.set_starred_court_auto_checkin('test:xo-home', false);
  perform pg_temp.as_admin();
  perform pg_temp.ok('X8 starred court switched off: off_here',
    public._pl_court_arrival_off(pg_temp.p('XA'), 'test:xo-home') = 'off_here');
  perform pg_temp.ok('X8 unstarred court: check in',
    public._pl_court_arrival_off(pg_temp.p('XA'), 'test:xo-other') is null);
  perform pg_temp.as_user(pg_temp.p('XA'));
  perform public.set_starred_court_auto_checkin('test:xo-home', true);
  perform public.set_court_arrival_settings(p_auto => false);
  perform pg_temp.as_admin();
  perform pg_temp.ok('X8 starred switch off: starred court off',
    public._pl_court_arrival_off(pg_temp.p('XA'), 'test:xo-home') = 'off');

  -- X9 the minute later: XC is checked in; XD switched it off meanwhile, so isn't
  perform pg_temp.as_user(pg_temp.p('XC'));
  perform public.set_court_arrival_settings(p_other_radius_m => 100, p_other_auto => true);
  perform public.queue_court_arrival('test:xo-other');
  perform pg_temp.as_user(pg_temp.p('XD'));
  perform public.set_court_arrival_settings(p_other_radius_m => 100, p_other_auto => true);
  perform public.queue_court_arrival('test:xo-other');
  perform public.set_court_arrival_settings(p_other_auto => false);
  perform pg_temp.as_admin();
  update public.pl_pending_arrivals set arrived_at = now() - interval '2 minutes', due_at = now() - interval '1 minute'
   where user_id in (pg_temp.p('XC'), pg_temp.p('XD'));
  perform public.process_court_arrivals();
  perform pg_temp.ok('X9 auto on: checked in by arrival',
    exists (select 1 from public.venue_checkins c
             where c.user_id = pg_temp.p('XC') and c.venue_id = 'test:xo-other'
               and c.via_arrival and c.checked_out_at is null));
  perform pg_temp.ok('X9 switched off while waiting: not checked in',
    not exists (select 1 from public.venue_checkins c where c.user_id = pg_temp.p('XD')));

  -- X10 grants survive the hardening re-run
  perform pg_temp.ok('X10 authenticated can set',
    has_function_privilege('authenticated', 'public.set_court_arrival_settings(integer, integer, boolean, boolean, boolean)', 'execute'));
  perform pg_temp.ok('X10 anon cannot',
    not has_function_privilege('anon', 'public.set_court_arrival_settings(integer, integer, boolean, boolean, boolean)', 'execute'));
  perform pg_temp.ok('X10 the old four-argument version is gone',
    to_regprocedure('public.set_court_arrival_settings(integer, integer, boolean, boolean)') is null);
  perform pg_temp.ok('X10 the arrival switch stays internal',
    not has_function_privilege('authenticated', 'public._pl_court_arrival_off(uuid, text)', 'execute'));
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
