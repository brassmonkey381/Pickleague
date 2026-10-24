-- ============================================================
-- Every check-in starts the play session: persona tests for
-- migration_checkin_starts_session.sql.
--
-- NOT runnable on its own: build-checkin-session-test.mjs puts, at the marker
-- line below, migration_checkin_starts_session.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep cancel_court_arrival and court_play_modes online). Everything runs
-- inside the begin / rollback below, so the linked (live) database is left
-- untouched:
--   node supabase/tests/build-checkin-session-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs presence, court arrival and routines live already (they are).
--
-- now() is fixed for the whole transaction: waits are made by moving rows
-- into the past (pg_temp.age), never by sleeping. The jobs
-- (process_court_arrivals, expire_venue_checkins) are called directly.
--
-- Courts near 41.5 N, 101.0 W (far from every real venue; a fix 11 m north is
-- lat + 0.0001): test:cs-a 41.50, test:cs-b 41.51, test:cs-c 41.52.
--
-- Personas:
--   KM checks in by hand, checks out · KE a check-in that runs out ·
--   KA an arrival · KT an arrival taken back · KR an arrival at B taken back
--   reopens A's check-in and session · KJ a "just time it" timer, then a
--   check-in (adopted) · KU a timer alone · KS Start right after a check-in
--   (takes its session over), and the app's replay of the check-in's id ·
--   KP ▶ Play with a fix (the Start's own check-in) then Check out · KV playing
--   at A, an arrival at B moves both · KX a timer blocks an arrival as before ·
--   KO open to play: a check-in alone says nothing, Play says open ·
--   KB checks in at B by hand while playing at A · KD a replayed check-in, and
--   one the app closed before it landed · KF ▶ Play at C, a drive-by arrival
--   at A taken back gives the Play back · KG an arrival while my check-in
--   elsewhere has run out (the expiry job not run yet) · KL a check-in queued
--   offline lands after a newer Play elsewhere · KN, KQ a no-fix check-in,
--   then ▶ Play with a fix 10 and 2 minutes later
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('KM', 'b9000000-0000-4000-8000-000000000001'), ('KE', 'b9000000-0000-4000-8000-000000000002'),
  ('KA', 'b9000000-0000-4000-8000-000000000003'), ('KT', 'b9000000-0000-4000-8000-000000000004'),
  ('KR', 'b9000000-0000-4000-8000-000000000005'), ('KJ', 'b9000000-0000-4000-8000-000000000006'),
  ('KU', 'b9000000-0000-4000-8000-000000000007'), ('KS', 'b9000000-0000-4000-8000-000000000008'),
  ('KP', 'b9000000-0000-4000-8000-000000000009'), ('KV', 'b9000000-0000-4000-8000-00000000000a'),
  ('KX', 'b9000000-0000-4000-8000-00000000000b'), ('KO', 'b9000000-0000-4000-8000-00000000000c'),
  ('KB', 'b9000000-0000-4000-8000-00000000000d'), ('KD', 'b9000000-0000-4000-8000-00000000000e'),
  ('KF', 'b9000000-0000-4000-8000-00000000000f'), ('KG', 'b9000000-0000-4000-8000-000000000010'),
  ('KL', 'b9000000-0000-4000-8000-000000000011'), ('KN', 'b9000000-0000-4000-8000-000000000012'),
  ('KQ', 'b9000000-0000-4000-8000-000000000013');
grant select on _p to authenticated, anon;

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

-- A check-in by hand with a fix 11 m north of the court, as persona k (the
-- app's call). Leaves the role as k.
create function pg_temp.ci(k text, p_id uuid, p_venue text, p_lat double precision) returns public.venue_checkins
language plpgsql as $$
declare r public.venue_checkins;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select * into r from public.checkin_venue(p_id => p_id, p_venue => p_venue, p_minutes => 120,
    p_source => 'manual', p_at => null, p_lat => p_lat, p_lng => -101.0, p_accuracy_m => 10, p_fix_at => now());
  return r;
end $$;

-- An arrival 2 minutes back (due already) and one run of the job. Leaves the role as admin.
create function pg_temp.arrive(k text, p_venue text, p_id uuid) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.queue_court_arrival(p_venue => p_venue, p_arrived_at => now() - interval '2 minutes', p_checkin_id => p_id);
  perform pg_temp.as_admin();
  perform public.process_court_arrivals();
  return j;
end $$;

-- Rows, read past RLS.
create function pg_temp.vci(p_id uuid) returns public.venue_checkins language sql security definer as $$
  select * from public.venue_checkins where id = p_id
$$;
create function pg_temp.ps(p_id uuid) returns public.play_sessions language sql security definer as $$
  select * from public.play_sessions where id = p_id
$$;
create function pg_temp.sessions(k text) returns int language sql security definer as $$
  select count(*)::int from public.play_sessions where user_id = pg_temp.p(k)
$$;
create function pg_temp.open_sessions(k text) returns int language sql security definer as $$
  select count(*)::int from public.play_sessions where user_id = pg_temp.p(k) and ended_at is null
$$;
create function pg_temp.pushes(k text, p_kind text default null) returns int language sql security definer as $$
  select count(*)::int from public.push_outbox o
   where o.recipient_id = pg_temp.p(k) and (p_kind is null or o.push_data ->> 'kind' = p_kind)
$$;
-- Waiting: a check-in and the session it started move p_by into the past. Leaves the role as admin.
create function pg_temp.age(p_id uuid, p_by interval) returns void language plpgsql as $$
begin
  perform pg_temp.as_admin();
  update public.venue_checkins
     set checked_in_at = checked_in_at - p_by, expires_at = expires_at - p_by,
         checked_out_at = checked_out_at - p_by, fix_at = fix_at - p_by,
         arrival_fix_at = arrival_fix_at - p_by, created_at = created_at - p_by,
         arrival_until = arrival_until - p_by
   where id = p_id;
  update public.play_sessions
     set started_at = started_at - p_by, ended_at = ended_at - p_by, created_at = created_at - p_by
   where id = p_id;
end $$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'cs-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'CS Player ' || k)
  from _p;

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:cs-a', array['pickleball'], 'CS Test Courts A', 'court', 41.50, -101.0, 'google', 100),
  ('test:cs-b', array['pickleball'], 'CS Test Courts B', 'court', 41.51, -101.0, 'google', 100),
  ('test:cs-c', array['pickleball'], 'CS Test Courts C', 'court', 41.52, -101.0, 'google', 100);

-- Consent (check-ins and arrivals need it); A and B starred (arrivals).
do $$
declare k text;
begin
  for k in select x.k from _p x loop
    perform pg_temp.as_user(pg_temp.p(k));
    perform public.set_presence_settings(p_consent_seen => true);
    perform public.set_court_favorite('test:cs-a', true);
    perform public.set_court_favorite('test:cs-b', true);
  end loop;
  perform pg_temp.as_admin();
end $$;

create temp table _before as
  select id, pickles from public.profiles where id in (select id from _p);

-- @@MIGRATION@@


-- ════ S1 shape, grants ═══════════════════════════════════════════════════
do $$
declare
  f     text;
  v_bad text := '';
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 play_sessions.checkin_id exists, with its index',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'play_sessions' and column_name = 'checkin_id')
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'play_sessions_checkin_id_idx'));
  perform pg_temp.ok('S1 the three triggers, enabled, on their functions',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.venue_checkins'::regclass and t.tgname = 'trg_venue_checkins_session'
             and t.tgenabled = 'O' and t.tgfoid = 'public._pl_checkin_starts_session()'::regprocedure)
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.venue_checkins'::regclass and t.tgname = 'trg_venue_checkins_session_end'
             and t.tgenabled = 'O' and t.tgfoid = 'public._pl_checkin_ends_session()'::regprocedure)
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.play_sessions'::regclass and t.tgname = 'trg_play_sessions_checkin'
             and t.tgenabled = 'O' and t.tgfoid = 'public._pl_play_session_checkin()'::regprocedure));
  foreach f in array array['public._pl_checkin_starts_session()', 'public._pl_checkin_ends_session()',
                           'public._pl_play_session_checkin()', 'public.process_court_arrivals()',
                           'public._pl_venue_open_now(uuid,text)',
                           'public._pl_take_back_arrival(uuid,uuid[],timestamptz)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      v_bad := v_bad || f || ' ';
    end if;
  end loop;
  perform pg_temp.ok('S1 internal functions: no client may execute them', v_bad = '', v_bad);
  perform pg_temp.ok('S1 cancel_court_arrival and court_play_modes: signed-in players only',
    has_function_privilege('authenticated', 'public.cancel_court_arrival(text,timestamptz,boolean)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.cancel_court_arrival(text,timestamptz,boolean)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.court_play_modes(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.court_play_modes(text)', 'EXECUTE'));
  perform pg_temp.ok('S1 every new and replaced function: SECURITY DEFINER, empty search_path, one version',
    (select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('_pl_checkin_starts_session', '_pl_checkin_ends_session', '_pl_play_session_checkin',
                          'process_court_arrivals', 'cancel_court_arrival', '_pl_venue_open_now', 'court_play_modes',
                          '_pl_take_back_arrival'))
    and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('_pl_checkin_starts_session', '_pl_checkin_ends_session', '_pl_play_session_checkin',
                              'process_court_arrivals', 'cancel_court_arrival', '_pl_venue_open_now', 'court_play_modes',
                              '_pl_take_back_arrival')) = 8);
  perform pg_temp.ok('S1 no trigger on play_sessions beyond no-overlap, validity and the new link (nothing pays for a session)',
    (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
      where t.tgrelid = 'public.play_sessions'::regclass and not t.tgisinternal)
    = array['trg_play_sessions_checkin', 'trg_play_sessions_no_overlap', 'trg_play_sessions_validity']);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 block crashed', false, sqlerrm);
end $$;


-- ════ S2 a check-in by hand starts the session; Check out ends it ════════
do $$
declare
  c public.venue_checkins;
  s public.play_sessions;
  n int;
begin
  c := pg_temp.ci('KM', 'c9000000-0000-4000-8000-000000000201', 'test:cs-a', 41.5001);
  perform pg_temp.as_admin();
  s := pg_temp.ps(c.id);
  perform pg_temp.ok('S2 a check-in by hand starts an open play session: its id, its court, its time, linked',
    c.location_confirmed and s.id = c.id and s.user_id = pg_temp.p('KM') and s.kind = 'open_play'
    and s.venue_id = 'test:cs-a' and s.started_at = c.checked_in_at and s.checkin_id = c.id and s.ended_at is null
    and pg_temp.sessions('KM') = 1, s::text);
  perform pg_temp.ok('S2 ...and says nothing more (no push for the session)', pg_temp.pushes('KM') = 0);
  perform pg_temp.as_user(pg_temp.p('KM'));
  perform public.checkin_venue(p_id => 'c9000000-0000-4000-8000-000000000201', p_venue => 'test:cs-a', p_minutes => 120,
    p_source => 'manual', p_at => null, p_lat => 41.5001, p_lng => -101.0, p_accuracy_m => 10, p_fix_at => now());
  perform public.checkin_venue(p_id => 'c9000000-0000-4000-8000-000000000202', p_venue => 'test:cs-a', p_minutes => 120,
    p_source => 'manual', p_at => null, p_lat => 41.5001, p_lng => -101.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  perform pg_temp.ok('S2 a replayed check-in, or a second tap at the same court: still one session',
    pg_temp.sessions('KM') = 1 and pg_temp.ps('c9000000-0000-4000-8000-000000000202') is null);
  -- 40 minutes later, Check out.
  perform pg_temp.age(c.id, interval '40 minutes');
  perform pg_temp.as_user(pg_temp.p('KM'));
  select public.checkout_venue(p_id => c.id, p_source => null, p_at => now(),
    p_lat => 41.5001, p_lng => -101.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  perform pg_temp.as_admin();
  s := pg_temp.ps(c.id);
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('S2 Check out ends the session at the check-out (40 minutes), and the visit counts as at the court',
    n = 1 and s.ended_at = c.checked_out_at and s.ended_at = now() and s.started_at = now() - interval '40 minutes'
    and pg_temp.open_sessions('KM') = 0 and s.at_court and s.valid_reason = 'no_match_or_drill', s::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S2 block crashed', false, sqlerrm);
end $$;


-- ════ S3 a check-in that runs out ════════════════════════════════════════
do $$
declare
  c public.venue_checkins;
  s public.play_sessions;
begin
  c := pg_temp.ci('KE', 'c9000000-0000-4000-8000-000000000301', 'test:cs-a', 41.5001);
  perform pg_temp.age(c.id, interval '2 hours 10 minutes');
  perform public.expire_venue_checkins();
  s := pg_temp.ps(c.id);
  c := pg_temp.vci(c.id);
  perform pg_temp.ok('S3 the expiry job closes the check-in at its end, and the session ends there too',
    c.checked_out_at = c.expires_at and s.ended_at = c.expires_at and s.ended_at = now() - interval '10 minutes'
    and pg_temp.open_sessions('KE') = 0, s::text);
  perform pg_temp.ok('S3 ...one "Checked out" push, nothing for the session', pg_temp.pushes('KE') = 1
    and pg_temp.pushes('KE', 'arrival_expired') = 1);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S3 block crashed', false, sqlerrm);
end $$;


-- ════ S4 an arrival starts it; S5 a take-back removes it ═════════════════
do $$
declare
  j jsonb;
  c public.venue_checkins;
  s public.play_sessions;
begin
  j := pg_temp.arrive('KA', 'test:cs-a', 'c9000000-0000-4000-8000-000000000401');
  c := pg_temp.vci('c9000000-0000-4000-8000-000000000401');
  s := pg_temp.ps(c.id);
  perform pg_temp.ok('S4 an arrival check-in starts a session at the arrival, linked',
    (j ->> 'queued')::boolean and c.via_arrival and c.checked_out_at is null
    and s.started_at = now() - interval '2 minutes' and s.checkin_id = c.id and s.ended_at is null
    and s.venue_id = 'test:cs-a' and s.kind = 'open_play', coalesce(s::text, 'no session') || ' ' || coalesce(c::text, 'no check-in'));
  perform pg_temp.ok('S4 ...one push, the arrival''s own "Checked in" (nothing for the session)',
    pg_temp.pushes('KA') = 1 and pg_temp.pushes('KA', 'arrival_checkin') = 1);

  j := pg_temp.arrive('KT', 'test:cs-a', 'c9000000-0000-4000-8000-000000000501');
  perform pg_temp.as_user(pg_temp.p('KT'));
  j := public.cancel_court_arrival(p_venue => 'test:cs-a');
  perform pg_temp.as_admin();
  c := pg_temp.vci('c9000000-0000-4000-8000-000000000501');
  perform pg_temp.ok('S5 an Exit within 5 minutes takes the arrival back, and its session is gone (no stats left)',
    (j ->> 'removed')::boolean and c.taken_back_at is not null and pg_temp.sessions('KT') = 0
    and pg_temp.ps('c9000000-0000-4000-8000-000000000501') is null, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4/S5 block crashed', false, sqlerrm);
end $$;


-- ════ S6 a take-back reopens the check-in (and session) it closed ════════
do $$
declare
  j  jsonb;
  ca public.venue_checkins;
  sa public.play_sessions;
begin
  ca := pg_temp.ci('KR', 'c9000000-0000-4000-8000-000000000601', 'test:cs-c', 41.5201);
  perform pg_temp.age(ca.id, interval '30 minutes');
  j := pg_temp.arrive('KR', 'test:cs-b', 'c9000000-0000-4000-8000-000000000602');
  sa := pg_temp.ps(ca.id);
  perform pg_temp.ok('S6 an arrival at B closes my check-in at C, and C''s session ends at the arrival',
    (pg_temp.vci(ca.id)).checked_out_at = now() - interval '2 minutes' and sa.ended_at = now() - interval '2 minutes'
    and (pg_temp.ps('c9000000-0000-4000-8000-000000000602')).ended_at is null and pg_temp.open_sessions('KR') = 1,
    sa::text);
  perform pg_temp.as_user(pg_temp.p('KR'));
  j := public.cancel_court_arrival(p_venue => 'test:cs-b');
  perform pg_temp.as_admin();
  sa := pg_temp.ps(ca.id);
  perform pg_temp.ok('S6 taking B back reopens C''s check-in and its session, B''s session is gone',
    (j ->> 'removed')::boolean and (pg_temp.vci(ca.id)).checked_out_at is null and sa.ended_at is null
    and sa.started_at = now() - interval '30 minutes'
    and pg_temp.ps('c9000000-0000-4000-8000-000000000602') is null and pg_temp.sessions('KR') = 1, j::text || ' ' || sa::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S6 block crashed', false, sqlerrm);
end $$;


-- ════ S7 a timer then a check-in: adopted; S8 a timer alone ══════════════
do $$
declare
  s public.play_sessions;
  c public.venue_checkins;
begin
  perform pg_temp.as_user(pg_temp.p('KJ'));
  perform public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000701', p_kind => 'drill');
  c := pg_temp.ci('KJ', 'c9000000-0000-4000-8000-000000000701', 'test:cs-a', 41.5001);
  perform pg_temp.as_admin();
  s := pg_temp.ps('f9000000-0000-4000-8000-000000000701');
  perform pg_temp.ok('S7 a check-in during a "just time it" timer adopts it: same session, now at the court, linked',
    pg_temp.sessions('KJ') = 1 and s.ended_at is null and s.kind = 'drill' and s.venue_id = 'test:cs-a'
    and s.checkin_id = c.id and pg_temp.ps(c.id) is null, s::text);
  perform pg_temp.as_user(pg_temp.p('KJ'));
  perform public.checkout_venue(p_id => c.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S7 ...and its Check out ends it', (pg_temp.ps('f9000000-0000-4000-8000-000000000701')).ended_at = now());

  perform pg_temp.as_user(pg_temp.p('KU'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000801', p_kind => 'open_play');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S8 "No court, just time it": a timer, no check-in, nothing linked',
    s.venue_id is null and s.checkin_id is null and s.ended_at is null
    and not exists (select 1 from public.venue_checkins where user_id = pg_temp.p('KU')), s::text);
  perform pg_temp.as_user(pg_temp.p('KU'));
  perform public.end_play_session('f9000000-0000-4000-8000-000000000801', now());
  perform pg_temp.as_admin();
  perform pg_temp.ok('S8 ...End ends it as before', (pg_temp.ps('f9000000-0000-4000-8000-000000000801')).ended_at = now()
    and pg_temp.sessions('KU') = 1);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S7/S8 block crashed', false, sqlerrm);
end $$;


-- ════ S9 a Start right after a check-in takes its session over ═══════════
do $$
declare
  c public.venue_checkins;
  s public.play_sessions;
begin
  c := pg_temp.ci('KS', 'c9000000-0000-4000-8000-000000000901', 'test:cs-a', 41.5001);
  -- The app on a server without this file: Start with the check-in's own id
  -- (a replay here).
  perform pg_temp.as_user(pg_temp.p('KS'));
  select * into s from public.start_play_session(p_id => c.id, p_kind => 'open_play', p_venue => 'test:cs-a');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 the app''s Start with the check-in''s id: the same session (a replay), not a second',
    s.id = c.id and s.ended_at is null and pg_temp.sessions('KS') = 1, s::text);
  -- An older build: ▶ Play right after, with its own id, as a drill.
  perform pg_temp.age(c.id, interval '2 minutes');
  perform pg_temp.as_user(pg_temp.p('KS'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000902', p_kind => 'drill',
    p_venue => 'test:cs-a');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 a Start 2 minutes in, its own id: takes the check-in''s session over (its start, its check-in), no stray session',
    pg_temp.sessions('KS') = 1 and pg_temp.ps(c.id) is null and s.kind = 'drill' and s.ended_at is null
    and s.started_at = now() - interval '2 minutes' and s.checkin_id = c.id
    and (pg_temp.vci(c.id)).checked_out_at is null, s::text);
  -- Switch mode 20 minutes later: that part stays a session of its own.
  perform pg_temp.as_admin();
  update public.play_sessions set started_at = started_at - interval '20 minutes' where id = s.id;
  perform pg_temp.as_user(pg_temp.p('KS'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000903', p_kind => 'open_play',
    p_venue => 'test:cs-a');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 a later switch keeps the first part (22 minutes) and links the new one to the same check-in',
    pg_temp.sessions('KS') = 2 and (pg_temp.ps('f9000000-0000-4000-8000-000000000902')).ended_at = now()
    and s.started_at = now() and s.checkin_id = c.id and s.ended_at is null, s::text);
  perform pg_temp.as_user(pg_temp.p('KS'));
  perform public.checkout_venue(p_id => c.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 ...Check out ends the running one', pg_temp.open_sessions('KS') = 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 block crashed', false, sqlerrm);
end $$;


-- ════ S10 ▶ Play with a fix: its own check-in; Check out = End ════════════
do $$
declare
  s public.play_sessions;
  n int;
begin
  perform pg_temp.as_user(pg_temp.p('KP'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000a01', p_kind => 'open_play',
    p_venue => 'test:cs-a', p_at => now(), p_lat => 41.5001, p_lng => -101.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.as_admin();
  s := pg_temp.ps(s.id);
  perform pg_temp.ok('S10 ▶ Play at the court: one session, its own check-in, linked',
    pg_temp.sessions('KP') = 1 and (pg_temp.vci(s.id)).source = 'session' and s.checkin_id = s.id and s.ended_at is null, s::text);
  perform pg_temp.as_user(pg_temp.p('KP'));
  select public.checkout_venue(p_id => s.id) into n;
  perform pg_temp.as_admin();
  perform pg_temp.ok('S10 Check out of it ends the session', n = 1 and (pg_temp.ps(s.id)).ended_at = now());
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S10 block crashed', false, sqlerrm);
end $$;


-- ════ S11 arrivals and a session running ═════════════════════════════════
do $$
declare
  c  public.venue_checkins;
  j  jsonb;
begin
  -- KV: checked in (so playing) at C for 20 minutes, arrives at A.
  c := pg_temp.ci('KV', 'c9000000-0000-4000-8000-000000000b01', 'test:cs-c', 41.5201);
  perform pg_temp.age(c.id, interval '20 minutes');
  j := pg_temp.arrive('KV', 'test:cs-a', 'c9000000-0000-4000-8000-000000000b02');
  perform pg_temp.ok('S11 playing at C (its check-in''s session), an arrival at A moves both: C ends, A starts',
    (pg_temp.vci(c.id)).checked_out_at = now() - interval '2 minutes'
    and (pg_temp.ps(c.id)).ended_at = now() - interval '2 minutes'
    and (pg_temp.ps('c9000000-0000-4000-8000-000000000b02')).ended_at is null
    and pg_temp.pushes('KV', 'arrival_failed') = 0 and pg_temp.pushes('KV', 'arrival_checkin') = 1,
    (pg_temp.ps(c.id))::text);

  -- KX: a timer running (no court): the arrival is refused as before.
  perform pg_temp.as_user(pg_temp.p('KX'));
  perform public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000b11', p_kind => 'open_play');
  j := pg_temp.arrive('KX', 'test:cs-a', 'c9000000-0000-4000-8000-000000000b12');
  perform pg_temp.ok('S11 a "just time it" timer still stops an arrival, and says why',
    pg_temp.vci('c9000000-0000-4000-8000-000000000b12') is null and pg_temp.pushes('KX', 'arrival_failed') = 1
    and pg_temp.sessions('KX') = 1);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S11 block crashed', false, sqlerrm);
end $$;


-- ════ S12 open to play ═══════════════════════════════════════════════════
do $$
declare
  j jsonb;
  c public.venue_checkins;
  n int;
begin
  c := pg_temp.ci('KO', 'c9000000-0000-4000-8000-000000000c01', 'test:cs-b', 41.5101);
  perform pg_temp.as_user(pg_temp.p('KO'));
  j := public.court_play_modes('test:cs-b');
  select x.open_now into n from public.venue_open_to_play(array['test:cs-b']) x;
  perform pg_temp.ok('S12 a check-in alone (its session started by it) says nothing: not open to play',
    (j ->> 'open_now')::int = 0 and (j ->> 'unsaid_now')::int = 1 and n = 0
    and j -> 'players' -> 0 ->> 'mode_now' is null, j::text);
  perform pg_temp.age(c.id, interval '1 minute');
  perform pg_temp.as_user(pg_temp.p('KO'));
  perform public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000c02', p_kind => 'open_play', p_venue => 'test:cs-b');
  j := public.court_play_modes('test:cs-b');
  select x.open_now into n from public.venue_open_to_play(array['test:cs-b']) x;
  perform pg_temp.ok('S12 ▶ Play (open play) says open, as before',
    (j ->> 'open_now')::int = 1 and n = 1 and j -> 'players' -> 0 ->> 'mode_now' = 'open', j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S12 block crashed', false, sqlerrm);
end $$;


-- ════ S13 a check-in elsewhere while playing; replays ════════════════════
do $$
declare
  ca public.venue_checkins;
  cb public.venue_checkins;
  r  public.venue_checkins;
begin
  ca := pg_temp.ci('KB', 'c9000000-0000-4000-8000-000000000d01', 'test:cs-a', 41.5001);
  perform pg_temp.age(ca.id, interval '30 minutes');
  cb := pg_temp.ci('KB', 'c9000000-0000-4000-8000-000000000d02', 'test:cs-b', 41.5101);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S13 checking in at B by hand ends A''s check-in and session, and starts B''s',
    (pg_temp.ps(ca.id)).ended_at = now() and (pg_temp.ps(cb.id)).ended_at is null
    and pg_temp.open_sessions('KB') = 1 and pg_temp.sessions('KB') = 2);

  -- KD: a Check out that reached Pickleague before its check-in (offline).
  perform pg_temp.as_user(pg_temp.p('KD'));
  perform public.checkout_venue(p_id => 'c9000000-0000-4000-8000-000000000d11', p_source => null, p_at => now());
  r := pg_temp.ci('KD', 'c9000000-0000-4000-8000-000000000d11', 'test:cs-a', 41.5001);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S13 a check-in stored closed (its Check out landed first) starts no session',
    r.checked_out_at is not null and pg_temp.sessions('KD') = 0, r::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S13 block crashed', false, sqlerrm);
end $$;


-- ════ S15 ▶ Play at C, a drive-by arrival at A taken back ════════════════
do $$
declare
  s public.play_sessions;
  j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('KF'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000000f01', p_kind => 'open_play',
    p_venue => 'test:cs-c', p_at => now(), p_lat => 41.5201, p_lng => -101.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.age(s.id, interval '20 minutes');
  j := pg_temp.arrive('KF', 'test:cs-a', 'c9000000-0000-4000-8000-000000000f02');
  perform pg_temp.ok('S15 playing at C (▶ Play, its own check-in), an arrival at A ends the Play there and starts A''s',
    (pg_temp.vci(s.id)).checked_out_at = now() - interval '2 minutes'
    and (pg_temp.ps(s.id)).ended_at = now() - interval '2 minutes'
    and (pg_temp.ps('c9000000-0000-4000-8000-000000000f02')).ended_at is null,
    (pg_temp.ps(s.id))::text);
  perform pg_temp.as_user(pg_temp.p('KF'));
  j := public.cancel_court_arrival(p_venue => 'test:cs-a');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S15 taking A back gives the Play back: its check-in and its session reopen, A''s session is gone',
    (j ->> 'removed')::boolean and (pg_temp.vci(s.id)).checked_out_at is null
    and (pg_temp.ps(s.id)).ended_at is null and (pg_temp.ps(s.id)).started_at = now() - interval '20 minutes'
    and pg_temp.ps('c9000000-0000-4000-8000-000000000f02') is null
    and pg_temp.open_sessions('KF') = 1 and pg_temp.sessions('KF') = 1,
    j::text || ' ' || (pg_temp.ps(s.id))::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S15 block crashed', false, sqlerrm);
end $$;


-- ════ S16 an arrival while my check-in elsewhere has run out ═════════════
do $$
declare
  c public.venue_checkins;
  j jsonb;
begin
  c := pg_temp.ci('KG', 'c9000000-0000-4000-8000-000000001001', 'test:cs-c', 41.5201);
  -- It ran out 5 minutes ago; the expiry job (every 10 minutes) hasn't closed it.
  perform pg_temp.age(c.id, interval '2 hours 5 minutes');
  c := pg_temp.vci(c.id);
  j := pg_temp.arrive('KG', 'test:cs-a', 'c9000000-0000-4000-8000-000000001002');
  perform pg_temp.ok('S16 the arrival at A lands (no "You have a play session running"); C''s session ends at C''s end',
    (pg_temp.vci('c9000000-0000-4000-8000-000000001002')).checked_out_at is null
    and (pg_temp.ps('c9000000-0000-4000-8000-000000001002')).ended_at is null
    and pg_temp.pushes('KG', 'arrival_failed') = 0
    and c.expires_at = now() - interval '5 minutes'
    and (pg_temp.ps(c.id)).ended_at = c.expires_at
    and pg_temp.open_sessions('KG') = 1,
    coalesce((pg_temp.ps(c.id))::text, 'no C session'));
  perform public.expire_venue_checkins();
  perform pg_temp.ok('S16 ...the expiry job then closes C at its end and leaves A''s session be',
    (pg_temp.vci(c.id)).checked_out_at = c.expires_at
    and (pg_temp.ps(c.id)).ended_at = c.expires_at
    and (pg_temp.ps('c9000000-0000-4000-8000-000000001002')).ended_at is null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S16 block crashed', false, sqlerrm);
end $$;


-- ════ S17 a check-in queued offline lands after a newer Play elsewhere ═══
do $$
declare
  s public.play_sessions;
  c public.venue_checkins;
begin
  perform pg_temp.as_user(pg_temp.p('KL'));
  select * into s from public.start_play_session(p_id => 'f9000000-0000-4000-8000-000000001101', p_kind => 'open_play',
    p_venue => 'test:cs-b');
  perform pg_temp.as_user(pg_temp.p('KL'));
  select * into c from public.checkin_venue(p_id => 'c9000000-0000-4000-8000-000000001102', p_venue => 'test:cs-a',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '5 minutes');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S17 the newer Play at B keeps running; the older check-in at A starts no session',
    (pg_temp.ps(s.id)).ended_at is null and pg_temp.ps(c.id) is null and pg_temp.open_sessions('KL') = 1,
    (pg_temp.ps(s.id))::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S17 block crashed', false, sqlerrm);
end $$;


-- ════ S18 a no-fix check-in, then ▶ Play with a fix ══════════════════════
do $$
declare
  c public.venue_checkins;
  s public.play_sessions;
  k text;
  v_ago interval;
  v_cid uuid;
  v_sid uuid;
begin
  foreach k in array array['KN', 'KQ'] loop
    v_ago := case k when 'KN' then interval '10 minutes' else interval '2 minutes' end;
    v_cid := case k when 'KN' then 'c9000000-0000-4000-8000-000000001201'::uuid else 'c9000000-0000-4000-8000-000000001301'::uuid end;
    v_sid := case k when 'KN' then 'f9000000-0000-4000-8000-000000001202'::uuid else 'f9000000-0000-4000-8000-000000001302'::uuid end;
    -- An older build's check-in without a fix (not location_confirmed).
    perform pg_temp.as_user(pg_temp.p(k));
    select * into c from public.checkin_venue(p_id => v_cid, p_venue => 'test:cs-a', p_minutes => 120, p_source => 'manual');
    perform pg_temp.age(c.id, v_ago);
    perform pg_temp.as_user(pg_temp.p(k));
    select * into s from public.start_play_session(p_id => v_sid, p_kind => 'open_play',
      p_venue => 'test:cs-a', p_at => now(), p_lat => 41.5001, p_lng => -101.0, p_accuracy_m => 10,
      p_fix_at => now(), p_fix_age_ms => 1000);
    perform pg_temp.as_admin();
    s := pg_temp.ps(v_sid);
    perform pg_temp.ok('S18 ' || k || ' ▶ Play with a fix ' || v_ago::text || ' after a no-fix check-in keeps running, on its own check-in',
      not c.location_confirmed and s.ended_at is null and s.checkin_id = s.id
      and (pg_temp.vci(s.id)).checked_out_at is null and pg_temp.open_sessions(k) = 1
      and not exists (select 1 from public.venue_checkins x
                       where x.user_id = pg_temp.p(k) and x.checked_out_at is null and x.id <> s.id),
      coalesce(s::text, 'gone') || ' | no-fix ci=' || (pg_temp.vci(c.id))::text);
  end loop;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S18 block crashed', false, sqlerrm);
end $$;

-- ════ S14 nothing paid twice ═════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('S14 no pickles, streak days or streak rewards from any of it',
    not exists (select 1 from public.profiles p join _before b on b.id = p.id where p.pickles is distinct from b.pickles)
    and not exists (select 1 from public.daily_play_streaks d where d.user_id in (select id from _p))
    and not exists (select 1 from public.user_streak_rewards u where u.user_id in (select id from _p)));
  perform pg_temp.ok('S14 never two open sessions for one player',
    not exists (select 1 from public.play_sessions where user_id in (select id from _p) and ended_at is null
                 group by user_id having count(*) > 1));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S14 block crashed', false, sqlerrm);
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
