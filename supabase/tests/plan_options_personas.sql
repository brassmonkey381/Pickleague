-- ============================================================
-- Plan options persona tests (migration_plan_options.sql).
--
-- NOT runnable on its own: build-plan-options-test.mjs puts, at the marker
-- line below, migration_plan_options.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must keep the new RPC
-- callable). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-plan-options-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs live already: routines, one-off plans and plan sharing.
--
-- Courts near 41.9 N, 103.2 W (far from every real venue).
-- Personas (temporary accounts made inside the transaction):
--   OW  plans a one-off check-in and edits its length and windows
--   ST  a stranger who tries to edit OW's plan
--   RD  a routine with a drill window; checked in drilling
-- ============================================================

begin;

-- pg_temp helpers are called as authenticated; since migration_anon_audit_rest.sql
-- postgres-created functions aren't PUBLIC-executable by default (rolled back below).
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('OW', 'a9c00000-0000-4000-8000-000000000001'), ('ST', 'a9c00000-0000-4000-8000-000000000002'),
  ('RD', 'a9c00000-0000-4000-8000-000000000003');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.t(p interval) returns timestamptz language sql stable as $$
  select date_trunc('minute', now()) + p $$;
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

-- One JSON value p_sql returns as persona k; {"error": ..., "hint": ...} when it failed.
create function pg_temp.json_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  j jsonb;
  v_hint text;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  begin
    execute p_sql into j;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.as_admin();
    return jsonb_build_object('error', sqlerrm, 'hint', v_hint);
  end;
  perform pg_temp.as_admin();
  return j;
end $$;

-- set_court_plan_details as persona k.
create function pg_temp.details(k text, p_plan uuid, p_len int, p_windows jsonb) returns jsonb language sql as $$
  select pg_temp.json_as(k, format('select public.set_court_plan_details(%L, %s, %L::jsonb)', p_plan, p_len, p_windows)) $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'po-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'PO Player ' || k), now()
    from _p;
  insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
    ('test:po-c1', array['pickleball'], 'PO Test C1', 'court', 41.90, -103.2, 'google', 100),
    ('test:po-c2', array['pickleball'], 'PO Test C2', 'court', 41.91, -103.2, 'google', 100);
  insert into public.court_favorites (user_id, venue_id) values (pg_temp.p('RD'), 'test:po-c2');
  insert into public.presence_settings (user_id, consent_seen_at)
  select id, now() from _p
  on conflict (user_id) do update set consent_seen_at = excluded.consent_seen_at;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ Q1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('Q1 set_court_plan_details is callable when signed in, not signed out',
    has_function_privilege('authenticated', 'public.set_court_plan_details(uuid,integer,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.set_court_plan_details(uuid,integer,jsonb)', 'execute'));
  perform pg_temp.ok('Q1 the window helpers stay internal',
    not has_function_privilege('authenticated', 'public._pl_windows_problem(jsonb,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_windows_summary(jsonb,timestamptz,text)', 'execute'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('Q1 block crashed', false, sqlerrm);
end $$;


-- ════ Q2 the owner edits length and windows ══════════════════════════════
do $$
declare
  j    jsonb;
  v_id uuid;
  v_pl public.court_plans;
  v_it jsonb;
begin
  j := pg_temp.json_as('OW', format('select public.plan_court_checkin(p_venue => %L, p_at => %L)',
                                    'test:po-c1', pg_temp.t(interval '2 hours')));
  select pl.id into v_id from public.court_plans pl
   where pl.user_id = pg_temp.p('OW') and pl.kind = 'once' and pl.status = 'planned';
  perform pg_temp.ok('Q2 a plan made the quick way lists 2 hours, nothing said',
    v_id is not null and (j -> 0 ->> 'length_min')::int = 120 and jsonb_array_length(j -> 0 -> 'windows') = 1
    and j -> 0 -> 'windows' -> 0 ->> 'mode' is null, j::text);

  j := pg_temp.details('OW', v_id, 180,
    '[{"start_min":0,"end_min":60,"mode":"drill"},{"start_min":60,"end_min":180,"mode":"open","hint":"all_levels"}]');
  select * into v_pl from public.court_plans where id = v_id;
  v_it := j -> 0;
  perform pg_temp.ok('Q2 3 hours: a drill hour, then open play',
    v_pl.planned_end_at = v_pl.planned_at + interval '3 hours'
    and v_pl.windows -> 0 ->> 'mode' = 'drill' and v_pl.windows -> 1 ->> 'mode' = 'open'
    and (v_pl.windows -> 0 ->> 'ends_at')::timestamptz = v_pl.planned_at + interval '1 hour'
    and (v_it ->> 'length_min')::int = 180 and jsonb_array_length(v_it -> 'windows') = 2, j::text);
  perform pg_temp.ok('Q2 its summary says Drill',
    public._pl_windows_summary(v_pl.windows, v_pl.planned_at, 'UTC') like 'Drill until %, then open play',
    public._pl_windows_summary(v_pl.windows, v_pl.planned_at, 'UTC'));

  j := pg_temp.details('OW', v_id, 90, '[]');
  select * into v_pl from public.court_plans where id = v_id;
  perform pg_temp.ok('Q2 back to 90 minutes, nothing said',
    v_pl.planned_end_at = v_pl.planned_at + interval '90 minutes'
    and jsonb_array_length(v_pl.windows) = 1 and v_pl.windows -> 0 ->> 'mode' is null, j::text);

  -- Refusals.
  j := pg_temp.details('OW', v_id, 200, '[]');
  perform pg_temp.ok('Q3 200 minutes is refused (visit.bad_length)', j ->> 'hint' = 'pl:visit.bad_length', j::text);
  j := pg_temp.details('OW', v_id, 120, '[{"start_min":0,"end_min":60,"mode":"drill"},{"start_min":75,"end_min":120,"mode":"open"}]');
  perform pg_temp.ok('Q3 a gap is refused (windows.bad)', j ->> 'hint' = 'pl:windows.bad', j::text);
  j := pg_temp.details('OW', v_id, 120, '[{"start_min":0,"end_min":120,"mode":"drill","hint":"friends"}]');
  perform pg_temp.ok('Q3 a drill window takes no hint', j ->> 'hint' = 'pl:windows.bad', j::text);
  j := pg_temp.details('OW', v_id, 120, '[{"start_min":0,"end_min":120,"mode":"nap"}]');
  perform pg_temp.ok('Q3 an unknown mode is refused', j ->> 'hint' = 'pl:windows.bad', j::text);
  j := pg_temp.details('ST', v_id, 120, '[]');
  perform pg_temp.ok('Q4 a stranger can''t edit the plan (visit.gone)',
    j ->> 'hint' = 'pl:visit.gone'
    and (select planned_end_at - planned_at from public.court_plans where id = v_id) = interval '90 minutes', j::text);

  update public.court_plans set planned_at = now() - interval '1 hour', planned_end_at = now() + interval '30 minutes'
   where id = v_id;
  j := pg_temp.details('OW', v_id, 120, '[]');
  perform pg_temp.ok('Q4 a plan whose time is well past can''t be edited', j ->> 'hint' = 'pl:visit.gone', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('Q2 block crashed', false, sqlerrm);
end $$;


-- ════ Q5 drill in routines and check-ins; not open to play ══════════════
do $$
declare
  j     jsonb;
  v_x   time := ((now() at time zone 'UTC') + interval '3 hours')::time;
  v_t   time := make_time(extract(hour from v_x)::int, extract(minute from v_x)::int, 0);
  v_win jsonb;
begin
  j := pg_temp.json_as('RD', format(
    'select public.save_court_routine(null, %L, %L::time, 127, %L, 120, %L::jsonb)',
    'test:po-c2', v_t, 'UTC',
    '[{"start_min":0,"end_min":60,"mode":"drill"},{"start_min":60,"end_min":120,"mode":"closed","hint":"competitive"}]'));
  perform pg_temp.ok('Q5 a routine takes a drill window',
    not (j ? 'error')
    and exists (select 1 from public.court_routines r
                 where r.user_id = pg_temp.p('RD') and r.windows -> 0 ->> 'mode' = 'drill'), j::text);

  -- Checked in now, drilling for the next hour, then open play.
  v_win := jsonb_build_array(
    jsonb_build_object('starts_at', now() - interval '10 minutes', 'ends_at', now() + interval '50 minutes',
                       'mode', 'drill', 'hint', null, 'group', '[]'::jsonb),
    jsonb_build_object('starts_at', now() + interval '50 minutes', 'ends_at', now() + interval '110 minutes',
                       'mode', 'open', 'hint', null, 'group', '[]'::jsonb));
  insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at, location_confirmed, play_windows, planned_end_at)
  values (pg_temp.p('RD'), 'test:po-c1', now() - interval '10 minutes', now() + interval '110 minutes', true,
          v_win, now() + interval '110 minutes');
  perform pg_temp.ok('Q6 a check-in''s own windows take drill (set_checkin_plan''s check)',
    jsonb_array_length(public._pl_clean_abs_windows(pg_temp.p('RD'), v_win, now() - interval '10 minutes',
                                                    now() + interval '110 minutes')) = 2);
  perform pg_temp.ok('Q6 drilling now is the mode in force', public._pl_checkin_mode_at(v_win, now()) = 'drill');
  j := pg_temp.json_as('RD', format('select public.court_play_modes(%L)', 'test:po-c1'));
  perform pg_temp.ok('Q6 drilling is not open to play',
    (j ->> 'open_now')::int = 0 and j -> 'players' -> 0 ->> 'mode_now' = 'drill'
    and (j -> 'players' -> 0 ->> 'next_open_at') is not null, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('Q5 block crashed', false, sqlerrm);
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
