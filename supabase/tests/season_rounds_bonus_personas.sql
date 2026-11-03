-- ============================================================
-- Season rounds and the overall bonus: persona tests
-- (migration_season_rounds_and_bonus.sql).
--
-- NOT runnable on its own: build-season-rounds-bonus-test.mjs puts, at the
-- marker line below, migration_season_rounds_and_bonus.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql. Everything runs
-- inside the begin / rollback below, so the linked (live) database is left
-- untouched:
--   node supabase/tests/build-season-rounds-bonus-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Big season SB: 8 players B1..B8, ranks 1..8 in every round.
--   B1 played 10 completed league matches in the season (paid overall).
--   B2 played 3 (League bonus only).
-- Small season SS (another league): 4 players S1..S4, S1 first with 10
--   matches (too few players: League bonus only).
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);

create temp table _ids (k text primary key, id uuid not null);
insert into _ids
select 'B' || g, ('a9f30000-0000-4000-8000-00000000000' || g)::uuid from generate_series(1, 8) g;
insert into _ids
select 'S' || g, ('a9f31000-0000-4000-8000-00000000000' || g)::uuid from generate_series(1, 4) g;
insert into _ids values
  ('LB', 'a9f32000-0000-4000-8000-000000000001'), ('LS', 'a9f32000-0000-4000-8000-000000000002'),
  ('SB', 'a9f33000-0000-4000-8000-000000000001'), ('SS', 'a9f33000-0000-4000-8000-000000000002');

create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
declare
  g int;
begin
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'sr-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'SR Player ' || k), now()
    from _ids where k ~ '^[BS][0-9]$';

  insert into public.leagues (id, name, is_open, created_by) values
    (pg_temp.i('LB'), 'SR Big League', true, pg_temp.i('B1')),
    (pg_temp.i('LS'), 'SR Small League', true, pg_temp.i('S1'));
  insert into public.league_members (league_id, user_id, role, expires_at)
  select case when k like 'B%' then pg_temp.i('LB') else pg_temp.i('LS') end, id,
         case when k in ('B1', 'S1') then 'admin' else 'member' end, null
    from _ids where k ~ '^[BS][0-9]$'
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;

  insert into public.league_seasons (
    id, league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
    status, elo_reset_applied, baseline_plupr, created_by) values
    (pg_temp.i('SB'), pg_temp.i('LB'), 'SR Big', current_date - 20, current_date - 1, 2, 1, 'active', false, 4.00, pg_temp.i('B1')),
    (pg_temp.i('SS'), pg_temp.i('LS'), 'SR Small', current_date - 20, current_date - 1, 2, 1, 'active', false, 4.00, pg_temp.i('S1'));

  insert into public.season_snapshots (
    season_id, league_id, period_number, snapshot_date, user_id, elo_at_snapshot,
    rank_at_snapshot, wins_in_season, losses_in_season)
  select case when k like 'B%' then pg_temp.i('SB') else pg_temp.i('SS') end,
         case when k like 'B%' then pg_temp.i('LB') else pg_temp.i('LS') end,
         p, current_date - 20 + p * 7, id, 4.00, substr(k, 2)::int, 0, 0
    from _ids, generate_series(1, 2) p
   where k ~ '^[BS][0-9]$';

  -- Completed league matches inside the season: B1 x10 (vs B8), B2 x3 (vs B7), S1 x10 (vs S4).
  for g in 1 .. 10 loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                                winner_id, winner_team, status, confirm_deadline, created_at, played_at)
    values (pg_temp.i('LB'), pg_temp.i('B1'), pg_temp.i('B8'), 11, 7, 'singles',
            pg_temp.i('B1'), 'team1', 'completed', now(), now() - interval '5 days', now() - interval '5 days'),
           (pg_temp.i('LS'), pg_temp.i('S1'), pg_temp.i('S4'), 11, 7, 'singles',
            pg_temp.i('S1'), 'team1', 'completed', now(), now() - interval '5 days', now() - interval '5 days');
  end loop;
  for g in 1 .. 3 loop
    insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                                winner_id, winner_team, status, confirm_deadline, created_at, played_at)
    values (pg_temp.i('LB'), pg_temp.i('B2'), pg_temp.i('B7'), 11, 7, 'singles',
            pg_temp.i('B2'), 'team1', 'completed', now(), now() - interval '5 days', now() - interval '5 days');
  end loop;
exception when others then
  perform pg_temp.ok('setup crashed', false, sqlerrm);
end $$;


-- ════ R1 round badges' descriptions ══════════════════════════════════════
do $$
begin
  perform pg_temp.ok('R1 the round badges'' descriptions say round, not period',
    (select bool_and(description like '%round%' and description not like '%period%')
       from public.badges where name in ('Period Champion', 'Period Sweeper')));
end $$;


-- ════ R2-R4 the big season ═══════════════════════════════════════════════
do $$
declare
  b1 numeric; b2 numeric; b1_after numeric; b2_after numeric;
  f1 record; f2 record;
  lr numeric;
  e text;
begin
  select rating into b1 from public.profiles where id = pg_temp.i('B1');
  select rating into b2 from public.profiles where id = pg_temp.i('B2');
  perform public._complete_season_unchecked(pg_temp.i('SB'), true);
  select rating into b1_after from public.profiles where id = pg_temp.i('B1');
  select rating into b2_after from public.profiles where id = pg_temp.i('B2');
  select * into f1 from public.season_final_standings where season_id = pg_temp.i('SB') and user_id = pg_temp.i('B1');
  select * into f2 from public.season_final_standings where season_id = pg_temp.i('SB') and user_id = pg_temp.i('B2');
  select rating into lr from public.league_player_ratings where league_id = pg_temp.i('LB') and user_id = pg_temp.i('B2');

  perform pg_temp.ok('R2 1st of 8 with 10 matches: +0.20 added to overall PLUPR',
    b1_after = b1 + 0.20 and f1.overall_bonus = 0.20, concat_ws(' ', b1, b1_after, f1.overall_bonus));
  perform pg_temp.ok('R3 2nd with 3 matches: League bonus only, overall untouched',
    b2_after = b2 and f2.overall_bonus = 0 and f2.elo_bonus = 0.15 and lr = 4.15,
    concat_ws(' ', b2, b2_after, f2.overall_bonus, f2.elo_bonus, lr));

  begin
    perform public._complete_season_unchecked(pg_temp.i('SB'), true);
    e := 'completed twice';
  exception when others then
    e := sqlerrm;
  end;
  select rating into b1 from public.profiles where id = pg_temp.i('B1');
  perform pg_temp.ok('R4 a second completion is refused and pays nothing more',
    e like '%already been applied%' and b1 = b1_after, e);
exception when others then
  perform pg_temp.ok('R2-R4 block crashed', false, sqlerrm);
end $$;


-- ════ R5 the small season ════════════════════════════════════════════════
do $$
declare
  s1 numeric; s1_after numeric;
  f record;
begin
  select rating into s1 from public.profiles where id = pg_temp.i('S1');
  perform public._complete_season_unchecked(pg_temp.i('SS'), true);
  select rating into s1_after from public.profiles where id = pg_temp.i('S1');
  select * into f from public.season_final_standings where season_id = pg_temp.i('SS') and user_id = pg_temp.i('S1');
  perform pg_temp.ok('R5 1st of only 4 players: no overall bonus (League bonus still)',
    s1_after = s1 and f.overall_bonus = 0 and f.elo_bonus = 0.20, concat_ws(' ', s1, s1_after, f.overall_bonus, f.elo_bonus));
exception when others then
  perform pg_temp.ok('R5 block crashed', false, sqlerrm);
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
