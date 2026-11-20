-- ============================================================
-- Tournament event log persona tests: PKL-054. Every logged write leaves one
-- tournament_events row with the right kind, actor and data; deleting the
-- tournament still works and takes its log with it.
--
-- Standalone and rolled back. Build it (splices PKL-052 then PKL-054 in at the
-- marker, twice), then run from the linked checkout:
--   node supabase/tests/build-tournament-events-test.mjs %TEMP%\tev_test.sql
--   supabase db query --linked -f %TEMP%\tev_test.sql -o csv
-- Every row should read ok = true; the first row is the summary.
-- ============================================================
begin;

create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, seed int not null);
insert into _p
select 'EV' || g, ('7b0e0000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, g
  from generate_series(1, 4) g;
grant select on _p to authenticated, anon;

-- @@MIGRATION@@

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create function pg_temp.key1(text) returns text language sql stable as $$ select id::text || ':' || id::text from _p where k = $1 $$;
grant execute on function pg_temp.p(text), pg_temp.ok(text, boolean, text), pg_temp.key1(text) to authenticated;
-- Act as a signed-in person (auth.uid()) while staying superuser, or as nobody (null).
create function pg_temp.as_user(text) returns void language sql as $$
  select set_config('request.jwt.claims', case when $1 is null then '' else
    json_build_object('sub', (select id from _p where k = $1), 'role', 'authenticated')::text end, true)
$$;
grant execute on function pg_temp.as_user(text) to authenticated;
-- Kinds logged for a tournament after an id, in order: "a,b,c".
create function pg_temp.kinds(p_t uuid, p_after bigint) returns text language sql stable as $$
  select coalesce(string_agg(kind, ',' order by id), '') from public.tournament_events where tournament_id = p_t and id > p_after
$$;
create function pg_temp.last_id() returns bigint language sql stable as $$
  select coalesce(max(id), 0) from public.tournament_events
$$;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'tev-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'EV Player ' || seed), now() from _p;
create temp table _ids (k text primary key, id uuid);
insert into _ids values ('L', '7b0f0000-0000-4000-8000-000000000001');
insert into public.leagues (id, name, is_open, created_by)
select id, 'EV Test League', true, pg_temp.p('EV1') from _ids where k = 'L';
insert into public.league_members (league_id, user_id, role)
select (select id from _ids where k = 'L'), id, case when k = 'EV1' then 'admin' else 'member' end from _p
on conflict do nothing;
-- The host pays the 2,500-pickle tournament fee like anyone else.
update public.profiles set pickles = 10000 where id = pg_temp.p('EV1');

do $$
declare
  v_t uuid; v_r uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_mark bigint; v_x text; v_e record; v_n int;
begin
  -- E1 created + registrations + a round, as the host EV1.
  perform pg_temp.as_user('EV1');
  v_mark := pg_temp.last_id();
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode, status)
  values ((select id from _ids where k = 'L'), '[SIM] EV T1', pg_temp.p('EV1'), 'round_robin', 'singles', 'none', 'invite_only', 'registration')
  returning id into v_t;
  insert into _ids values ('T1', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'EV1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round 1', 'winners') returning id into v_r;
  v_x := pg_temp.kinds(v_t, v_mark);
  perform pg_temp.ok('E1.1 created, 4 registrations, a round', v_x = 'tournament_created,registered,registered,registered,registered,round_added', v_x);
  select count(*) into v_n from public.tournament_events where tournament_id = v_t and actor = pg_temp.p('EV1');
  perform pg_temp.ok('E1.2 the actor is the signed-in host', v_n = 6, v_n || ' of 6');

  -- E2 seed change, settings change, status change.
  v_mark := pg_temp.last_id();
  update public.tournament_registrations set seed = 9 where tournament_id = v_t and user_id = pg_temp.p('EV4');
  update public.tournaments set courts = array['1', '2'], prize_pool = 100 where id = v_t;
  update public.tournaments set status = 'active' where id = v_t;
  v_x := pg_temp.kinds(v_t, v_mark);
  perform pg_temp.ok('E2.1 seed, settings, status logged', v_x like 'registration_changed,settings_changed,tournament_status%', v_x);
  select * into v_e from public.tournament_events where tournament_id = v_t and kind = 'settings_changed' order by id limit 1;
  perform pg_temp.ok('E2.2 settings diff has courts and prize_pool only',
    (select array_agg(k order by k) from jsonb_object_keys(v_e.data) k) = array['courts', 'prize_pool'], v_e.data::text);
  select * into v_e from public.tournament_events where tournament_id = v_t and kind = 'registration_changed' order by id limit 1;
  perform pg_temp.ok('E2.3 seed 4 -> 9 for EV4', v_e.user_id = pg_temp.p('EV4') and v_e.data -> 'seed' = '[4, 9]'::jsonb, v_e.data::text);

  -- E3 a match is called to a court, scored by a player, corrected by the admin.
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  values (v_t, v_r, 0, 'singles', pg_temp.p('EV1'), pg_temp.p('EV2'), 'pending') returning id into v_m1;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  values (v_t, v_r, 1, 'singles', pg_temp.p('EV3'), pg_temp.p('EV4'), 'pending') returning id into v_m2;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  values (v_t, v_r, 2, 'singles', pg_temp.p('EV1'), null, 'pending') returning id into v_m3;
  perform pg_temp.as_user(null);
  v_mark := pg_temp.last_id();
  update public.tournament_matches set court = '1', called_at = now() where id = v_m1;
  select * into v_e from public.tournament_events where tournament_id = v_t and id > v_mark order by id limit 1;
  perform pg_temp.ok('E3.1 court call: match_called on court 1, server actor',
    v_e.kind = 'match_called' and v_e.match_id = v_m1 and v_e.actor is null and v_e.data -> 'court' ->> 1 = '1',
    coalesce(v_e.kind || ' ' || v_e.data::text, 'none'));

  perform pg_temp.as_user('EV2');
  v_mark := pg_temp.last_id();
  update public.tournament_matches set team1_score = 7, team2_score = 11, winner_team = 'team2', status = 'completed', completed_at = now()
   where id = v_m1;
  select * into v_e from public.tournament_events where tournament_id = v_t and id > v_mark and kind = 'match_scored' order by id limit 1;
  perform pg_temp.ok('E3.2 score: match_scored 7-11 entered by EV2',
    v_e.match_id = v_m1 and v_e.actor = pg_temp.p('EV2') and v_e.data -> 'score' = '[7, 11]'::jsonb, coalesce(v_e.data::text, 'none'));
  select count(*) into v_n from public.notifications n where n.entity_id = v_t and n.created_at = v_e.at;
  perform pg_temp.ok('E3.3 alerts caused by that score share its time (info)', true, v_n || ' notifications at the same time');

  -- Only the service role or godmode may correct a completed match.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  v_mark := pg_temp.last_id();
  update public.tournament_matches set team1_score = 9, team2_score = 11 where id = v_m1;
  select * into v_e from public.tournament_events where tournament_id = v_t and id > v_mark and kind = 'score_edited' order by id limit 1;
  perform pg_temp.ok('E3.4 correction: score_edited 7 -> 9 (server, no user)',
    v_e.actor is null and v_e.data -> 'team1_score' = '[7, 9]'::jsonb, coalesce(v_e.data::text, 'none'));

  -- E4 cancel, slot fill, court move.
  perform pg_temp.as_user('EV1');
  v_mark := pg_temp.last_id();
  update public.tournament_matches set status = 'cancelled' where id = v_m2;
  update public.tournament_matches set team2_player1 = pg_temp.p('EV3') where id = v_m3;
  -- Courts are server-owned (_pl_tm_court_guard): the server calls it, then moves it.
  perform pg_temp.as_user(null);
  update public.tournament_matches set court = '2', called_at = now() where id = v_m3;
  update public.tournament_matches set court = '1' where id = v_m3;
  perform pg_temp.as_user('EV1');
  v_x := pg_temp.kinds(v_t, v_mark);
  perform pg_temp.ok('E4.1 cancel, bracket slot, court move', v_x = 'match_cancelled,slots_filled,match_called,court_changed',
    v_x || ' / m3: ' || (select coalesce(court, '-') || ' ' || coalesce(called_at::text, '-') || ' ' || status from public.tournament_matches where id = v_m3));

  -- E5 the admin's tie order (PKL-052): one row per entrant, the admin as actor.
  v_mark := pg_temp.last_id();
  perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('EV3'), pg_temp.key1('EV4')]);
  select count(*) into v_n from public.tournament_events
   where tournament_id = v_t and id > v_mark and kind = 'tie_rank_set' and actor = pg_temp.p('EV1');
  perform pg_temp.ok('E5.1 tie order: 2 tie_rank_set rows by EV1', v_n = 2, v_n::text);

  -- E6 who can read it: a registered player yes; anon has no grant; helpers locked.
  perform pg_temp.as_user('EV3');
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.tournament_events where tournament_id = v_t;
  perform set_config('role', 'none', true);
  perform pg_temp.ok('E6.1 a player in the tournament can read the log', v_n > 10, v_n::text);
  perform pg_temp.ok('E6.2 anon cannot read it', not has_table_privilege('anon', 'public.tournament_events', 'select'), null);
  perform pg_temp.ok('E6.3 the writer helper is not callable by users',
    not has_function_privilege('authenticated', 'public._pl_tev(uuid, text, uuid, uuid, jsonb)', 'execute'), null);

  -- E7 deleting the tournament works and removes its log.
  perform pg_temp.as_user(null);
  delete from public.tournaments where id = v_t;
  select count(*) into v_n from public.tournament_events where tournament_id = v_t;
  perform pg_temp.ok('E7.1 delete cascades: no rows left', v_n = 0, v_n::text);
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
