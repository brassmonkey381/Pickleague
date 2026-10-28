-- ============================================================
-- Fair rewards persona tests (migration_fair_rewards.sql).
--
-- NOT runnable on its own: build-fair-rewards-test.mjs puts, at the marker
-- line below, migration_fair_rewards.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql. Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-fair-rewards-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   LA  logs in day 1, reaches day 7, then day 8, then day 30
--   LB  a 120-day streak already running when the new rules arrive
--   MA  plays MB, MC, MD, ME in one day (front-loaded pay, 3 new opponents a week)
--   CA  checks in at a court, then plays CB
--   OR  organises a season with MA..MD (real play); SO a solo league's season
--   DA..DE  doubles: the same four, then one player swapped (a new group)
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
  ('LA', 'a9f00000-0000-4000-8000-000000000001'), ('LB', 'a9f00000-0000-4000-8000-000000000002'),
  ('MA', 'a9f00000-0000-4000-8000-000000000003'), ('MB', 'a9f00000-0000-4000-8000-000000000004'),
  ('MC', 'a9f00000-0000-4000-8000-000000000005'), ('MD', 'a9f00000-0000-4000-8000-000000000006'),
  ('ME', 'a9f00000-0000-4000-8000-000000000007'), ('CA', 'a9f00000-0000-4000-8000-000000000008'),
  ('CB', 'a9f00000-0000-4000-8000-000000000009'), ('OR', 'a9f00000-0000-4000-8000-00000000000a'),
  ('SO', 'a9f00000-0000-4000-8000-00000000000b'), ('DA', 'a9f00000-0000-4000-8000-00000000000c'),
  ('DB', 'a9f00000-0000-4000-8000-00000000000d'), ('DC', 'a9f00000-0000-4000-8000-00000000000e'),
  ('DD', 'a9f00000-0000-4000-8000-00000000000f'), ('DE', 'a9f00000-0000-4000-8000-000000000010');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.lg() returns uuid language sql immutable as $$ select 'b9f00000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.solo() returns uuid language sql immutable as $$ select 'b9f00000-0000-4000-8000-000000000002'::uuid $$;

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

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'fair-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Fair Player ' || k), now()
    from _p;
  insert into public.leagues (id, name, description, is_open, created_by)
  values (pg_temp.lg(), 'Fair Rewards League', null, true, pg_temp.p('OR')),
         (pg_temp.solo(), 'Fair Solo League', null, false, pg_temp.p('SO'));
  insert into public.league_members (league_id, user_id, role)
  select pg_temp.lg(), pg_temp.p(k), case when k = 'OR' then 'admin' else 'member' end
    from unnest(array['OR','MA','MB','MC','MD','ME','CA','CB','DA','DB','DC','DD','DE']) k
  union all select pg_temp.solo(), pg_temp.p('SO'), 'admin'
  on conflict (league_id, user_id) do nothing;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ F1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('F1 the three new grant triggers',
    (select count(*) from pg_trigger where tgname in ('trg_grant_new_opponent_bonus', 'trg_grant_checkin_match_bonus',
                                                      'trg_grant_season_organiser_bonus')) = 3);
  perform pg_temp.ok('F1 the new grants are not client-callable',
    not has_function_privilege('authenticated', 'public._grant_new_opponent_bonus()', 'execute')
    and not has_function_privilege('authenticated', 'public._grant_checkin_match_bonus()', 'execute')
    and not has_function_privilege('anon', 'public._grant_season_organiser_bonus()', 'execute'));
  perform pg_temp.ok('F1 the login claim is still callable',
    has_function_privilege('authenticated', 'public.claim_daily_login_streak()', 'execute'));
  perform pg_temp.ok('F1 pickle history knows the three new sources',
    (select count(*) from public.pickle_ledger_sources
      where source in ('_grant_new_opponent_bonus', '_grant_checkin_match_bonus', '_grant_season_organiser_bonus')) = 3);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F1 block crashed', false, sqlerrm);
end $$;


-- ════ F2 the login build-up and the streak badges ════════════════════════
create function pg_temp.claim(k text) returns jsonb language sql as $$
  select pg_temp.json_as(k, 'select to_jsonb(x) from public.claim_daily_login_streak() x') $$;
-- Let another claim happen today: the streak at n, last claimed yesterday.
create function pg_temp.set_streak(k text, n integer) returns void language plpgsql as $$
begin
  delete from public.user_streak_rewards where user_id = pg_temp.p(k);
  update public.user_login_streaks
     set current_streak = n, longest_streak = greatest(longest_streak, n),
         last_login_date = (now() at time zone public._pickleague_tz_for(pg_temp.p(k)))::date - 1
   where user_id = pg_temp.p(k);
end $$;

do $$
declare
  j jsonb;
  v_before integer;
begin
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 day 1 pays 15', (j ->> 'streak_after')::int = 1 and (j ->> 'daily_pickles')::int = 15, j::text);
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 ...and a second claim the same day pays nothing', not (j ->> 'claimed_today')::boolean, j::text);

  perform pg_temp.set_streak('LA', 6);
  v_before := pg_temp.pickles('LA');
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 day 7 pays 75 plus the Week Streak badge (+200)',
    (j ->> 'daily_pickles')::int = 75 and (j ->> 'milestone_pickles')::int = 200
    and j ->> 'milestone_label' = 'Week Streak' and pg_temp.pickles('LA') - v_before = 275, j::text);
  perform pg_temp.ok('F2 ...the badge is its own gold row in pickle history',
    exists (select 1 from public.pickle_ledger where profile_id = pg_temp.p('LA') and delta = 200
             and reason = 'Week Streak badge' and is_bonus));

  perform pg_temp.set_streak('LA', 7);
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 day 8 pays a flat 50, no badge',
    (j ->> 'daily_pickles')::int = 50 and (j ->> 'milestone_pickles')::int = 0, j::text);

  -- A broken streak that reaches 7 again: the badge was once per account.
  perform pg_temp.set_streak('LA', 6);
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 reaching day 7 again pays no second Week Streak', (j ->> 'milestone_pickles')::int = 0, j::text);

  perform pg_temp.set_streak('LA', 29);
  j := pg_temp.claim('LA');
  perform pg_temp.ok('F2 day 30 pays the Month Streak badge (+1,000)',
    (j ->> 'milestone_pickles')::int = 1000 and j ->> 'milestone_label' = 'Month Streak', j::text);

  -- A 120-day streak already running collects the three it passed, once.
  perform pg_temp.claim('LB');
  perform pg_temp.set_streak('LB', 120);
  j := pg_temp.claim('LB');
  perform pg_temp.ok('F2 a 120-day streak collects Week, Month and 100-Day (3,700) at once',
    (j ->> 'milestone_pickles')::int = 3700 and j ->> 'milestone_label' = '100-Day Streak'
    and (select count(*) from public.login_streak_milestones where user_id = pg_temp.p('LB')) = 3, j::text);
  perform pg_temp.ok('F2 ...and reads only its own streak badges',
    pg_temp.json_as('LB', 'select to_jsonb(count(*)) from public.login_streak_milestones') = '3'::jsonb);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F2 block crashed', false, sqlerrm);
end $$;


-- ════ F3 match pay front-loaded; new opponents ═══════════════════════════
do $$
declare
  k text;
  v_pays integer[];
  v_new  integer;
begin
  -- Badge pickles off for this block, so the 500 cap can't blur the amounts.
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  foreach k in array array['MB', 'MC', 'MD', 'ME'] loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
    values (pg_temp.lg(), pg_temp.p('MA'), pg_temp.p(k), 11, 6, 'singles', 'completed', now());
  end loop;

  select array_agg(delta order by id) into v_pays from public.pickle_ledger
   where profile_id = pg_temp.p('MA') and source = '_grant_match_game_bonus';
  perform pg_temp.ok('F3 four matches in a day, each with someone else, pay 40, 40, 40, 35',
    v_pays = array[40, 40, 40, 35], v_pays::text);
  select count(*) into v_new from public.pickle_ledger
   where profile_id = pg_temp.p('MA') and source = '_grant_new_opponent_bonus' and delta = 50 and reason = 'New opponent';
  perform pg_temp.ok('F3 four new opponents: +50 for 3 of them (3 a week)', v_new = 3, v_new::text);
  perform pg_temp.ok('F3 ...and MA was a new opponent for each of the four',
    (select count(*) from public.new_opponent_grants where opponent_id = pg_temp.p('MA')) = 4);

  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.lg(), pg_temp.p('MB'), pg_temp.p('MA'), 11, 9, 'singles', 'completed', now());
  perform pg_temp.ok('F3 a rematch is not a new opponent',
    (select count(*) from public.new_opponent_grants where user_id = pg_temp.p('MB')) = 1);
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F3 block crashed', false, sqlerrm);
end $$;


-- ════ F3b the same players pay for 3 matches within 12 hours ═════════════
do $$
declare
  v_ids uuid[] := '{}';
  v_id  uuid;
  i     integer;
begin
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  for i in 1..6 loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
    values (pg_temp.lg(), pg_temp.p('LA'), pg_temp.p('LB'), 11, 5, 'singles', 'completed', now())
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
  perform pg_temp.ok('F3b six matches with the same pair pay 40, 40, 40, then nothing (3 in 12 hours)',
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('LA'))
            from generate_series(1, 6) s(n)) = array[40, 40, 40, 0, 0, 0],
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('LA'))
            from generate_series(1, 6) s(n))::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F3b block crashed', false, sqlerrm);
end $$;


-- ════ F3c the day's curve: 40 x3, then 35 ... 5, then 0 ═════════════════════
do $$
declare
  v_pays integer[] := '{}';
  v_id   uuid;
  k text;
begin
  -- ME plays 12 matches today against 6 players in turn, twice each, so no
  -- pair reaches 3. The 500 cap isn't reached either (about 460 in all).
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  foreach k in array array['MB','MC','MD','CA','CB','OR','MB','MC','MD','CA','CB','OR'] loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
    values (pg_temp.lg(), pg_temp.p('ME'), pg_temp.p(k), 11, 7, 'singles', 'completed', now())
    returning id into v_id;
    v_pays := v_pays || (select g.paid from public.match_game_bonus_grants g
                          where g.match_id = v_id and g.user_id = pg_temp.p('ME'));
  end loop;
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
  -- ME already played MA once in F3 (its match 1, 40), so these are matches 2-13.
  perform pg_temp.ok('F3c the day''s curve: matches 2-13 pay 40, 40, 35, 30, 25, 20, 15, 10, 5, 0, 0, 0',
    v_pays = array[40, 40, 35, 30, 25, 20, 15, 10, 5, 0, 0, 0], v_pays::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F3c block crashed', false, sqlerrm);
end $$;


-- ════ F3d doubles: one different player makes a new group ════════════════
do $$
declare
  v_ids uuid[] := '{}';
  v_id  uuid;
  i     integer;
begin
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  -- DA + DB vs DC + DD four times, then DA + DB vs DC + DE four times.
  for i in 1..8 loop
    insert into public.matches (league_id, player1_id, partner1_id, player2_id, partner2_id,
                                player1_score, player2_score, match_type, status, played_at)
    values (pg_temp.lg(), pg_temp.p('DA'), pg_temp.p('DB'), pg_temp.p('DC'),
            pg_temp.p(case when i <= 4 then 'DD' else 'DE' end), 11, 6, 'doubles', 'completed', now())
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
  -- DA: the first group pays 3 (the 4th pays 0 and doesn't move the curve);
  -- the new group pays 3 more, on down the curve: 35, 30, 25.
  perform pg_temp.ok('F3d doubles: same four pay 3 matches, then a swapped player is a new group',
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('DA'))
            from generate_series(1, 8) s(n)) = array[40, 40, 40, 0, 35, 30, 25, 0],
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('DA'))
            from generate_series(1, 8) s(n))::text);
  perform pg_temp.ok('F3d ...and the new player starts at 40 x 3',
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('DE'))
            from generate_series(5, 8) s(n)) = array[40, 40, 40, 0],
    array(select (select g.paid from public.match_game_bonus_grants g
                   where g.match_id = v_ids[s.n] and g.user_id = pg_temp.p('DE'))
            from generate_series(5, 8) s(n))::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F3d block crashed', false, sqlerrm);
end $$;


-- ════ F4 checked in and played ═══════════════════════════════════════════
do $$
declare
  v_venue text := (select id from public.venues limit 1);
begin
  insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at)
  values (pg_temp.p('CA'), v_venue, now() - interval '1 hour', now() + interval '2 hours');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.lg(), pg_temp.p('CA'), pg_temp.p('CB'), 11, 4, 'singles', 'completed', now());
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.lg(), pg_temp.p('CB'), pg_temp.p('CA'), 11, 8, 'singles', 'completed', now());
  perform pg_temp.ok('F4 a match after a check-in pays +25, once a day',
    (select coalesce(sum(delta), 0) from public.pickle_ledger
      where profile_id = pg_temp.p('CA') and source = '_grant_checkin_match_bonus') = 25,
    coalesce(v_venue, 'no venue on this database'));
  perform pg_temp.ok('F4 ...and nothing to the player who didn''t check in',
    not exists (select 1 from public.pickle_ledger where profile_id = pg_temp.p('CB') and source = '_grant_checkin_match_bonus'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F4 block crashed', false, sqlerrm);
end $$;


-- ════ F5 the season organiser ════════════════════════════════════════════
do $$
declare
  v_real uuid;
  v_next uuid;
  v_solo uuid;
  v_paid integer;
begin
  -- Real play: MA..MD each play 2+ others (F3 gave MA four; add MB-MC, MC-MD, MD-MB).
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  select pg_temp.lg(), pg_temp.p(a), pg_temp.p(b), 11, 7, 'singles', 'completed', now() - interval '3 days'
    from (values ('MB','MC'), ('MC','MD'), ('MD','MB')) v (a, b);
  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks, status, elo_reset_applied, created_by)
  values (pg_temp.lg(), 'Fair Season', current_date - 40, current_date - 5, 5, 1, 'active', false, pg_temp.p('OR'))
  returning id into v_real;
  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks, status, elo_reset_applied, created_by)
  values (pg_temp.lg(), 'Fair Season 2', current_date - 40, current_date - 5, 5, 1, 'active', false, pg_temp.p('OR'))
  returning id into v_next;
  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks, status, elo_reset_applied, created_by)
  values (pg_temp.solo(), 'Solo Season', current_date - 40, current_date - 5, 5, 1, 'active', false, pg_temp.p('SO'))
  returning id into v_solo;

  update public.league_seasons set status = 'completed', elo_reset_applied = true where id = v_real;
  select coalesce(sum(delta), 0) into v_paid from public.pickle_ledger
   where profile_id = pg_temp.p('OR') and source = '_grant_season_organiser_bonus' and is_bonus;
  perform pg_temp.ok('F5 a season with real play pays its organiser +200 (gold)', v_paid = 200, v_paid::text);
  update public.league_seasons set status = 'completed', elo_reset_applied = true where id = v_next;
  perform pg_temp.ok('F5 ...a second season within 28 days pays nothing',
    (select coalesce(sum(delta), 0) from public.pickle_ledger
      where profile_id = pg_temp.p('OR') and source = '_grant_season_organiser_bonus') = 200);
  update public.league_seasons set status = 'completed', elo_reset_applied = true where id = v_solo;
  perform pg_temp.ok('F5 a solo league''s season pays nothing',
    not exists (select 1 from public.pickle_ledger where profile_id = pg_temp.p('SO') and source = '_grant_season_organiser_bonus'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F5 block crashed', false, sqlerrm);
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
