-- ============================================================
-- Routine check-ins: persona tests for migration_court_routines.sql.
--
-- NOT runnable on its own: build-court-routines-test.mjs puts, at the marker
-- line below, migration_court_routines.sql twice (it must be re-runnable)
-- and then migration_rls_hardening_2026q3.sql (a re-run must keep the new
-- client RPCs online). Everything runs inside the begin / rollback below, so
-- the linked (live) database is left untouched:
--   node supabase/tests/build-court-routines-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs the presence, court arrival (two-hours included) and star-cap files
-- live already (they are, before this file goes live).
--
-- now() is fixed for the whole transaction: waits are made by moving rows
-- into the past, and the materializer is called with an explicit clock
-- (_pl_materialize_court_routines(routine, p_now)) for the DST and midnight
-- cases, in 2027 so they stay in the future whenever this runs.
--
-- Courts near 40.7 N, 100.0 W (far from every real venue; a fix 11 m north is
-- lat + 0.0001): test:cr-home (+ duplicate row test:cr-home-osm), cr-two,
-- cr-three, cr-unstarred, cr-crowd, cr-arr, cr-off, cr-man, cr-split,
-- cr-split3a, cr-split3b, cr-split3c.
--
-- Personas:
--   RO owner (CRUD, windows, DST, midnight, skip / move / undo, privacy)
--   RF RO's friend · RS stranger · RB blocked by RO · RH RO's friend, hidden
--   from · RG RO's friend on a guest pass · RL the 12-routine cap
--   RA arrival at a routine court with automatic check-in off; take-back
--   RA2 "Staying until" · RA3 a short routine ends the arrival early
--   RX court switched off (off_here) · RN routine check-in off
--   RW reminder then Skip today · RM manual check-in keeps the occurrence,
--   set_checkin_plan · RU unstars a routine court · RD deletes the account
--   RV crowd viewer · C1-C7 at the crowd court
--   RP the closed / open split end to end, with the payloads the app sent
--   before and after the 2026-10-22 fix (R14)
--   RQ RQ2 RQ3 a check-in made by hand on a 3-hour routine, closed 2 h then
--   open 1 h, reaches open play: the planned end it now takes, "Stay until",
--   the routine's length (R15; migration_court_routines_planned_end.sql)
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('RO',  'a8000000-0000-4000-8000-000000000001'), ('RF',  'a8000000-0000-4000-8000-000000000002'),
  ('RS',  'a8000000-0000-4000-8000-000000000003'), ('RB',  'a8000000-0000-4000-8000-000000000004'),
  ('RH',  'a8000000-0000-4000-8000-000000000005'), ('RG',  'a8000000-0000-4000-8000-000000000006'),
  ('RL',  'a8000000-0000-4000-8000-000000000007'), ('RA',  'a8000000-0000-4000-8000-000000000008'),
  ('RA2', 'a8000000-0000-4000-8000-000000000009'), ('RA3', 'a8000000-0000-4000-8000-00000000000a'),
  ('RX',  'a8000000-0000-4000-8000-00000000000b'), ('RN',  'a8000000-0000-4000-8000-00000000000c'),
  ('RW',  'a8000000-0000-4000-8000-00000000000d'), ('RM',  'a8000000-0000-4000-8000-00000000000e'),
  ('RU',  'a8000000-0000-4000-8000-00000000000f'), ('RD',  'a8000000-0000-4000-8000-000000000010'),
  ('RV',  'a8000000-0000-4000-8000-000000000011'), ('C1',  'a8000000-0000-4000-8000-000000000012'),
  ('C2',  'a8000000-0000-4000-8000-000000000013'), ('C3',  'a8000000-0000-4000-8000-000000000014'),
  ('C4',  'a8000000-0000-4000-8000-000000000015'), ('C5',  'a8000000-0000-4000-8000-000000000016'),
  ('C6',  'a8000000-0000-4000-8000-000000000017'), ('C7',  'a8000000-0000-4000-8000-000000000018'),
  ('RP',  'a8000000-0000-4000-8000-000000000019'), ('RQ',  'a8000000-0000-4000-8000-00000000001a'),
  ('RQ2', 'a8000000-0000-4000-8000-00000000001b'), ('RQ3', 'a8000000-0000-4000-8000-00000000001c');
grant select on _p to authenticated, anon;

-- Ids picked in advance (check-ins, sessions).
create temp table _ids (k text primary key, id uuid not null default gen_random_uuid());
insert into _ids (k) values ('RA'), ('RA2'), ('RA3'), ('RM'), ('C1'), ('C2'), ('C3'), ('C5'), ('C6'), ('C7'), ('RP'),
  ('RQ'), ('RQ2'), ('RQ3');
grant select on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;

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

-- Runs p_sql; null if it went through, else the error's message, hint, detail.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon;

-- One window, offsets.
create function pg_temp.w(s int, e int, m text default null, h text default null, g jsonb default '[]'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('start_min', s, 'end_min', e, 'mode', m, 'hint', h, 'group', g)
$$;

-- One window, absolute.
create function pg_temp.aw(s timestamptz, e timestamptz, m text default null, h text default null, g jsonb default '[]'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('starts_at', s, 'ends_at', e, 'mode', m, 'hint', h, 'group', g)
$$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'cr-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'CR Player ' || k)
  from _p;
update public.profiles set is_guest = true where id = pg_temp.p('RG');

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:cr-home',      array['pickleball'], 'CR Test Courts Home',      'court', 40.70, -100.0, 'google', 100),
  ('test:cr-two',       array['pickleball'], 'CR Test Courts Two',       'court', 40.71, -100.0, 'google', 100),
  ('test:cr-three',     array['pickleball'], 'CR Test Courts Three',     'court', 40.72, -100.0, 'google', 100),
  ('test:cr-unstarred', array['pickleball'], 'CR Test Courts Unstarred', 'court', 40.73, -100.0, 'google', 100),
  ('test:cr-crowd',     array['pickleball'], 'CR Test Courts Crowd',     'court', 40.74, -100.0, 'google', 100),
  ('test:cr-arr',       array['pickleball'], 'CR Test Courts Arrival',   'court', 40.75, -100.0, 'google', 100),
  ('test:cr-off',       array['pickleball'], 'CR Test Courts Off',       'court', 40.76, -100.0, 'google', 100),
  ('test:cr-man',       array['pickleball'], 'CR Test Courts Manual',    'court', 40.77, -100.0, 'google', 100),
  ('test:cr-split',     array['pickleball'], 'CR Test Courts Split',     'court', 40.78, -100.0, 'google', 100),
  ('test:cr-split3a',   array['pickleball'], 'CR Test Courts Split 3A',  'court', 40.79, -100.0, 'google', 100),
  ('test:cr-split3b',   array['pickleball'], 'CR Test Courts Split 3B',  'court', 40.80, -100.0, 'google', 100),
  ('test:cr-split3c',   array['pickleball'], 'CR Test Courts Split 3C',  'court', 40.81, -100.0, 'google', 100);
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, canonical_id) values
  ('test:cr-home-osm', array['pickleball'], 'CR Test Courts Home', 'court', 40.70005, -100.0, 'osm', 100, 'test:cr-home');

insert into public.court_favorites (user_id, venue_id)
select pg_temp.p(k), v from (values
  ('RO', 'test:cr-home'), ('RO', 'test:cr-two'), ('RO', 'test:cr-three'),
  ('RL', 'test:cr-home'), ('RA', 'test:cr-arr'), ('RA2', 'test:cr-arr'), ('RA3', 'test:cr-arr'),
  ('RW', 'test:cr-arr'), ('RX', 'test:cr-off'), ('RN', 'test:cr-off'), ('RM', 'test:cr-man'), ('RP', 'test:cr-split'),
  ('RU', 'test:cr-home'), ('RD', 'test:cr-home'),
  ('RQ', 'test:cr-split3a'), ('RQ2', 'test:cr-split3b'), ('RQ3', 'test:cr-split3c')) s(k, v);

-- Consent (arrivals need it); RA and RN have automatic check-in off.
insert into public.presence_settings (user_id, consent_seen_at, auto_checkin)
select pg_temp.p(k), now(), k not in ('RA', 'RN')
  from _p where k in ('RA', 'RA2', 'RA3', 'RX', 'RN', 'RW', 'RM', 'RP', 'RQ', 'RQ2', 'RQ3');

insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p(a), pg_temp.p(b), 'accepted', now() from (values
  ('RO', 'RF'), ('RO', 'RH'), ('RO', 'RG'), ('RA', 'RF'), ('RV', 'C2'), ('RV', 'C3'),
  ('C2', 'C3'), ('C2', 'C4')) s(a, b);
insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('RO'), pg_temp.p('RB')), (pg_temp.p('RV'), pg_temp.p('C7'));
insert into public.presence_hidden_from (user_id, hidden_user_id) values (pg_temp.p('RO'), pg_temp.p('RH'));

-- @@MIGRATION@@


-- ════ Helpers that read the new tables ═════════════════════════════════
-- Persona k's routines (read as admin).
create function pg_temp.routines(k text) returns int language sql stable as $$
  select count(*)::int from public.court_routines where user_id = pg_temp.p(k)
$$;
-- Persona k's routine at a court (and time, when given). now() is fixed for
-- the transaction, so created_at can't tell routines apart.
create function pg_temp.routine(k text, p_venue text default null, p_time time default null)
returns public.court_routines language sql stable as $$
  select * from public.court_routines
   where user_id = pg_temp.p(k) and (p_venue is null or venue_id = p_venue) and (p_time is null or local_time = p_time)
   order by local_time, id limit 1
$$;
-- A routine's occurrence on a date (all nulls when none).
create function pg_temp.occ(p_routine uuid, p_date date) returns public.court_plans language sql stable as $$
  select * from public.court_plans where routine_id = p_routine and routine_date = p_date
$$;
-- Persona k's planned occurrence nearest now (all nulls when none).
create function pg_temp.next_plan(k text) returns public.court_plans language sql stable as $$
  select * from public.court_plans where user_id = pg_temp.p(k) and status = 'planned'
   order by abs(extract(epoch from (planned_at - now()))) limit 1
$$;
create function pg_temp.plan(p_id uuid) returns public.court_plans language sql stable as $$
  select * from public.court_plans where id = p_id
$$;
create function pg_temp.vci(p_id uuid) returns public.venue_checkins language sql stable as $$
  select * from public.venue_checkins where id = p_id
$$;
-- Persona k's outbox pushes of a kind (written straight to the outbox).
create function pg_temp.pushes(k text, p_kind text) returns int language sql stable as $$
  select count(*)::int from public.push_outbox o
   where o.recipient_id = pg_temp.p(k) and o.notification_id is null and o.push_data ->> 'kind' = p_kind
$$;
create function pg_temp.push_row(k text, p_kind text) returns public.push_outbox language sql stable as $$
  select * from public.push_outbox o
   where o.recipient_id = pg_temp.p(k) and o.notification_id is null and o.push_data ->> 'kind' = p_kind
   order by o.created_at desc, o.id limit 1
$$;
-- A routine due about 10 minutes from now (UTC wall clock, every day) at a
-- court, saved as persona k. Leaves the role as k.
create function pg_temp.due_routine(k text, p_venue text, p_length int, p_windows jsonb default null)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.p(k));
  return public.save_court_routine(null, p_venue, ((now() at time zone 'UTC') + interval '10 minutes')::time,
                                   127, 'UTC', p_length, p_windows);
end $$;
-- An arrival p_ago back (due already) and one run of the job. Leaves the role as admin.
create function pg_temp.arrive(k text, p_venue text, p_id uuid, p_ago interval default interval '2 minutes')
returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.queue_court_arrival(p_venue => p_venue, p_arrived_at => now() - p_ago, p_checkin_id => p_id);
  perform pg_temp.as_admin();
  perform public.process_court_arrivals();
  return j;
end $$;


-- ════ R1 grants, attributes, jobs ════════════════════════════════════════
do $$
declare
  f     text;
  v_bad text;
  v_client text[] := array[
    'public.list_my_court_routines()',
    'public.get_court_routine_settings()',
    'public.set_routine_auto_checkin(boolean)',
    'public.save_court_routine(uuid,text,time without time zone,integer,text,integer,jsonb)',
    'public.set_court_routine_active(uuid,boolean)',
    'public.delete_court_routine(uuid)',
    'public.skip_court_routine_occurrence(uuid)',
    'public.unskip_court_routine_occurrence(uuid)',
    'public.move_court_routine_occurrence(uuid,timestamptz)',
    'public.suggest_court_routines(text)',
    'public.list_profile_court_routines(uuid)',
    'public.set_checkin_plan(uuid,timestamptz,jsonb)',
    'public.venue_open_to_play(text[])',
    'public.court_play_modes(text)'];
  v_internal text[] := array[
    'public._pl_window_hint_ok(text,text)', 'public._pl_json_str(jsonb)',
    'public._pl_windows_problem(jsonb,integer)', 'public._pl_raise_windows(jsonb)',
    'public._pl_clean_group(uuid,jsonb)', 'public._pl_clean_windows(uuid,jsonb,integer)',
    'public._pl_windows_at(jsonb,timestamptz)', 'public._pl_shift_windows(jsonb,interval)',
    'public._pl_fit_windows(jsonb,timestamptz)', 'public._pl_clean_abs_windows(uuid,jsonb,timestamptz,timestamptz)',
    'public._pl_windows_now(jsonb,timestamptz)', 'public._pl_checkin_mode_at(jsonb,timestamptz)',
    'public._pl_clock(timestamptz,text)', 'public._pl_windows_summary(jsonb,timestamptz,text)',
    'public._pl_is_starred(uuid,text)', 'public._pl_routine_plan_at(uuid,text,timestamptz)',
    'public._pl_materialize_court_routines(uuid,timestamptz)', 'public.materialize_court_routines(uuid)',
    'public._pl_checkin_link_plan()', 'public._pl_checkin_plan_kept()',
    'public._pl_court_push(uuid,text,text,text,timestamptz,jsonb)', 'public._pl_venue_open_now(uuid,text)',
    'public.process_court_routine_reminders()',
    -- replaced
    'public._pl_court_arrival_off(uuid,text)', 'public._pl_take_back_arrival(uuid,uuid[],timestamptz)',
    'public.process_court_arrivals()', 'public._purge_account(uuid)', 'public.prune_presence_history()'];
begin
  perform pg_temp.as_admin();
  foreach f in array v_client || array['public.cancel_court_arrival(text,timestamptz,boolean)'] loop
    perform pg_temp.ok('R1 authenticated may execute ' || f,
      to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'EXECUTE'));
    perform pg_temp.ok('R1 anon may not execute ' || f,
      to_regprocedure(f) is not null and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  foreach f in array v_internal loop
    perform pg_temp.ok('R1 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  select string_agg(w.sig, ', ') into v_bad
    from unnest(v_client || v_internal) w(sig)
   where not exists (select 1 from pg_proc p where p.oid = to_regprocedure(w.sig)
                      and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""');
  perform pg_temp.ok('R1 every new and replaced function is SECURITY DEFINER with an empty search_path', v_bad is null, v_bad);

  -- The replaced ones keep their one signature (no overloads beside them).
  select string_agg(w.fn || ' ' || got.n, '; ') into v_bad
    from (values ('_pl_court_arrival_off'), ('_pl_take_back_arrival'), ('cancel_court_arrival'),
                 ('process_court_arrivals'), ('_purge_account'), ('prune_presence_history')) w(fn)
    cross join lateral (select count(*) as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                         where ns.nspname = 'public' and p.proname = w.fn) got
   where got.n <> 1;
  perform pg_temp.ok('R1 each replaced function has one version', v_bad is null, v_bad);
  perform pg_temp.ok('R1 the arrival bodies keep the 2-hour length and the old untouched test',
    (select prosrc like '%r.arrived_at + public._pl_arrival_length()%'
            and prosrc like '%public._pl_arrival_untouched(c.checked_in_at, c.expires_at)%'
            and prosrc like '%arrival_extend_until%'
       from pg_proc where oid = 'public.process_court_arrivals()'::regprocedure)
    and (select prosrc like '%public._pl_arrival_untouched(c.checked_in_at, c.expires_at)%'
                and prosrc like '%c.arrival_until%'
           from pg_proc where oid = 'public.cancel_court_arrival(text,timestamptz,boolean)'::regprocedure));

  perform pg_temp.ok('R1 court_routines and court_plans: RLS on, no client writes, nothing for anon',
    (select bool_and(c.relrowsecurity) from pg_class c
      where c.oid in ('public.court_routines'::regclass, 'public.court_plans'::regclass))
    and not has_table_privilege('authenticated', 'public.court_routines', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('authenticated', 'public.court_plans', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.court_routines', 'SELECT, INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.court_plans', 'SELECT, INSERT, UPDATE, DELETE'));
  perform pg_temp.ok('R1 one owner-only select policy on each, no write policies',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'court_routines') = 1
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'court_plans') = 1
    and (select bool_and(cmd = 'SELECT') from pg_policies
          where schemaname = 'public' and tablename in ('court_routines', 'court_plans')));
  perform pg_temp.ok('R1 the new venue_checkins columns and the setting exist (routine check-in defaults on)',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'venue_checkins'
      and column_name in ('planned_end_at', 'play_windows', 'plan_id', 'arrival_until')) = 4
    and (select column_default from information_schema.columns where table_schema = 'public'
          and table_name = 'presence_settings' and column_name = 'routine_auto_checkin') = 'true');
  perform pg_temp.ok('R1 one pg_cron job each: materializer */15, reminders */5 (applied twice)',
    (select count(*) from cron.job where jobname = 'pickleague-materialize-court-routines'
       and schedule = '*/15 * * * *' and command like '%public.materialize_court_routines()%') = 1
    and (select count(*) from cron.job where jobname = 'pickleague-court-routine-reminders'
       and schedule = '*/5 * * * *' and command like '%public.process_court_routine_reminders()%') = 1);
  perform pg_temp.ok('R1 the plan link takes the occurrence''s planned end (migration_court_routines_planned_end.sql, applied after the routines file)',
    (select prosrc like '%new.planned_end_at := greatest(v_occ.planned_end_at, new.checked_in_at + interval ''30 minutes'')%'
       from pg_proc where oid = 'public._pl_checkin_link_plan()'::regprocedure));
  perform pg_temp.ok('R1 both venue_checkins triggers exist once',
    (select count(*) from pg_trigger where tgrelid = 'public.venue_checkins'::regclass
      and tgname in ('trg_venue_checkins_plan_link', 'trg_venue_checkins_plan_kept') and not tgisinternal) = 2);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R1 block crashed', false, sqlerrm);
end $$;


-- ════ R2 the window rules (foundation 1.52.0 validateWindows) ═══════════
do $$
declare
  good jsonb := jsonb_build_array(pg_temp.w(0, 90, 'closed', 'friends'), pg_temp.w(90, 180, 'open', '3.5+'));
  function_problem text;
  c record;
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('R2 closed then open over 3 hours passes', public._pl_windows_problem(good, 180) is null);
  perform pg_temp.ok('R2 one window, mode not said, passes',
    public._pl_windows_problem(jsonb_build_array(pg_temp.w(0, 60)), 60) is null);
  for c in
    select * from (values
      ('bad_length', null::jsonb, 50),
      ('empty', '[]'::jsonb, 60),
      ('too_many', jsonb_build_array(pg_temp.w(0, 15), pg_temp.w(15, 30), pg_temp.w(30, 45), pg_temp.w(45, 60),
                                     pg_temp.w(60, 75), pg_temp.w(75, 90), pg_temp.w(90, 105)), 105),
      ('off_step', jsonb_build_array(pg_temp.w(0, 50), pg_temp.w(50, 60)), 60),
      ('too_short', jsonb_build_array(pg_temp.w(0, 0), pg_temp.w(0, 60)), 60),
      ('not_from_start', jsonb_build_array(pg_temp.w(15, 60)), 60),
      ('gap', jsonb_build_array(pg_temp.w(0, 30), pg_temp.w(45, 60)), 60),
      ('overlap', jsonb_build_array(pg_temp.w(0, 45), pg_temp.w(30, 60)), 60),
      ('not_to_end', jsonb_build_array(pg_temp.w(0, 45)), 60),
      ('bad_mode', jsonb_build_array(pg_temp.w(0, 60, 'social')), 60),
      ('bad_hint', jsonb_build_array(pg_temp.w(0, 60, 'closed', '3.5+')), 60),
      ('bad_hint', jsonb_build_array(pg_temp.w(0, 60, null, 'friends')), 60),
      ('group_too_big', jsonb_build_array(pg_temp.w(0, 60, 'closed', null,
         (select jsonb_agg(gen_random_uuid()) from generate_series(1, 8)))), 60)) t(problem, windows, len)
  loop
    function_problem := public._pl_windows_problem(c.windows, c.len) ->> 'problem';
    perform pg_temp.ok('R2 refused as ' || c.problem, function_problem = c.problem, function_problem);
  end loop;
  perform pg_temp.ok('R2 _pl_windows_now: before, inside, the run end, the next open start',
    (select x ->> 'mode' = 'closed' and x ->> 'position' = 'inside'
            and (x ->> 'until')::timestamptz = now() + interval '30 minutes'
            and (x ->> 'next_open_at')::timestamptz = now() + interval '30 minutes'
       from public._pl_windows_now(jsonb_build_array(
              pg_temp.aw(now() - interval '30 minutes', now(), 'closed'),
              pg_temp.aw(now(), now() + interval '30 minutes', 'closed'),
              pg_temp.aw(now() + interval '30 minutes', now() + interval '2 hours', 'open')), now()) x)
    and public._pl_checkin_mode_at(jsonb_build_array(
          pg_temp.aw(now() + interval '10 minutes', now() + interval '1 hour', 'open')), now()) = 'open'
    and public._pl_checkin_mode_at(jsonb_build_array(
          pg_temp.aw(now() - interval '2 hours', now() - interval '1 hour', 'closed')), now()) = 'closed'
    and public._pl_checkin_mode_at(null, now()) is null);
  perform pg_temp.ok('R2 the summary reads like the app''s',
    public._pl_windows_summary(jsonb_build_array(
      pg_temp.aw('2027-01-04 09:00Z', '2027-01-04 10:30Z', 'closed'),
      pg_temp.aw('2027-01-04 10:30Z', '2027-01-04 12:00Z', 'open')), '2027-01-04 09:10Z', 'UTC')
      = 'Closed group until 10:30 AM, then open play',
    public._pl_windows_summary(jsonb_build_array(
      pg_temp.aw('2027-01-04 09:00Z', '2027-01-04 10:30Z', 'closed'),
      pg_temp.aw('2027-01-04 10:30Z', '2027-01-04 12:00Z', 'open')), '2027-01-04 09:10Z', 'UTC'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R2 block crashed', false, sqlerrm);
end $$;


-- ════ R3 create, edit, delete (starred courts only) ═════════════════════
do $$
declare
  j  jsonb;
  e  jsonb;
  r  public.court_routines;
  r2 public.court_routines;
begin
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.save_court_routine(null, 'test:cr-home', '09:00:37', 31, 'America/Los_Angeles', 180,
         jsonb_build_array(
           pg_temp.w(0, 90, 'closed', 'friends', jsonb_build_array(pg_temp.p('RF'), pg_temp.p('RS'), 'junk', pg_temp.p('RF'))),
           pg_temp.w(90, 180, 'open', 'all_levels')));
  perform pg_temp.ok('R3 a routine at a starred court is saved and listed', jsonb_array_length(j) = 1, j::text);
  perform pg_temp.as_admin();
  r := pg_temp.routine('RO', 'test:cr-home', '09:00');
  perform pg_temp.ok('R3 time to the minute, zone kept, length and windows stored',
    r.local_time = '09:00' and r.tz = 'America/Los_Angeles' and r.length_min = 180 and r.days = 31
    and jsonb_array_length(r.windows) = 2, row_to_json(r)::text);
  perform pg_temp.ok('R3 the closed group keeps friends only (once): a stranger and junk dropped',
    r.windows -> 0 -> 'group' = jsonb_build_array(pg_temp.p('RF')::text), (r.windows -> 0 -> 'group')::text);

  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.save_court_routine(null, 'test:cr-home-osm', '18:00', 96, 'Mars/Base', 60, null);
  perform pg_temp.as_admin();
  r2 := pg_temp.routine('RO', 'test:cr-home', '18:00');
  perform pg_temp.ok('R3 a duplicate court id is stored canonical; a bad zone falls back to mine; no windows = one, not said',
    r2.venue_id = 'test:cr-home' and r2.tz = public._pickleague_tz_for(pg_temp.p('RO'))
    and r2.windows = jsonb_build_array(jsonb_build_object('start_min', 0, 'end_min', 60, 'mode', null, 'hint', null, 'group', '[]'::jsonb)),
    row_to_json(r2)::text);

  perform pg_temp.as_user(pg_temp.p('RO'));
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-unstarred', '09:00', 31, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 an unstarred court: pl:routine.not_starred', e ->> 'hint' = 'pl:routine.not_starred', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-nope', '09:00', 31, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 a court not in Pickleague: pl:court.gone', e ->> 'hint' = 'pl:court.gone', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, null, '09:00', 31, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 no court: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '09:00', 0, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 no days: pl:routine.bad_days', e ->> 'hint' = 'pl:routine.bad_days', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '09:00', 128, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 days past Sunday: pl:routine.bad_days', e ->> 'hint' = 'pl:routine.bad_days', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', null, 31, 'UTC', 60)$q$);
  perform pg_temp.ok('R3 no time: pl:routine.bad_time', e ->> 'hint' = 'pl:routine.bad_time', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '09:00', 31, 'UTC', 20)$q$);
  perform pg_temp.ok('R3 20 minutes: pl:routine.bad_length', e ->> 'hint' = 'pl:routine.bad_length', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '09:00', 31, 'UTC', 255)$q$);
  perform pg_temp.ok('R3 over 4 hours: pl:routine.bad_length', e ->> 'hint' = 'pl:routine.bad_length', e::text);
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '09:00', 31, 'UTC', 50)$q$);
  perform pg_temp.ok('R3 off the 15-minute step: pl:routine.bad_length', e ->> 'hint' = 'pl:routine.bad_length', e::text);
  e := pg_temp.err(format('select public.save_court_routine(null, %L, %L, 31, %L, 60, %L::jsonb)', 'test:cr-home', '09:00', 'UTC',
         jsonb_build_array(pg_temp.w(0, 30, 'closed'), pg_temp.w(45, 60, 'open'))));
  perform pg_temp.ok('R3 a gap: pl:windows.bad, DETAIL {"problem": "gap", "index": 1}',
    e ->> 'hint' = 'pl:windows.bad' and (e ->> 'detail')::jsonb = '{"problem": "gap", "index": 1}'::jsonb, e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R3 nothing refused was stored', pg_temp.routines('RO') = 2, pg_temp.routines('RO')::text);

  -- Edit.
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.save_court_routine(r2.id, 'test:cr-home', '19:15', 96, 'UTC', 90, null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R3 an edit changes time, zone and length in place',
    (select local_time = '19:15' and tz = 'UTC' and length_min = 90 from public.court_routines where id = r2.id)
    and pg_temp.routines('RO') = 2);
  perform pg_temp.as_user(pg_temp.p('RF'));
  e := pg_temp.err(format('select public.save_court_routine(%L, %L, %L, 31, %L, 60)', r2.id, 'test:cr-home', '09:00', 'UTC'));
  perform pg_temp.ok('R3 editing another player''s routine: pl:routine.not_found', e ->> 'hint' = 'pl:routine.not_found', e::text);
  e := pg_temp.err(format('select public.delete_court_routine(%L)', r2.id));
  perform pg_temp.ok('R3 deleting another player''s routine: pl:routine.not_found', e ->> 'hint' = 'pl:routine.not_found', e::text);
  e := pg_temp.err(format('select public.set_court_routine_active(%L, false)', r2.id));
  perform pg_temp.ok('R3 pausing another player''s routine: pl:routine.not_found', e ->> 'hint' = 'pl:routine.not_found', e::text);

  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.set_court_routine_active(r2.id, false);
  perform pg_temp.ok('R3 set inactive', (select not (x ->> 'active')::boolean from jsonb_array_elements(j) x where x ->> 'id' = r2.id::text));
  j := public.delete_court_routine(r2.id);
  perform pg_temp.ok('R3 deleted: one left', jsonb_array_length(j) = 1, j::text);
  e := pg_temp.err(format('select public.delete_court_routine(%L)', r2.id));
  perform pg_temp.ok('R3 deleted twice: pl:routine.not_found', e ->> 'hint' = 'pl:routine.not_found', e::text);

  perform pg_temp.as_signed_out();
  e := pg_temp.err($q$select public.list_my_court_routines()$q$);
  perform pg_temp.ok('R3 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R3 block crashed', false, sqlerrm);
end $$;


-- ════ R4 at most 12 ══════════════════════════════════════════════════════
do $$
declare
  e jsonb;
  i int;
begin
  perform pg_temp.as_user(pg_temp.p('RL'));
  for i in 1 .. 12 loop
    perform public.save_court_routine(null, 'test:cr-home', make_time(6 + i, 0, 0), 31, 'UTC', 60);
  end loop;
  e := pg_temp.err($q$select public.save_court_routine(null, 'test:cr-home', '20:30', 31, 'UTC', 60)$q$);
  perform pg_temp.ok('R4 a 13th routine: pl:routine.limit', e ->> 'hint' = 'pl:routine.limit', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R4 still 12', pg_temp.routines('RL') = 12, pg_temp.routines('RL')::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R4 block crashed', false, sqlerrm);
end $$;


-- ════ R5 occurrences: DST, midnight, skip / move / undo ═══════════════════
do $$
declare
  r   public.court_routines;
  m   public.court_routines;
  nn  public.court_routines;
  o   public.court_plans;
  o2  public.court_plans;
  v_nov7 uuid;
  n   int;
  e   jsonb;
  j   jsonb;
begin
  -- RO's home routine becomes Sundays 9:00 Los Angeles, 3 hours.
  perform pg_temp.as_admin();
  r := pg_temp.routine('RO', 'test:cr-home');
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.save_court_routine(r.id, 'test:cr-home', '09:00', 64, 'America/Los_Angeles', 180,
    jsonb_build_array(pg_temp.w(0, 90, 'closed', 'friends', jsonb_build_array(pg_temp.p('RF'))), pg_temp.w(90, 180, 'open')));
  perform pg_temp.as_admin();
  delete from public.court_plans where routine_id = r.id;

  -- Saturday 2027-10-30 8 PM PDT: tomorrow is Sunday, still daylight time.
  n := public._pl_materialize_court_routines(r.id, '2027-10-30 20:00-07');
  o := pg_temp.occ(r.id, '2027-10-31');
  perform pg_temp.ok('R5 Sunday before the DST change: 9:00 PDT = 16:00 UTC, 3 hours',
    n = 1 and o.planned_at = '2027-10-31 16:00+00' and o.planned_end_at = '2027-10-31 19:00+00' and o.status = 'planned',
    n || ' ' || coalesce(o.planned_at::text, 'none'));
  perform pg_temp.ok('R5 its windows are absolute from the start (closed 90 min, then open)',
    (o.windows -> 0 ->> 'starts_at')::timestamptz = o.planned_at
    and (o.windows -> 1 ->> 'starts_at')::timestamptz = o.planned_at + interval '90 minutes'
    and (o.windows -> 1 ->> 'ends_at')::timestamptz = o.planned_end_at
    and o.windows -> 0 ->> 'mode' = 'closed' and o.windows -> 1 ->> 'mode' = 'open', o.windows::text);

  -- Saturday 2027-11-06 8 PM PDT: tomorrow (Sunday) DST has ended.
  n := public._pl_materialize_court_routines(r.id, '2027-11-06 20:00-07');
  o := pg_temp.occ(r.id, '2027-11-07');
  v_nov7 := o.id;
  perform pg_temp.ok('R5 Sunday after the DST change keeps 9:00 local: 9:00 PST = 17:00 UTC',
    n = 1 and o.planned_at = '2027-11-07 17:00+00'
    and (o.planned_at at time zone 'America/Los_Angeles')::time = '09:00', coalesce(o.planned_at::text, 'none'));
  perform pg_temp.ok('R5 a second run makes nothing new',
    public._pl_materialize_court_routines(r.id, '2027-11-06 20:00-07') = 0
    and (select count(*) from public.court_plans where routine_id = r.id and routine_date = '2027-11-07') = 1);
  perform pg_temp.ok('R5 a day not in the mask (Saturday) makes nothing',
    public._pl_materialize_court_routines(r.id, '2027-11-05 20:00-07') = 0);

  -- Skip, then a save and a re-run: still skipped.
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.skip_court_routine_occurrence(o.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 Skip today cancels the occurrence', (pg_temp.plan(o.id)).status = 'cancelled');
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.save_court_routine(r.id, 'test:cr-home', '09:00', 64, 'America/Los_Angeles', 180,
    jsonb_build_array(pg_temp.w(0, 90, 'closed', 'friends', jsonb_build_array(pg_temp.p('RF'))), pg_temp.w(90, 180, 'open')));
  perform pg_temp.as_admin();
  n := public._pl_materialize_court_routines(r.id, '2027-11-06 20:00-07');
  perform pg_temp.ok('R5 a skipped day survives a save and a re-run (never made again)',
    n = 0 and (pg_temp.plan(o.id)).status = 'cancelled'
    and (select count(*) from public.court_plans where routine_id = r.id and routine_date = '2027-11-07') = 1, n::text);

  perform pg_temp.as_user(pg_temp.p('RF'));
  e := pg_temp.err(format('select public.skip_court_routine_occurrence(%L)', o.id));
  perform pg_temp.ok('R5 skipping another player''s occurrence: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', e::text);
  e := pg_temp.err(format('select public.unskip_court_routine_occurrence(%L)', o.id));
  perform pg_temp.ok('R5 undoing another player''s skip: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', e::text);

  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.unskip_court_routine_occurrence(o.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 Undo makes it planned again', (pg_temp.plan(o.id)).status = 'planned');

  -- Change today's time: 10:30 local the same day; end and windows move too.
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.move_court_routine_occurrence(o.id, '2027-11-07 10:30-08');
  perform pg_temp.as_admin();
  o2 := pg_temp.plan(o.id);
  perform pg_temp.ok('R5 moved to 10:30: start, end and windows follow',
    o2.planned_at = '2027-11-07 18:30+00' and o2.planned_end_at = '2027-11-07 21:30+00'
    and (o2.windows -> 0 ->> 'starts_at')::timestamptz = '2027-11-07 18:30+00'
    and (o2.windows -> 1 ->> 'starts_at')::timestamptz = '2027-11-07 20:00+00', row_to_json(o2)::text);
  perform pg_temp.as_user(pg_temp.p('RO'));
  e := pg_temp.err(format('select public.move_court_routine_occurrence(%L, %L)', o.id, '2027-11-08 10:30-08'));
  perform pg_temp.ok('R5 moving to another day: pl:plan.bad_time', e ->> 'hint' = 'pl:plan.bad_time', e::text);
  e := pg_temp.err(format('select public.move_court_routine_occurrence(%L, %L)', o.id, now() - interval '1 hour'));
  perform pg_temp.ok('R5 moving into the past: pl:plan.bad_time', e ->> 'hint' = 'pl:plan.bad_time', e::text);

  -- Midnight: 23:30 UTC for 90 minutes (runs past midnight), and 00:15 UTC.
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.save_court_routine(null, 'test:cr-two', '23:30', 127, 'UTC', 90,
    jsonb_build_array(pg_temp.w(0, 60, 'closed'), pg_temp.w(60, 90, 'open', 'near_my_level')));
  perform pg_temp.as_admin();
  m := pg_temp.routine('RO', 'test:cr-two');
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.save_court_routine(null, 'test:cr-three', '00:15', 127, 'UTC', 60, null);
  perform pg_temp.as_admin();
  nn := pg_temp.routine('RO', 'test:cr-three', '00:15');
  delete from public.court_plans where routine_id in (m.id, nn.id);
  n := public._pl_materialize_court_routines(m.id, '2027-12-01 23:40+00');
  o := pg_temp.occ(m.id, '2027-12-02');
  perform pg_temp.ok('R5 23:30 at 23:40: today''s is past, tomorrow''s is made, ending after midnight',
    n = 1 and (pg_temp.occ(m.id, '2027-12-01')).id is null
    and o.planned_at = '2027-12-02 23:30+00' and o.planned_end_at = '2027-12-03 01:00+00'
    and (o.windows -> 1 ->> 'starts_at')::timestamptz = '2027-12-03 00:30+00', coalesce(row_to_json(o)::text, 'none'));
  n := public._pl_materialize_court_routines(nn.id, '2027-12-01 23:40+00');
  o := pg_temp.occ(nn.id, '2027-12-02');
  perform pg_temp.ok('R5 00:15 at 23:40: the next one is 35 minutes later, dated the next day',
    n = 1 and o.planned_at = '2027-12-02 00:15+00', coalesce(row_to_json(o)::text, 'none'));

  -- Another routine 15 minutes after a planned one at the same court: covered.
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.save_court_routine(null, 'test:cr-three', '00:30', 127, 'UTC', 60, null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 a stop within 30 minutes of another plan of mine there is not made',
    public._pl_materialize_court_routines((pg_temp.routine('RO', 'test:cr-three', '00:30')).id, '2027-12-01 23:40+00') = 0
    and (pg_temp.occ((pg_temp.routine('RO', 'test:cr-three', '00:30')).id, '2027-12-02')).id is null);

  -- Inactive: upcoming planned ones go, none are made.
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.set_court_routine_active(m.id, false);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 inactive: its upcoming occurrences are gone, and none are made',
    (pg_temp.occ(m.id, '2027-12-02')).id is null
    and public._pl_materialize_court_routines(m.id, '2027-12-01 23:40+00') = 0);

  -- list_my_court_routines carries next and occurrences.
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.list_my_court_routines();
  perform pg_temp.ok('R5 my list: 4 routines, starred, the moved Sunday among the home routine''s occurrences',
    jsonb_array_length(j) = 4
    and (select bool_and((x ->> 'starred')::boolean and jsonb_typeof(x -> 'occurrences') = 'array') from jsonb_array_elements(j) x)
    and exists (select 1 from jsonb_array_elements(j) x, jsonb_array_elements(x -> 'occurrences') oc
                 where x ->> 'id' = r.id::text and oc ->> 'plan_id' = v_nov7::text
                   and (oc ->> 'planned_at')::timestamptz = '2027-11-07 18:30+00' and oc ->> 'status' = 'planned'),
    j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 block crashed', false, sqlerrm);
end $$;


-- ════ R6 arrival at a routine court ══════════════════════════════════════
do $$
declare
  j   jsonb;
  pl  public.court_plans;
  c   public.venue_checkins;
  pu  public.push_outbox;
  e   jsonb;
  old timestamptz;
begin
  -- RA: automatic check-in OFF, routine check-in on (the default).
  perform pg_temp.due_routine('RA', 'test:cr-arr', 240,
    jsonb_build_array(pg_temp.w(0, 90, 'closed', 'friends', jsonb_build_array(pg_temp.p('RF'))), pg_temp.w(90, 240, 'open', 'all_levels')));
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RA');
  perform pg_temp.ok('R6 saving makes the occurrence about 10 minutes from now',
    pl.planned_at = date_trunc('minute', now() + interval '10 minutes')
    and pl.planned_end_at = pl.planned_at + interval '4 hours', coalesce(pl.planned_at::text, 'none'));
  perform pg_temp.ok('R6 the gate lets a routine arrival through with automatic check-in off',
    public._pl_court_arrival_off(pg_temp.p('RA'), 'test:cr-arr') is null);

  j := pg_temp.arrive('RA', 'test:cr-arr', pg_temp.i('RA'));
  c := pg_temp.vci(pg_temp.i('RA'));
  perform pg_temp.ok('R6 queued and checked in', (j ->> 'queued')::boolean and c.id is not null, j::text);
  perform pg_temp.ok('R6 it keeps the occurrence: plan, planned end, windows',
    c.plan_id = pl.id and c.planned_end_at = pl.planned_end_at and c.play_windows = pl.windows, row_to_json(c)::text);
  perform pg_temp.ok('R6 the 2-hour arrival length (the planned end is later) and arrival_until = its end',
    c.expires_at = c.checked_in_at + interval '2 hours' and c.arrival_until = c.expires_at and c.via_arrival);
  perform pg_temp.ok('R6 the occurrence is completed by it', (pg_temp.plan(pl.id)).status = 'completed'
    and (pg_temp.plan(pl.id)).checkin_id = c.id);
  pu := pg_temp.push_row('RA', 'arrival_checkin');
  perform pg_temp.ok('R6 the push says until when, and carries plan_id and planned_end_at',
    pu.title like '✅ Checked in at CR Test Courts Arrival until %' and pu.push_data ->> 'plan_id' = pl.id::text
    and (pu.push_data ->> 'planned_end_at')::timestamptz = pl.planned_end_at, pu.title || ' / ' || pu.body);

  -- Take-back within 5 minutes: the occurrence goes back to planned.
  perform pg_temp.as_user(pg_temp.p('RA'));
  j := public.cancel_court_arrival(p_venue => 'test:cr-arr');
  perform pg_temp.as_admin();
  c := pg_temp.vci(pg_temp.i('RA'));
  perform pg_temp.ok('R6 leaving within 5 minutes takes it back', (j ->> 'removed')::boolean and c.taken_back_at is not null, j::text);
  perform pg_temp.ok('R6 ... and the occurrence is planned again, unlinked',
    (pg_temp.plan(pl.id)).status = 'planned' and (pg_temp.plan(pl.id)).checkin_id is null and c.plan_id is null);
  perform pg_temp.ok('R6 ... and its "Checked in" push is gone', pg_temp.pushes('RA', 'arrival_checkin') = 0);

  -- RA2: "Staying until" when the planned end is later than the first stage.
  perform pg_temp.due_routine('RA2', 'test:cr-arr', 240, null);
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RA2');
  perform pg_temp.arrive('RA2', 'test:cr-arr', pg_temp.i('RA2'));
  c := pg_temp.vci(pg_temp.i('RA2'));
  perform pg_temp.ok('R6 RA2 checked in for the first stage', c.plan_id = pl.id and c.expires_at = c.arrival_until);
  -- 1 h 57 min later: 3 minutes left.
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '117 minutes', expires_at = expires_at - interval '117 minutes',
         arrival_until = arrival_until - interval '117 minutes', created_at = created_at - interval '117 minutes'
   where id = c.id;
  perform public.process_court_arrivals();
  pu := pg_temp.push_row('RA2', 'arrival_extend_until');
  perform pg_temp.ok('R6 5 minutes before: "Staying until <planned end>?" with planned_end_at, not "Still at"',
    pu.id is not null and pu.title like 'Staying until %?'
    and (pu.push_data ->> 'planned_end_at')::timestamptz = pl.planned_end_at
    and pu.push_data ->> 'checkin_id' = c.id::text and pg_temp.pushes('RA2', 'arrival_extend') = 0,
    coalesce(pu.title, 'none'));
  perform public.process_court_arrivals();
  perform pg_temp.ok('R6 ... once', pg_temp.pushes('RA2', 'arrival_extend_until') = 1);
  -- Stay until: extend_checkin to the planned end (within the 4-hour cap).
  perform pg_temp.as_user(pg_temp.p('RA2'));
  old := c.expires_at - interval '117 minutes';
  perform public.extend_checkin(p_id => c.id, p_until => pl.planned_end_at);
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R6 Stay until extends it (to the planned end, within the 4-hour cap); no longer "untouched"',
    c.expires_at > old and c.expires_at = least(pl.planned_end_at, c.checked_in_at + interval '4 hours')
    and c.expires_at <> c.arrival_until, row_to_json(c)::text);

  -- RA3: a 30-minute routine ends the arrival at its planned end.
  perform pg_temp.due_routine('RA3', 'test:cr-arr', 30, null);
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RA3');
  perform pg_temp.arrive('RA3', 'test:cr-arr', pg_temp.i('RA3'));
  c := pg_temp.vci(pg_temp.i('RA3'));
  perform pg_temp.ok('R6 a short routine: the check-in ends at its planned end (before the 2 hours)',
    c.expires_at = pl.planned_end_at and c.arrival_until = c.expires_at and c.planned_end_at = pl.planned_end_at,
    row_to_json(c)::text);

  -- RX: the court is switched off for automatic check-in: it still asks.
  perform pg_temp.due_routine('RX', 'test:cr-off', 60, null);
  perform public.set_starred_court_auto_checkin('test:cr-off', false);
  j := public.queue_court_arrival(p_venue => 'test:cr-off', p_arrived_at => now() - interval '2 minutes');
  perform pg_temp.ok('R6 a court switched off still asks (off_here)', j ->> 'reason' = 'off_here', j::text);

  -- RN: automatic check-in off AND routine check-in off.
  perform pg_temp.due_routine('RN', 'test:cr-off', 60, null);
  j := public.set_routine_auto_checkin(false);
  perform pg_temp.ok('R6 the setting reads back off', not (j ->> 'routine_auto_checkin')::boolean
    and not (public.get_court_routine_settings() ->> 'routine_auto_checkin')::boolean, j::text);
  j := public.queue_court_arrival(p_venue => 'test:cr-off', p_arrived_at => now() - interval '2 minutes');
  perform pg_temp.ok('R6 routine check-in off too: off', j ->> 'reason' = 'off', j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R6 block crashed', false, sqlerrm);
end $$;


-- ════ R7 a manual check-in keeps it; set_checkin_plan ═══════════════════
do $$
declare
  pl public.court_plans;
  c  public.venue_checkins;
  j  jsonb;
  e  jsonb;
  v_exp timestamptz;
begin
  perform pg_temp.due_routine('RM', 'test:cr-man', 120,
    jsonb_build_array(pg_temp.w(0, 60, 'closed'), pg_temp.w(60, 120, 'open')));
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RM');
  perform pg_temp.as_user(pg_temp.p('RM'));
  perform public.checkin_venue(p_id => pg_temp.i('RM'), p_venue => 'test:cr-man', p_minutes => 120, p_source => 'manual',
    p_at => null, p_lat => 40.7701, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  c := pg_temp.vci(pg_temp.i('RM'));
  perform pg_temp.ok('R7 a manual check-in in the window keeps the occurrence and takes its windows',
    c.location_confirmed and c.plan_id = pl.id and c.play_windows = pl.windows
    and (pg_temp.plan(pl.id)).status = 'completed' and (pg_temp.plan(pl.id)).checkin_id = c.id, row_to_json(c)::text);
  perform pg_temp.ok('R7 and its planned end; its own end stays what was asked (Doggle: an ordinary length)',
    c.planned_end_at = pl.planned_end_at and c.expires_at = c.checked_in_at + interval '120 minutes', row_to_json(c)::text);

  -- A planned end and windows.
  perform pg_temp.as_user(pg_temp.p('RM'));
  j := public.set_checkin_plan(c.id, now() + interval '3 hours', jsonb_build_array(
         pg_temp.aw(now() - interval '1 hour', now() + interval '1 hour', 'closed', 'competitive', jsonb_build_array(pg_temp.p('RS'))),
         pg_temp.aw(now() + interval '1 hour', now() + interval '5 hours', 'open', '3.5+')));
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R7 set_checkin_plan: runs to the planned end; windows from the check-in to that end',
    c.planned_end_at = date_trunc('minute', now() + interval '3 hours') and c.expires_at = c.planned_end_at
    and (c.play_windows -> 0 ->> 'starts_at')::timestamptz = c.checked_in_at
    and (c.play_windows -> 1 ->> 'ends_at')::timestamptz = c.planned_end_at
    and c.play_windows -> 0 -> 'group' = '[]'::jsonb and j ->> 'mode_now' = 'closed', j::text);

  -- Half an hour later, "Switch to open play now" (windows only: the end stays).
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '30 minutes', fix_at = fix_at - interval '30 minutes',
         arrival_fix_at = arrival_fix_at - interval '30 minutes', created_at = created_at - interval '30 minutes'
   where id = c.id;
  v_exp := c.expires_at;
  perform pg_temp.as_user(pg_temp.p('RM'));
  j := public.set_checkin_plan(c.id, null, jsonb_build_array(
         pg_temp.aw(now() - interval '30 minutes', now(), 'closed'),
         pg_temp.aw(now(), now() + interval '3 hours', 'open', 'all_levels')));
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R7 Switch to open play now: open from now, the end unchanged',
    j ->> 'mode_now' = 'open' and c.expires_at = v_exp and jsonb_array_length(c.play_windows) = 2, j::text);
  perform pg_temp.as_user(pg_temp.p('RM'));
  j := public.set_checkin_plan(c.id, null, null);
  perform pg_temp.ok('R7 nothing sent: windows kept, end kept', (j ->> 'expires_at')::timestamptz = v_exp
    and jsonb_array_length(j -> 'play_windows') = 2, j::text);

  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, %L::jsonb)', c.id, jsonb_build_array(
         pg_temp.aw(now() - interval '30 minutes', now(), 'closed'),
         pg_temp.aw(now() + interval '10 minutes', now() + interval '1 hour', 'open'))));
  perform pg_temp.ok('R7 a gap: pl:windows.bad (gap)', e ->> 'hint' = 'pl:windows.bad'
    and (e ->> 'detail')::jsonb ->> 'problem' = 'gap', e::text);
  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, %L::jsonb)', c.id, jsonb_build_array(
         pg_temp.aw(now() - interval '30 minutes', now() + interval '1 hour', 'open', 'pros_only'))));
  perform pg_temp.ok('R7 a hint not on the list: pl:windows.bad (bad_hint)', e ->> 'hint' = 'pl:windows.bad'
    and (e ->> 'detail')::jsonb ->> 'problem' = 'bad_hint', e::text);
  e := pg_temp.err(format('select public.set_checkin_plan(%L, %L, null)', c.id, now() - interval '5 minutes'));
  perform pg_temp.ok('R7 an end in the past: pl:plan.bad_end', e ->> 'hint' = 'pl:plan.bad_end', e::text);
  perform pg_temp.as_user(pg_temp.p('RS'));
  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, null)', c.id));
  perform pg_temp.ok('R7 another player''s check-in: pl:checkin.none', e ->> 'hint' = 'pl:checkin.none', e::text);

  -- The 4-hour cap past the last fix.
  perform pg_temp.as_user(pg_temp.p('RM'));
  j := public.set_checkin_plan(c.id, now() + interval '10 hours', null);
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R7 an end past the cap is cut to 4 hours past the last fix; windows refit to it',
    c.planned_end_at = c.fix_at + interval '4 hours' and c.expires_at = c.planned_end_at
    and (c.play_windows -> 1 ->> 'ends_at')::timestamptz = c.planned_end_at, row_to_json(c)::text);

  -- Checked out: closed.
  perform pg_temp.as_user(pg_temp.p('RM'));
  perform public.checkout_venue(p_id => c.id);
  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, null)', c.id));
  perform pg_temp.ok('R7 after check-out: pl:checkin.closed', e ->> 'hint' = 'pl:checkin.closed', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R7 the occurrence stays kept after the check-out', (pg_temp.plan(pl.id)).status = 'completed');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R7 block crashed', false, sqlerrm);
end $$;


-- ════ R8 the reminder, then Skip today ══════════════════════════════════
do $$
declare
  pl public.court_plans;
  pu public.push_outbox;
begin
  perform pg_temp.due_routine('RW', 'test:cr-arr', 60, null);
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RW');
  perform public.process_court_routine_reminders();
  pu := pg_temp.push_row('RW', 'routine_reminder');
  perform pg_temp.ok('R8 one reminder: "<time> · <court>", "We''ll check you in", plan_id',
    pu.id is not null and pu.title like '% · CR Test Courts Arrival'
    and pu.body = 'Your planned check-in. We''ll check you in when you get there.'
    and pu.push_data ->> 'plan_id' = pl.id::text and pu.category = 'notifyAutoCheckins', coalesce(pu.title, 'none'));
  perform public.process_court_routine_reminders();
  perform pg_temp.ok('R8 ... only once', pg_temp.pushes('RW', 'routine_reminder') = 1);
  pu := pg_temp.push_row('RX', 'routine_reminder');
  perform pg_temp.ok('R8 at a court switched off it says to tap Check in',
    pu.body = 'Your planned check-in. Tap Check in when you get there.', coalesce(pu.body, 'none'));
  perform pg_temp.ok('R8 none for a player already checked in there (RA2, RA3, RM)',
    pg_temp.pushes('RA2', 'routine_reminder') = 0 and pg_temp.pushes('RA3', 'routine_reminder') = 0
    and pg_temp.pushes('RM', 'routine_reminder') = 0);
  perform pg_temp.as_user(pg_temp.p('RW'));
  perform public.skip_court_routine_occurrence(pl.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R8 Skip today drops the unsent reminder', pg_temp.pushes('RW', 'routine_reminder') = 0
    and (pg_temp.plan(pl.id)).status = 'cancelled');
  perform pg_temp.ok('R8 a skipped occurrence lets no arrival through with auto check-in off',
    public._pl_routine_plan_at(pg_temp.p('RW'), 'test:cr-arr', now()) is null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R8 block crashed', false, sqlerrm);
end $$;


-- ════ R9 open to play (crowd) ═══════════════════════════════════════════
do $$
declare
  j    jsonb;
  c2   jsonb;
  n    int;
  v_open jsonb := jsonb_build_array(jsonb_build_object('starts_at', now() - interval '30 minutes',
                    'ends_at', now() + interval '90 minutes', 'mode', 'open', 'hint', null, 'group', '[]'::jsonb));
begin
  perform pg_temp.as_admin();
  insert into public.venue_checkins (id, user_id, venue_id, checked_in_at, expires_at, source, location_confirmed, fix_at, play_windows)
  values
    (pg_temp.i('C1'), pg_temp.p('C1'), 'test:cr-crowd', now() - interval '30 minutes', now() + interval '90 minutes', 'manual', true, now() - interval '30 minutes', v_open),
    (pg_temp.i('C2'), pg_temp.p('C2'), 'test:cr-crowd', now() - interval '30 minutes', now() + interval '90 minutes', 'manual', true, now() - interval '30 minutes', null),
    (pg_temp.i('C3'), pg_temp.p('C3'), 'test:cr-crowd', now() - interval '30 minutes', now() + interval '90 minutes', 'manual', true, now() - interval '30 minutes', null),
    (pg_temp.i('C6'), pg_temp.p('C6'), 'test:cr-crowd', now() - interval '30 minutes', now() + interval '90 minutes', 'manual', true, now() - interval '30 minutes', null),
    (pg_temp.i('C7'), pg_temp.p('C7'), 'test:cr-crowd', now() - interval '30 minutes', now() + interval '90 minutes', 'manual', true, now() - interval '30 minutes', v_open);
  -- C5 starts open play there (its session's check-in says nothing).
  perform pg_temp.as_user(pg_temp.p('C5'));
  perform public.start_play_session(p_id => pg_temp.i('C5'), p_kind => 'open_play', p_source => null,
    p_venue => 'test:cr-crowd', p_at => null, p_lat => 40.7401, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  -- C2: closed group with C3 and C4 (friends) and RS (not), open later.
  perform pg_temp.as_user(pg_temp.p('C2'));
  j := public.set_checkin_plan(pg_temp.i('C2'), null, jsonb_build_array(
         pg_temp.aw(now() - interval '30 minutes', now() + interval '30 minutes', 'closed', 'competitive',
                    jsonb_build_array(pg_temp.p('C3'), pg_temp.p('C4'), pg_temp.p('RS'))),
         pg_temp.aw(now() + interval '30 minutes', now() + interval '90 minutes', 'open', 'all_levels')));
  perform pg_temp.ok('R9 (setup) C2''s group keeps friends only',
    j -> 'play_windows' -> 0 -> 'group' = jsonb_build_array(pg_temp.p('C3')::text, pg_temp.p('C4')::text), j::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R9 (setup) C5''s session check-in is there',
    exists (select 1 from public.venue_checkins where id = pg_temp.i('C5') and location_confirmed and checked_out_at is null));

  -- RV: friend of C2 and C3, blocked C7.
  perform pg_temp.as_user(pg_temp.p('RV'));
  select x.open_now into n from public.venue_open_to_play(array['test:cr-crowd', 'test:cr-nope']) x where x.venue_id = 'test:cr-crowd';
  perform pg_temp.ok('R9 open to play: C1 (open window) and C5 (open play, nothing said); not C7 (blocked), C2 (closed)',
    n = 2 and (select count(*) from public.venue_open_to_play(array['test:cr-crowd', 'test:cr-nope'])) = 1, n::text);
  j := public.court_play_modes('test:cr-crowd');
  perform pg_temp.ok('R9 court_play_modes counts: 2 open, 1 closed, 2 not said',
    (j ->> 'open_now')::int = 2 and (j ->> 'closed_now')::int = 1 and (j ->> 'unsaid_now')::int = 2, j::text);
  perform pg_temp.ok('R9 rows only for players RV sees by name (C2, C3)',
    jsonb_array_length(j -> 'players') = 2
    and (select bool_and(x ->> 'user_id' in (pg_temp.p('C2')::text, pg_temp.p('C3')::text)) from jsonb_array_elements(j -> 'players') x),
    (j -> 'players')::text);
  c2 := (select x from jsonb_array_elements(j -> 'players') x where x ->> 'user_id' = pg_temp.p('C2')::text);
  perform pg_temp.ok('R9 C2: closed until 30 minutes from now, open from then',
    c2 ->> 'mode_now' = 'closed' and (c2 ->> 'mode_until')::timestamptz = now() + interval '30 minutes'
    and (c2 ->> 'next_open_at')::timestamptz = now() + interval '30 minutes', c2::text);
  perform pg_temp.ok('R9 C2''s group as RV sees it: C3 (here, named), never C4 (not here)',
    c2 -> 'closed_group' = jsonb_build_array(jsonb_build_object('user_id', pg_temp.p('C3'), 'full_name',
                                              (select full_name from public.profiles where id = pg_temp.p('C3')))),
    (c2 -> 'closed_group')::text);

  perform pg_temp.as_user(pg_temp.p('C2'));
  j := public.court_play_modes('test:cr-home-osm');
  perform pg_temp.ok('R9 another court, by a duplicate id: empty', (j ->> 'open_now')::int = 0 and jsonb_array_length(j -> 'players') = 0, j::text);
  j := public.court_play_modes('test:cr-crowd');
  c2 := (select x from jsonb_array_elements(j -> 'players') x where x ->> 'user_id' = pg_temp.p('C2')::text);
  perform pg_temp.ok('R9 C2 sees the whole group (C3 and C4)', jsonb_array_length(c2 -> 'closed_group') = 2, c2::text);

  perform pg_temp.as_user(pg_temp.p('RS'));
  j := public.court_play_modes('test:cr-crowd');
  perform pg_temp.ok('R9 a stranger: counts only (C7 counts for them), no rows',
    (j ->> 'open_now')::int = 3 and (j ->> 'closed_now')::int = 1 and jsonb_array_length(j -> 'players') = 0, j::text);
  perform pg_temp.as_user(pg_temp.p('RG'));
  j := public.court_play_modes('test:cr-crowd');
  perform pg_temp.ok('R9 a guest: counts only', (j ->> 'open_now')::int = 3 and jsonb_array_length(j -> 'players') = 0, j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R9 block crashed', false, sqlerrm);
end $$;


-- ════ R10 who sees my routines (plans_level) ════════════════════════════
do $$
declare
  j    jsonb;
  mine int;
  e    jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.list_profile_court_routines(pg_temp.p('RO'));
  mine := jsonb_array_length(j);
  perform pg_temp.ok('R10 my own: the active ones (3), the group shown to me',
    mine = 3 and exists (select 1 from jsonb_array_elements(j) x, jsonb_array_elements(x -> 'windows') w where w ? 'group'), j::text);
  perform pg_temp.as_user(pg_temp.p('RF'));
  j := public.list_profile_court_routines(pg_temp.p('RO'));
  perform pg_temp.ok('R10 a friend (plans: friends by default): the same 3, never the group',
    jsonb_array_length(j) = mine
    and not exists (select 1 from jsonb_array_elements(j) x, jsonb_array_elements(x -> 'windows') w where w ? 'group'), j::text);
  perform pg_temp.as_user(pg_temp.p('RS'));
  perform pg_temp.ok('R10 a stranger: nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('RB'));
  perform pg_temp.ok('R10 blocked: nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('RH'));
  perform pg_temp.ok('R10 a friend I hide from: nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('RG'));
  perform pg_temp.ok('R10 a friend on a guest pass: nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);

  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.set_presence_settings(p_plans_level => 'hidden');
  perform pg_temp.as_user(pg_temp.p('RF'));
  perform pg_temp.ok('R10 plans hidden: a friend sees nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.set_presence_settings(p_plans_level => 'friends', p_paused_until => now() + interval '1 hour');
  perform pg_temp.as_user(pg_temp.p('RF'));
  perform pg_temp.ok('R10 paused: a friend sees nothing', public.list_profile_court_routines(pg_temp.p('RO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform public.set_presence_settings(p_clear_pause => true);
  perform pg_temp.as_user(pg_temp.p('RF'));
  perform pg_temp.ok('R10 back to friends: a friend sees them again',
    jsonb_array_length(public.list_profile_court_routines(pg_temp.p('RO'))) = mine);

  -- The tables themselves: owner-only.
  perform pg_temp.ok('R10 a friend reads none of RO''s rows from the tables',
    (select count(*) from public.court_routines where user_id = pg_temp.p('RO')) = 0
    and (select count(*) from public.court_plans where user_id = pg_temp.p('RO')) = 0);
  perform pg_temp.as_user(pg_temp.p('RO'));
  perform pg_temp.ok('R10 RO reads their own',
    (select count(*) from public.court_routines where user_id = pg_temp.p('RO')) = 4
    and (select count(*) from public.court_plans where user_id = pg_temp.p('RO')) > 0);
  e := pg_temp.err(format('insert into public.court_routines (user_id, venue_id, local_time, days, tz, length_min) values (%L, %L, %L, 1, %L, 60)',
                          pg_temp.p('RO'), 'test:cr-home', '09:00', 'UTC'));
  perform pg_temp.ok('R10 no direct writes, even my own', e is not null, e::text);

  perform pg_temp.as_anon();
  e := pg_temp.err('select count(*) from public.court_routines');
  perform pg_temp.as_admin();
  perform pg_temp.ok('R10 anon: no table access', e ->> 'msg' like 'permission denied%', e::text);
  perform pg_temp.as_anon();
  e := pg_temp.err('select public.list_my_court_routines()');
  perform pg_temp.as_admin();
  perform pg_temp.ok('R10 anon: no RPC access', e ->> 'msg' like 'permission denied%', e::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R10 block crashed', false, sqlerrm);
end $$;


-- ════ R11 suggestions ═══════════════════════════════════════════════════
do $$
declare
  j jsonb;
  d date;
  s jsonb;
begin
  perform pg_temp.as_admin();
  -- Three weekday visits at 18:00 UTC for 2 hours at a starred court (Three),
  -- and three at an unstarred one.
  for d in select g::date from generate_series(((now() at time zone 'UTC')::date - 20)::timestamp,
                                               ((now() at time zone 'UTC')::date - 1)::timestamp, interval '1 day') g
            where extract(isodow from g) <= 5 order by g limit 3 loop
    insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at, checked_out_at, source, location_confirmed, fix_at)
    values (pg_temp.p('RO'), 'test:cr-three', (d + time '18:00') at time zone 'UTC', (d + time '20:00') at time zone 'UTC',
            (d + time '20:00') at time zone 'UTC', 'manual', true, (d + time '18:00') at time zone 'UTC'),
           (pg_temp.p('RO'), 'test:cr-unstarred', (d + time '07:00') at time zone 'UTC', (d + time '08:00') at time zone 'UTC',
            (d + time '08:00') at time zone 'UTC', 'manual', true, (d + time '07:00') at time zone 'UTC');
  end loop;
  perform pg_temp.as_user(pg_temp.p('RO'));
  j := public.suggest_court_routines('UTC');
  s := (select x from jsonb_array_elements(j) x where x ->> 'venue_id' = 'test:cr-three');
  perform pg_temp.ok('R11 a 3-day habit at a starred court: weekdays, 18:00, 2 hours',
    s ->> 'local_time' = '18:00' and (s ->> 'days')::int = 31 and (s ->> 'length_min')::int = 120
    and (s ->> 'visits')::int = 3, j::text);
  perform pg_temp.ok('R11 none at an unstarred court',
    not exists (select 1 from jsonb_array_elements(j) x where x ->> 'venue_id' = 'test:cr-unstarred'), j::text);
  perform public.save_court_routine(null, 'test:cr-three', '18:00', 31, 'UTC', 120, null);
  j := public.suggest_court_routines('UTC');
  perform pg_temp.ok('R11 once it is a routine, it isn''t suggested',
    not exists (select 1 from jsonb_array_elements(j) x where x ->> 'venue_id' = 'test:cr-three'), j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R11 block crashed', false, sqlerrm);
end $$;


-- ════ R12 unstarring leaves the routine dormant ═════════════════════════
do $$
declare
  r public.court_routines;
  j jsonb;
begin
  perform pg_temp.due_routine('RU', 'test:cr-home', 60, null);
  perform pg_temp.as_admin();
  r := pg_temp.routine('RU');
  perform pg_temp.ok('R12 (setup) an occurrence', (pg_temp.next_plan('RU')).id is not null);
  perform pg_temp.as_user(pg_temp.p('RU'));
  perform public.set_court_favorite('test:cr-home', false);
  perform pg_temp.as_admin();
  perform public.materialize_court_routines();
  perform pg_temp.ok('R12 the cron run drops its upcoming occurrence', (pg_temp.next_plan('RU')).id is null);
  perform pg_temp.ok('R12 and makes none while unstarred',
    public._pl_materialize_court_routines(r.id, now()) = 0
    and public._pl_court_arrival_off(pg_temp.p('RU'), 'test:cr-home') = 'not_starred');
  perform pg_temp.as_user(pg_temp.p('RU'));
  j := public.list_my_court_routines();
  perform pg_temp.ok('R12 the routine stays, listed as not starred',
    jsonb_array_length(j) = 1 and not (j -> 0 ->> 'starred')::boolean, j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R12 block crashed', false, sqlerrm);
end $$;


-- ════ R13 account deletion ══════════════════════════════════════════════
do $$
begin
  perform pg_temp.due_routine('RD', 'test:cr-home', 60, null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('R13 (setup) a routine and an occurrence',
    pg_temp.routines('RD') = 1 and (pg_temp.next_plan('RD')).id is not null);
  perform public._purge_account(pg_temp.p('RD'));
  perform pg_temp.ok('R13 deleting the account removes routines and plans',
    pg_temp.routines('RD') = 0 and not exists (select 1 from public.court_plans where user_id = pg_temp.p('RD')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R13 block crashed', false, sqlerrm);
end $$;


-- ════ R14 the closed / open split, end to end (user report 2026-10-22) ══════
-- "The split of closed / open time during a window does not seem to work."
-- The server stored and served a split all along (R3, R5, R7); the app never
-- sent one (the editor merged every Split straight back: foundation 1.58), and
-- three of its check-in payloads were refused or changed nothing. Each "old"
-- check below is the payload the app sent before the fix, each "new" one what
-- lib/courtRoutineRules sends now.
do $$
declare
  r   public.court_routines;
  pl  public.court_plans;
  c   public.venue_checkins;
  j   jsonb;
  e   jsonb;
  ci  timestamptz;
  v_end timestamptz;
begin
  -- A routine saved as the fixed editor sends it: Not set for 1 h, then open play.
  perform pg_temp.due_routine('RP', 'test:cr-split', 180, jsonb_build_array(pg_temp.w(0, 60), pg_temp.w(60, 180, 'open')));
  perform pg_temp.as_admin();
  r := pg_temp.routine('RP');
  pl := pg_temp.next_plan('RP');
  perform pg_temp.ok('R14 Not set then open play: stored as two windows, made absolute on the occurrence',
    jsonb_array_length(r.windows) = 2 and r.windows -> 0 -> 'mode' = 'null'::jsonb and r.windows -> 1 ->> 'mode' = 'open'
    and jsonb_array_length(pl.windows) = 2
    and (pl.windows -> 1 ->> 'starts_at')::timestamptz = pl.planned_at + interval '60 minutes'
    and (pl.windows -> 1 ->> 'ends_at')::timestamptz = pl.planned_end_at, coalesce(pl.windows::text, 'no occurrence'));
  perform pg_temp.ok('R14 its summary is the app''s line: "Open play from <time>"',
    public._pl_windows_summary(pl.windows, pl.planned_at, 'UTC')
      = 'Open play from ' || public._pl_clock(pl.planned_at + interval '60 minutes', 'UTC'),
    public._pl_windows_summary(pl.windows, pl.planned_at, 'UTC'));

  -- A split left with the same mode on both sides (an unmerged save) is accepted as sent.
  perform pg_temp.as_user(pg_temp.p('RP'));
  j := public.save_court_routine(r.id, 'test:cr-split', r.local_time, 127, 'UTC', 180,
         jsonb_build_array(pg_temp.w(0, 30, 'closed'), pg_temp.w(30, 60, 'closed'), pg_temp.w(60, 180, 'open')));
  perform pg_temp.ok('R14 same-mode neighbours: accepted, listed, the occurrence re-made with them',
    jsonb_array_length(j -> 0 -> 'windows') = 3 and jsonb_array_length(j -> 0 -> 'occurrences' -> 0 -> 'windows') = 3, j::text);

  -- The merged save: closed group 1 h, then open play 2 h.
  j := public.save_court_routine(r.id, 'test:cr-split', r.local_time, 127, 'UTC', 180,
         jsonb_build_array(pg_temp.w(0, 60, 'closed', 'friends'), pg_temp.w(60, 180, 'open', 'all_levels')));
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RP');
  perform pg_temp.ok('R14 closed then open: the occurrence carries the split',
    pl.windows -> 0 ->> 'mode' = 'closed' and pl.windows -> 1 ->> 'mode' = 'open'
    and (pl.windows -> 1 ->> 'starts_at')::timestamptz = pl.planned_at + interval '60 minutes', pl.windows::text);

  -- Checked in early (the routine is 10 minutes away): the check-in takes the split.
  perform pg_temp.as_user(pg_temp.p('RP'));
  perform public.checkin_venue(p_id => pg_temp.i('RP'), p_venue => 'test:cr-split', p_minutes => 120, p_source => 'manual',
    p_at => null, p_lat => 40.7801, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  -- Five minutes in (now() is fixed: the check-in moves back instead).
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '5 minutes', fix_at = fix_at - interval '5 minutes',
         arrival_fix_at = arrival_fix_at - interval '5 minutes', created_at = created_at - interval '5 minutes'
   where id = pg_temp.i('RP');
  c := pg_temp.vci(pg_temp.i('RP'));
  ci := c.checked_in_at;
  perform pg_temp.ok('R14 an early check-in keeps the occurrence and its split (first window after the check-in)',
    c.plan_id = pl.id and c.play_windows = pl.windows and (c.play_windows -> 0 ->> 'starts_at')::timestamptz > ci,
    row_to_json(c)::text);
  perform pg_temp.as_user(pg_temp.p('RP'));
  j := public.court_play_modes('test:cr-split');
  perform pg_temp.ok('R14 court_play_modes: closed group now (before the first window its mode applies), open from the split',
    j -> 'players' -> 0 ->> 'mode_now' = 'closed'
    and (j -> 'players' -> 0 ->> 'next_open_at')::timestamptz = pl.planned_at + interval '60 minutes', j::text);

  -- "Switch to open play now", old payload: the windows unchanged (splitting before the first window did nothing).
  j := public.set_checkin_plan(c.id, null, pl.windows);
  perform pg_temp.ok('R14 old switch payload before the first window: still closed (the bug)', j ->> 'mode_now' = 'closed', j::text);
  -- New payload: cut to the check-in, closed until now, open from now to its
  -- planned end (the occurrence's: the link sets it since
  -- migration_court_routines_planned_end.sql, and the windows run to it).
  j := public.set_checkin_plan(c.id, null, jsonb_build_array(
         pg_temp.aw(ci, now(), 'closed', 'friends'),
         pg_temp.aw(now(), c.planned_end_at, 'open')));
  perform pg_temp.ok('R14 new switch payload before the first window: open now, to the occurrence''s planned end',
    j ->> 'mode_now' = 'open' and c.planned_end_at = pl.planned_end_at
    and (j -> 'play_windows' -> 1 ->> 'ends_at')::timestamptz = pl.planned_end_at
    and (j ->> 'expires_at')::timestamptz = c.expires_at, j::text);
  j := public.court_play_modes('test:cr-split');
  perform pg_temp.ok('R14 and the court counts it open to play', (j ->> 'open_now')::int >= 1 and j -> 'players' -> 0 ->> 'mode_now' = 'open', j::text);

  -- The plan sheet, length cut to 1 h with a 1 h + 1 h split. Old payload: the
  -- last edit's windows (past the new end), refused.
  v_end := ci + interval '60 minutes';
  e := pg_temp.err(format('select public.set_checkin_plan(%L, %L, %L::jsonb)', c.id, v_end, jsonb_build_array(
         pg_temp.aw(ci, ci + interval '60 minutes', 'closed'),
         pg_temp.aw(ci + interval '60 minutes', ci + interval '120 minutes', 'open'))));
  perform pg_temp.ok('R14 old plan-sheet payload after a shorter length: pl:windows.bad too_short (the bug)',
    e ->> 'hint' = 'pl:windows.bad' and (e ->> 'detail')::jsonb ->> 'problem' = 'too_short', coalesce(e::text, 'accepted'));
  -- New payload: the windows the sheet shows, fitted to the length.
  j := public.set_checkin_plan(c.id, v_end, jsonb_build_array(pg_temp.aw(ci, v_end, 'closed')));
  perform pg_temp.ok('R14 new plan-sheet payload: saved, planned to the new end',
    (j ->> 'planned_end_at')::timestamptz = date_trunc('minute', v_end) and jsonb_array_length(j -> 'play_windows') = 1, j::text);

  -- A routine arrival 25 minutes late whose first window (15 min) ended before the check-in.
  perform pg_temp.as_admin();
  update public.venue_checkins
     set play_windows = jsonb_build_array(
           pg_temp.aw(ci - interval '20 minutes', ci - interval '5 minutes', 'open'),
           pg_temp.aw(ci - interval '5 minutes', ci + interval '2 hours', 'closed')),
         planned_end_at = ci + interval '2 hours', expires_at = ci + interval '2 hours'
   where id = c.id;
  perform pg_temp.as_user(pg_temp.p('RP'));
  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, %L::jsonb)', c.id, jsonb_build_array(
         pg_temp.aw(ci - interval '20 minutes', ci - interval '5 minutes', 'open'),
         pg_temp.aw(ci - interval '5 minutes', now(), 'closed'),
         pg_temp.aw(now(), ci + interval '2 hours', 'open'))));
  perform pg_temp.ok('R14 old switch payload with a window over before the check-in: pl:windows.bad too_short (the bug)',
    e ->> 'hint' = 'pl:windows.bad' and (e ->> 'detail')::jsonb ->> 'problem' = 'too_short', coalesce(e::text, 'accepted'));
  j := public.set_checkin_plan(c.id, null, jsonb_build_array(
         pg_temp.aw(ci, now(), 'closed'), pg_temp.aw(now(), ci + interval '2 hours', 'open')));
  perform pg_temp.ok('R14 new switch payload (cut to the check-in): open now', j ->> 'mode_now' = 'open', j::text);

  -- Extended past the planned end (Stay 1 more hour): checked in 2 h 10 min ago,
  -- planned to 10 minutes ago, open then closed, running 50 more minutes.
  ci := now() - interval '130 minutes';
  perform pg_temp.as_admin();
  update public.venue_checkins
     set checked_in_at = ci, created_at = ci, fix_at = now() - interval '5 minutes',
         play_windows = jsonb_build_array(
           pg_temp.aw(ci, now() - interval '40 minutes', 'open'),
           pg_temp.aw(now() - interval '40 minutes', now() - interval '10 minutes', 'closed')),
         planned_end_at = now() - interval '10 minutes', expires_at = now() + interval '50 minutes'
   where id = c.id;
  perform pg_temp.as_user(pg_temp.p('RP'));
  j := public.set_checkin_plan(c.id, null, null);
  perform pg_temp.ok('R14 (setup) past the planned end the last mode carries on: closed', j ->> 'mode_now' = 'closed', j::text);
  -- Old payload: splitting after the last window changed nothing, so the same windows went back.
  j := public.set_checkin_plan(c.id, null, j -> 'play_windows');
  perform pg_temp.ok('R14 old switch payload past the planned end: unchanged, still closed (the bug)', j ->> 'mode_now' = 'closed', j::text);
  -- Sending a split to the check-in's end without moving the planned end is refused.
  e := pg_temp.err(format('select public.set_checkin_plan(%L, null, %L::jsonb)', c.id, jsonb_build_array(
         pg_temp.aw(ci, now() - interval '40 minutes', 'open'),
         pg_temp.aw(now() - interval '40 minutes', now(), 'closed'),
         pg_temp.aw(now(), now() + interval '50 minutes', 'open'))));
  perform pg_temp.ok('R14 a split past the planned end with the end kept: pl:windows.bad too_short (why the app sends the end)',
    e ->> 'hint' = 'pl:windows.bad' and (e ->> 'detail')::jsonb ->> 'problem' = 'too_short', coalesce(e::text, 'accepted'));
  j := public.set_checkin_plan(c.id, now() + interval '50 minutes', jsonb_build_array(
         pg_temp.aw(ci, now() - interval '40 minutes', 'open'),
         pg_temp.aw(now() - interval '40 minutes', now(), 'closed'),
         pg_temp.aw(now(), now() + interval '50 minutes', 'open')));
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R14 new switch payload past the planned end (plan moved to the check-in''s end): open now',
    j ->> 'mode_now' = 'open' and c.planned_end_at = date_trunc('minute', now() + interval '50 minutes')
    and c.expires_at = c.planned_end_at and jsonb_array_length(c.play_windows) = 3, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R14 block crashed', false, sqlerrm);
end $$;


-- ════ R15 a check-in by hand reaches the open part of a 3-hour split ═══════
-- The review of the R14 fix: on the web (no geofence arrivals) every routine
-- check-in is made by hand, the app asked for 2 hours, and the link left
-- planned_end_at null, so a routine closed 2 h then open 1 h ended while
-- still closed, with nothing offering the rest. Now the link also takes the
-- occurrence's planned end (migration_court_routines_planned_end.sql; the
-- check-in's own end stays what was asked, as in Doggle). RQ sends the old
-- payload (2 hours) and taps "Stay until <planned end>" on the line under the
-- check-in; RQ2 sends what lib/courtCheckin sends now (the routine's length,
-- routineCheckinMinutes); RQ3 checks in 25 minutes into a 30-minute routine.
-- now() is fixed: time passes by moving the check-in back.
do $$
declare
  pl    public.court_plans;
  c     public.venue_checkins;
  j     jsonb;
  v_min int;
begin
  -- RQ: the routine as the fixed editor saves it, 10 minutes from now.
  perform pg_temp.due_routine('RQ', 'test:cr-split3a', 180,
    jsonb_build_array(pg_temp.w(0, 120, 'closed', 'friends'), pg_temp.w(120, 180, 'open')));
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RQ');
  perform pg_temp.ok('R15 (setup) the occurrence: closed 2 h, then open 1 h',
    pl.windows -> 0 ->> 'mode' = 'closed' and pl.windows -> 1 ->> 'mode' = 'open'
    and (pl.windows -> 1 ->> 'starts_at')::timestamptz = pl.planned_at + interval '120 minutes'
    and pl.planned_end_at = pl.planned_at + interval '180 minutes', coalesce(pl.windows::text, 'no occurrence'));

  -- Old payload (the web app before this fix): 2 hours.
  perform pg_temp.as_user(pg_temp.p('RQ'));
  perform public.checkin_venue(p_id => pg_temp.i('RQ'), p_venue => 'test:cr-split3a', p_minutes => 120, p_source => 'manual',
    p_at => null, p_lat => 40.7901, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  c := pg_temp.vci(pg_temp.i('RQ'));
  perform pg_temp.ok('R15 a check-in by hand keeps the occurrence, its windows and now its planned end',
    c.plan_id = pl.id and c.play_windows = pl.windows and c.planned_end_at = pl.planned_end_at
    and (pg_temp.plan(pl.id)).status = 'completed', row_to_json(c)::text);
  perform pg_temp.ok('R15 its own end stays the 2 hours asked, still closed then: the planned end is later (the app offers Stay until)',
    c.expires_at = c.checked_in_at + interval '120 minutes'
    and public._pl_checkin_mode_at(c.play_windows, c.expires_at - interval '1 minute') = 'closed'
    and c.planned_end_at > c.expires_at + interval '1 minute', row_to_json(c)::text);

  -- 100 minutes in (closed group), "Stay until <planned end>": extend_checkin to it, no fix.
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '100 minutes', created_at = created_at - interval '100 minutes',
         fix_at = fix_at - interval '100 minutes', arrival_fix_at = arrival_fix_at - interval '100 minutes',
         expires_at = expires_at - interval '100 minutes', planned_end_at = planned_end_at - interval '100 minutes',
         play_windows = public._pl_shift_windows(play_windows, - interval '100 minutes')
   where id = c.id;
  c := pg_temp.vci(c.id);
  perform pg_temp.as_user(pg_temp.p('RQ'));
  perform public.extend_checkin(p_id => c.id, p_until => c.planned_end_at);
  j := public.set_checkin_plan(c.id, null, null);
  perform pg_temp.as_admin();
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('R15 Stay until: the check-in runs to the planned end, the split kept, closed for now',
    c.expires_at = c.planned_end_at and j ->> 'mode_now' = 'closed' and jsonb_array_length(c.play_windows) = 2
    and (c.play_windows -> 1 ->> 'ends_at')::timestamptz = c.planned_end_at, j::text);

  -- 150 minutes in: the routine's last hour.
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '50 minutes', created_at = created_at - interval '50 minutes',
         fix_at = fix_at - interval '50 minutes', arrival_fix_at = arrival_fix_at - interval '50 minutes',
         expires_at = expires_at - interval '50 minutes', planned_end_at = planned_end_at - interval '50 minutes',
         play_windows = public._pl_shift_windows(play_windows, - interval '50 minutes')
   where id = c.id;
  perform pg_temp.as_user(pg_temp.p('RQ'));
  j := public.court_play_modes('test:cr-split3a');
  perform pg_temp.ok('R15 old payload + Stay until, 150 minutes in: still checked in, open to play, counted',
    (j ->> 'open_now')::int = 1 and j -> 'players' -> 0 ->> 'checkin_id' = c.id::text
    and j -> 'players' -> 0 ->> 'mode_now' = 'open', j::text);

  -- RQ2: the same routine; the new app asks for the routine's length.
  perform pg_temp.due_routine('RQ2', 'test:cr-split3b', 180,
    jsonb_build_array(pg_temp.w(0, 120, 'closed'), pg_temp.w(120, 180, 'open')));
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RQ2');
  -- routineCheckinMinutes: to the planned end, rounded up, 30 to 240.
  v_min := least(240, greatest(30, ceil(extract(epoch from (pl.planned_end_at - now())) / 60)::int));
  perform pg_temp.as_user(pg_temp.p('RQ2'));
  perform public.checkin_venue(p_id => pg_temp.i('RQ2'), p_venue => 'test:cr-split3b', p_minutes => v_min, p_source => 'manual',
    p_at => null, p_lat => 40.8001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  c := pg_temp.vci(pg_temp.i('RQ2'));
  perform pg_temp.ok('R15 new payload (the routine''s length): runs to the planned end, the split kept',
    v_min between 180 and 200 and c.plan_id = pl.id and c.planned_end_at = pl.planned_end_at
    and c.expires_at >= pl.planned_end_at and c.expires_at < pl.planned_end_at + interval '1 minute'
    and c.play_windows = pl.windows, 'minutes ' || v_min || ' ' || row_to_json(c)::text);
  update public.venue_checkins
     set checked_in_at = checked_in_at - interval '150 minutes', created_at = created_at - interval '150 minutes',
         fix_at = fix_at - interval '150 minutes', arrival_fix_at = arrival_fix_at - interval '150 minutes',
         expires_at = expires_at - interval '150 minutes', planned_end_at = planned_end_at - interval '150 minutes',
         play_windows = public._pl_shift_windows(play_windows, - interval '150 minutes')
   where id = c.id;
  perform pg_temp.as_user(pg_temp.p('RQ2'));
  j := public.court_play_modes('test:cr-split3b');
  perform pg_temp.ok('R15 new payload, 150 minutes in (the last hour): still checked in, open to play, counted',
    (j ->> 'open_now')::int = 1 and j -> 'players' -> 0 ->> 'checkin_id' = c.id::text
    and j -> 'players' -> 0 ->> 'mode_now' = 'open', j::text);
  j := public.set_checkin_plan(c.id, null, null);
  perform pg_temp.ok('R15 and its plan reads open now, the windows to the planned end', j ->> 'mode_now' = 'open'
    and (j ->> 'planned_end_at')::timestamptz = pl.planned_end_at - interval '150 minutes'
    and (j -> 'play_windows' -> 1 ->> 'ends_at')::timestamptz = pl.planned_end_at - interval '150 minutes', j::text);

  -- RQ3: 25 minutes into a 30-minute routine: the planned end is at least 30 minutes after the check-in.
  perform pg_temp.due_routine('RQ3', 'test:cr-split3c', 30, null);
  perform pg_temp.as_admin();
  pl := pg_temp.next_plan('RQ3');
  update public.court_plans
     set planned_at = now() - interval '25 minutes', planned_end_at = now() + interval '5 minutes'
   where id = pl.id;
  perform pg_temp.as_user(pg_temp.p('RQ3'));
  perform public.checkin_venue(p_id => pg_temp.i('RQ3'), p_venue => 'test:cr-split3c', p_minutes => 120, p_source => 'manual',
    p_at => null, p_lat => 40.8101, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  c := pg_temp.vci(pg_temp.i('RQ3'));
  perform pg_temp.ok('R15 a late check-in on a short routine: planned end 30 minutes after the check-in (process_court_arrivals'' rule)',
    c.plan_id = pl.id and c.planned_end_at = c.checked_in_at + interval '30 minutes'
    and c.expires_at = c.checked_in_at + interval '120 minutes', row_to_json(c)::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R15 block crashed', false, sqlerrm);
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
