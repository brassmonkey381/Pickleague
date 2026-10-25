-- ============================================================
-- Plan sharing: persona tests for migration_plan_sharing.sql (foundation
-- 1.70 "Plan sharing contract").
--
-- NOT runnable on its own: build-plan-sharing-test.mjs puts
-- migration_court_oneoff_plans.sql (it may not be live yet),
-- migration_plan_sharing.sql (twice: it must be re-runnable), the one-off
-- file again (it puts older bodies back) and this file once more (its
-- re-apply must undo that), then migration_rls_hardening_2026q3.sql (a re-run
-- must keep the new RPCs online) at the marker line below. Everything runs
-- inside the begin / rollback below, so the linked (live) database is left
-- untouched:
--   node supabase/tests/build-plan-sharing-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs live already: presence, court arrival, routines (+ planned end),
-- check-in session and on-my-way files.
--
-- now() is fixed for the whole transaction: time passing is a backdated
-- row. Routines are in UTC with every day on, so a routine saved for
-- "now + 2 h" has a stop at exactly date_trunc('minute', now()) + 2 h (and
-- maybe one a day later): the tests find stops by that time, never by count.
-- Courts near 41.6 N, 103.2 W (far from every real venue).
--
-- Personas (temporary accounts, @pickleague.test emails):
--   OA  routine owner (stars ps-r1, ps-r2, ps-r3)   OB  auto-share owner (ps-b1, ps-b2)
--   OC  one-off plans and their push                OD  deletes their account
--   OE  the time window (one-off plans)
--   FR  friend of OA, OB, OC, OD, OE                ST  a stranger
--   LM  in a closed league with OA (not a friend)   GU  a guest, OA's friend
--   BK  OA's friend whom OA blocked                 BY  OA's friend who blocked OA
--   HF  OA's friend OA hid presence from
--   CF  close friend (starred) of OC and OA, push on: the one push recipient
--   CN  starred OC, "Friends on the way" off        CP  starred OC, push off
--   CT  starred OC, no phone                        CB  starred OC, blocked by OC
--   CH  starred OC, OC hid presence from them       CS  starred OC, not a friend
--
-- Nothing reads court_plans, pl_throttle or push_outbox beyond these
-- personas: the linked database has real players' rows (shared ones too once
-- this file is live), and a re-run of the apply script must still pass.
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('OA', 'a9300000-0000-4000-8000-000000000001'), ('OB', 'a9300000-0000-4000-8000-000000000002'),
  ('OC', 'a9300000-0000-4000-8000-000000000003'), ('OD', 'a9300000-0000-4000-8000-000000000004'),
  ('OE', 'a9300000-0000-4000-8000-000000000005'), ('FR', 'a9300000-0000-4000-8000-000000000006'),
  ('ST', 'a9300000-0000-4000-8000-000000000007'), ('LM', 'a9300000-0000-4000-8000-000000000008'),
  ('GU', 'a9300000-0000-4000-8000-000000000009'), ('BK', 'a9300000-0000-4000-8000-00000000000a'),
  ('BY', 'a9300000-0000-4000-8000-00000000000b'), ('HF', 'a9300000-0000-4000-8000-00000000000c'),
  ('CF', 'a9300000-0000-4000-8000-00000000000d'), ('CN', 'a9300000-0000-4000-8000-00000000000e'),
  ('CP', 'a9300000-0000-4000-8000-00000000000f'), ('CT', 'a9300000-0000-4000-8000-000000000010'),
  ('CB', 'a9300000-0000-4000-8000-000000000011'), ('CH', 'a9300000-0000-4000-8000-000000000012'),
  ('CS', 'a9300000-0000-4000-8000-000000000013');
grant select on _p to authenticated, anon;

-- Routine ids (R...), stop ids (S... / B...) and plan ids the sections hand on.
create temp table _ids (k text primary key, id uuid);
grant select, insert, update on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.keep(p_k text, p_id uuid) returns void language sql as $$
  insert into _ids values (p_k, p_id) on conflict (k) do update set id = excluded.id
$$;
-- A time to the minute from now (plans and routine stops keep minutes).
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

-- An error from persona k running p_sql. Leaves the role as admin.
create function pg_temp.err_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  v := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  return v;
end $$;

-- The jsonb answer of p_sql run as persona k. An unexpected error is a
-- failed row (not an aborted run) and null. Leaves the role as admin.
create function pg_temp.rpc(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  v      jsonb;
  v_msg  text;
  v_hint text;
begin
  begin
    perform pg_temp.as_user(pg_temp.p(k));
    execute p_sql into v;
    perform pg_temp.as_admin();
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    perform pg_temp.as_admin();
    perform pg_temp.ok('UNEXPECTED ERROR as ' || k || ': ' || p_sql, false, v_msg || ' [' || coalesce(v_hint, '') || ']');
    return null;
  end;
  return v;
end $$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'ps-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'PS Player ' || k)
  from _p;
update public.profiles set full_name = 'Ana Owner' where id = pg_temp.p('OA');
update public.profiles set full_name = 'Cleo Planner' where id = pg_temp.p('OC');
update public.profiles set is_guest = true, guest_expires_at = now() + interval '1 day' where id = pg_temp.p('GU');

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:ps-r1', array['pickleball'], 'PS Test R1', 'court', 41.60, -103.2, 'google', 100),
  ('test:ps-r2', array['pickleball'], 'PS Test R2', 'court', 41.61, -103.2, 'google', 100),
  ('test:ps-r3', array['pickleball'], 'PS Test R3', 'court', 41.62, -103.2, 'google', 100),
  ('test:ps-b1', array['pickleball'], 'PS Test B1', 'court', 41.63, -103.2, 'google', 100),
  ('test:ps-b2', array['pickleball'], 'PS Test B2', 'court', 41.64, -103.2, 'google', 100),
  ('test:ps-c1', array['pickleball'], 'PS Test C1', 'court', 41.65, -103.2, 'google', 100),
  ('test:ps-c2', array['pickleball'], 'PS Test C2', 'court', 41.66, -103.2, 'google', 100),
  ('test:ps-c3', array['pickleball'], 'PS Test C3', 'court', 41.67, -103.2, 'google', 100),
  ('test:ps-c4', array['pickleball'], 'PS Test C4', 'court', 41.68, -103.2, 'google', 100),
  ('test:ps-c5', array['pickleball'], 'PS Test C5', 'court', 41.69, -103.2, 'google', 100),
  ('test:ps-c6', array['pickleball'], 'PS Test C6', 'court', 41.70, -103.2, 'google', 100),
  ('test:ps-c7', array['pickleball'], 'PS Test C7', 'court', 41.71, -103.2, 'google', 100),
  ('test:ps-c8', array['pickleball'], 'PS Test C8', 'court', 41.72, -103.2, 'google', 100),
  ('test:ps-d1', array['pickleball'], 'PS Test D1', 'court', 41.73, -103.2, 'google', 100),
  ('test:ps-e1', array['pickleball'], 'PS Test E1', 'court', 41.74, -103.2, 'google', 100),
  ('test:ps-e2', array['pickleball'], 'PS Test E2', 'court', 41.75, -103.2, 'google', 100);
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, canonical_id) values
  ('test:ps-c1-osm', array['pickleball'], 'PS Test C1', 'court', 41.65005, -103.2, 'osm', 100, 'test:ps-c1');

insert into public.court_favorites (user_id, venue_id)
select pg_temp.p(k), v from (values
  ('OA', 'test:ps-r1'), ('OA', 'test:ps-r2'), ('OA', 'test:ps-r3'),
  ('OB', 'test:ps-b1'), ('OB', 'test:ps-b2')) s(k, v);

insert into public.presence_settings (user_id, consent_seen_at)
select id, now() from _p
on conflict (user_id) do update set consent_seen_at = excluded.consent_seen_at;

insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p(a), pg_temp.p(b), 'accepted', now() from (values
  ('OA', 'FR'), ('OB', 'FR'), ('OC', 'FR'), ('OD', 'FR'), ('OE', 'FR'),
  ('OA', 'GU'), ('OA', 'BK'), ('BY', 'OA'), ('OA', 'HF'), ('OA', 'CF'),
  ('OC', 'CF'), ('OC', 'CN'), ('OC', 'CP'), ('OC', 'CT'), ('OC', 'CB'), ('OC', 'CH')) s(a, b);
-- close_friends (user_id = who starred, friend_id = the starred one).
insert into public.close_friends (user_id, friend_id)
select pg_temp.p(a), pg_temp.p(b) from (values
  ('CF', 'OC'), ('CN', 'OC'), ('CP', 'OC'), ('CT', 'OC'), ('CB', 'OC'), ('CH', 'OC'), ('CS', 'OC'),
  ('CF', 'OA')) s(a, b);
insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('OA'), pg_temp.p('BK')), (pg_temp.p('BY'), pg_temp.p('OA')), (pg_temp.p('OC'), pg_temp.p('CB'));
insert into public.presence_hidden_from (user_id, hidden_user_id) values
  (pg_temp.p('OA'), pg_temp.p('HF')), (pg_temp.p('OC'), pg_temp.p('CH'));

-- A closed league: OA and LM (admitted while closed, by the insert trigger).
insert into public.leagues (id, name, is_open, created_by) values
  ('b9300000-0000-4000-8000-000000000001', 'PS Test Closed', false, pg_temp.p('OA'));
insert into public.league_members (league_id, user_id, role) values
  ('b9300000-0000-4000-8000-000000000001', pg_temp.p('OA'), 'admin'),
  ('b9300000-0000-4000-8000-000000000001', pg_temp.p('LM'), 'member')
on conflict do nothing;

-- Phones: everyone but CT. Push on for all but CP; CN has "Friends on the way" off.
insert into public.push_tokens (user_id, token, platform)
select id, 'ExponentPushToken[ps-' || lower(k) || ']', 'ios' from _p where k <> 'CT';
insert into public.user_preferences (user_id, prefs)
select id, case k when 'CP' then '{"pushEnabled": false}'::jsonb
                  when 'CN' then '{"pushEnabled": true, "notifyFriendsOnTheWay": false}'::jsonb
                  else '{"pushEnabled": true}'::jsonb end
  from _p
on conflict (user_id) do update set prefs = excluded.prefs;

-- @@MIGRATION@@


-- ════ Helpers that read court_plans (after its new columns exist) ═══════
create function pg_temp.pl(p_id uuid) returns public.court_plans language sql stable as $$
  select * from public.court_plans where id = p_id
$$;

-- Persona k saves a UTC every-day routine at p_venue for now + p_in; keeps
-- 'R<key>' (the routine) and 'S<key>' (its stop at exactly t(p_in)).
create function pg_temp.rt(k text, p_venue text, p_in interval, p_key text, p_len int default 120) returns uuid
language plpgsql as $$
declare
  v_x  time := ((now() at time zone 'UTC') + p_in)::time;
  v_t  time := make_time(extract(hour from v_x)::int, extract(minute from v_x)::int, 0);
  v_id uuid;
begin
  perform pg_temp.rpc(k, format('select public.save_court_routine(null, %L, %L::time, 127, %L, %s, null)',
                                p_venue, v_t, 'UTC', p_len));
  select id into v_id from public.court_routines
   where user_id = pg_temp.p(k) and venue_id = p_venue and local_time = v_t;
  perform pg_temp.keep('R' || p_key, v_id);
  perform pg_temp.keep('S' || p_key,
    (select pl.id from public.court_plans pl where pl.routine_id = v_id and pl.planned_at = pg_temp.t(p_in)));
  return v_id;
end $$;

-- After an edit re-made a routine's stops: the stop at p_at again.
create function pg_temp.restop(p_key text, p_at timestamptz) returns uuid language plpgsql as $$
declare v uuid;
begin
  select pl.id into v from public.court_plans pl where pl.routine_id = pg_temp.i('R' || p_key) and pl.planned_at = p_at;
  perform pg_temp.keep('S' || p_key, v);
  return v;
end $$;

-- plan_court_checkin as persona k (p_share given); keeps the plan as p_key.
create function pg_temp.plan(k text, p_venue text, p_in interval, p_share boolean, p_key text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.rpc(k, format('select public.plan_court_checkin(p_venue => %L, p_at => %L, p_share => %L)',
                                p_venue, pg_temp.t(p_in), p_share));
  select pl.id into v from public.court_plans pl
   where pl.user_id = pg_temp.p(k) and pl.kind = 'once' and pl.venue_id = p_venue and pl.planned_at = pg_temp.t(p_in)
     and pl.status = 'planned';
  perform pg_temp.keep(p_key, v);
  return v;
end $$;

-- list_friend_court_plans as viewer k.
create function pg_temp.fp(k text, p_venue text default null, p_days int default 7) returns jsonb
language plpgsql as $$
begin
  return pg_temp.rpc(k, format('select public.list_friend_court_plans(%L, %s)', p_venue, coalesce(p_days::text, 'null')));
end $$;

-- The row viewer k gets for plan p_plan (null when absent).
create function pg_temp.fprow(k text, p_plan uuid, p_venue text default null, p_days int default 7) returns jsonb
language sql as $$
  select x from jsonb_array_elements(coalesce(pg_temp.fp(k, p_venue, p_days), '[]'::jsonb)) x
   where (x ->> 'plan_id')::uuid = p_plan limit 1
$$;
create function pg_temp.sees(k text, p_plan uuid, p_venue text default null, p_days int default 7) returns boolean
language sql as $$ select p_plan is not null and pg_temp.fprow(k, p_plan, p_venue, p_days) is not null $$;
create function pg_temp.blind(k text, p_plan uuid, p_venue text default null, p_days int default 7) returns boolean
language sql as $$ select p_plan is not null and pg_temp.fprow(k, p_plan, p_venue, p_days) is null $$;

-- Persona keys with a friend_plan push from sender k (at p_venue, or any), comma-joined.
create function pg_temp.pushed(p_who text, p_venue text default null) returns text language sql stable as $$
  select coalesce(string_agg(r.k, ',' order by r.k), '')
    from public.push_outbox o join _p r on r.id = o.recipient_id
   where o.push_data ->> 'kind' = 'friend_plan' and o.push_data ->> 'sender_id' = pg_temp.p(p_who)::text
     and (p_venue is null or o.push_data ->> 'venue_id' = p_venue)
$$;

-- A stop's share as text, for details.
create function pg_temp.share(p_id uuid) returns text language sql stable as $$
  select coalesce(share_source, 'null') || ' @ ' || coalesce(shared_at::text, 'null') || ' ' || status
    from public.court_plans where id = p_id
$$;


-- ════ P16 grants, attributes, the one plan_court_checkin ════════════════
do $$
declare
  f        text;
  v_bad    text;
  v_client text[] := array[
    'public.confirm_court_plans(uuid[])',
    'public.set_court_plan_shared(uuid,boolean)',
    'public.set_auto_share_routines(boolean)',
    'public.list_friend_court_plans(text,integer)',
    'public.plan_court_checkin(text,timestamptz,integer,boolean)',
    'public.list_my_court_plans()',
    'public.list_my_court_routines()',
    'public.get_court_routine_settings()',
    'public.save_court_routine(uuid,text,time,integer,text,integer,jsonb)',
    'public.list_profile_court_routines(uuid)'];
  v_internal text[] := array[
    'public._pl_plan_visible(uuid,public.court_plans)',
    'public._pl_friend_plan_push(uuid)',
    'public._pl_court_plan_auto_share()'];
  -- Every function a client may call that runs as its owner (so past RLS)
  -- and names court_plans or court_routines in its body. Each answers only
  -- the caller's own rows, but for list_friend_court_plans (rule 8) and
  -- list_profile_court_routines (rule 11). A new one fails this check: read
  -- it for a leak of other players' plans, then add it here.
  v_readers text[] := array[
    'public.cancel_court_plan(uuid)',
    'public.confirm_court_plans(uuid[])',
    'public.delete_court_routine(uuid)',
    'public.list_friend_court_plans(text,integer)',
    'public.list_my_court_plans()',
    'public.list_my_court_routines()',
    'public.list_profile_court_routines(uuid)',
    'public.move_court_plan(uuid,timestamptz)',
    'public.move_court_routine_occurrence(uuid,timestamptz)',
    'public.plan_court_checkin(text,timestamptz,integer,boolean)',
    'public.save_court_routine(uuid,text,time,integer,text,integer,jsonb)',
    'public.set_auto_share_routines(boolean)',
    'public.set_court_plan_shared(uuid,boolean)',
    'public.set_court_routine_active(uuid,boolean)',
    'public.skip_court_routine_occurrence(uuid)',
    'public.suggest_court_routines(text)',
    'public.unskip_court_routine_occurrence(uuid)'];
  v_extra   text;
  v_missing text;
begin
  perform pg_temp.as_admin();
  foreach f in array v_client loop
    perform pg_temp.ok('P16 authenticated may execute ' || f,
      to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'EXECUTE'));
    perform pg_temp.ok('P16 anon may not execute ' || f,
      to_regprocedure(f) is not null and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  foreach f in array v_internal loop
    perform pg_temp.ok('P16 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  select string_agg(w.sig, ', ') into v_bad
    from unnest(v_client || v_internal) w(sig)
   where not exists (select 1 from pg_proc p where p.oid = to_regprocedure(w.sig)
                      and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""');
  perform pg_temp.ok('P16 every new and replaced function is SECURITY DEFINER with an empty search_path', v_bad is null, v_bad);
  perform pg_temp.ok('P9 exactly one plan_court_checkin (4 arguments; the 3-argument one is gone after the one-off file''s re-run too)',
    (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'plan_court_checkin')
    and to_regprocedure('public.plan_court_checkin(text,timestamptz,integer)') is null);
  perform pg_temp.ok('P16 trigger trg_court_plans_auto_share: BEFORE INSERT on court_plans, enabled',
    exists (select 1 from pg_trigger tg
             where tg.tgrelid = 'public.court_plans'::regclass and tg.tgname = 'trg_court_plans_auto_share'
               and tg.tgenabled = 'O' and (tg.tgtype & 2) = 2 and (tg.tgtype & 4) = 4));
  perform pg_temp.ok('P16 court_plans stays owner-only: one policy, no client writes, nothing for anon',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'court_plans') = 1
    and not has_table_privilege('authenticated', 'public.court_plans', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.court_plans', 'SELECT'));
  perform pg_temp.ok('P16 columns: court_plans.shared_at, share_source; presence_settings.auto_share_routines (not null, default false)',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'court_plans'
               and column_name = 'shared_at' and data_type = 'timestamp with time zone')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'court_plans'
                   and column_name = 'share_source' and data_type = 'text')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'presence_settings'
                   and column_name = 'auto_share_routines' and is_nullable = 'NO' and column_default = 'false'));

  -- Nothing new reads plans or routines for other players.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_extra
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prosrc ~* 'court_(plans|routines)'
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
     and p.oid not in (select to_regprocedure(r)::oid from unnest(v_readers) r where to_regprocedure(r) is not null);
  select string_agg(r, ', ' order by r) into v_missing
    from unnest(v_readers) r
   where to_regprocedure(r) is null
      or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(r) and p.prosecdef
                        and p.prosrc ~* 'court_(plans|routines)'
                        and has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  perform pg_temp.ok('P16 the client-callable SECURITY DEFINER functions that name court_plans / court_routines are exactly the known '
                     || cardinality(v_readers) || ' (a new one: check it for a leak, then list it)',
    v_extra is null and v_missing is null,
    'not listed: ' || coalesce(v_extra, 'none') || ' | listed, not found: ' || coalesce(v_missing, 'none'));
  perform pg_temp.ok('P16 no view in public reads court_plans or court_routines (a view would run past RLS)',
    not exists (select 1 from pg_views where schemaname = 'public' and definition ~* 'court_(plans|routines)'));
  perform pg_temp.ok('P16 court_plans and court_routines are in no realtime publication',
    not exists (select 1 from pg_publication_tables where schemaname = 'public' and tablename in ('court_plans', 'court_routines')));
  perform pg_temp.ok('P16 the auto-share trigger, save_court_routine and set_auto_share_routines take the owner''s court_plans lock',
    (select bool_and(p.prosrc like '%pg_advisory_xact_lock(hashtext(''court_plans:''%') from pg_proc p
      where p.oid in (to_regprocedure('public._pl_court_plan_auto_share()'),
                      to_regprocedure('public.save_court_routine(uuid,text,time,integer,text,integer,jsonb)'),
                      to_regprocedure('public.set_auto_share_routines(boolean)')))
    and (select count(*) from pg_proc p
          where p.oid in (to_regprocedure('public._pl_court_plan_auto_share()'),
                          to_regprocedure('public.save_court_routine(uuid,text,time,integer,text,integer,jsonb)'),
                          to_regprocedure('public.set_auto_share_routines(boolean)'))) = 3);
end $$;


-- ════ P18 the check constraint ══════════════════════════════════════════
do $$
declare
  q text := $q$insert into public.court_plans (user_id, venue_id, planned_at, planned_end_at, kind, shared_at, share_source)
               values ('a9300000-0000-4000-8000-000000000005', 'test:ps-e2', now() + interval '20 hours',
                       now() + interval '22 hours', 'once', %s, %L)$q$;
begin
  perform pg_temp.ok('P18 shared_at set with ''hidden'' is refused (court_plans_share_chk)',
    pg_temp.err(format(q, 'now()', 'hidden')) ->> 'state' = '23514');
  perform pg_temp.ok('P18 shared_at null with ''confirm'' is refused',
    pg_temp.err(format(q, 'null', 'confirm')) ->> 'state' = '23514');
  perform pg_temp.ok('P18 shared_at null with ''plan'' / ''auto'' is refused',
    pg_temp.err(format(q, 'null', 'plan')) ->> 'state' = '23514'
    and pg_temp.err(format(q, 'null', 'auto')) ->> 'state' = '23514');
  perform pg_temp.ok('P18 an unknown share_source is refused',
    pg_temp.err(format(q, 'now()', 'everyone')) ->> 'state' = '23514');
  perform pg_temp.ok('P18 shared_at set with no share_source is refused',
    pg_temp.err(format(q, 'now()', null)) ->> 'state' = '23514');
  perform pg_temp.ok('P18 nothing was written', not exists (select 1 from public.court_plans where user_id = pg_temp.p('OE')));
end $$;


-- ════ Routines for the sections below (auto-share off) ══════════════════
do $$
begin
  perform pg_temp.rt('OA', 'test:ps-r1', '2 hours', '1');
  perform pg_temp.rt('OA', 'test:ps-r1', '5 hours', '2');
  perform pg_temp.rt('OA', 'test:ps-r3', '3 hours', '3');
  perform pg_temp.rt('OA', 'test:ps-r2', '2 hours', '4');
  perform pg_temp.rt('OA', 'test:ps-r2', '6 hours', '5');
  perform pg_temp.rt('OA', 'test:ps-r3', '7 hours', '6');
  perform pg_temp.rt('OA', 'test:ps-r3', '10 hours', '7');
  perform pg_temp.rt('OA', 'test:ps-r2', '4 hours', '8');
  perform pg_temp.rt('OB', 'test:ps-b1', '2 hours', 'B1');
  perform pg_temp.rt('OB', 'test:ps-b1', '5 hours', 'B2');
  perform pg_temp.rt('OB', 'test:ps-b2', '2 hours', 'B3');
  perform pg_temp.rt('OB', 'test:ps-b2', '5 hours', 'B4');
  -- OA's one-off plan (private).
  perform pg_temp.plan('OA', 'test:ps-c7', '3 hours', false, 'OA7');
  perform pg_temp.ok('setup: every routine stop and plan the sections use exists',
    (select count(*) from _ids where id is null) = 0
    and (select count(*) from _ids) = 25,
    (select string_agg(k || '=' || coalesce(id::text, 'NULL'), ', ' order by k) from _ids));
end $$;


-- ════ P17 the owner's reads carry the share; the setting defaults off ═══
do $$
declare
  j jsonb;
  r jsonb;
begin
  j := pg_temp.rpc('OA', 'select public.get_court_routine_settings()');
  perform pg_temp.ok('P17 get_court_routine_settings: auto_share_routines false by default, routine_auto_checkin unchanged (true)',
    j = jsonb_build_object('routine_auto_checkin', true, 'auto_share_routines', false), j::text);
  j := pg_temp.rpc('OA', 'select public.list_my_court_routines()');
  select x into r from jsonb_array_elements(j) x where (x ->> 'id')::uuid = pg_temp.i('R1');
  perform pg_temp.ok('P17 list_my_court_routines: next carries shared_at and share_source (null: never shared)',
    (r -> 'next' ->> 'plan_id')::uuid = pg_temp.i('S1')
    and r -> 'next' ? 'shared_at' and r -> 'next' ? 'share_source'
    and r -> 'next' -> 'shared_at' = 'null'::jsonb and r -> 'next' -> 'share_source' = 'null'::jsonb, r::text);
  perform pg_temp.ok('P17 and so does every occurrence',
    jsonb_array_length(r -> 'occurrences') >= 1
    and not exists (select 1 from jsonb_array_elements(r -> 'occurrences') o
                     where not (o ? 'shared_at' and o ? 'share_source' and o ? 'windows')), r::text);
  j := pg_temp.rpc('OA', 'select public.list_my_court_plans()');
  perform pg_temp.ok('P17 list_my_court_plans: kind once, shared_at and share_source (null), the old keys kept',
    jsonb_array_length(j) = 1 and (j -> 0 ->> 'plan_id')::uuid = pg_temp.i('OA7') and j -> 0 ->> 'kind' = 'once'
    and j -> 0 ? 'shared_at' and j -> 0 -> 'share_source' = 'null'::jsonb
    and j -> 0 ? 'starred' and j -> 0 ? 'venue_name' and j -> 0 ? 'planned_end_at', j::text);
end $$;


-- ════ P1 a routine stop made with auto-share off is private ═════════════
do $$
declare
  pl public.court_plans;
begin
  pl := pg_temp.pl(pg_temp.i('S1'));
  perform pg_temp.ok('P1 a routine stop materialized with auto-share off: shared_at null, share_source null',
    pl.id is not null and pl.kind = 'routine' and pl.shared_at is null and pl.share_source is null, row_to_json(pl)::text);
  perform pg_temp.ok('P1 a friend''s list_friend_court_plans doesn''t return it', pg_temp.blind('FR', pl.id));
  perform pg_temp.ok('P1 FR sees none of OA''s stops yet',
    not exists (select 1 from jsonb_array_elements(pg_temp.fp('FR')) x where (x ->> 'user_id')::uuid = pg_temp.p('OA')));
  perform pg_temp.ok('P1 no stop made before this file (or since, auto-share off) is shared',
    not exists (select 1 from public.court_plans where user_id in (select id from _p) and shared_at is not null));
end $$;


-- ════ P2 confirm shares a stop ══════════════════════════════════════════
do $$
declare
  j  jsonb;
  pl public.court_plans;
  x  jsonb;
begin
  j := pg_temp.rpc('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S1')));
  pl := pg_temp.pl(pg_temp.i('S1'));
  perform pg_temp.ok('P2 confirm_court_plans: share_source confirm, shared_at now, still planned',
    pl.share_source = 'confirm' and pl.shared_at = now() and pl.status = 'planned', row_to_json(pl)::text);
  perform pg_temp.ok('P2 the answer is list_my_court_routines, the stop confirmed in it',
    exists (select 1 from jsonb_array_elements(j) r, jsonb_array_elements(r -> 'occurrences') o
             where (o ->> 'plan_id')::uuid = pl.id and o ->> 'share_source' = 'confirm'
               and (o ->> 'shared_at')::timestamptz = now()), j::text);
  x := pg_temp.fprow('FR', pl.id);
  perform pg_temp.ok('P2 a friend (default plans_level friends) sees it: kind routine, the owner, the court, the times',
    x ->> 'kind' = 'routine' and (x ->> 'user_id')::uuid = pg_temp.p('OA') and x ->> 'full_name' = 'Ana Owner'
    and x ->> 'venue_id' = 'test:ps-r1' and x ->> 'venue_name' = 'PS Test R1'
    and (x ->> 'planned_at')::timestamptz = pg_temp.t('2 hours')
    and (x ->> 'planned_end_at')::timestamptz = pg_temp.t('4 hours')
    and (x ->> 'is_friend')::boolean and not (x ->> 'is_close_friend')::boolean
    and (x ->> 'lat')::float8 = 41.60, coalesce(x::text, 'absent'));
  perform pg_temp.ok('P2 the row has exactly the documented keys (no windows, no group)',
    (select array_agg(k order by k) from jsonb_object_keys(x) k)
      = array['avatar_bg_color', 'avatar_emoji', 'avatar_url', 'full_name', 'is_close_friend', 'is_friend', 'kind',
              'lat', 'lng', 'plan_id', 'planned_at', 'planned_end_at', 'user_id', 'venue_id', 'venue_name'],
    coalesce(x::text, 'absent'));
  x := pg_temp.fprow('CF', pl.id);
  perform pg_temp.ok('P2 a friend who starred OA: is_close_friend true', (x ->> 'is_close_friend')::boolean, coalesce(x::text, 'absent'));
  perform pg_temp.ok('P2 the owner never gets their own plans in the friends read', pg_temp.blind('OA', pl.id));
  perform pg_temp.ok('P2 _pl_plan_visible: false for the owner, true for FR',
    not public._pl_plan_visible(pg_temp.p('OA'), pl) and public._pl_plan_visible(pg_temp.p('FR'), pl));
end $$;


-- ════ P3 a re-confirm is idempotent ═════════════════════════════════════
do $$
declare
  e  jsonb;
  pl public.court_plans;
begin
  update public.court_plans set shared_at = now() - interval '1 hour' where id = pg_temp.i('S1');
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S1')));
  pl := pg_temp.pl(pg_temp.i('S1'));
  perform pg_temp.ok('P3 confirming again: no error, shared_at unchanged, still confirm',
    e is null and pl.shared_at = now() - interval '1 hour' and pl.share_source = 'confirm', coalesce(e::text, pg_temp.share(pl.id)));
end $$;


-- ════ P4 only my own stops ══════════════════════════════════════════════
do $$
declare
  e jsonb;
begin
  e := pg_temp.err_as('OB', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S2')));
  perform pg_temp.ok('P4 another player''s stop: pl:plan.gone, nothing shared',
    e ->> 'hint' = 'pl:plan.gone'
    and e ->> 'msg' = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.'
    and (pg_temp.pl(pg_temp.i('S2'))).shared_at is null, coalesce(e::text, 'no error'));
  e := pg_temp.err_as('FR', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S2')));
  perform pg_temp.ok('P4 nor a friend', e ->> 'hint' = 'pl:plan.gone' and (pg_temp.pl(pg_temp.i('S2'))).shared_at is null,
    coalesce(e::text, 'no error'));
  -- Mine and OB's in one call: only mine change.
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L, %L, %L]::uuid[])',
                                   pg_temp.i('S2'), pg_temp.i('SB1'), gen_random_uuid()));
  perform pg_temp.ok('P4 mixed ids (mine, theirs, unknown): no error, mine confirmed, theirs untouched',
    e is null and (pg_temp.pl(pg_temp.i('S2'))).share_source = 'confirm'
    and (pg_temp.pl(pg_temp.i('SB1'))).shared_at is null and (pg_temp.pl(pg_temp.i('SB1'))).share_source is null,
    coalesce(e::text, pg_temp.share(pg_temp.i('SB1'))));
end $$;


-- ════ P5 only stops still planned and in play ═══════════════════════════
do $$
declare
  e jsonb;
begin
  -- 40 minutes past its time: over.
  update public.court_plans set planned_at = now() - interval '40 minutes' where id = pg_temp.i('S5');
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S5')));
  perform pg_temp.ok('P5 a stop 40 minutes past its time: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone'
    and (pg_temp.pl(pg_temp.i('S5'))).shared_at is null, coalesce(e::text, 'no error'));
  -- Skipped.
  perform pg_temp.rpc('OA', format('select public.skip_court_routine_occurrence(%L)', pg_temp.i('S6')));
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S6')));
  perform pg_temp.ok('P5 a skipped stop: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone'
    and (pg_temp.pl(pg_temp.i('S6'))).shared_at is null, coalesce(e::text, 'no error'));
  -- Kept by a check-in.
  update public.court_plans set status = 'completed' where id = pg_temp.i('S7');
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('S7')));
  perform pg_temp.ok('P5 a kept (completed) stop: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', coalesce(e::text, 'no error'));
  -- A one-off plan isn't a routine stop.
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('OA7')));
  perform pg_temp.ok('P5 a one-off plan: pl:plan.gone (it is shared with set_court_plan_shared)',
    e ->> 'hint' = 'pl:plan.gone' and (pg_temp.pl(pg_temp.i('OA7'))).shared_at is null, coalesce(e::text, 'no error'));
  -- All of them at once: still gone.
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(array[%L, %L, %L, %L]::uuid[])',
                                   pg_temp.i('S5'), pg_temp.i('S6'), pg_temp.i('S7'), pg_temp.i('OA7')));
  perform pg_temp.ok('P5 none eligible in a batch: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', coalesce(e::text, 'no error'));
end $$;


-- ════ P6 bad requests, signed out, anon ═════════════════════════════════
do $$
declare
  e jsonb;
  q text;
begin
  e := pg_temp.err_as('OA', $q$select public.confirm_court_plans('{}'::uuid[])$q$);
  perform pg_temp.ok('P6 no ids: pl:request.bad, says to update', e ->> 'hint' = 'pl:request.bad'
    and e ->> 'msg' = 'Couldn''t share your plans because the app sent an incomplete request. Update Pickleague, then try again.',
    coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', $q$select public.confirm_court_plans(null)$q$);
  perform pg_temp.ok('P6 null: pl:request.bad', e ->> 'hint' = 'pl:request.bad', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(%L::uuid[])',
                                   (select array_agg(gen_random_uuid()) from generate_series(1, 50))::text));
  perform pg_temp.ok('P6 50 ids is the most: not request.bad (here none is mine: plan.gone)', e ->> 'hint' = 'pl:plan.gone',
    coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', format('select public.confirm_court_plans(%L::uuid[])',
                                   (select array_agg(gen_random_uuid()) from generate_series(1, 51))::text));
  perform pg_temp.ok('P6 51 ids: pl:request.bad', e ->> 'hint' = 'pl:request.bad', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', format('select public.set_court_plan_shared(%L, null)', pg_temp.i('S1')));
  perform pg_temp.ok('P6 set_court_plan_shared without a choice: pl:request.bad, nothing changed',
    e ->> 'hint' = 'pl:request.bad' and (pg_temp.pl(pg_temp.i('S1'))).share_source = 'confirm', coalesce(e::text, 'no error'));

  perform pg_temp.as_signed_out();
  foreach q in array array[
    $s$select public.confirm_court_plans(array[gen_random_uuid()])$s$,
    $s$select public.set_court_plan_shared(gen_random_uuid(), true)$s$,
    $s$select public.set_auto_share_routines(true)$s$,
    $s$select public.list_friend_court_plans()$s$,
    $s$select public.plan_court_checkin('test:ps-c8', now() + interval '1 hour', 120, true)$s$] loop
    e := pg_temp.err(q);
    perform pg_temp.ok('P6 signed out: pl:auth.signed_out from ' || split_part(split_part(q, 'public.', 2), '(', 1),
      e ->> 'hint' = 'pl:auth.signed_out', coalesce(e::text, 'no error'));
  end loop;
  perform pg_temp.as_anon();
  foreach q in array array[
    $s$select public.confirm_court_plans(array[gen_random_uuid()])$s$,
    $s$select public.set_court_plan_shared(gen_random_uuid(), true)$s$,
    $s$select public.set_auto_share_routines(true)$s$,
    $s$select public.list_friend_court_plans()$s$,
    $s$select public.plan_court_checkin('test:ps-c8', now() + interval '1 hour', 120, true)$s$] loop
    e := pg_temp.err(q);
    perform pg_temp.ok('P6 anon: permission denied for ' || split_part(split_part(q, 'public.', 2), '(', 1),
      e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  end loop;
  perform pg_temp.as_admin();
end $$;


-- ════ P7 auto-share ═════════════════════════════════════════════════════
do $$
declare
  j jsonb;
  e jsonb;
  v_b5 uuid;
  v_b6 uuid;
  v_ob uuid;
begin
  -- Before: B2 made "Only you", B3 confirmed, B4 skipped; B1 untouched.
  perform pg_temp.rpc('OB', format('select public.set_court_plan_shared(%L, false)', pg_temp.i('SB2')));
  perform pg_temp.rpc('OB', format('select public.confirm_court_plans(array[%L]::uuid[])', pg_temp.i('SB3')));
  perform pg_temp.rpc('OB', format('select public.skip_court_routine_occurrence(%L)', pg_temp.i('SB4')));
  perform pg_temp.ok('P7 before: FR sees OB''s confirmed stop only',
    pg_temp.sees('FR', pg_temp.i('SB3')) and pg_temp.blind('FR', pg_temp.i('SB1'))
    and pg_temp.blind('FR', pg_temp.i('SB2')) and pg_temp.blind('FR', pg_temp.i('SB4')));

  j := pg_temp.rpc('OB', 'select public.set_auto_share_routines(true)');
  perform pg_temp.ok('P7 set_auto_share_routines(true) answers get_court_routine_settings, on',
    j = jsonb_build_object('routine_auto_checkin', true, 'auto_share_routines', true)
    and (select auto_share_routines from public.presence_settings where user_id = pg_temp.p('OB')), j::text);
  perform pg_temp.ok('P7 on: an unshared stop still in play becomes auto, shared now',
    (pg_temp.pl(pg_temp.i('SB1'))).share_source = 'auto' and (pg_temp.pl(pg_temp.i('SB1'))).shared_at = now(),
    pg_temp.share(pg_temp.i('SB1')));
  perform pg_temp.ok('P7 on: "Only you" stays hidden', (pg_temp.pl(pg_temp.i('SB2'))).share_source = 'hidden'
    and (pg_temp.pl(pg_temp.i('SB2'))).shared_at is null, pg_temp.share(pg_temp.i('SB2')));
  perform pg_temp.ok('P7 on: a confirmed one stays confirm', (pg_temp.pl(pg_temp.i('SB3'))).share_source = 'confirm',
    pg_temp.share(pg_temp.i('SB3')));
  perform pg_temp.ok('P7 on: a skipped one is auto too (Undo skip brings it back shared), still skipped',
    (pg_temp.pl(pg_temp.i('SB4'))).share_source = 'auto' and (pg_temp.pl(pg_temp.i('SB4'))).status = 'cancelled',
    pg_temp.share(pg_temp.i('SB4')));
  perform pg_temp.ok('P7 FR sees B1 (auto) and B3, not B2 (Only you) nor B4 (skipped)',
    pg_temp.sees('FR', pg_temp.i('SB1')) and pg_temp.sees('FR', pg_temp.i('SB3'))
    and pg_temp.blind('FR', pg_temp.i('SB2')) and pg_temp.blind('FR', pg_temp.i('SB4')));
  perform pg_temp.rpc('OB', format('select public.unskip_court_routine_occurrence(%L)', pg_temp.i('SB4')));
  perform pg_temp.ok('P7 Undo skip: planned, still auto, FR sees it',
    (pg_temp.pl(pg_temp.i('SB4'))).status = 'planned' and (pg_temp.pl(pg_temp.i('SB4'))).share_source = 'auto'
    and pg_temp.sees('FR', pg_temp.i('SB4')), pg_temp.share(pg_temp.i('SB4')));

  -- A routine saved while on: its stop is auto from the start (the trigger).
  perform pg_temp.rt('OB', 'test:ps-b2', '8 hours', 'B5');
  v_b5 := pg_temp.i('SB5');
  perform pg_temp.ok('P7 a stop made while on is auto (trg_court_plans_auto_share), FR sees it',
    (pg_temp.pl(v_b5)).share_source = 'auto' and (pg_temp.pl(v_b5)).shared_at = now() and pg_temp.sees('FR', v_b5),
    pg_temp.share(v_b5));
  -- A one-off plan while on is NOT shared (auto-share is for routine stops).
  v_ob := pg_temp.plan('OB', 'test:ps-c8', '4 hours', false, 'OB8');
  perform pg_temp.ok('P7 a one-off plan made while on stays private (auto-share is for routine stops only)',
    v_ob is not null and (pg_temp.pl(v_ob)).shared_at is null and (pg_temp.pl(v_ob)).share_source is null
    and pg_temp.blind('FR', v_ob), pg_temp.share(v_ob));

  j := pg_temp.rpc('OB', 'select public.set_auto_share_routines(false)');
  perform pg_temp.ok('P7 set_auto_share_routines(false): off',
    j ->> 'auto_share_routines' = 'false' and not (select auto_share_routines from public.presence_settings where user_id = pg_temp.p('OB')),
    j::text);
  perform pg_temp.ok('P7 off: every auto stop is private again (B1, B4, B5)',
    (pg_temp.pl(pg_temp.i('SB1'))).share_source is null and (pg_temp.pl(pg_temp.i('SB1'))).shared_at is null
    and (pg_temp.pl(pg_temp.i('SB4'))).share_source is null and (pg_temp.pl(v_b5)).share_source is null
    and (pg_temp.pl(v_b5)).shared_at is null,
    pg_temp.share(pg_temp.i('SB1')) || ' | ' || pg_temp.share(pg_temp.i('SB4')) || ' | ' || pg_temp.share(v_b5));
  perform pg_temp.ok('P7 off: confirm and hidden stay as they were',
    (pg_temp.pl(pg_temp.i('SB3'))).share_source = 'confirm' and (pg_temp.pl(pg_temp.i('SB3'))).shared_at = now()
    and (pg_temp.pl(pg_temp.i('SB2'))).share_source = 'hidden');
  perform pg_temp.ok('P7 FR sees only B3 now',
    pg_temp.sees('FR', pg_temp.i('SB3')) and pg_temp.blind('FR', pg_temp.i('SB1'))
    and pg_temp.blind('FR', pg_temp.i('SB4')) and pg_temp.blind('FR', v_b5) and pg_temp.blind('FR', pg_temp.i('SB2')));
  perform pg_temp.rt('OB', 'test:ps-b1', '8 hours', 'B6');
  v_b6 := pg_temp.i('SB6');
  perform pg_temp.ok('P7 a stop made after turning it off is private',
    v_b6 is not null and (pg_temp.pl(v_b6)).shared_at is null and (pg_temp.pl(v_b6)).share_source is null, pg_temp.share(v_b6));
  perform pg_temp.ok('P7 no push for any of it',
    not exists (select 1 from public.push_outbox o where o.push_data ->> 'sender_id' = pg_temp.p('OB')::text));
  -- A first call by someone with no settings row makes one.
  delete from public.presence_settings where user_id = pg_temp.p('OE');
  j := pg_temp.rpc('OE', 'select public.set_auto_share_routines(null)');
  perform pg_temp.ok('P7 no settings row yet: one is made; null means off',
    j ->> 'auto_share_routines' = 'false'
    and exists (select 1 from public.presence_settings where user_id = pg_temp.p('OE') and not auto_share_routines), j::text);
  insert into public.presence_settings (user_id, consent_seen_at) values (pg_temp.p('OE'), now())
  on conflict (user_id) do update set consent_seen_at = excluded.consent_seen_at;
end $$;


-- ════ P9 one-off plans: shared only when asked ══════════════════════════
do $$
declare
  j  jsonb;
  pl public.court_plans;
  v  uuid;
  x  jsonb;
begin
  j := pg_temp.rpc('OC', format('select public.plan_court_checkin(p_venue => %L, p_at => %L, p_share => true)',
                                'test:ps-c1', pg_temp.t('3 hours')));
  select * into pl from public.court_plans where user_id = pg_temp.p('OC') and venue_id = 'test:ps-c1' and planned_at = pg_temp.t('3 hours');
  perform pg_temp.keep('C1', pl.id);
  perform pg_temp.ok('P9 p_share => true: share_source plan, shared_at now',
    pl.kind = 'once' and pl.share_source = 'plan' and pl.shared_at = now(), row_to_json(pl)::text);
  perform pg_temp.ok('P17 the answer (list_my_court_plans) carries kind, shared_at, share_source',
    exists (select 1 from jsonb_array_elements(j) y where (y ->> 'plan_id')::uuid = pl.id and y ->> 'kind' = 'once'
              and y ->> 'share_source' = 'plan' and (y ->> 'shared_at')::timestamptz = now()), j::text);
  x := pg_temp.fprow('FR', pl.id);
  perform pg_temp.ok('P9 a friend sees it, kind once', x ->> 'kind' = 'once' and x ->> 'venue_id' = 'test:ps-c1'
    and x ->> 'full_name' = 'Cleo Planner', coalesce(x::text, 'absent'));

  -- The old call shapes: by name with 2 and 3 arguments, positional 3: private.
  perform pg_temp.rpc('OC', format('select public.plan_court_checkin(p_venue => %L, p_at => %L)', 'test:ps-c2', pg_temp.t('3 hours')));
  perform pg_temp.rpc('OC', format('select public.plan_court_checkin(p_venue => %L, p_at => %L, p_length_min => 90)',
                                   'test:ps-c2', pg_temp.t('6 hours')));
  perform pg_temp.rpc('OC', format('select public.plan_court_checkin(%L, %L, 120)', 'test:ps-c2', pg_temp.t('9 hours')));
  perform pg_temp.ok('P9 calls by name with 2 and 3 arguments, and positional, resolve: three plans, all private',
    (select count(*) from public.court_plans where user_id = pg_temp.p('OC') and venue_id = 'test:ps-c2'
       and kind = 'once' and shared_at is null and share_source is null) = 3
    and exists (select 1 from public.court_plans where user_id = pg_temp.p('OC') and venue_id = 'test:ps-c2'
                   and planned_at = pg_temp.t('6 hours') and planned_end_at = pg_temp.t('7 hours 30 minutes')));
  select id into v from public.court_plans where user_id = pg_temp.p('OC') and venue_id = 'test:ps-c2' and planned_at = pg_temp.t('3 hours');
  perform pg_temp.keep('C2', v);
  perform pg_temp.ok('P9 a plan made without p_share: a friend doesn''t see it', pg_temp.blind('FR', v));
  perform pg_temp.rpc('OC', format('select public.plan_court_checkin(p_venue => %L, p_at => %L, p_share => null)',
                                   'test:ps-c8', pg_temp.t('3 hours')));
  perform pg_temp.ok('P9 p_share null: private',
    exists (select 1 from public.court_plans where user_id = pg_temp.p('OC') and venue_id = 'test:ps-c8'
               and shared_at is null and share_source is null));
end $$;


-- ════ P10 who sees a shared plan ════════════════════════════════════════
do $$
declare
  v_s4 uuid := pg_temp.i('S4');
  x    jsonb;
  v_od uuid;
begin
  perform pg_temp.rpc('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', v_s4));
  perform pg_temp.ok('P10 friend FR sees S4 (shared, plans_level friends)', pg_temp.sees('FR', v_s4));

  update public.presence_settings set plans_level = 'hidden' where user_id = pg_temp.p('OA');
  perform pg_temp.ok('P10 plans_level hidden: FR doesn''t', pg_temp.blind('FR', v_s4));
  update public.presence_settings set plans_level = 'friends', paused_until = now() + interval '1 hour' where user_id = pg_temp.p('OA');
  perform pg_temp.ok('P10 paused: FR doesn''t', pg_temp.blind('FR', v_s4));
  update public.presence_settings set paused_until = null where user_id = pg_temp.p('OA');
  perform pg_temp.ok('P10 unpaused: FR does again', pg_temp.sees('FR', v_s4));

  perform pg_temp.ok('P10 a friend OA hid from: no', pg_temp.blind('HF', v_s4));
  perform pg_temp.ok('P10 a friend OA blocked: no', pg_temp.blind('BK', v_s4));
  perform pg_temp.ok('P10 a friend who blocked OA: no', pg_temp.blind('BY', v_s4));
  perform pg_temp.ok('P10 a guest (OA''s friend): nothing at all', pg_temp.fp('GU') = '[]'::jsonb, pg_temp.fp('GU')::text);
  perform pg_temp.ok('P10 a stranger: nothing at all', pg_temp.fp('ST') = '[]'::jsonb, pg_temp.fp('ST')::text);

  perform pg_temp.ok('P10 a closed-league mate under plans_level friends: no', pg_temp.fp('LM') = '[]'::jsonb, pg_temp.fp('LM')::text);
  update public.presence_settings set plans_level = 'leaguemates' where user_id = pg_temp.p('OA');
  x := pg_temp.fprow('LM', v_s4);
  perform pg_temp.ok('P10 under plans_level leaguemates: yes, is_friend false',
    x is not null and not (x ->> 'is_friend')::boolean and not (x ->> 'is_close_friend')::boolean, coalesce(x::text, 'absent'));
  perform pg_temp.ok('P10 and still not to the guest or the stranger', pg_temp.fp('GU') = '[]'::jsonb and pg_temp.fp('ST') = '[]'::jsonb);
  update public.presence_settings set plans_level = 'friends' where user_id = pg_temp.p('OA');

  -- A deleted account's plans go with it.
  v_od := pg_temp.plan('OD', 'test:ps-d1', '2 hours', true, 'OD1');
  perform pg_temp.ok('P10 OD''s shared plan: FR sees it', pg_temp.sees('FR', v_od));
  update public.profiles set deleted_at = now() where id = pg_temp.p('OD');
  perform pg_temp.ok('P10 OD deleted: FR doesn''t', pg_temp.blind('FR', v_od));
  perform pg_temp.ok('P10 _pl_plan_visible agrees: OD''s plan false, S4 true for FR, false for HF / BK / BY / GU / LM / ST',
    not public._pl_plan_visible(pg_temp.p('FR'), pg_temp.pl(v_od))
    and public._pl_plan_visible(pg_temp.p('FR'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('HF'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('BK'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('BY'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('GU'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('LM'), pg_temp.pl(v_s4))
    and not public._pl_plan_visible(pg_temp.p('ST'), pg_temp.pl(v_s4)));
  perform pg_temp.ok('P10 _pl_plan_visible: no viewer, or no plan, is false (never null)',
    public._pl_plan_visible(null, pg_temp.pl(v_s4)) = false
    and public._pl_plan_visible(pg_temp.p('FR'), null::public.court_plans) = false);
end $$;


-- ════ P10 a profile's weekly routines: only while auto-share is on ══════
do $$
declare
  q    text := format('select public.list_profile_court_routines(%L)', pg_temp.p('OA'));
  mine jsonb;
  j    jsonb;
  k    text;
  e    jsonb;
begin
  mine := pg_temp.rpc('OA', q);
  perform pg_temp.ok('P10 profile: my own routines, to me, whatever auto-share says (off here)',
    jsonb_array_length(mine) >= 3
    and not (select auto_share_routines from public.presence_settings where user_id = pg_temp.p('OA')), coalesce(mine::text, 'null'));
  j := pg_temp.rpc('FR', q);
  perform pg_temp.ok('P10 profile: auto-share off, a friend who sees OA''s plans gets [] (no pattern to read a stop off)',
    j = '[]'::jsonb, coalesce(j::text, 'null'));
  j := pg_temp.rpc('CF', q);
  perform pg_temp.ok('P10 profile: nor a friend who starred OA', j = '[]'::jsonb, coalesce(j::text, 'null'));

  update public.presence_settings set auto_share_routines = true where user_id = pg_temp.p('OA');
  j := pg_temp.rpc('FR', q);
  perform pg_temp.ok('P10 profile: auto-share on, the friend gets them all, the documented keys, never a window''s group',
    jsonb_array_length(j) = jsonb_array_length(mine)
    and not exists (select 1 from jsonb_array_elements(j) x
                     where (select array_agg(y order by y) from jsonb_object_keys(x) y)
                           <> array['days', 'length_min', 'local_time', 'tz', 'venue_id', 'venue_name', 'windows'])
    and not exists (select 1 from jsonb_array_elements(j) x, jsonb_array_elements(x -> 'windows') w where w ? 'group'),
    coalesce(j::text, 'null'));
  foreach k in array array['HF', 'BK', 'BY', 'GU', 'ST', 'LM'] loop
    j := pg_temp.rpc(k, q);
    perform pg_temp.ok('P10 profile: auto-share on, still [] to ' || k || ' (plan privacy as before)',
      j = '[]'::jsonb, coalesce(j::text, 'null'));
  end loop;
  update public.presence_settings set plans_level = 'hidden' where user_id = pg_temp.p('OA');
  j := pg_temp.rpc('FR', q);
  perform pg_temp.ok('P10 profile: auto-share on, plans hidden: []', j = '[]'::jsonb, coalesce(j::text, 'null'));
  update public.presence_settings set plans_level = 'friends' where user_id = pg_temp.p('OA');

  -- Off again from the setting's own RPC: gone again.
  perform pg_temp.rpc('OA', 'select public.set_auto_share_routines(false)');
  j := pg_temp.rpc('FR', q);
  perform pg_temp.ok('P10 profile: set_auto_share_routines(false): [] again', j = '[]'::jsonb, coalesce(j::text, 'null'));
  perform pg_temp.ok('P10 profile: and still all mine to me', pg_temp.rpc('OA', q) = mine);
  e := pg_temp.err_as('OA', format('select public.list_profile_court_routines(%L)', gen_random_uuid()));
  perform pg_temp.ok('P10 profile: an unknown player: [] (no error)', e is null);
  perform pg_temp.as_signed_out();
  e := pg_temp.err(q);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P10 profile: signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', coalesce(e::text, 'no error'));
end $$;


-- ════ P11 the time window ═══════════════════════════════════════════════
do $$
declare
  v_2h  uuid := pg_temp.plan('OE', 'test:ps-e1', '2 hours', true, 'E2H');
  v_4h  uuid := pg_temp.plan('OE', 'test:ps-e1', '4 hours', true, 'E4H');
  v_6d  uuid := pg_temp.plan('OE', 'test:ps-e1', '6 days', true, 'E6D');
  v_8d  uuid := pg_temp.plan('OE', 'test:ps-e1', '8 days', true, 'E8D');
  v_cmp uuid := pg_temp.plan('OE', 'test:ps-e2', '2 hours', true, 'ECMP');
  v_cxl uuid := pg_temp.plan('OE', 'test:ps-e2', '5 hours', true, 'ECXL');
begin
  perform pg_temp.ok('P11 setup: six shared plans', v_2h is not null and v_4h is not null and v_6d is not null
    and v_8d is not null and v_cmp is not null and v_cxl is not null);
  perform pg_temp.ok('P11 +6 days: yes; +8 days: no', pg_temp.sees('FR', v_6d) and pg_temp.blind('FR', v_8d));
  perform pg_temp.ok('P11 p_days 30 is clamped to 7: +6 days yes, +8 days no',
    pg_temp.sees('FR', v_6d, null, 30) and pg_temp.blind('FR', v_8d, null, 30));
  perform pg_temp.ok('P11 p_days 1: +2 h yes, +6 days no', pg_temp.sees('FR', v_2h, null, 1) and pg_temp.blind('FR', v_6d, null, 1));
  perform pg_temp.ok('P11 p_days 0 is clamped to 1, null means 7',
    pg_temp.sees('FR', v_2h, null, 0) and pg_temp.blind('FR', v_6d, null, 0)
    and pg_temp.sees('FR', v_6d, null, null));
  update public.court_plans set planned_at = now() + interval '7 days', planned_end_at = now() + interval '7 days 2 hours'
   where id = v_6d;
  perform pg_temp.ok('P11 exactly 7 days ahead: yes', pg_temp.sees('FR', v_6d));
  update public.court_plans set planned_at = now() + interval '7 days 1 millisecond' where id = v_6d;
  perform pg_temp.ok('P11 7 days and 1 ms ahead: no', pg_temp.blind('FR', v_6d));
  update public.court_plans set planned_at = now() - interval '29 minutes' where id = v_4h;
  perform pg_temp.ok('P11 29 minutes ago: still yes (in play)', pg_temp.sees('FR', v_4h));
  update public.court_plans set planned_at = now() - interval '30 minutes' where id = v_4h;
  perform pg_temp.ok('P11 30 minutes ago: no', pg_temp.blind('FR', v_4h));
  update public.court_plans set planned_at = now() - interval '31 minutes' where id = v_4h;
  perform pg_temp.ok('P11 31 minutes ago: no', pg_temp.blind('FR', v_4h));
  update public.court_plans set status = 'completed' where id = v_cmp;
  perform pg_temp.ok('P11 kept (completed): no', pg_temp.blind('FR', v_cmp));
  perform pg_temp.rpc('OE', format('select public.cancel_court_plan(%L)', v_cxl));
  perform pg_temp.ok('P11 cancelled: no', pg_temp.blind('FR', v_cxl) and (pg_temp.pl(v_cxl)).status = 'cancelled');
  update public.court_plans set status = 'missed' where id = v_2h;
  perform pg_temp.ok('P11 missed: no', pg_temp.blind('FR', v_2h));
  perform pg_temp.ok('P11 the read is in time order',
    (select bool_and(a <= b) from (
       select (x ->> 'planned_at')::timestamptz as a,
              lead((x ->> 'planned_at')::timestamptz) over (order by o) as b
         from jsonb_array_elements(pg_temp.fp('FR')) with ordinality y(x, o)) z where b is not null));
end $$;


-- ════ P12 a court's page: any row of the facility ═══════════════════════
do $$
declare
  v_c1 uuid := pg_temp.i('C1');
begin
  perform pg_temp.ok('P12 p_venue = the court: OC''s plan there', pg_temp.sees('FR', v_c1, 'test:ps-c1'));
  perform pg_temp.ok('P12 p_venue = a duplicate row of it: the same plan, venue_id canonical',
    pg_temp.fprow('FR', v_c1, 'test:ps-c1-osm') ->> 'venue_id' = 'test:ps-c1');
  perform pg_temp.ok('P12 p_venue = another court: not there', pg_temp.blind('FR', v_c1, 'test:ps-c2'));
  perform pg_temp.ok('P12 p_venue unknown: []', pg_temp.fp('FR', 'test:ps-nowhere') = '[]'::jsonb);
  perform pg_temp.ok('P12 p_venue only that court''s plans',
    not exists (select 1 from jsonb_array_elements(pg_temp.fp('FR', 'test:ps-c1')) x where x ->> 'venue_id' <> 'test:ps-c1'));
end $$;


-- ════ P13 a routine stop needs its routine and its star ═════════════════
do $$
declare
  v_s3 uuid := pg_temp.i('S3');
begin
  perform pg_temp.rpc('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', v_s3));
  perform pg_temp.ok('P13 S3 confirmed: FR sees it', pg_temp.sees('FR', v_s3));
  delete from public.court_favorites where user_id = pg_temp.p('OA') and venue_id = 'test:ps-r3';
  perform pg_temp.ok('P13 OA unstars the court: hidden at once (the row is still planned and shared)',
    pg_temp.blind('FR', v_s3) and (pg_temp.pl(v_s3)).status = 'planned' and (pg_temp.pl(v_s3)).shared_at is not null);
  insert into public.court_favorites (user_id, venue_id) values (pg_temp.p('OA'), 'test:ps-r3');
  perform pg_temp.ok('P13 starred again: seen again', pg_temp.sees('FR', v_s3));
  update public.court_routines set active = false where id = pg_temp.i('R3');
  perform pg_temp.ok('P13 its routine paused: hidden', pg_temp.blind('FR', v_s3));
  update public.court_routines set active = true where id = pg_temp.i('R3');
  perform pg_temp.ok('P13 resumed: seen', pg_temp.sees('FR', v_s3));
end $$;


-- ════ P14 the friend push ═══════════════════════════════════════════════
do $$
declare
  o    public.push_outbox;
  v    uuid;
  v_c3 uuid;
begin
  perform pg_temp.ok('P14 the shared plan at C1 told CF only (not FR: not a close friend; not CN, CP, CT, CB, CH, CS)',
    pg_temp.pushed('OC', 'test:ps-c1') = 'CF', pg_temp.pushed('OC', 'test:ps-c1'));
  select * into o from public.push_outbox
   where recipient_id = pg_temp.p('CF') and push_data ->> 'kind' = 'friend_plan' and push_data ->> 'plan_id' = pg_temp.i('C1')::text;
  perform pg_temp.ok('P14 the push: "Cleo Planner plans to play at PS Test C1" / "<day, time>. Tap to see the court."',
    o.title = 'Cleo Planner plans to play at PS Test C1'
    and o.body = public._pickleague_local_label(pg_temp.t('3 hours'), public._pickleague_tz_for(pg_temp.p('CF'))) || '. Tap to see the court.',
    row_to_json(o)::text);
  perform pg_temp.ok('P14 category notifyFriendsOnTheWay, kind info, link home/-, expires at the plan''s time',
    o.category = 'notifyFriendsOnTheWay' and o.kind = 'info' and o.deep_link = 'home/-'
    and o.expires_at = pg_temp.t('3 hours') and o.notification_id is null and o.status = 'pending', row_to_json(o)::text);
  perform pg_temp.ok('P14 push_data: kind friend_plan, plan, court, sender, time',
    o.push_data ->> 'plan_id' = pg_temp.i('C1')::text and o.push_data ->> 'venue_id' = 'test:ps-c1'
    and o.push_data ->> 'venue_name' = 'PS Test C1' and o.push_data ->> 'sender_id' = pg_temp.p('OC')::text
    and (o.push_data ->> 'planned_at')::timestamptz = pg_temp.t('3 hours'), o.push_data::text);
  perform pg_temp.ok('P14 one throttle row: OC, friend_plan, the court',
    (select count(*) from public.pl_throttle where scope = pg_temp.p('OC')::text and kind = 'friend_plan') = 1
    and exists (select 1 from public.pl_throttle where scope = pg_temp.p('OC')::text and kind = 'friend_plan' and key = 'test:ps-c1'));

  -- The same court within 6 hours: quiet. Another court: told.
  perform pg_temp.plan('OC', 'test:ps-c1', '6 hours', true, 'C1b');
  perform pg_temp.ok('P14 a second shared plan at C1 within 6 hours queues nothing new',
    (select count(*) from public.push_outbox where push_data ->> 'kind' = 'friend_plan'
       and push_data ->> 'sender_id' = pg_temp.p('OC')::text and push_data ->> 'venue_id' = 'test:ps-c1') = 1
    and (pg_temp.pl(pg_temp.i('C1b'))).share_source = 'plan');
  perform pg_temp.plan('OC', 'test:ps-c4', '3 hours', true, 'C4');
  perform pg_temp.ok('P14 another court: CF told', pg_temp.pushed('OC', 'test:ps-c4') = 'CF', pg_temp.pushed('OC', 'test:ps-c4'));

  -- Plans hidden / paused: nobody.
  update public.presence_settings set plans_level = 'hidden' where user_id = pg_temp.p('OC');
  perform pg_temp.plan('OC', 'test:ps-c5', '3 hours', true, 'C5');
  update public.presence_settings set plans_level = 'friends', paused_until = now() + interval '1 hour' where user_id = pg_temp.p('OC');
  perform pg_temp.plan('OC', 'test:ps-c6', '3 hours', true, 'C6');
  update public.presence_settings set paused_until = null where user_id = pg_temp.p('OC');
  perform pg_temp.ok('P14 plans hidden, or paused: nobody told',
    pg_temp.pushed('OC', 'test:ps-c5') = '' and pg_temp.pushed('OC', 'test:ps-c6') = ''
    and pg_temp.i('C5') is not null and pg_temp.i('C6') is not null);
  perform pg_temp.ok('P14 ...and with nobody told, those courts'' 6 hours stay unused (no throttle row)',
    not exists (select 1 from public.pl_throttle where scope = pg_temp.p('OC')::text and kind = 'friend_plan'
                   and key in ('test:ps-c5', 'test:ps-c6')));
  perform pg_temp.plan('OC', 'test:ps-c5', '5 hours', true, 'C5b');
  perform pg_temp.ok('P14 visible again, another shared plan at C5 within the 6 hours: CF told',
    pg_temp.i('C5b') is not null and pg_temp.pushed('OC', 'test:ps-c5') = 'CF', pg_temp.pushed('OC', 'test:ps-c5'));

  -- 10 days ahead: no push, and it doesn't use up the court's 6 hours.
  v_c3 := pg_temp.plan('OC', 'test:ps-c3', '10 days', true, 'C3far');
  perform pg_temp.ok('P14 a shared plan 10 days ahead: no push (beyond the 7 days friends see)',
    v_c3 is not null and pg_temp.pushed('OC', 'test:ps-c3') = ''
    and not exists (select 1 from public.pl_throttle where scope = pg_temp.p('OC')::text and kind = 'friend_plan' and key = 'test:ps-c3'));
  perform pg_temp.plan('OC', 'test:ps-c3', '3 hours', true, 'C3');
  perform pg_temp.ok('P14 then one 3 hours ahead at that court: told', pg_temp.pushed('OC', 'test:ps-c3') = 'CF',
    pg_temp.pushed('OC', 'test:ps-c3'));

  -- Not shared when made, shared later: no push.
  perform pg_temp.ok('P14 p_share false: no push', pg_temp.pushed('OC', 'test:ps-c2') = '' and pg_temp.pushed('OC', 'test:ps-c8') = '');
  perform pg_temp.rpc('OC', format('select public.set_court_plan_shared(%L, true)', pg_temp.i('C2')));
  perform pg_temp.ok('P14 shared later from its chip: share_source plan, no push',
    (pg_temp.pl(pg_temp.i('C2'))).share_source = 'plan' and pg_temp.pushed('OC', 'test:ps-c2') = '');
  perform pg_temp.ok('P14 routine confirms (OA, whom CF starred) and auto-share (OB): no push',
    pg_temp.pushed('OA') = '' and pg_temp.pushed('OB') = '');
  perform pg_temp.ok('P14 CF got 4 in all (C1, C4, C5b, C3); nobody else got any',
    (select count(*) from public.push_outbox where push_data ->> 'kind' = 'friend_plan'
       and push_data ->> 'sender_id' = pg_temp.p('OC')::text) = 4
    and pg_temp.pushed('OC') = 'CF,CF,CF,CF', pg_temp.pushed('OC'));
  perform pg_temp.ok('P14 _pl_friend_plan_push on a routine stop, a private plan or no plan: 0, never an error',
    public._pl_friend_plan_push(pg_temp.i('S4')) = 0 and public._pl_friend_plan_push(pg_temp.i('OB8')) = 0
    and public._pl_friend_plan_push(gen_random_uuid()) = 0 and public._pl_friend_plan_push(null) = 0);
end $$;


-- ════ P15 moving, skipping, cancelling never touch the share ════════════
do $$
declare
  v_s4  uuid := pg_temp.i('S4');
  before public.court_plans := pg_temp.pl(pg_temp.i('S4'));
  v_to  timestamptz;
  pl    public.court_plans;
begin
  v_to := case when ((before.planned_at + interval '5 minutes') at time zone 'UTC')::date = before.routine_date
               then before.planned_at + interval '5 minutes' else before.planned_at - interval '5 minutes' end;
  perform pg_temp.rpc('OA', format('select public.move_court_routine_occurrence(%L, %L)', v_s4, v_to));
  pl := pg_temp.pl(v_s4);
  perform pg_temp.ok('P15 move_court_routine_occurrence keeps shared_at and share_source; FR sees the new time',
    pl.planned_at = v_to and pl.shared_at = before.shared_at and pl.share_source = 'confirm'
    and (pg_temp.fprow('FR', v_s4) ->> 'planned_at')::timestamptz = v_to, pg_temp.share(v_s4));
  perform pg_temp.rpc('OA', format('select public.skip_court_routine_occurrence(%L)', v_s4));
  pl := pg_temp.pl(v_s4);
  perform pg_temp.ok('P15 skipped: still shared, hidden by its status',
    pl.status = 'cancelled' and pl.shared_at = before.shared_at and pl.share_source = 'confirm' and pg_temp.blind('FR', v_s4),
    pg_temp.share(v_s4));
  perform pg_temp.rpc('OA', format('select public.unskip_court_routine_occurrence(%L)', v_s4));
  pl := pg_temp.pl(v_s4);
  perform pg_temp.ok('P15 un-skipped: shared as before, FR sees it again',
    pl.status = 'planned' and pl.shared_at = before.shared_at and pl.share_source = 'confirm' and pg_temp.sees('FR', v_s4),
    pg_temp.share(v_s4));

  perform pg_temp.rpc('OC', format('select public.move_court_plan(%L, %L)', pg_temp.i('C4'), pg_temp.t('4 hours')));
  pl := pg_temp.pl(pg_temp.i('C4'));
  perform pg_temp.ok('P15 move_court_plan keeps the share; no new push',
    pl.planned_at = pg_temp.t('4 hours') and pl.share_source = 'plan' and pl.shared_at = now()
    and pg_temp.pushed('OC', 'test:ps-c4') = 'CF', pg_temp.share(pl.id));
  perform pg_temp.rpc('OC', format('select public.cancel_court_plan(%L)', pg_temp.i('C4')));
  pl := pg_temp.pl(pg_temp.i('C4'));
  perform pg_temp.ok('P15 cancel_court_plan: share kept, hidden by its status',
    pl.status = 'cancelled' and pl.share_source = 'plan' and pg_temp.blind('FR', pl.id), pg_temp.share(pl.id));
end $$;


-- ════ P8 "Only you", and an edited routine keeps the choice ═════════════
do $$
declare
  j     jsonb;
  e     jsonb;
  v_s1  uuid := pg_temp.i('S1');
  v_s8  uuid := pg_temp.i('S8');
  v_at8 timestamptz;
  v_new uuid;
begin
  j := pg_temp.rpc('OA', format('select public.set_court_plan_shared(%L, false)', v_s1));
  perform pg_temp.ok('P8 set_court_plan_shared(stop, false): hidden, shared_at null; answers plan_id, kind, shared_at, share_source',
    j = jsonb_build_object('plan_id', v_s1, 'kind', 'routine', 'shared_at', null, 'share_source', 'hidden')
    and (pg_temp.pl(v_s1)).share_source = 'hidden' and (pg_temp.pl(v_s1)).shared_at is null, coalesce(j::text, 'null'));
  perform pg_temp.ok('P8 FR doesn''t see it', pg_temp.blind('FR', v_s1));

  -- Auto-share on doesn't re-share it (S8 is unshared: it becomes auto).
  perform pg_temp.rpc('OA', 'select public.set_auto_share_routines(true)');
  perform pg_temp.ok('P8 auto-share on: the hidden stop stays hidden, an unshared one becomes auto',
    (pg_temp.pl(v_s1)).share_source = 'hidden' and pg_temp.blind('FR', v_s1)
    and (pg_temp.pl(v_s8)).share_source = 'auto', pg_temp.share(v_s1) || ' | ' || pg_temp.share(v_s8));
  perform pg_temp.rpc('OA', 'select public.set_auto_share_routines(false)');
  perform pg_temp.ok('P8 auto-share off: confirmed stops stay (S2, S3, S4), S8 private again',
    (pg_temp.pl(pg_temp.i('S2'))).share_source = 'confirm' and (pg_temp.pl(pg_temp.i('S3'))).share_source = 'confirm'
    and (pg_temp.pl(pg_temp.i('S4'))).share_source = 'confirm' and (pg_temp.pl(v_s8)).share_source is null);

  -- An edit (90 minutes long) re-makes the stops: hidden stays hidden.
  perform pg_temp.rpc('OA', format('select public.save_court_routine(%L, %L, %L::time, 127, %L, 90, null)',
    pg_temp.i('R1'), 'test:ps-r1', ((pg_temp.t('2 hours')) at time zone 'UTC')::time, 'UTC'));
  v_new := pg_temp.restop('1', pg_temp.t('2 hours'));
  perform pg_temp.ok('P8 save_court_routine re-makes the stop (a new row, 90 minutes) and it stays hidden',
    v_new is not null and v_new <> v_s1 and (pg_temp.pl(v_new)).planned_end_at = pg_temp.t('3 hours 30 minutes')
    and (pg_temp.pl(v_new)).share_source = 'hidden' and (pg_temp.pl(v_new)).shared_at is null and pg_temp.blind('FR', v_new),
    coalesce(pg_temp.share(v_new), 'no stop'));
  -- Confirmed stays confirmed, with its first shared_at.
  perform pg_temp.rpc('OA', format('select public.confirm_court_plans(array[%L]::uuid[])', v_s8));
  update public.court_plans set shared_at = now() - interval '2 hours' where id = v_s8;
  perform pg_temp.rpc('OA', format('select public.save_court_routine(%L, %L, %L::time, 127, %L, 90, null)',
    pg_temp.i('R8'), 'test:ps-r2', ((pg_temp.t('4 hours')) at time zone 'UTC')::time, 'UTC'));
  v_new := pg_temp.restop('8', pg_temp.t('4 hours'));
  perform pg_temp.ok('P8 an edited routine keeps today''s confirmed stop shared (same shared_at), FR still sees it',
    v_new is not null and v_new <> v_s8 and (pg_temp.pl(v_new)).share_source = 'confirm'
    and (pg_temp.pl(v_new)).shared_at = now() - interval '2 hours' and pg_temp.sees('FR', v_new),
    coalesce(pg_temp.share(v_new), 'no stop'));
  -- Moved to another court: a confirmation said "this court", so it doesn't carry; hidden does.
  perform pg_temp.rpc('OA', format('select public.save_court_routine(%L, %L, %L::time, 127, %L, 90, null)',
    pg_temp.i('R8'), 'test:ps-r3', ((pg_temp.t('4 hours')) at time zone 'UTC')::time, 'UTC'));
  v_new := pg_temp.restop('8', pg_temp.t('4 hours'));
  perform pg_temp.ok('P8 the routine moved to another court: the confirmation doesn''t carry (private)',
    v_new is not null and (pg_temp.pl(v_new)).venue_id = 'test:ps-r3' and (pg_temp.pl(v_new)).share_source is null
    and pg_temp.blind('FR', v_new), coalesce(pg_temp.share(v_new), 'no stop'));
  perform pg_temp.rpc('OA', format('select public.save_court_routine(%L, %L, %L::time, 127, %L, 90, null)',
    pg_temp.i('R1'), 'test:ps-r3', ((pg_temp.t('2 hours')) at time zone 'UTC')::time, 'UTC'));
  v_new := pg_temp.restop('1', pg_temp.t('2 hours'));
  perform pg_temp.ok('P8 ...but "Only you" does',
    v_new is not null and (pg_temp.pl(v_new)).venue_id = 'test:ps-r3' and (pg_temp.pl(v_new)).share_source = 'hidden',
    coalesce(pg_temp.share(v_new), 'no stop'));

  -- Share it again from its chip: confirm.
  j := pg_temp.rpc('OA', format('select public.set_court_plan_shared(%L, true)', v_new));
  perform pg_temp.ok('P8 set_court_plan_shared(stop, true): confirm, shared now; FR sees it',
    j ->> 'share_source' = 'confirm' and j ->> 'kind' = 'routine' and (j ->> 'shared_at')::timestamptz = now()
    and pg_temp.sees('FR', v_new), coalesce(j::text, 'null'));
  -- A one-off plan: plan / hidden.
  j := pg_temp.rpc('OA', format('select public.set_court_plan_shared(%L, true)', pg_temp.i('OA7')));
  perform pg_temp.ok('P8 set_court_plan_shared(one-off, true): plan; FR sees it; no push',
    j ->> 'share_source' = 'plan' and j ->> 'kind' = 'once' and pg_temp.sees('FR', pg_temp.i('OA7')) and pg_temp.pushed('OA') = '',
    coalesce(j::text, 'null'));
  j := pg_temp.rpc('OA', format('select public.set_court_plan_shared(%L, false)', pg_temp.i('OA7')));
  perform pg_temp.ok('P8 set_court_plan_shared(one-off, false): hidden; FR doesn''t see it',
    j ->> 'share_source' = 'hidden' and j -> 'shared_at' = 'null'::jsonb and pg_temp.blind('FR', pg_temp.i('OA7')),
    coalesce(j::text, 'null'));

  -- Refusals: the same words whoever asks.
  e := pg_temp.err_as('OB', format('select public.set_court_plan_shared(%L, false)', pg_temp.i('S4')));
  perform pg_temp.ok('P8 another player''s stop: pl:plan.gone, unchanged',
    e ->> 'hint' = 'pl:plan.gone' and (pg_temp.pl(pg_temp.i('S4'))).share_source = 'confirm', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OB', format('select public.set_court_plan_shared(%L, false)', pg_temp.i('C1')));
  perform pg_temp.ok('P8 another player''s one-off: pl:plan.gone too (nobody learns it is a one-off)',
    e ->> 'hint' = 'pl:plan.gone' and (pg_temp.pl(pg_temp.i('C1'))).share_source = 'plan', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', format('select public.set_court_plan_shared(%L, true)', gen_random_uuid()));
  perform pg_temp.ok('P8 a plan that doesn''t exist: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('OA', format('select public.set_court_plan_shared(%L, true)', pg_temp.i('S5')));
  perform pg_temp.ok('P8 my stop past its window: pl:plan.gone', e ->> 'hint' = 'pl:plan.gone', coalesce(e::text, 'no error'));
  perform pg_temp.rpc('OA', format('select public.cancel_court_plan(%L)', pg_temp.i('OA7')));
  e := pg_temp.err_as('OA', format('select public.set_court_plan_shared(%L, true)', pg_temp.i('OA7')));
  perform pg_temp.ok('P8 my cancelled one-off: pl:visit.gone, its own words',
    e ->> 'hint' = 'pl:visit.gone'
    and e ->> 'msg' = 'That planned check-in is over or was cancelled, so it can''t be changed. Pull to refresh.',
    coalesce(e::text, 'no error'));
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
