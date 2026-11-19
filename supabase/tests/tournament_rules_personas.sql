-- ============================================================
-- Tournament rules persona tests: PKL-044 (rotating-partners tiebreak),
-- PKL-045 (top_2 follows the 3rd-place setting), PKL-047 (tournament match
-- pay earns Court Pass XP), PKL-048 (league W-L counts the match winner).
--
-- Standalone and rolled back: nothing it writes survives. Build it (splices
-- the four migrations in at the marker, each twice), then run from the
-- linked checkout:
--   node supabase/tests/build-tournament-rules-test.mjs %TEMP%\tournament_rules_test.sql
--   supabase db query --linked -f %TEMP%\tournament_rules_test.sql -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas: 8 temporary accounts (RP1..RP8, created inside the transaction;
-- the signup trigger makes the profiles), all gender 'male', in a temporary
-- league. Nothing commits.
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, seed int not null);
insert into _p
select 'RP' || g, ('c7c00000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, g
  from generate_series(1, 8) g;
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid);
grant select, insert, update on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
end $$;
create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Score a tournament match (as the database owner; RLS is not under test here).
create function pg_temp.score(p_match uuid, s1 int, s2 int) returns void language plpgsql as $$
begin
  update public.tournament_matches
     set team1_score = s1, team2_score = s2,
         winner_team = case when s1 > s2 then 'team1' else 'team2' end, status = 'completed'
   where id = p_match;
end $$;

create function pg_temp.wl(p_user uuid) returns text language sql stable as $$
  select coalesce((select wins || '-' || losses from public.league_player_ratings
                    where league_id = pg_temp.i('L') and user_id = p_user), 'none')
$$;

-- W-L text after adding dw wins and dl losses to a 'w-l' (or 'none' = 0-0).
create function pg_temp.plus(p_wl text, dw int, dl int) returns text language sql immutable as $$
  select (split_part(coalesce(nullif(p_wl, 'none'), '0-0'), '-', 1)::int + dw) || '-' ||
         (split_part(coalesce(nullif(p_wl, 'none'), '0-0'), '-', 2)::int + dl)
$$;

-- A round-robin singles tournament of RP1..RP4 (lower seed wins every RR match 11-5).
create function pg_temp.rr4(p_key text, p_creator text, p_third boolean) returns uuid language plpgsql as $$
declare v_t uuid; v_r uuid; i int; j int; o int := 0; v_m uuid;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, playoff_third_place, registration_mode)
  values (pg_temp.i('L'), '[SIM] TR ' || p_key, pg_temp.p(p_creator), 'round_robin', 'singles', 'top_2', p_third, 'invite_only')
  returning id into v_t;
  insert into _ids values (p_key, v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = p_creator then 'admin' else 'member' end from _p where seed <= 4;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin Schedule', 'winners') returning id into v_r;
  for i in 1..3 loop
    for j in i + 1..4 loop
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1)
      values (v_t, v_r, o, 'singles', pg_temp.p('RP' || i), pg_temp.p('RP' || j)) returning id into v_m;
      o := o + 1;
    end loop;
  end loop;
  update public.tournaments set status = 'active' where id = v_t;
  for v_m in select id from public.tournament_matches where tournament_id = v_t loop
    perform pg_temp.score(v_m, 11, 5);
  end loop;
  return v_t;
end $$;


-- ════ The migrations under test ══════════════════════════════════════════
-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'trule-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'TR Player ' || seed), now()
  from _p;
update public.profiles p set gender = 'male', rating = 3.250, singles_rating = 3.250, doubles_rating = 3.250,
       total_matches_played = 20, pickles = 1000
  from _p where p.id = _p.id;

insert into _ids values ('L', 'c7d00000-0000-4000-8000-000000000001');
insert into public.leagues (id, name, is_open, created_by)
values (pg_temp.i('L'), 'TR Test League', true, pg_temp.p('RP1'));
insert into public.league_members (league_id, user_id, role)
select pg_temp.i('L'), id, case when k = 'RP1' then 'admin' else 'member' end from _p
on conflict do nothing;


-- ════ T1 PKL-045: top_2 with the 3rd-place setting off is the Final only ═
do $$
declare v_t uuid; v_n int; v_f uuid; v_ranks text;
begin
  v_t := pg_temp.rr4('T1', 'RP1', false);
  perform pg_temp.as_service();
  v_n := public.generate_playoff_bracket(v_t);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T1 setting off: the draw makes 1 match', v_n = 1, v_n::text);
  select count(*) into v_n from public.tournament_rounds where tournament_id = v_t and round_type = 'third_place_match';
  perform pg_temp.ok('T1 setting off: no Third Place Match round', v_n = 0, v_n::text);
  select m.id into v_f from public.tournament_matches m join public.tournament_rounds r on r.id = m.round_id
   where m.tournament_id = v_t and r.round_type = 'finals';
  perform pg_temp.score(v_f, 9, 11);  -- RP2 beats RP1 in the Final
  perform pg_temp.ok('T1 completes by itself after the Final',
                     (select status from public.tournaments where id = v_t) = 'completed', null);
  select string_agg(_p.k, ',' order by fr.final_rank) into v_ranks
    from public.tournament_final_ranks fr join _p on _p.id = fr.user_id where fr.tournament_id = v_t;
  perform pg_temp.ok('T1 places: Final 1-2, then 3-4 by round robin (rule 3)', v_ranks = 'RP2,RP1,RP3,RP4', v_ranks);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T1 crashed', false, sqlerrm);
end $$;


-- ════ T2 PKL-045: setting on still adds the 3PM ══════════════════════════
do $$
declare v_t uuid; v_n int; v_who text;
begin
  v_t := pg_temp.rr4('T2', 'RP2', true);
  perform pg_temp.as_service();
  v_n := public.generate_playoff_bracket(v_t);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 setting on: Final and 3PM (2 matches)', v_n = 2, v_n::text);
  select string_agg(a.k || 'v' || b.k, ',') into v_who
    from public.tournament_matches m
    join public.tournament_rounds r on r.id = m.round_id and r.round_type = 'third_place_match'
    join _p a on a.id = m.team1_player1 join _p b on b.id = m.team2_player1
   where m.tournament_id = v_t;
  perform pg_temp.ok('T2 the 3PM is RR #3 vs #4', v_who = 'RP3vRP4', v_who);
  select count(*) into v_n from public.tournaments
   where playoff_format = 'top_2' and format in ('round_robin', 'pool_play') and not coalesce(playoff_third_place, false)
     and status <> 'completed' and id not in (pg_temp.i('T1'), pg_temp.i('T2'))
     and not exists (select 1 from public.tournament_rounds r where r.tournament_id = tournaments.id
                      and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match'));
  perform pg_temp.ok('T2 no undrawn top_2 tournament is left without its promised 3PM', v_n = 0, v_n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 crashed', false, sqlerrm);
end $$;


-- ════ T3 PKL-044: rotating partners, a 3-way tie ═════════════════════════
-- RP5..RP8 = me, a, b, c of the client test (standingsPlacement.test.ts):
-- me+a beat b+c 11-5, me+b beat a+c 11-9, a+b beat me+c 11-6. me, a, b are
-- all 2-1 and 2-1 against each other; point diff decides: a +9, me +3, b +1.
do $$
declare v_t uuid; v_r uuid; v_m uuid; v_ranks text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, registration_mode)
  values (null, '[SIM] TR rotating', pg_temp.p('RP5'), 'rotating_partners', 'doubles', 'invite_only')
  returning id into v_t;
  insert into _ids values ('T3', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'RP5' then 'admin' else 'member' end from _p where seed >= 5;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2)
  values (v_t, v_r, 0, 'doubles', pg_temp.p('RP5'), pg_temp.p('RP6'), pg_temp.p('RP7'), pg_temp.p('RP8')),
         (v_t, v_r, 1, 'doubles', pg_temp.p('RP5'), pg_temp.p('RP7'), pg_temp.p('RP6'), pg_temp.p('RP8')),
         (v_t, v_r, 2, 'doubles', pg_temp.p('RP5'), pg_temp.p('RP8'), pg_temp.p('RP6'), pg_temp.p('RP7'));
  update public.tournaments set status = 'active' where id = v_t;
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 0; perform pg_temp.score(v_m, 11, 5);
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 1; perform pg_temp.score(v_m, 11, 9);
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 2; perform pg_temp.score(v_m, 6, 11);
  perform pg_temp.ok('T3 completes by itself', (select status from public.tournaments where id = v_t) = 'completed', null);
  select string_agg(_p.k, ',' order by fr.final_rank) into v_ranks
    from public.tournament_final_ranks fr join _p on _p.id = fr.user_id where fr.tournament_id = v_t;
  perform pg_temp.ok('T3 head-to-head level, point diff decides: a, me, b, c', v_ranks = 'RP6,RP5,RP7,RP8', v_ranks);

  -- Recomputing (as a later payout or admin action might) keeps the order.
  perform public.compute_tournament_final_ranks(v_t);
  select string_agg(_p.k, ',' order by fr.final_rank) into v_ranks
    from public.tournament_final_ranks fr join _p on _p.id = fr.user_id where fr.tournament_id = v_t;
  perform pg_temp.ok('T3 recompute gives the same order', v_ranks = 'RP6,RP5,RP7,RP8', v_ranks);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 crashed', false, sqlerrm);
end $$;


-- ════ T4 PKL-044: a 2-way tie goes to head-to-head before point diff ════
-- 6 players (fixture from the client rule, tiedOpponentRecord):
--   m0 RP3+RP5 lose to RP2+RP4  5-11
--   m1 RP5+RP1 lose to RP6+RP4  9-11
--   m2 RP5+RP1 beat    RP2+RP3 12-10
-- RP1 and RP2 are both 1-1. RP2 has the better point diff (+4 vs 0), but
-- RP1 beat RP2 (m2), so RP1 ranks ahead: RP4 2-0, RP6 1-0, RP1, RP2, RP5 1-2, RP3 0-2.
do $$
declare v_t uuid; v_r uuid; v_m uuid; v_ranks text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, registration_mode)
  values (null, '[SIM] TR rotating h2h', pg_temp.p('RP6'), 'rotating_partners', 'doubles', 'invite_only')
  returning id into v_t;
  insert into _ids values ('T4', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'RP6' then 'admin' else 'member' end from _p where seed <= 6;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2)
  values (v_t, v_r, 0, 'doubles', pg_temp.p('RP3'), pg_temp.p('RP5'), pg_temp.p('RP2'), pg_temp.p('RP4')),
         (v_t, v_r, 1, 'doubles', pg_temp.p('RP5'), pg_temp.p('RP1'), pg_temp.p('RP6'), pg_temp.p('RP4')),
         (v_t, v_r, 2, 'doubles', pg_temp.p('RP5'), pg_temp.p('RP1'), pg_temp.p('RP2'), pg_temp.p('RP3'));
  update public.tournaments set status = 'active' where id = v_t;
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 0; perform pg_temp.score(v_m, 5, 11);
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 1; perform pg_temp.score(v_m, 9, 11);
  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 2; perform pg_temp.score(v_m, 12, 10);
  perform pg_temp.ok('T4 completes by itself', (select status from public.tournaments where id = v_t) = 'completed', null);
  select string_agg(_p.k, ',' order by fr.final_rank) into v_ranks
    from public.tournament_final_ranks fr join _p on _p.id = fr.user_id where fr.tournament_id = v_t;
  perform pg_temp.ok('T4 head-to-head beats point diff: RP4, RP6, RP1, RP2, RP5, RP3', v_ranks = 'RP4,RP6,RP1,RP2,RP5,RP3', v_ranks);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 crashed', false, sqlerrm);
end $$;


-- ════ T5 PKL-048: a narrow league-match win is a win ═════════════════════
do $$
declare v_m uuid; v_d numeric; a0 text; b0 text;
begin
  -- RP1/RP2 already have W-L from T1/T2 (same league): check the change.
  a0 := pg_temp.wl(pg_temp.p('RP1')); b0 := pg_temp.wl(pg_temp.p('RP2'));
  update public.profiles set rating = 5.000, singles_rating = 5.000 where id = pg_temp.p('RP1');
  insert into public.matches (league_id, match_type, player1_id, player2_id, player1_score, player2_score,
                              winner_team, winner_id, status, played_at)
  values (pg_temp.i('L'), 'singles', pg_temp.p('RP1'), pg_temp.p('RP2'), 12, 10, 'team1', pg_temp.p('RP1'),
          'completed', now())
  returning id, pending_delta1 into v_m, v_d;
  perform pg_temp.ok('T5 the 5.0 player won 12-10 and lost PLUPR (the B13 case)', v_d < 0, v_d::text);
  perform pg_temp.ok('T5 winner: +1 league win', pg_temp.wl(pg_temp.p('RP1')) = pg_temp.plus(a0, 1, 0), a0 || ' -> ' || pg_temp.wl(pg_temp.p('RP1')));
  perform pg_temp.ok('T5 loser: +1 league loss', pg_temp.wl(pg_temp.p('RP2')) = pg_temp.plus(b0, 0, 1), b0 || ' -> ' || pg_temp.wl(pg_temp.p('RP2')));
  update public.profiles set rating = 3.250, singles_rating = 3.250 where id = pg_temp.p('RP1');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 crashed', false, sqlerrm);
end $$;


-- ════ T6 PKL-048: tournament match in a league, corrected, then deleted ══
do $$
declare v_t uuid; v_r uuid; v_m uuid; v_d numeric; a0 text; b0 text; v_won text;
begin
  a0 := pg_temp.wl(pg_temp.p('RP3')); b0 := pg_temp.wl(pg_temp.p('RP4'));
  update public.profiles set rating = 5.000, singles_rating = 5.000 where id = pg_temp.p('RP3');
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values (pg_temp.i('L'), '[SIM] TR league wl', pg_temp.p('RP3'), 'round_robin', 'singles', 'none', 'invite_only')
  returning id into v_t;
  insert into _ids values ('T6', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'RP3' then 'admin' else 'member' end from _p where k in ('RP3', 'RP4');
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin Schedule', 'winners') returning id into v_r;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1)
  values (v_t, v_r, 0, 'singles', pg_temp.p('RP3'), pg_temp.p('RP4')) returning id into v_m;
  update public.tournaments set status = 'active' where id = v_t;
  perform pg_temp.score(v_m, 12, 10);
  select plupr_delta, plupr_ratings -> pg_temp.p('RP3')::text ->> 'won' into v_d, v_won from public.tournament_matches where id = v_m;
  perform pg_temp.ok('T6 narrow win with a PLUPR drop', v_d < 0, v_d::text);
  perform pg_temp.ok('T6 the row records won = true for the winner', v_won = 'true', v_won);
  perform pg_temp.ok('T6 winner +1 win, loser +1 loss',
                     pg_temp.wl(pg_temp.p('RP3')) = pg_temp.plus(a0, 1, 0) and pg_temp.wl(pg_temp.p('RP4')) = pg_temp.plus(b0, 0, 1),
                     pg_temp.wl(pg_temp.p('RP3')) || ' / ' || pg_temp.wl(pg_temp.p('RP4')));
  -- Correct the score: RP4 won after all (the tournament is completed; the
  -- admin correction path is the service role).
  perform pg_temp.as_service();
  update public.tournament_matches set team1_score = 10, team2_score = 12, winner_team = 'team2' where id = v_m;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 after the correction: RP3 +1 loss, RP4 +1 win (from before the match)',
                     pg_temp.wl(pg_temp.p('RP3')) = pg_temp.plus(a0, 0, 1) and pg_temp.wl(pg_temp.p('RP4')) = pg_temp.plus(b0, 1, 0),
                     pg_temp.wl(pg_temp.p('RP3')) || ' / ' || pg_temp.wl(pg_temp.p('RP4')));
  delete from public.tournaments where id = v_t;
  perform pg_temp.ok('T6 deleting the tournament takes the W-L back',
                     pg_temp.wl(pg_temp.p('RP3')) = pg_temp.plus(a0, 0, 0) and pg_temp.wl(pg_temp.p('RP4')) = pg_temp.plus(b0, 0, 0),
                     pg_temp.wl(pg_temp.p('RP3')) || ' / ' || pg_temp.wl(pg_temp.p('RP4')));
  update public.profiles set rating = 3.250, singles_rating = 3.250 where id = pg_temp.p('RP3');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 crashed', false, sqlerrm);
end $$;


-- ════ T7 PKL-048: a rating bonus is not a win ════════════════════════════
do $$
declare w0 text;
begin
  w0 := pg_temp.wl(pg_temp.p('RP7'));
  perform public._apply_plupr_delta_to_league(pg_temp.i('L'), pg_temp.p('RP7'), 0.100, null);
  perform pg_temp.ok('T7 a +0.1 league bonus adds no win', pg_temp.wl(pg_temp.p('RP7')) = (case when w0 = 'none' then '0-0' else w0 end),
                     w0 || ' -> ' || pg_temp.wl(pg_temp.p('RP7')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T7 crashed', false, sqlerrm);
end $$;


-- ════ T8 PKL-047: tournament match pay is on the Court Pass allowlist ════
do $$
begin
  perform pg_temp.ok('T8 _grant_tournament_match_bonus earns XP at 0.5',
                     (select xp_ratio from public.reward_track_xp_sources where source = '_grant_tournament_match_bonus') = 0.5, null);
  perform pg_temp.ok('T8 placement pay stays off it',
                     not exists (select 1 from public.reward_track_xp_sources where source = '_grant_tournament_placement_pay'), null);
  perform pg_temp.ok('T8 the allowlist is the 5 play sources',
                     (select count(*) from public.reward_track_xp_sources) = 5,
                     (select string_agg(source, ', ' order by source) from public.reward_track_xp_sources));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T8 crashed', false, sqlerrm);
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
