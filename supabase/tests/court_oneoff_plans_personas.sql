-- ============================================================
-- One-off planned check-ins and "Check in and tell friends": persona tests
-- for migration_court_oneoff_plans.sql.
--
-- NOT runnable on its own: build-court-oneoff-plans-test.mjs puts
-- migration_court_oneoff_plans.sql (twice: it must be re-runnable),
-- migration_plan_sharing.sql (re-applied after it, as on live: plans stay
-- private unless p_share) and then migration_rls_hardening_2026q3.sql (a
-- re-run must keep the new RPCs online) at the marker line below. Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-court-oneoff-plans-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs live already: presence, court arrival, routines (+ planned end),
-- check-in session and on-my-way files.
--
-- now() is fixed for the whole transaction: time passing is a backdated
-- row. Courts near 41.3 N, 103.0 W (far from every real venue; a fix 11 m
-- north is lat + 0.0001).
--
-- Personas (temporary accounts, @pickleague.test emails):
--   PO  plans, moves, cancels (stars op-home)       PF  PO's friend
--   PS  a stranger (tries PO's plans)               PL  the 20-plan cap
--   PK  keeps a plan by a check-in by hand          PK2 checks in outside the window
--   PV  keeps a plan by an arrival (op-arr, auto on)
--   PM  the reminder at an unstarred court          PW  the reminder at a starred court
--   PA  automatic check-in off: a one-off plan doesn't let an arrival in,
--       a routine stop still does
--   PR  routines unaffected                         PR2 a one-off plan and a routine at one time
--   SN  "I'm here": F1 (push on), F2 (no phone), FH (hidden from), NF (not a friend)
--   SO  old send_on_my_way calls, friend G1         SO2 friend G2 (no pick)
--   PD  account deleted
--   PR3 a routine stop days ahead holds its time    PR4 Undo skip next to a one-off
--   PR5 Change today's time next to a one-off
--   SL  "I'm here" at a 4th court in 30 minutes (friend FL)
--   SP  "I'm here" paused / check-ins hidden / a blocked friend (FP, FB)
--
-- Nothing reads court_plans or push_outbox beyond these personas: the
-- linked database has real players' rows (one-off plans included once this
-- file is live), and a re-run of the apply script must still pass.
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('PO',  'a9100000-0000-4000-8000-000000000001'), ('PF',  'a9100000-0000-4000-8000-000000000002'),
  ('PS',  'a9100000-0000-4000-8000-000000000003'), ('PL',  'a9100000-0000-4000-8000-000000000004'),
  ('PK',  'a9100000-0000-4000-8000-000000000005'), ('PK2', 'a9100000-0000-4000-8000-000000000006'),
  ('PV',  'a9100000-0000-4000-8000-000000000007'), ('PM',  'a9100000-0000-4000-8000-000000000008'),
  ('PW',  'a9100000-0000-4000-8000-000000000009'), ('PA',  'a9100000-0000-4000-8000-00000000000a'),
  ('PR',  'a9100000-0000-4000-8000-00000000000b'), ('PR2', 'a9100000-0000-4000-8000-00000000000c'),
  ('SN',  'a9100000-0000-4000-8000-00000000000d'), ('F1',  'a9100000-0000-4000-8000-00000000000e'),
  ('F2',  'a9100000-0000-4000-8000-00000000000f'), ('FH',  'a9100000-0000-4000-8000-000000000010'),
  ('NF',  'a9100000-0000-4000-8000-000000000011'), ('SO',  'a9100000-0000-4000-8000-000000000012'),
  ('G1',  'a9100000-0000-4000-8000-000000000013'), ('SO2', 'a9100000-0000-4000-8000-000000000014'),
  ('G2',  'a9100000-0000-4000-8000-000000000015'), ('PD',  'a9100000-0000-4000-8000-000000000016'),
  ('PR3', 'a9100000-0000-4000-8000-000000000017'), ('PR4', 'a9100000-0000-4000-8000-000000000018'),
  ('PR5', 'a9100000-0000-4000-8000-000000000019'), ('SL',  'a9100000-0000-4000-8000-00000000001a'),
  ('FL',  'a9100000-0000-4000-8000-00000000001b'), ('SP',  'a9100000-0000-4000-8000-00000000001c'),
  ('FP',  'a9100000-0000-4000-8000-00000000001d'), ('FB',  'a9100000-0000-4000-8000-00000000001e');
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid not null default gen_random_uuid());
insert into _ids (k) values ('PK'), ('PK2'), ('PV'), ('SN'), ('SL'), ('SP');
grant select on _ids to authenticated, anon;

-- Plan ids the sections hand on to each other.
create temp table _plans (k text primary key, id uuid);
grant select, insert, update on _plans to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.pid(text) returns uuid language sql stable as $$ select id from _plans where k = $1 $$;
create function pg_temp.ids(text[]) returns uuid[] language sql stable as $$
  select coalesce(array_agg(id order by k), '{}') from _p where k = any ($1)
$$;
-- A time to the minute from now (plan_court_checkin keeps minutes).
create function pg_temp.t(p interval) returns timestamptz language sql stable as $$
  select date_trunc('minute', now()) + p
$$;

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

-- Runs p_sql; null if it went through, else the error's message, hint, detail, state.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg    text;
  v_hint   text;
  v_detail text;
  v_state  text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detail = pg_exception_detail,
                          v_state = returned_sqlstate;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint, 'detail', v_detail, 'state', v_state);
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon;

-- plan_court_checkin as persona k. Leaves the role as admin.
create function pg_temp.plan(k text, p_venue text, p_at timestamptz, p_len int default 120) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  v := public.plan_court_checkin(p_venue, p_at, p_len);
  perform pg_temp.as_admin();
  return v;
end $$;

-- An error from persona k running p_sql. Leaves the role as admin.
create function pg_temp.err_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  v := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  return v;
end $$;

-- send_on_my_way as one persona. Leaves the role as admin.
create function pg_temp.send(p_who text, p_venue text, p_eta int, p_to text[], p_here boolean) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(p_who));
  v := public.send_on_my_way(p_venue, p_eta, case when p_to is null then null else pg_temp.ids(p_to) end, p_here);
  perform pg_temp.as_admin();
  return v;
end $$;

-- Persona keys with an on-my-way outbox row from this sender (here: the I'm
-- here ones only, else the on my way ones), comma-joined.
create function pg_temp.pushed(p_from text, p_here boolean) returns text language sql stable as $$
  select coalesce(string_agg(k.k, ',' order by k.k), '')
    from public.push_outbox o join _p k on k.id = o.recipient_id
   where o.push_data ->> 'kind' = 'on_my_way' and o.push_data ->> 'sender_id' = pg_temp.p(p_from)::text
     and coalesce((o.push_data ->> 'here')::boolean, false) = p_here
$$;

-- A check-in by hand with a fix 11 m from the court. Leaves the role as admin.
create function pg_temp.checkin(k text, p_venue text, p_id uuid) returns void language plpgsql as $$
declare v_lat double precision;
        v_lng double precision;
begin
  select lat, lng into v_lat, v_lng from public.venues where id = p_venue;
  perform pg_temp.as_user(pg_temp.p(k));
  perform public.checkin_venue(p_id => p_id, p_venue => p_venue, p_minutes => 120, p_source => 'manual',
    p_at => null, p_lat => v_lat + 0.0001, p_lng => v_lng, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
end $$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'op-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'OP Player ' || k)
  from _p;
update public.profiles set full_name = 'Sam Sender' where id = pg_temp.p('SN');
update public.profiles set full_name = 'Olive Old' where id = pg_temp.p('SO');

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:op-home',     array['pickleball'], 'OP Test Home',     'court', 41.30, -103.0, 'google', 100),
  ('test:op-away',     array['pickleball'], 'OP Test Away',     'court', 41.31, -103.0, 'google', 100),
  ('test:op-third',    array['pickleball'], 'OP Test Third',    'court', 41.32, -103.0, 'google', 100),
  ('test:op-keep',     array['pickleball'], 'OP Test Keep',     'court', 41.33, -103.0, 'google', 100),
  ('test:op-keep2',    array['pickleball'], 'OP Test Keep 2',   'court', 41.34, -103.0, 'google', 100),
  ('test:op-arr',      array['pickleball'], 'OP Test Arrival',  'court', 41.35, -103.0, 'google', 100),
  ('test:op-arr2',     array['pickleball'], 'OP Test Arrival 2','court', 41.36, -103.0, 'google', 100),
  ('test:op-arr3',     array['pickleball'], 'OP Test Arrival 3','court', 41.37, -103.0, 'google', 100),
  ('test:op-routine',  array['pickleball'], 'OP Test Routine',  'court', 41.38, -103.0, 'google', 100),
  ('test:op-routine2', array['pickleball'], 'OP Test Routine 2','court', 41.39, -103.0, 'google', 100),
  ('test:op-here',     array['pickleball'], 'OP Test Here',     'court', 41.40, -103.0, 'google', 100),
  ('test:op-there',    array['pickleball'], 'OP Test There',    'court', 41.41, -103.0, 'google', 100),
  ('test:op-omw',      array['pickleball'], 'OP Test Omw',      'court', 41.42, -103.0, 'google', 100),
  ('test:op-rejected', array['pickleball'], 'OP Test Rejected', 'court', 41.43, -103.0, 'google', 100),
  ('test:op-r3',       array['pickleball'], 'OP Test Routine 3','court', 41.44, -103.0, 'google', 100),
  ('test:op-r4',       array['pickleball'], 'OP Test Routine 4','court', 41.45, -103.0, 'google', 100),
  ('test:op-r5',       array['pickleball'], 'OP Test Routine 5','court', 41.46, -103.0, 'google', 100),
  ('test:op-cap',      array['pickleball'], 'OP Test Cap',      'court', 41.47, -103.0, 'google', 100),
  ('test:op-pause',    array['pickleball'], 'OP Test Pause',    'court', 41.48, -103.0, 'google', 100);
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, canonical_id) values
  ('test:op-home-osm', array['pickleball'], 'OP Test Home', 'court', 41.30005, -103.0, 'osm', 100, 'test:op-home'),
  ('test:op-here-osm', array['pickleball'], 'OP Test Here', 'court', 41.40005, -103.0, 'osm', 100, 'test:op-here');
update public.venues set confirmation_status = 'rejected' where id = 'test:op-rejected';

insert into public.court_favorites (user_id, venue_id)
select pg_temp.p(k), v from (values
  ('PO', 'test:op-home'), ('PV', 'test:op-arr'), ('PW', 'test:op-home'), ('PA', 'test:op-arr2'),
  ('PA', 'test:op-arr3'), ('PR', 'test:op-routine'), ('PR2', 'test:op-routine2'),
  ('PR3', 'test:op-r3'), ('PR4', 'test:op-r4'), ('PR5', 'test:op-r5')) s(k, v);

-- Consent for everyone; PA has automatic check-in off.
insert into public.presence_settings (user_id, consent_seen_at, auto_checkin)
select id, now(), k <> 'PA' from _p
on conflict (user_id) do update set consent_seen_at = excluded.consent_seen_at, auto_checkin = excluded.auto_checkin;

insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p(a), pg_temp.p(b), 'accepted', now() from (values
  ('PO', 'PF'), ('SN', 'F1'), ('SN', 'F2'), ('SN', 'FH'), ('SO', 'G1'), ('SO2', 'G2'),
  ('SL', 'FL'), ('SP', 'FP'), ('SP', 'FB')) s(a, b);
insert into public.presence_hidden_from (user_id, hidden_user_id) values (pg_temp.p('SN'), pg_temp.p('FH'));
insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.p('SP'), pg_temp.p('FB'));

-- Phones: everyone but F2; push on for all.
insert into public.push_tokens (user_id, token, platform)
select id, 'ExponentPushToken[op-' || lower(k) || ']', 'ios' from _p where k <> 'F2';
insert into public.user_preferences (user_id, prefs)
select id, '{"pushEnabled": true}'::jsonb from _p
on conflict (user_id) do update set prefs = excluded.prefs;

-- @@MIGRATION@@


-- ════ P1 grants, attributes, the table ══════════════════════════════════
do $$
declare
  f        text;
  v_bad    text;
  -- plan_court_checkin: the 4-argument one (p_share) of
  -- migration_plan_sharing.sql, which the builder re-applies after this file.
  v_client text[] := array[
    'public.plan_court_checkin(text,timestamptz,integer,boolean)',
    'public.move_court_plan(uuid,timestamptz)',
    'public.cancel_court_plan(uuid)',
    'public.list_my_court_plans()',
    'public.send_on_my_way(text,integer,uuid[],boolean)',
    'public.unskip_court_routine_occurrence(uuid)',
    'public.move_court_routine_occurrence(uuid,timestamptz)'];
  v_internal text[] := array[
    'public._pl_plan_near(uuid,text,timestamptz,uuid)',
    'public._pl_routine_stop_due(uuid,text,timestamptz)',
    'public._pl_routine_time_near(uuid,text,timestamptz)',
    'public._pl_court_arrival_off(uuid,text)',
    'public.process_court_routine_reminders()'];
begin
  perform pg_temp.as_admin();
  foreach f in array v_client loop
    perform pg_temp.ok('P1 authenticated may execute ' || f,
      to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'EXECUTE'));
    perform pg_temp.ok('P1 anon may not execute ' || f,
      to_regprocedure(f) is not null and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  foreach f in array v_internal loop
    perform pg_temp.ok('P1 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  select string_agg(w.sig, ', ') into v_bad
    from unnest(v_client || v_internal) w(sig)
   where not exists (select 1 from pg_proc p where p.oid = to_regprocedure(w.sig)
                      and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""');
  perform pg_temp.ok('P1 every new and replaced function is SECURITY DEFINER with an empty search_path', v_bad is null, v_bad);
  perform pg_temp.ok('P1 one send_on_my_way (no overload for PostgREST to choose between), the 3-argument one gone',
    (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'send_on_my_way')
    and to_regprocedure('public.send_on_my_way(text,integer,uuid[])') is null);
  -- Any player's rows: a routine occurrence always reads routine (one-off
  -- plans real players made since this file went live are fine).
  perform pg_temp.ok('P1 court_plans.kind: every routine occurrence reads routine',
    not exists (select 1 from public.court_plans where routine_id is not null and kind <> 'routine'));
  perform pg_temp.ok('P1 a once row can''t carry a routine (court_plans_kind_chk)',
    pg_temp.err($q$insert into public.court_plans (user_id, venue_id, planned_at, planned_end_at, kind, routine_date)
                   values ('a9100000-0000-4000-8000-000000000001', 'test:op-away', now(), now() + interval '1 hour',
                           'once', current_date)$q$) ->> 'state' = '23514');
  perform pg_temp.ok('P1 court_plans stays owner-only: anon can''t read it, nobody can write it directly',
    not has_table_privilege('anon', 'public.court_plans', 'SELECT')
    and not has_table_privilege('authenticated', 'public.court_plans', 'INSERT')
    and not has_table_privilege('authenticated', 'public.court_plans', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.court_plans', 'DELETE'));
end $$;


-- ════ P2 signed out and anon ════════════════════════════════════════════
do $$
declare
  e jsonb;
  q text;
begin
  perform pg_temp.as_signed_out();
  foreach q in array array[
    $s$select public.plan_court_checkin('test:op-away', now() + interval '1 hour')$s$,
    $s$select public.move_court_plan(gen_random_uuid(), now() + interval '1 hour')$s$,
    $s$select public.cancel_court_plan(gen_random_uuid())$s$,
    $s$select public.list_my_court_plans()$s$,
    $s$select public.send_on_my_way('test:op-here', null, null, true)$s$] loop
    e := pg_temp.err(q);
    perform pg_temp.ok('P2 signed out: pl:auth.signed_out from ' || split_part(split_part(q, 'public.', 2), '(', 1),
      e ->> 'hint' = 'pl:auth.signed_out', e::text);
  end loop;
  perform pg_temp.as_anon();
  foreach q in array array[
    $s$select public.plan_court_checkin('test:op-away', now() + interval '1 hour')$s$,
    $s$select public.move_court_plan(gen_random_uuid(), now() + interval '1 hour')$s$,
    $s$select public.cancel_court_plan(gen_random_uuid())$s$,
    $s$select public.list_my_court_plans()$s$,
    $s$select public.send_on_my_way('test:op-here', null, null, true)$s$] loop
    e := pg_temp.err(q);
    perform pg_temp.ok('P2 anon: permission denied for ' || split_part(split_part(q, 'public.', 2), '(', 1),
      e ->> 'state' = '42501', e::text);
  end loop;
  perform pg_temp.as_admin();
  perform pg_temp.ok('P2 nothing planned by any of it',
    not exists (select 1 from public.court_plans where kind = 'once' and user_id in (select id from _p)));
end $$;


-- ════ P3 plan ═══════════════════════════════════════════════════════════
do $$
declare
  j  jsonb;
  pl public.court_plans;
begin
  j := pg_temp.plan('PO', 'test:op-away', pg_temp.t('2 hours'));
  select * into pl from public.court_plans where user_id = pg_temp.p('PO') and venue_id = 'test:op-away';
  insert into _plans values ('A', pl.id);
  perform pg_temp.ok('P3 a one-off plan at an unstarred court (Doggle: no favorite needed): kind once, no routine',
    pl.kind = 'once' and pl.routine_id is null and pl.routine_date is null and pl.status = 'planned'
    and pl.planned_at = pg_temp.t('2 hours') and pl.planned_end_at = pg_temp.t('4 hours'), row_to_json(pl)::text);
  perform pg_temp.ok('P3 its windows: the whole length, mode not said (as a routine with none)',
    jsonb_array_length(pl.windows) = 1
    and (pl.windows -> 0 ->> 'starts_at')::timestamptz = pl.planned_at
    and (pl.windows -> 0 ->> 'ends_at')::timestamptz = pl.planned_end_at
    and pl.windows -> 0 -> 'mode' = 'null'::jsonb, pl.windows::text);
  perform pg_temp.ok('P3 the answer is list_my_court_plans: the plan with its court',
    jsonb_array_length(j) = 1 and (j -> 0 ->> 'plan_id')::uuid = pl.id and j -> 0 ->> 'venue_name' = 'OP Test Away'
    and (j -> 0 ->> 'planned_at')::timestamptz = pl.planned_at and j -> 0 ->> 'status' = 'planned'
    and (j -> 0 ->> 'starred')::boolean = false, j::text);

  -- Through a duplicate row of a starred facility, 90 minutes long.
  j := pg_temp.plan('PO', 'test:op-home-osm', pg_temp.t('5 hours'), 90);
  select * into pl from public.court_plans where user_id = pg_temp.p('PO') and planned_at = pg_temp.t('5 hours');
  insert into _plans values ('H', pl.id);
  perform pg_temp.ok('P3 a duplicate row plans at its facility; 90 minutes; starred says so',
    pl.venue_id = 'test:op-home' and pl.planned_end_at = pg_temp.t('6 hours 30 minutes')
    and (j -> 1 ->> 'starred')::boolean and j -> 1 ->> 'venue_id' = 'test:op-home', j::text);
  perform pg_temp.ok('P3 the list is in time order', (j -> 0 ->> 'planned_at')::timestamptz < (j -> 1 ->> 'planned_at')::timestamptz, j::text);

  -- 10 minutes ago is still fine (Doggle's 15).
  j := pg_temp.plan('PO', 'test:op-third', pg_temp.t('-10 minutes'));
  insert into _plans select 'C', id from public.court_plans where user_id = pg_temp.p('PO') and venue_id = 'test:op-third';
  perform pg_temp.ok('P3 a time up to 15 minutes ago is taken (Doggle) and listed while in play',
    pg_temp.pid('C') is not null and jsonb_array_length(j) = 3, j::text);
  -- The same time at another court is fine.
  j := pg_temp.plan('PO', 'test:op-third', pg_temp.t('2 hours'));
  insert into _plans select 'D', id from public.court_plans where user_id = pg_temp.p('PO') and venue_id = 'test:op-third' and planned_at = pg_temp.t('2 hours');
  perform pg_temp.ok('P3 the same time at another court is fine', pg_temp.pid('D') is not null);
end $$;


-- ════ P4 plan refusals (each says why and what to do) ══════════════════
do $$
declare
  e jsonb;
  n int;
begin
  select count(*) into n from public.court_plans where user_id = pg_temp.p('PO');
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin(null, now() + interval '1 hour')$q$);
  perform pg_temp.ok('P4 no court: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-nowhere', now() + interval '1 hour')$q$);
  perform pg_temp.ok('P4 unknown court: pl:court.gone, says to find the court', e ->> 'hint' = 'pl:court.gone'
    and e ->> 'msg' ilike '%can''t plan a check-in there%', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-rejected', now() + interval '1 hour')$q$);
  perform pg_temp.ok('P4 a court an admin rejected: pl:court.gone', e ->> 'hint' = 'pl:court.gone', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', null)$q$);
  perform pg_temp.ok('P4 no time: pl:visit.bad_time', e ->> 'hint' = 'pl:visit.bad_time', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', now() - interval '20 minutes')$q$);
  perform pg_temp.ok('P4 20 minutes ago: pl:visit.bad_time', e ->> 'hint' = 'pl:visit.bad_time'
    and e ->> 'msg' = 'Pick a time later than now for your check-in.', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', now() + interval '61 days')$q$);
  perform pg_temp.ok('P4 61 days ahead: pl:visit.too_far', e ->> 'hint' = 'pl:visit.too_far', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', now() + interval '20 hours', 25)$q$);
  perform pg_temp.ok('P4 25 minutes long: pl:visit.bad_length', e ->> 'hint' = 'pl:visit.bad_length', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', now() + interval '20 hours', 250)$q$);
  perform pg_temp.ok('P4 250 minutes long: pl:visit.bad_length', e ->> 'hint' = 'pl:visit.bad_length', e::text);
  e := pg_temp.err_as('PO', $q$select public.plan_court_checkin('test:op-away', now() + interval '20 hours', 50)$q$);
  perform pg_temp.ok('P4 50 minutes (off the 15-minute step): pl:visit.bad_length', e ->> 'hint' = 'pl:visit.bad_length', e::text);
  -- Within 30 minutes of plan A (op-away, +2 h).
  e := pg_temp.err_as('PO', format('select public.plan_court_checkin(%L, %L)', 'test:op-away', pg_temp.t('2 hours 30 minutes')));
  perform pg_temp.ok('P4 30 minutes after another plan there: pl:visit.taken, naming the court and the time',
    e ->> 'hint' = 'pl:visit.taken' and e ->> 'msg' like 'You already plan to check in at OP Test Away at %. Change that time instead.'
    and (e ->> 'detail')::jsonb ->> 'plan_id' = pg_temp.pid('A')::text
    and ((e ->> 'detail')::jsonb ->> 'routine')::boolean = false, e::text);
  e := pg_temp.err_as('PO', format('select public.plan_court_checkin(%L, %L)', 'test:op-home', pg_temp.t('4 hours 45 minutes')));
  perform pg_temp.ok('P4 the facility counts as one court (plan H was made through its duplicate row)',
    e ->> 'hint' = 'pl:visit.taken' and (e ->> 'detail')::jsonb ->> 'plan_id' = pg_temp.pid('H')::text, e::text);
  perform pg_temp.ok('P4 refusals plan nothing', (select count(*) from public.court_plans where user_id = pg_temp.p('PO')) = n);
  -- Just outside the 30 minutes, and 59 days ahead, and 4 hours long: fine.
  perform pg_temp.plan('PO', 'test:op-away', pg_temp.t('2 hours 31 minutes'));
  insert into _plans select 'B', id from public.court_plans where user_id = pg_temp.p('PO') and planned_at = pg_temp.t('2 hours 31 minutes');
  perform pg_temp.plan('PO', 'test:op-away', pg_temp.t('59 days'), 240);
  perform pg_temp.ok('P4 31 minutes apart, 59 days ahead and 4 hours long are all fine',
    pg_temp.pid('B') is not null
    and exists (select 1 from public.court_plans where user_id = pg_temp.p('PO') and planned_at = pg_temp.t('59 days')
                   and planned_end_at = pg_temp.t('59 days 4 hours')));
end $$;


-- ════ P5 at most 20 still to come ═══════════════════════════════════════
do $$
declare
  e jsonb;
  i int;
  v_first uuid;
begin
  for i in 1 .. 20 loop
    perform pg_temp.plan('PL', 'test:op-away', pg_temp.t(make_interval(hours => i)));
  end loop;
  e := pg_temp.err_as('PL', format('select public.plan_court_checkin(%L, %L)', 'test:op-away', pg_temp.t('30 hours')));
  perform pg_temp.ok('P5 a 21st: pl:visit.limit', e ->> 'hint' = 'pl:visit.limit'
    and e ->> 'msg' = 'You have 20 planned check-ins coming up. Cancel one to plan another.', e::text);
  select id into v_first from public.court_plans where user_id = pg_temp.p('PL') order by planned_at limit 1;
  perform pg_temp.as_user(pg_temp.p('PL'));
  perform public.cancel_court_plan(v_first);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P5 after a cancel, the 21st goes in',
    jsonb_array_length(pg_temp.plan('PL', 'test:op-away', pg_temp.t('30 hours'))) = 20);
end $$;


-- ════ P6 move ═══════════════════════════════════════════════════════════
do $$
declare
  e   jsonb;
  j   jsonb;
  pl  public.court_plans;
  pl2 public.court_plans;
begin
  -- Someone else's plan: the same "gone" as a plan that doesn't exist.
  e := pg_temp.err_as('PS', format('select public.move_court_plan(%L, %L)', pg_temp.pid('A'), pg_temp.t('3 hours')));
  perform pg_temp.ok('P6 a stranger can''t move PO''s plan: pl:visit.gone, nothing moved',
    e ->> 'hint' = 'pl:visit.gone' and (select planned_at from public.court_plans where id = pg_temp.pid('A')) = pg_temp.t('2 hours'), e::text);
  e := pg_temp.err_as('PF', format('select public.move_court_plan(%L, %L)', pg_temp.pid('A'), pg_temp.t('3 hours')));
  perform pg_temp.ok('P6 nor a friend', e ->> 'hint' = 'pl:visit.gone', e::text);
  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', gen_random_uuid(), pg_temp.t('3 hours')));
  perform pg_temp.ok('P6 a plan that doesn''t exist: the same words', e ->> 'hint' = 'pl:visit.gone'
    and e ->> 'msg' = 'That planned check-in is over or was cancelled, so it can''t be changed. Pull to refresh.', e::text);

  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', pg_temp.pid('A'), pg_temp.t('-10 minutes')));
  perform pg_temp.ok('P6 to 10 minutes ago: pl:visit.bad_time', e ->> 'hint' = 'pl:visit.bad_time', e::text);
  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', pg_temp.pid('A'), pg_temp.t('61 days')));
  perform pg_temp.ok('P6 to 61 days ahead: pl:visit.too_far', e ->> 'hint' = 'pl:visit.too_far', e::text);
  -- B is at +2:31 at the same court.
  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', pg_temp.pid('A'), pg_temp.t('2 hours 45 minutes')));
  perform pg_temp.ok('P6 next to another plan there: pl:visit.taken (Pick another time)',
    e ->> 'hint' = 'pl:visit.taken' and e ->> 'msg' like '%Pick another time.' and (e ->> 'detail')::jsonb ->> 'plan_id' = pg_temp.pid('B')::text, e::text);

  select * into pl from public.court_plans where id = pg_temp.pid('A');
  perform pg_temp.as_user(pg_temp.p('PO'));
  j := public.move_court_plan(pg_temp.pid('A'), pg_temp.t('3 hours 15 minutes'));
  perform pg_temp.as_admin();
  select * into pl2 from public.court_plans where id = pg_temp.pid('A');
  perform pg_temp.ok('P6 moved: its time, end and windows move together; still planned, still once',
    pl2.planned_at = pg_temp.t('3 hours 15 minutes') and pl2.planned_end_at = pg_temp.t('5 hours 15 minutes')
    and (pl2.windows -> 0 ->> 'starts_at')::timestamptz = pl2.planned_at
    and (pl2.windows -> 0 ->> 'ends_at')::timestamptz = pl2.planned_end_at
    and pl2.status = 'planned' and pl2.kind = 'once', row_to_json(pl2)::text);
  perform pg_temp.ok('P6 the answer is the list, A at its new time',
    exists (select 1 from jsonb_array_elements(j) x where (x ->> 'plan_id')::uuid = pg_temp.pid('A')
              and (x ->> 'planned_at')::timestamptz = pg_temp.t('3 hours 15 minutes')), j::text);
  -- Moving across a day, and away from the minute.
  perform pg_temp.as_user(pg_temp.p('PO'));
  perform public.move_court_plan(pg_temp.pid('A'), now() + interval '3 days 17 seconds');
  perform pg_temp.as_admin();
  perform pg_temp.ok('P6 another day is fine (not a routine stop: no same-day rule), kept to the minute',
    (select planned_at from public.court_plans where id = pg_temp.pid('A')) = date_trunc('minute', now() + interval '3 days 17 seconds'));
  -- A plan whose time passed 10 minutes ago is still in play: movable.
  perform pg_temp.as_user(pg_temp.p('PO'));
  perform public.move_court_plan(pg_temp.pid('C'), pg_temp.t('1 hour'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('P6 a plan 10 minutes past its time can still move',
    (select planned_at from public.court_plans where id = pg_temp.pid('C')) = pg_temp.t('1 hour'));
  -- 40 minutes past its time: over.
  update public.court_plans set planned_at = now() - interval '40 minutes', planned_end_at = now() + interval '80 minutes'
   where id = pg_temp.pid('D');
  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', pg_temp.pid('D'), pg_temp.t('1 hour 45 minutes')));
  perform pg_temp.ok('P6 one 40 minutes past its time: pl:visit.gone', e ->> 'hint' = 'pl:visit.gone', e::text);
  perform pg_temp.as_user(pg_temp.p('PO'));
  j := public.list_my_court_plans();
  perform pg_temp.as_admin();
  perform pg_temp.ok('P6 and it is no longer listed',
    not exists (select 1 from jsonb_array_elements(j) x where (x ->> 'plan_id')::uuid = pg_temp.pid('D')), j::text);
end $$;


-- ════ P7 cancel ═════════════════════════════════════════════════════════
do $$
declare
  e jsonb;
  j jsonb;
begin
  e := pg_temp.err_as('PS', format('select public.cancel_court_plan(%L)', pg_temp.pid('B')));
  perform pg_temp.ok('P7 a stranger can''t cancel PO''s plan: pl:visit.gone, still planned',
    e ->> 'hint' = 'pl:visit.gone' and (select status from public.court_plans where id = pg_temp.pid('B')) = 'planned', e::text);
  e := pg_temp.err_as('PF', format('select public.cancel_court_plan(%L)', pg_temp.pid('B')));
  perform pg_temp.ok('P7 nor a friend', e ->> 'hint' = 'pl:visit.gone', e::text);

  perform pg_temp.as_user(pg_temp.p('PO'));
  j := public.cancel_court_plan(pg_temp.pid('B'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('P7 cancelled: status cancelled, gone from the list',
    (select status from public.court_plans where id = pg_temp.pid('B')) = 'cancelled'
    and not exists (select 1 from jsonb_array_elements(j) x where (x ->> 'plan_id')::uuid = pg_temp.pid('B')), j::text);
  e := pg_temp.err_as('PO', format('select public.cancel_court_plan(%L)', pg_temp.pid('B')));
  perform pg_temp.ok('P7 cancel it again: pl:visit.gone', e ->> 'hint' = 'pl:visit.gone'
    and e ->> 'msg' = 'That planned check-in is already over or cancelled. Pull to refresh.', e::text);
  e := pg_temp.err_as('PO', format('select public.move_court_plan(%L, %L)', pg_temp.pid('B'), pg_temp.t('6 hours')));
  perform pg_temp.ok('P7 move a cancelled one: pl:visit.gone', e ->> 'hint' = 'pl:visit.gone', e::text);
  -- Its time is free again.
  perform pg_temp.ok('P7 a cancelled plan no longer holds its time',
    jsonb_typeof(pg_temp.plan('PO', 'test:op-away', pg_temp.t('2 hours 31 minutes'))) = 'array');
end $$;


-- ════ P8 who sees a one-off plan: only its owner ═══════════════════════
do $$
declare
  n int;
  e jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('PF'));
  select count(*) into n from public.court_plans where user_id = pg_temp.p('PO');
  perform pg_temp.ok('P8 a friend reads none of PO''s plans (court_plans is owner-only)', n = 0, n::text);
  perform pg_temp.ok('P8 a friend''s list_my_court_plans is their own (empty)', public.list_my_court_plans() = '[]'::jsonb);
  perform pg_temp.ok('P8 PO''s profile shows routines only: none, no one-off plan',
    public.list_profile_court_routines(pg_temp.p('PO')) = '[]'::jsonb);
  perform pg_temp.as_user(pg_temp.p('PS'));
  select count(*) into n from public.court_plans where user_id = pg_temp.p('PO');
  perform pg_temp.ok('P8 a stranger reads none either', n = 0, n::text);
  perform pg_temp.as_user(pg_temp.p('PO'));
  select count(*) into n from public.court_plans where user_id = pg_temp.p('PO') and kind = 'once';
  perform pg_temp.ok('P8 PO reads their own', n > 0, n::text);
  perform pg_temp.as_anon();
  e := pg_temp.err($q$select count(*) from public.court_plans$q$);
  perform pg_temp.ok('P8 anon can''t read the table at all', e ->> 'state' = '42501', e::text);
  perform pg_temp.as_admin();
end $$;


-- ════ P9 a check-in keeps a one-off plan, as a routine stop ═════════════
do $$
declare
  pl public.court_plans;
  c  public.venue_checkins;
  j  jsonb;
begin
  perform pg_temp.plan('PK', 'test:op-keep', pg_temp.t('10 minutes'));
  select * into pl from public.court_plans where user_id = pg_temp.p('PK');
  perform pg_temp.checkin('PK', 'test:op-keep', pg_temp.i('PK'));
  select * into c from public.venue_checkins where id = pg_temp.i('PK');
  perform pg_temp.ok('P9 a check-in by hand 10 minutes early keeps the plan (location-confirmed)',
    c.location_confirmed and c.plan_id = pl.id
    and (select status from public.court_plans where id = pl.id) = 'completed'
    and (select checkin_id from public.court_plans where id = pl.id) = c.id, row_to_json(c)::text);
  perform pg_temp.ok('P9 and takes its planned end and windows (an ordinary length still)',
    c.planned_end_at = pl.planned_end_at and c.play_windows = pl.windows
    and c.expires_at = c.checked_in_at + interval '120 minutes', row_to_json(c)::text);
  perform pg_temp.as_user(pg_temp.p('PK'));
  j := public.list_my_court_plans();
  perform pg_temp.as_admin();
  perform pg_temp.ok('P9 the list says kept', j -> 0 ->> 'status' = 'completed', j::text);

  -- 45 minutes ahead: outside the window, nothing kept.
  perform pg_temp.plan('PK2', 'test:op-keep2', pg_temp.t('45 minutes'));
  perform pg_temp.checkin('PK2', 'test:op-keep2', pg_temp.i('PK2'));
  select * into c from public.venue_checkins where id = pg_temp.i('PK2');
  perform pg_temp.ok('P9 a check-in 45 minutes early keeps nothing',
    c.plan_id is null and (select status from public.court_plans where user_id = pg_temp.p('PK2')) = 'planned', row_to_json(c)::text);

  -- An arrival at a starred court (automatic check-in on) keeps one too.
  perform pg_temp.plan('PV', 'test:op-arr', pg_temp.t('5 minutes'));
  select * into pl from public.court_plans where user_id = pg_temp.p('PV');
  perform pg_temp.as_user(pg_temp.p('PV'));
  perform public.queue_court_arrival(p_venue => 'test:op-arr', p_arrived_at => now() - interval '2 minutes', p_checkin_id => pg_temp.i('PV'));
  perform pg_temp.as_admin();
  perform public.process_court_arrivals();
  select * into c from public.venue_checkins where id = pg_temp.i('PV');
  perform pg_temp.ok('P9 an arrival keeps it: plan_id, planned end, and "Your planned check-in" in the push',
    c.via_arrival and c.plan_id = pl.id and c.planned_end_at = pl.planned_end_at
    and (select status from public.court_plans where id = pl.id) = 'completed'
    and exists (select 1 from public.push_outbox o where o.recipient_id = pg_temp.p('PV')
                   and o.push_data ->> 'kind' = 'arrival_checkin' and o.push_data ->> 'plan_id' = pl.id::text
                   and o.body like '%Your planned check-in.%'), row_to_json(c)::text);
end $$;


-- ════ P10 the reminder, on the routine stops' path ═════════════════════
do $$
declare
  o  public.push_outbox;
  v_pm uuid;
  v_pw uuid;
  n  int;
begin
  perform pg_temp.plan('PM', 'test:op-away', pg_temp.t('5 minutes'));
  select id into v_pm from public.court_plans where user_id = pg_temp.p('PM');
  perform pg_temp.plan('PW', 'test:op-home', pg_temp.t('5 minutes'));
  select id into v_pw from public.court_plans where user_id = pg_temp.p('PW');
  -- One 20 minutes out: not yet.
  perform pg_temp.plan('PW', 'test:op-away', pg_temp.t('20 minutes'));
  perform public.process_court_routine_reminders();

  select * into o from public.push_outbox where recipient_id = pg_temp.p('PM') and push_data ->> 'kind' = 'plan_reminder';
  perform pg_temp.ok('P10 a one-off plan 5 minutes out gets the reminder: "<time> · <court>", kind plan_reminder',
    o.id is not null
    and o.title = public._pl_clock(pg_temp.t('5 minutes'), public._pickleague_tz_for(pg_temp.p('PM'))) || ' · OP Test Away'
    and o.push_data ->> 'plan_id' = v_pm::text and o.push_data ->> 'venue_id' = 'test:op-away'
    and (o.push_data ->> 'planned_at')::timestamptz = pg_temp.t('5 minutes')
    and (o.push_data ->> 'planned_end_at')::timestamptz = pg_temp.t('2 hours 5 minutes'), row_to_json(o)::text);
  perform pg_temp.ok('P10 an unstarred court: "Tap Check in" (no arrival will), category and link as a routine stop''s',
    o.body = 'Your planned check-in. Tap Check in when you get there.'
    and o.category = 'notifyAutoCheckins' and o.deep_link = 'home/-' and o.expires_at = pg_temp.t('35 minutes'), row_to_json(o)::text);
  select * into o from public.push_outbox where recipient_id = pg_temp.p('PW') and push_data ->> 'kind' = 'plan_reminder';
  perform pg_temp.ok('P10 a starred court with automatic check-in on: "We''ll check you in"',
    o.push_data ->> 'plan_id' = v_pw::text and o.body = 'Your planned check-in. We''ll check you in when you get there.',
    row_to_json(o)::text);
  perform pg_temp.ok('P10 not the one 20 minutes out',
    (select count(*) from public.push_outbox where recipient_id = pg_temp.p('PW') and push_data ->> 'kind' = 'plan_reminder') = 1);
  perform public.process_court_routine_reminders();
  perform pg_temp.ok('P10 once only',
    (select count(*) from public.push_outbox where recipient_id = pg_temp.p('PM') and push_data ->> 'kind' = 'plan_reminder') = 1);

  -- Moved: the unsent one goes, the new time is reminded.
  perform pg_temp.as_user(pg_temp.p('PM'));
  perform public.move_court_plan(v_pm, pg_temp.t('8 minutes'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('P10 a move drops the unsent reminder',
    not exists (select 1 from public.push_outbox where recipient_id = pg_temp.p('PM') and push_data ->> 'kind' = 'plan_reminder'));
  perform public.process_court_routine_reminders();
  select * into o from public.push_outbox where recipient_id = pg_temp.p('PM') and push_data ->> 'kind' = 'plan_reminder';
  perform pg_temp.ok('P10 and the new time is reminded',
    (o.push_data ->> 'planned_at')::timestamptz = pg_temp.t('8 minutes'), row_to_json(o)::text);
  -- Cancelled: the unsent one goes.
  perform pg_temp.as_user(pg_temp.p('PM'));
  perform public.cancel_court_plan(v_pm);
  perform pg_temp.as_admin();
  perform public.process_court_routine_reminders();
  perform pg_temp.ok('P10 a cancel drops the unsent reminder, and none comes back',
    not exists (select 1 from public.push_outbox where recipient_id = pg_temp.p('PM') and push_data ->> 'kind' = 'plan_reminder'));
  -- Kept plans (PK, PV) and the one checked in early elsewhere (PK2 is at
  -- op-keep2, plan there): nothing.
  select count(*) into n from public.push_outbox
   where recipient_id in (pg_temp.p('PK'), pg_temp.p('PK2'), pg_temp.p('PV')) and push_data ->> 'kind' = 'plan_reminder';
  perform pg_temp.ok('P10 no reminder for a kept plan or while checked in there', n = 0, n::text);
end $$;


-- ════ P11 automatic check-in off: only a routine stop lets an arrival in ═
do $$
begin
  perform pg_temp.plan('PA', 'test:op-arr2', pg_temp.t('5 minutes'));
  perform pg_temp.as_user(pg_temp.p('PA'));
  perform public.save_court_routine(null, 'test:op-arr3', ((now() at time zone 'UTC') + interval '10 minutes')::time,
                                    127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P11 a one-off plan due now does not override "Check me in when I arrive" off',
    public._pl_court_arrival_off(pg_temp.p('PA'), 'test:op-arr2') = 'off');
  perform pg_temp.ok('P11 a routine stop due now still does (unchanged)',
    exists (select 1 from public.court_plans where user_id = pg_temp.p('PA') and venue_id = 'test:op-arr3' and kind = 'routine')
    and public._pl_court_arrival_off(pg_temp.p('PA'), 'test:op-arr3') is null);
  perform pg_temp.ok('P11 _pl_routine_stop_due: routine yes, one-off no',
    public._pl_routine_stop_due(pg_temp.p('PA'), 'test:op-arr3', now())
    and not public._pl_routine_stop_due(pg_temp.p('PA'), 'test:op-arr2', now()));
end $$;


-- ════ P12 "Check in and tell friends" (p_here) ═════════════════════════
do $$
declare
  v jsonb;
  o public.push_outbox;
  e jsonb;
begin
  v := pg_temp.send('SN', 'test:op-here', null, array['F1', 'F2', 'FH', 'NF'], true);
  perform pg_temp.ok('P12 not checked in there: reason not_here, nothing sent, no window spent',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'not_here' and (v ->> 'here')::boolean
    and pg_temp.pushed('SN', true) = ''
    and not exists (select 1 from public.pl_throttle where scope = pg_temp.p('SN')::text), v::text);

  perform pg_temp.checkin('SN', 'test:op-here', pg_temp.i('SN'));
  v := pg_temp.send('SN', 'test:op-here-osm', 0, array['F1', 'F2', 'FH', 'NF', 'SN'], true);
  perform pg_temp.ok('P12 checked in: told F1 and F2 (not FH, hidden from; not NF, no friend; not myself); an ETA of 0 is ignored',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 2 and (v ->> 'skipped_recent')::int = 0
    and (v ->> 'here')::boolean and v -> 'eta_minutes' = 'null'::jsonb
    and v ->> 'venue_id' = 'test:op-here' and v ->> 'venue_name' = 'OP Test Here', v::text);
  perform pg_temp.ok('P12 a push only where it reaches: F1 (F2 has no phone), never FH',
    pg_temp.pushed('SN', true) = 'F1', pg_temp.pushed('SN', true));
  select * into o from public.push_outbox where recipient_id = pg_temp.p('F1') and push_data ->> 'sender_id' = pg_temp.p('SN')::text;
  perform pg_temp.ok('P12 the push: "Sam Sender is at OP Test Here", checked in just now',
    o.title = 'Sam Sender is at OP Test Here' and o.body = 'Checked in just now. Tap to see the court.', row_to_json(o)::text);
  perform pg_temp.ok('P12 kind on_my_way with here: true (every build opens the court), no ETA; category, link, 30-minute life',
    o.push_data ->> 'kind' = 'on_my_way' and (o.push_data ->> 'here')::boolean
    and not (o.push_data ? 'eta_minutes') and o.push_data ->> 'venue_id' = 'test:op-here'
    and o.category = 'notifyFriendsOnTheWay' and o.kind = 'info' and o.deep_link = 'home/-'
    and o.expires_at = now() + interval '30 minutes' and o.notification_id is null, row_to_json(o)::text);
  perform pg_temp.ok('P12 its own throttle rows: the court, and each friend at that court',
    (select count(*) from public.pl_throttle where scope = pg_temp.p('SN')::text and kind = 'on_my_way_here' and key = 'test:op-here') = 1
    and (select count(*) from public.pl_throttle where scope = pg_temp.p('SN')::text and kind = 'on_my_way_here_to'
           and key in ('test:op-here|' || pg_temp.p('F1'), 'test:op-here|' || pg_temp.p('F2'))) = 2
    and not exists (select 1 from public.pl_throttle where scope = pg_temp.p('SN')::text and kind in ('on_my_way', 'on_my_way_to')));

  v := pg_temp.send('SN', 'test:op-here', null, array['F1'], true);
  perform pg_temp.ok('P12 again within 30 minutes: reason recent, sent_at and retry_at',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'recent' and (v ->> 'here')::boolean
    and (v ->> 'sent_at')::timestamptz = now() and (v ->> 'retry_at')::timestamptz = now() + interval '30 minutes', v::text);

  -- "On my way" there has its own windows: an I'm here never blocks it, nor it the other way.
  v := pg_temp.send('SN', 'test:op-here', 10, array['F1'], false);
  perform pg_temp.ok('P12 an "on my way" right after: sent (separate windows), the old wording',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 1 and not (v ? 'here') and (v ->> 'eta_minutes')::int = 10
    and pg_temp.pushed('SN', false) = 'F1', v::text);

  -- Only the court's window aged 31 minutes: the friends' own still hold.
  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('SN')::text and kind = 'on_my_way_here';
  v := pg_temp.send('SN', 'test:op-here', null, array['F1', 'F2'], true);
  perform pg_temp.ok('P12 every friend picked told about this court within 30 minutes: reason recent_friends',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'recent_friends'
    and (v ->> 'retry_at')::timestamptz = now() + interval '30 minutes', v::text);
  -- 31 minutes for both: no pick = every friend but the hidden one.
  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('SN')::text and kind = 'on_my_way_here_to';
  v := pg_temp.send('SN', 'test:op-here', null, null, true);
  perform pg_temp.ok('P12 no pick: all my friends but the one I hid from (F1, F2)',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 2, v::text);

  -- Only the hidden friend picked: nobody, no window.
  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('SN')::text and kind in ('on_my_way_here', 'on_my_way_here_to');
  v := pg_temp.send('SN', 'test:op-here', null, array['FH'], true);
  perform pg_temp.ok('P12 only the friend I hid from picked: reason nobody',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'nobody' and (v ->> 'here')::boolean, v::text);

  v := pg_temp.send('SN', 'test:op-there', null, array['F1'], true);
  perform pg_temp.ok('P12 another court than the one I''m at: not_here', v ->> 'reason' = 'not_here', v::text);

  e := pg_temp.err_as('SN', $q$select public.send_on_my_way('test:op-nowhere', null, null, true)$q$);
  perform pg_temp.ok('P12 an unknown court: pl:court.gone', e ->> 'hint' = 'pl:court.gone', e::text);

  -- Checked out: not here any more.
  update public.venue_checkins set checked_out_at = now() where id = pg_temp.i('SN');
  v := pg_temp.send('SN', 'test:op-here', null, array['F1'], true);
  perform pg_temp.ok('P12 checked out: not_here', v ->> 'reason' = 'not_here', v::text);
end $$;


-- ════ P13 old send_on_my_way calls still work ═══════════════════════════
do $$
declare
  v jsonb;
  o public.push_outbox;
  e jsonb;
begin
  -- The 3 arguments the shipped app sends, positionally.
  perform pg_temp.as_user(pg_temp.p('SO'));
  v := public.send_on_my_way('test:op-omw', 20, array[pg_temp.p('G1')]);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P13 three arguments (the shipped app): sent as before, no here key',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 1 and (v ->> 'eta_minutes')::int = 20 and not (v ? 'here'), v::text);
  select * into o from public.push_outbox where recipient_id = pg_temp.p('G1') and push_data ->> 'sender_id' = pg_temp.p('SO')::text;
  perform pg_temp.ok('P13 the old push: "is on the way to", about 20 min, eta in push_data, no here',
    o.title = 'Olive Old is on the way to OP Test Omw' and o.body = 'About 20 min away. Tap to see the court.'
    and (o.push_data ->> 'eta_minutes')::int = 20 and not (o.push_data ? 'here')
    and o.expires_at = now() + interval '20 minutes', row_to_json(o)::text);
  -- By name, as PostgREST calls it.
  perform pg_temp.as_user(pg_temp.p('SO'));
  v := public.send_on_my_way(p_venue => 'test:op-omw', p_eta_minutes => 10, p_recipients => array[pg_temp.p('G1')]);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P13 by name without p_here: the on-my-way window (recent)', v ->> 'reason' = 'recent', v::text);
  -- One argument (all friends, 15 minutes).
  perform pg_temp.as_user(pg_temp.p('SO2'));
  v := public.send_on_my_way('test:op-omw');
  perform pg_temp.as_admin();
  perform pg_temp.ok('P13 one argument: 15 minutes, all my friends',
    (v ->> 'sent')::boolean and (v ->> 'eta_minutes')::int = 15 and (v ->> 'count')::int = 1, v::text);
  -- p_here null reads as false.
  update public.pl_throttle set last_at = last_at - interval '31 minutes' where scope = pg_temp.p('SO')::text;
  v := pg_temp.send('SO', 'test:op-omw', 5, array['G1'], null);
  perform pg_temp.ok('P13 p_here null: an on my way', (v ->> 'sent')::boolean and not (v ? 'here'), v::text);
  e := pg_temp.err_as('SO', $q$select public.send_on_my_way('test:op-omw', 0, null)$q$);
  perform pg_temp.ok('P13 an on my way still refuses ETA 0: pl:omw.bad_eta', e ->> 'hint' = 'pl:omw.bad_eta', e::text);
  e := pg_temp.err_as('SO', $q$select public.send_on_my_way('test:op-omw', 15, (select array_agg(gen_random_uuid()) from generate_series(1, 51)), true)$q$);
  perform pg_temp.ok('P13 51 friends: pl:omw.too_many, I''m here too', e ->> 'hint' = 'pl:omw.too_many', e::text);
end $$;


-- ════ P14 routine stops unaffected ══════════════════════════════════════
do $$
declare
  occ public.court_plans;
  e   jsonb;
  j   jsonb;
  v_once uuid;
  v_at   timestamptz;
  n   int;
begin
  perform pg_temp.as_user(pg_temp.p('PR'));
  j := public.save_court_routine(null, 'test:op-routine', ((now() at time zone 'UTC') + interval '10 minutes')::time,
                                 127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  select * into occ from public.court_plans where user_id = pg_temp.p('PR') and venue_id = 'test:op-routine'
   order by planned_at limit 1;
  perform pg_temp.ok('P14 a routine still makes its occurrence: kind routine, routine and date set',
    occ.kind = 'routine' and occ.routine_id is not null and occ.routine_date is not null and occ.status = 'planned',
    row_to_json(occ)::text);
  perform pg_temp.as_user(pg_temp.p('PR'));
  perform pg_temp.ok('P14 list_my_court_routines has it; list_my_court_plans doesn''t',
    (j -> 0 -> 'next' ->> 'plan_id')::uuid = occ.id and public.list_my_court_plans() = '[]'::jsonb, j::text);
  perform pg_temp.as_admin();

  e := pg_temp.err_as('PR', format('select public.plan_court_checkin(%L, %L)', 'test:op-routine', occ.planned_at + interval '10 minutes'));
  perform pg_temp.ok('P14 a one-off within 30 minutes of a routine stop: pl:visit.taken, says it is the routine''s',
    e ->> 'hint' = 'pl:visit.taken' and e ->> 'msg' like 'Your routine already has you at OP Test Routine at %'
    and ((e ->> 'detail')::jsonb ->> 'routine')::boolean, e::text);
  e := pg_temp.err_as('PR', format('select public.cancel_court_plan(%L)', occ.id));
  perform pg_temp.ok('P14 cancel_court_plan won''t take a routine stop: pl:visit.gone', e ->> 'hint' = 'pl:visit.gone', e::text);
  e := pg_temp.err_as('PR', format('select public.move_court_plan(%L, %L)', occ.id, occ.planned_at + interval '5 minutes'));
  perform pg_temp.ok('P14 nor move_court_plan', e ->> 'hint' = 'pl:visit.gone'
    and (select status from public.court_plans where id = occ.id) = 'planned'
    and (select planned_at from public.court_plans where id = occ.id) = occ.planned_at, e::text);

  -- A one-off of PR's elsewhere: the routine RPCs won't take it.
  perform pg_temp.plan('PR', 'test:op-away', pg_temp.t('6 hours'));
  select id into v_once from public.court_plans where user_id = pg_temp.p('PR') and kind = 'once';
  e := pg_temp.err_as('PR', format('select public.skip_court_routine_occurrence(%L)', v_once));
  perform pg_temp.ok('P14 skip_court_routine_occurrence won''t take a one-off: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', e::text);
  e := pg_temp.err_as('PR', format('select public.move_court_routine_occurrence(%L, %L)', v_once, pg_temp.t('6 hours 30 minutes')));
  perform pg_temp.ok('P14 nor move_court_routine_occurrence', e ->> 'hint' = 'pl:plan.gone', e::text);

  -- The routine stop's reminder is as before.
  perform public.process_court_routine_reminders();
  perform pg_temp.ok('P14 the routine stop''s reminder: kind routine_reminder, same words',
    exists (select 1 from public.push_outbox o where o.recipient_id = pg_temp.p('PR')
              and o.push_data ->> 'kind' = 'routine_reminder' and o.push_data ->> 'plan_id' = occ.id::text
              and o.title = public._pl_clock(occ.planned_at, 'UTC') || ' · OP Test Routine'
              and o.body = 'Your planned check-in. We''ll check you in when you get there.')
    and not exists (select 1 from public.push_outbox o where o.recipient_id = pg_temp.p('PR') and o.push_data ->> 'kind' = 'plan_reminder'));

  -- Skip still works.
  perform pg_temp.as_user(pg_temp.p('PR'));
  perform public.skip_court_routine_occurrence(occ.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P14 skip today still works', (select status from public.court_plans where id = occ.id) = 'cancelled');

  -- Doggle's rule: a routine makes no occurrence within 30 minutes of
  -- another plan of mine there (a one-off included).
  v_at := date_trunc('minute', now() + interval '20 minutes');
  perform pg_temp.plan('PR2', 'test:op-routine2', v_at);
  perform pg_temp.as_user(pg_temp.p('PR2'));
  perform public.save_court_routine(null, 'test:op-routine2', (v_at at time zone 'UTC')::time, 127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  select count(*) into n from public.court_plans
   where user_id = pg_temp.p('PR2') and kind = 'routine' and planned_at between v_at - interval '30 minutes' and v_at + interval '30 minutes';
  perform pg_temp.ok('P14 a one-off at a routine''s time covers that day: no second plan', n = 0, n::text);
  -- (Unless v_at is already tomorrow in UTC: the materializer looks no further.)
  perform pg_temp.ok('P14 the routine''s other day is made as usual',
    exists (select 1 from public.court_plans where user_id = pg_temp.p('PR2') and kind = 'routine'
              and planned_at = v_at + interval '1 day')
    or (v_at at time zone 'UTC')::date > (now() at time zone 'UTC')::date);
end $$;


-- ════ P15 account deletion takes one-off plans too ═════════════════════
do $$
begin
  perform pg_temp.plan('PD', 'test:op-away', pg_temp.t('3 hours'));
  perform public._purge_account(pg_temp.p('PD'));
  perform pg_temp.ok('P15 a deleted account leaves no plan behind',
    not exists (select 1 from public.court_plans where user_id = pg_temp.p('PD')));
end $$;


-- ════ P16 a routine stop not made yet holds its time ═══════════════════
-- The materializer makes yesterday to tomorrow only; a one-off plan days
-- ahead at a routine's time would otherwise take that day from it.
do $$
declare
  e      jsonb;
  v_stop timestamptz;
  v_once uuid;
  v_rid  uuid;
begin
  perform pg_temp.as_user(pg_temp.p('PR3'));
  perform public.save_court_routine(null, 'test:op-r3', ((now() at time zone 'UTC') + interval '10 minutes')::time,
                                    127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  select id into v_rid from public.court_routines where user_id = pg_temp.p('PR3');
  -- Its stop 4 days from now (every day, UTC, to the minute): not made yet.
  v_stop := date_trunc('minute', now() + interval '10 minutes') + interval '4 days';
  perform pg_temp.ok('P16 the routine has no stop 4 days ahead yet',
    not exists (select 1 from public.court_plans where user_id = pg_temp.p('PR3') and planned_at = v_stop));
  e := pg_temp.err_as('PR3', format('select public.plan_court_checkin(%L, %L)', 'test:op-r3', v_stop + interval '10 minutes'));
  perform pg_temp.ok('P16 a one-off 10 minutes from that stop: pl:visit.taken, the routine''s, naming the court and that day',
    e ->> 'hint' = 'pl:visit.taken'
    and e ->> 'msg' like 'Your routine already has you at OP Test Routine 3 at % that day. Pick another time.'
    and ((e ->> 'detail')::jsonb ->> 'routine')::boolean
    and ((e ->> 'detail')::jsonb ->> 'planned_at')::timestamptz = v_stop
    and (e ->> 'detail')::jsonb -> 'plan_id' = 'null'::jsonb, e::text);
  e := pg_temp.err_as('PR3', format('select public.plan_court_checkin(%L, %L)', 'test:op-r3', v_stop - interval '30 minutes'));
  perform pg_temp.ok('P16 30 minutes before it: refused too', e ->> 'hint' = 'pl:visit.taken', e::text);
  perform pg_temp.plan('PR3', 'test:op-r3', v_stop + interval '45 minutes');
  select id into v_once from public.court_plans where user_id = pg_temp.p('PR3') and kind = 'once';
  perform pg_temp.ok('P16 45 minutes from it is fine', v_once is not null);
  e := pg_temp.err_as('PR3', format('select public.move_court_plan(%L, %L)', v_once, v_stop - interval '5 minutes'));
  perform pg_temp.ok('P16 moving a one-off onto that stop: pl:visit.taken, not moved',
    e ->> 'hint' = 'pl:visit.taken' and ((e ->> 'detail')::jsonb ->> 'routine')::boolean
    and (select planned_at from public.court_plans where id = v_once) = v_stop + interval '45 minutes', e::text);
  perform pg_temp.plan('PR3', 'test:op-routine', v_stop);
  perform pg_temp.ok('P16 the same time at another court is fine',
    exists (select 1 from public.court_plans where user_id = pg_temp.p('PR3') and venue_id = 'test:op-routine'));
  -- A paused routine makes no stop, so it holds nothing.
  perform pg_temp.as_user(pg_temp.p('PR3'));
  perform public.set_court_routine_active(v_rid, false);
  perform pg_temp.as_admin();
  perform pg_temp.plan('PR3', 'test:op-r3', v_stop + interval '10 minutes');
  perform pg_temp.ok('P16 with the routine paused, that time is free',
    exists (select 1 from public.court_plans where user_id = pg_temp.p('PR3') and kind = 'once'
              and planned_at = v_stop + interval '10 minutes'));
end $$;


-- ════ P17 Undo skip / Change today's time next to a one-off ═════════════
do $$
declare
  occ    public.court_plans;
  e      jsonb;
  v_once uuid;
  v_to   timestamptz;
begin
  -- PR4: today's stop skipped, a one-off 3 minutes after it, then Undo skip.
  perform pg_temp.as_user(pg_temp.p('PR4'));
  perform public.save_court_routine(null, 'test:op-r4', ((now() at time zone 'UTC') + interval '20 minutes')::time,
                                    127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  select * into occ from public.court_plans where user_id = pg_temp.p('PR4') and kind = 'routine' order by planned_at limit 1;
  perform pg_temp.as_user(pg_temp.p('PR4'));
  perform public.skip_court_routine_occurrence(occ.id);
  perform pg_temp.as_admin();
  perform pg_temp.plan('PR4', 'test:op-r4', occ.planned_at + interval '3 minutes');
  select id into v_once from public.court_plans where user_id = pg_temp.p('PR4') and kind = 'once';
  perform pg_temp.ok('P17 a one-off 3 minutes from a skipped stop is fine (a skipped stop holds nothing)', v_once is not null);
  e := pg_temp.err_as('PR4', format('select public.unskip_court_routine_occurrence(%L)', occ.id));
  perform pg_temp.ok('P17 Undo skip next to it: pl:plan.taken, naming the court, still skipped',
    e ->> 'hint' = 'pl:plan.taken'
    and e ->> 'msg' like 'You already plan to check in at OP Test Routine 4 at %. Cancel that check-in first, then undo the skip.'
    and (e ->> 'detail')::jsonb ->> 'plan_id' = v_once::text
    and (select status from public.court_plans where id = occ.id) = 'cancelled', e::text);
  perform pg_temp.as_user(pg_temp.p('PR4'));
  perform public.cancel_court_plan(v_once);
  perform public.unskip_court_routine_occurrence(occ.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P17 with the one-off cancelled, Undo skip works',
    (select status from public.court_plans where id = occ.id) = 'planned');
  -- Undo skip on a stop that isn't skipped: still fine (as before).
  perform pg_temp.as_user(pg_temp.p('PR4'));
  perform public.unskip_court_routine_occurrence(occ.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P17 Undo skip on a planned stop changes nothing',
    (select status from public.court_plans where id = occ.id) = 'planned');

  -- PR5: a one-off 35 minutes after today's stop, then the stop moved next to it.
  perform pg_temp.as_user(pg_temp.p('PR5'));
  perform public.save_court_routine(null, 'test:op-r5', ((now() at time zone 'UTC') + interval '40 minutes')::time,
                                    127, 'UTC', 120, null);
  perform pg_temp.as_admin();
  select * into occ from public.court_plans where user_id = pg_temp.p('PR5') and kind = 'routine' order by planned_at limit 1;
  perform pg_temp.plan('PR5', 'test:op-r5', occ.planned_at + interval '35 minutes');
  select id into v_once from public.court_plans where user_id = pg_temp.p('PR5') and kind = 'once';
  perform pg_temp.ok('P17 a one-off 35 minutes after a stop is fine', v_once is not null);
  v_to := occ.planned_at + interval '30 minutes';
  e := pg_temp.err_as('PR5', format('select public.move_court_routine_occurrence(%L, %L)', occ.id, v_to));
  perform pg_temp.ok('P17 Change today''s time to 5 minutes from the one-off: pl:plan.taken, not moved',
    ((e ->> 'hint' = 'pl:plan.taken'
      and e ->> 'msg' like 'You already plan to check in at OP Test Routine 5 at %. Pick another time.'
      and (e ->> 'detail')::jsonb ->> 'plan_id' = v_once::text)
     -- (Past UTC midnight the same-day rule answers first.)
     or ((v_to at time zone 'UTC')::date <> occ.routine_date and e ->> 'hint' = 'pl:plan.bad_time'))
    and (select planned_at from public.court_plans where id = occ.id) = occ.planned_at, e::text);
  v_to := occ.planned_at + interval '4 minutes';
  e := pg_temp.err_as('PR5', format('select public.move_court_routine_occurrence(%L, %L)', occ.id, v_to));
  perform pg_temp.ok('P17 to 31 minutes from it: moved',
    (e is null and (select planned_at from public.court_plans where id = occ.id) = v_to)
    or ((v_to at time zone 'UTC')::date <> occ.routine_date and e ->> 'hint' = 'pl:plan.bad_time'), coalesce(e::text, ''));
end $$;


-- ════ P18 "I'm here" at most 3 other courts per 30 minutes ═════════════
do $$
declare
  v jsonb;
begin
  perform pg_temp.checkin('SL', 'test:op-cap', pg_temp.i('SL'));
  -- Told friends at three other courts in the last 30 minutes.
  insert into public.pl_throttle (scope, kind, key, last_at) values
    (pg_temp.p('SL')::text, 'on_my_way_here', 'test:op-c1', now() - interval '5 minutes'),
    (pg_temp.p('SL')::text, 'on_my_way_here', 'test:op-c2', now() - interval '10 minutes'),
    (pg_temp.p('SL')::text, 'on_my_way_here', 'test:op-c3', now() - interval '20 minutes');
  v := pg_temp.send('SL', 'test:op-cap', null, array['FL'], true);
  perform pg_temp.ok('P18 a 4th court within 30 minutes: reason limit, retry_at when the third of them ages out; nothing sent, no window spent',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'limit' and (v ->> 'here')::boolean
    and (v ->> 'retry_at')::timestamptz = now() + interval '10 minutes'
    and pg_temp.pushed('SL', true) = ''
    and not exists (select 1 from public.pl_throttle where scope = pg_temp.p('SL')::text
                      and kind in ('on_my_way_here', 'on_my_way_here_to') and key like 'test:op-cap%'), v::text);
  update public.pl_throttle set last_at = now() - interval '31 minutes'
   where scope = pg_temp.p('SL')::text and key = 'test:op-c3';
  v := pg_temp.send('SL', 'test:op-cap', null, array['FL'], true);
  perform pg_temp.ok('P18 two other courts in 30 minutes: sent', (v ->> 'sent')::boolean and (v ->> 'count')::int = 1
    and pg_temp.pushed('SL', true) = 'FL', v::text);
end $$;


-- ════ P19 "I'm here" is presence: paused, check-ins hidden, blocked ════
do $$
declare
  v jsonb;
begin
  perform pg_temp.checkin('SP', 'test:op-pause', pg_temp.i('SP'));
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP', 'FB'], true);
  perform pg_temp.ok('P19 a friend I blocked is never told: FP only',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 1 and pg_temp.pushed('SP', true) = 'FP', v::text);

  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('SP')::text and kind in ('on_my_way_here', 'on_my_way_here_to');
  update public.presence_settings set paused_until = now() + interval '1 hour' where user_id = pg_temp.p('SP');
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP'], true);
  perform pg_temp.ok('P19 paused: nobody is told, no window spent',
    (v ->> 'sent')::boolean = false and v ->> 'reason' = 'nobody' and (v ->> 'here')::boolean
    and (select count(*) from public.push_outbox o where o.recipient_id = pg_temp.p('FP')
           and o.push_data ->> 'sender_id' = pg_temp.p('SP')::text and (o.push_data ->> 'here')::boolean) = 1
    and (select last_at from public.pl_throttle where scope = pg_temp.p('SP')::text and kind = 'on_my_way_here'
           and key = 'test:op-pause') < now() - interval '30 minutes', v::text);
  v := pg_temp.send('SP', 'test:op-pause', 10, array['FP'], false);
  perform pg_temp.ok('P19 an "on my way" while paused still goes (an ETA, not presence)',
    (v ->> 'sent')::boolean and (v ->> 'count')::int = 1, v::text);

  update public.presence_settings set paused_until = null, checkins_level = 'hidden' where user_id = pg_temp.p('SP');
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP'], true);
  perform pg_temp.ok('P19 check-ins hidden: nobody is told', v ->> 'reason' = 'nobody', v::text);
  update public.presence_settings set checkins_level = 'friends' where user_id = pg_temp.p('SP');
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP'], true);
  perform pg_temp.ok('P19 check-ins shown to friends again: told', (v ->> 'sent')::boolean and (v ->> 'count')::int = 1, v::text);

  -- Not here: a check-in that isn't location-confirmed, or was taken back.
  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('SP')::text and kind in ('on_my_way_here', 'on_my_way_here_to');
  update public.venue_checkins set location_confirmed = false where id = pg_temp.i('SP');
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP'], true);
  perform pg_temp.ok('P19 a check-in not location-confirmed: not_here', v ->> 'reason' = 'not_here', v::text);
  update public.venue_checkins set location_confirmed = true, taken_back_at = now() where id = pg_temp.i('SP');
  v := pg_temp.send('SP', 'test:op-pause', null, array['FP'], true);
  perform pg_temp.ok('P19 a check-in taken back: not_here', v ->> 'reason' = 'not_here', v::text);
end $$;


-- ════ P20 taking an arrival back un-keeps its one-off plan ══════════════
do $$
declare
  v_plan uuid;
begin
  select plan_id into v_plan from public.venue_checkins where id = pg_temp.i('PV');
  perform public._pl_take_back_arrival(pg_temp.p('PV'), array[pg_temp.i('PV')], now());
  perform pg_temp.ok('P20 the plan PV''s arrival kept (P9) is planned again, with no check-in',
    v_plan is not null
    and (select status from public.court_plans where id = v_plan) = 'planned'
    and (select checkin_id from public.court_plans where id = v_plan) is null);
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
