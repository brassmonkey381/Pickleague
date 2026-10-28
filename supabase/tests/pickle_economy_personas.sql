-- ============================================================
-- Pickle economy guard persona tests (migration_pickle_economy_guards.sql).
--
-- NOT runnable on its own: build-pickle-economy-test.mjs puts, at the marker
-- line below, migration_pickle_economy_guards.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql. Everything runs
-- inside the begin / rollback below, so the linked (live) database is left
-- untouched:
--   node supabase/tests/build-pickle-economy-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   SO  owns a 1-member league (the farm)
--   R1..R4  a real 4-player league; R1 is its admin
--   CP  earns five different badges in one day (the 500 cap)
--   CQ  earns the same badge twice
--   MX, MY  play a 10-game match, then the same match four times
--   DS  sends a drill request to DR
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
  ('SO', 'a9e00000-0000-4000-8000-000000000001'),
  ('R1', 'a9e00000-0000-4000-8000-000000000002'), ('R2', 'a9e00000-0000-4000-8000-000000000003'),
  ('R3', 'a9e00000-0000-4000-8000-000000000004'), ('R4', 'a9e00000-0000-4000-8000-000000000005'),
  ('CP', 'a9e00000-0000-4000-8000-000000000006'), ('CQ', 'a9e00000-0000-4000-8000-000000000007'),
  ('MX', 'a9e00000-0000-4000-8000-000000000008'), ('MY', 'a9e00000-0000-4000-8000-000000000009'),
  ('DS', 'a9e00000-0000-4000-8000-00000000000a'), ('DR', 'a9e00000-0000-4000-8000-00000000000b');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.solo() returns uuid language sql immutable as $$ select 'b9e00000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.real() returns uuid language sql immutable as $$ select 'b9e00000-0000-4000-8000-000000000002'::uuid $$;
-- Where MX/MY and DS/DR play (matches need a league).
create function pg_temp.free() returns uuid language sql immutable as $$ select 'b9e00000-0000-4000-8000-000000000003'::uuid $$;

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

create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select coalesce(pickles, 0) from public.profiles where id = pg_temp.p(k) $$;

create function pg_temp.badge(p_name text) returns uuid language sql stable as $$
  select id from public.badges where name = p_name $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
create temp table _ids (k text primary key, id uuid);
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'economy-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Economy Player ' || k), now()
    from _p;

  insert into public.leagues (id, name, description, is_open, created_by)
  values (pg_temp.solo(), 'Economy Solo League', null, false, pg_temp.p('SO')),
         (pg_temp.real(), 'Economy Real League', null, false, pg_temp.p('R1')),
         (pg_temp.free(), 'Economy Free League', null, true, pg_temp.p('MX'));
  insert into public.league_members (league_id, user_id, role) values
    (pg_temp.solo(), pg_temp.p('SO'), 'admin'),
    (pg_temp.real(), pg_temp.p('R1'), 'admin'), (pg_temp.real(), pg_temp.p('R2'), 'member'),
    (pg_temp.real(), pg_temp.p('R3'), 'member'), (pg_temp.real(), pg_temp.p('R4'), 'member'),
    (pg_temp.free(), pg_temp.p('MX'), 'admin'), (pg_temp.free(), pg_temp.p('MY'), 'member'),
    (pg_temp.free(), pg_temp.p('DS'), 'member'), (pg_temp.free(), pg_temp.p('DR'), 'member')
  on conflict (league_id, user_id) do nothing;
  insert into public.league_player_ratings (league_id, user_id, rating)
  select pg_temp.solo(), pg_temp.p('SO'), 3.5
  union all select pg_temp.real(), pg_temp.p(k), 3.5 from unnest(array['R1','R2','R3','R4']) k
  on conflict do nothing;

  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.solo(), 'Solo Season', current_date - 14, current_date + 60, 10, 1, 'active', false, pg_temp.p('SO'))
  returning id into v_id;
  insert into _ids values ('solo_season', v_id);

  -- The real league: everyone plays 3 others (6 completed matches, 3 days ago).
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  select pg_temp.real(), pg_temp.p(a), pg_temp.p(b), 11, 7, 'singles', 'completed', now() - interval '3 days'
    from (values ('R1','R2'), ('R1','R3'), ('R2','R3'), ('R2','R4'), ('R3','R4'), ('R4','R1')) v (a, b);

  -- Drill request DS -> DR.
  insert into public.drill_requests (from_user_id, to_user_id, proposed_slots, status)
  values (pg_temp.p('DS'), pg_temp.p('DR'), jsonb_build_array(jsonb_build_object('date', current_date - 1, 'slot', 20)), 'pending')
  returning id into v_id;
  insert into _ids values ('drill', v_id);

  -- Pot money for SO.
  update public.profiles set pickles = 1000 where id = pg_temp.p('SO');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ E1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('E1 play cap trigger on profiles',
    exists (select 1 from pg_trigger where tgname = 'trg_profiles_play_cap' and tgrelid = 'public.profiles'::regclass));
  perform pg_temp.ok('E1 pot guard on leagues, league_seasons, tournaments',
    (select count(*) from pg_trigger where tgname = 'trg_pl_pot_columns_guard') = 3);
  perform pg_temp.ok('E1 the scheduled-match UPDATE policy is gone',
    not exists (select 1 from pg_policies where tablename = 'matches' and policyname = 'League members can update scheduled matches'));
  perform pg_temp.ok('E1 new helpers are not client-callable',
    not has_function_privilege('authenticated', 'public._pl_play_cap_left(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_league_real_play(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._pl_tournament_real_play(uuid)', 'execute'));
  perform pg_temp.ok('E1 contribute_pickles_to_pool still callable',
    has_function_privilege('authenticated', 'public.contribute_pickles_to_pool(text,uuid,integer)', 'execute'));
  perform pg_temp.ok('E1 existing badges are backfilled as paid',
    (select count(*) from public.pickle_badge_payouts) > 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E1 block crashed', false, sqlerrm);
end $$;


-- ════ E2 the solo league farm pays nothing ═══════════════════════════════
do $$
declare
  v_before integer := pg_temp.pickles('SO');
  j1 jsonb; j2 jsonb;
begin
  j1 := pg_temp.json_as('SO', format('select to_jsonb(1) from (select public.lock_season_period(%L, 1, current_date)) x',
          (select id from _ids where k = 'solo_season')));
  j2 := pg_temp.json_as('SO', format('select to_jsonb(1) from (select public.lock_season_period(%L, 1, current_date)) x',
          (select id from _ids where k = 'solo_season')));
  perform pg_temp.ok('E2 the solo owner locks period 1 twice', j1 = '1'::jsonb and j2 = '1'::jsonb, j1::text || ' ' || j2::text);
  perform pg_temp.ok('E2 ...still gets the Period Champion badge',
    exists (select 1 from public.player_badges where user_id = pg_temp.p('SO') and badge_id = pg_temp.badge('Period Champion')
            and league_id = pg_temp.solo()));
  perform pg_temp.ok('E2 ...and no pickles for it', pg_temp.pickles('SO') = v_before,
    format('before %s, after %s', v_before, pg_temp.pickles('SO')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E2 block crashed', false, sqlerrm);
end $$;


-- ════ E3 a real league pays Period Champion once ═════════════════════════
do $$
declare
  v_before integer;
  v_mid    integer;
begin
  perform pg_temp.ok('E3 the real league qualifies, the solo one does not',
    public._pl_league_real_play(pg_temp.real()) and not public._pl_league_real_play(pg_temp.solo()));
  v_before := pg_temp.pickles('R1');
  insert into public.player_badges (user_id, badge_id, league_id, context)
  values (pg_temp.p('R1'), pg_temp.badge('Period Champion'), pg_temp.real(), 'Economy Season — Period 1');
  v_mid := pg_temp.pickles('R1');
  insert into public.player_badges (user_id, badge_id, league_id, context)
  values (pg_temp.p('R1'), pg_temp.badge('Period Champion'), pg_temp.real(), 'Economy Season — Period 1');
  perform pg_temp.ok('E3 Period Champion in a real league pays',
    v_mid > v_before and v_mid - v_before <= 150, format('before %s, after %s', v_before, v_mid));
  perform pg_temp.ok('E3 ...the same period again pays nothing', pg_temp.pickles('R1') = v_mid,
    format('after first %s, after second %s', v_mid, pg_temp.pickles('R1')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E3 block crashed', false, sqlerrm);
end $$;


-- ════ E4 a repeat badge pays once; E5 the 500 cap ════════════════════════
do $$
declare
  v_before integer := pg_temp.pickles('CQ');
  v_b      uuid;
  v_cp     integer := pg_temp.pickles('CP');
  v_n      integer := 0;
begin
  select id into v_b from public.badges
   where name not in ('Period Champion', 'Period Sweeper', 'Season Crown', 'Season Silver', 'Season Bronze',
                      'Tournament Champion', 'Tournament Silver', 'Tournament Bronze')
   order by sort_order, name limit 1;
  insert into public.player_badges (user_id, badge_id, context) values (pg_temp.p('CQ'), v_b, 'first');
  insert into public.player_badges (user_id, badge_id, context) values (pg_temp.p('CQ'), v_b, 'second');
  perform pg_temp.ok('E4 the same badge twice pays 150 once', pg_temp.pickles('CQ') - v_before = 150,
    format('gained %s', pg_temp.pickles('CQ') - v_before));

  for v_b in
    select id from public.badges
     where name not in ('Period Champion', 'Period Sweeper', 'Season Crown', 'Season Silver', 'Season Bronze',
                        'Tournament Champion', 'Tournament Silver', 'Tournament Bronze')
     order by sort_order, name limit 5
  loop
    insert into public.player_badges (user_id, badge_id, context) values (pg_temp.p('CP'), v_b, 'cap test');
    v_n := v_n + 1;
  end loop;
  perform pg_temp.ok('E5 five badges in a day pay 500, not 750', v_n = 5 and pg_temp.pickles('CP') - v_cp = 500,
    format('%s badges, gained %s', v_n, pg_temp.pickles('CP') - v_cp));
  perform pg_temp.ok('E5 ...and the cap says 0 left', public._pl_play_cap_left(pg_temp.p('CP')) = 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E4 block crashed', false, sqlerrm);
end $$;


-- ════ E6 match games: at most 5; the same pair a 4th time pays nothing ═══
do $$
declare
  v_games jsonb := (select jsonb_agg(jsonb_build_object('t1', 11, 't2', 5)) from generate_series(1, 10));
  v_id    uuid;
  v_paid  integer;
  v_ids   uuid[] := '{}';
  i       integer;
begin
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at, game_scores)
  values (pg_temp.free(), pg_temp.p('MX'), pg_temp.p('MY'), 11, 0, 'singles', 'completed', now(), v_games)
  returning id into v_id;
  -- Pay is per match since migration_fair_rewards.sql; the grant still counts at most 5 games.
  select coalesce(max(games), 0) into v_paid from public.match_game_bonus_grants
   where user_id = pg_temp.p('MX') and match_id = v_id;
  perform pg_temp.ok('E6 a 10-game match counts 5 games', v_paid = 5, format('games %s', v_paid));

  for i in 1..5 loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
    values (pg_temp.free(), pg_temp.p('MX'), pg_temp.p('MY'), 11, 3, 'singles', 'completed', now())
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  -- Since migration_fair_rewards.sql: the same players earn at most 120 within 12 hours.
  perform pg_temp.ok('E6 ...six matches with the same pair within 12 hours pay 120 in all',
    (select sum(paid) from public.match_game_bonus_grants where user_id = pg_temp.p('MX')) = 120
    and (select paid from public.match_game_bonus_grants where match_id = v_ids[5] and user_id = pg_temp.p('MX')) = 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E6 block crashed', false, sqlerrm);
end $$;


-- ════ E7 no back-filled streak days ══════════════════════════════════════
do $$
begin
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.free(), pg_temp.p('DS'), pg_temp.p('DR'), 11, 4, 'singles', 'completed', now() - interval '10 days');
  perform pg_temp.ok('E7 a match dated 10 days ago starts no streak day',
    not exists (select 1 from public.daily_play_streaks where user_id = pg_temp.p('DS')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E7 block crashed', false, sqlerrm);
end $$;


-- ════ E8 pots: no house bonus ════════════════════════════════════════════
do $$
declare
  v_pool integer := coalesce((select prize_pool from public.leagues where id = pg_temp.solo()), 0);
  j jsonb;
begin
  j := pg_temp.json_as('SO', format('select to_jsonb(x) from public.contribute_pickles_to_pool(''league'', %L, 100) x', pg_temp.solo()));
  perform pg_temp.ok('E8 contributing 100 adds exactly 100',
    coalesce((j ->> 'success')::boolean, false)
    and (select prize_pool from public.leagues where id = pg_temp.solo()) = v_pool + 100, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 block crashed', false, sqlerrm);
end $$;


-- ════ E9 the pot columns are server-owned ════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('SO', format(
    'with u as (update public.leagues set prize_pool = 999999 where id = %L returning 1) select to_jsonb(count(*)) from u', pg_temp.solo()));
  perform pg_temp.ok('E9 the owner cannot set the league pot', j ->> 'hint' = 'pl:pot.server_owned', j::text);
  j := pg_temp.json_as('SO', format(
    'with u as (update public.league_seasons set elo_reset_applied = true where id = %L returning 1) select to_jsonb(count(*)) from u',
    (select id from _ids where k = 'solo_season')));
  perform pg_temp.ok('E9 ...nor mark the season done', j ->> 'hint' = 'pl:pot.server_owned', j::text);
  j := pg_temp.json_as('SO', format(
    'with u as (update public.leagues set description = ''still editable'' where id = %L returning 1) select to_jsonb(count(*)) from u', pg_temp.solo()));
  perform pg_temp.ok('E9 ...other league fields still save', j = '1'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 block crashed', false, sqlerrm);
end $$;


-- ════ E10 a member can't complete a match ════════════════════════════════
do $$
declare
  v_id uuid;
  j jsonb;
begin
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.real(), pg_temp.p('R1'), pg_temp.p('R2'), 11, 2, 'singles', 'pending', now())
  returning id into v_id;
  j := pg_temp.json_as('R1', format(
    'with u as (update public.matches set status = ''completed'' where id = %L returning 1) select to_jsonb(count(*)) from u', v_id));
  perform pg_temp.ok('E10 the recorder cannot mark their own match completed',
    (j = '0'::jsonb or j ? 'error') and (select status from public.matches where id = v_id) = 'pending', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E10 block crashed', false, sqlerrm);
end $$;


-- ════ E11 drill requests: only the invitee answers ═══════════════════════
do $$
declare
  v_id uuid := (select id from _ids where k = 'drill');
  j jsonb;
begin
  j := pg_temp.json_as('DS', format(
    'with u as (update public.drill_requests set status = ''accepted'', accepted_slot = proposed_slots -> 0 where id = %L returning 1) select to_jsonb(count(*)) from u', v_id));
  perform pg_temp.ok('E11 the sender cannot accept their own request', j ->> 'hint' = 'pl:drill.not_yours', j::text);
  j := pg_temp.json_as('DR', format(
    'with u as (update public.drill_requests set status = ''accepted'', accepted_slot = proposed_slots -> 0 where id = %L returning 1) select to_jsonb(count(*)) from u', v_id));
  perform pg_temp.ok('E11 the invitee accepts', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('DR', format(
    'with u as (update public.drill_requests set status = ''pending'' where id = %L returning 1) select to_jsonb(count(*)) from u', v_id));
  perform pg_temp.ok('E11 ...and cannot put it back to pending', j ->> 'hint' = 'pl:drill.not_yours', j::text);
  j := pg_temp.json_as('DS', format(
    'with u as (update public.drill_requests set status = ''cancelled'' where id = %L returning 1) select to_jsonb(count(*)) from u', v_id));
  perform pg_temp.ok('E11 the sender can still cancel', j = '1'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 block crashed', false, sqlerrm);
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
