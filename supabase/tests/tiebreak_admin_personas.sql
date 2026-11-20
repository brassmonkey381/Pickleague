-- ============================================================
-- Tiebreak persona tests: PKL-052. Wins, fewer losses, point diff, then the
-- admin's tie order. Never head-to-head, never rating.
--
-- Standalone and rolled back: nothing it writes survives. Build it (splices
-- the migration in at the marker, twice), then run from the linked checkout:
--   node supabase/tests/build-tiebreak-admin-test.mjs %TEMP%\tiebreak_test.sql
--   supabase db query --linked -f %TEMP%\tiebreak_test.sql -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas: 8 temporary accounts TB1..TB8 in a temporary league. TB1 creates
-- every tournament (the host).
-- ============================================================
begin;

create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, seed int not null);
insert into _p
select 'TB' || g, ('7b0c0000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, g
  from generate_series(1, 8) g;
grant select on _p to authenticated, anon;

-- @@MIGRATION@@

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create function pg_temp.key1(text) returns text language sql stable as $$ select id::text || ':' || id::text from _p where k = $1 $$;
grant execute on function pg_temp.p(text), pg_temp.ok(text, boolean, text), pg_temp.key1(text) to authenticated;
-- Insert one finished match: a beat b s1-s2 (singles, or doubles when the partners are given).
create function pg_temp.won(p_t uuid, p_r uuid, p_order int, a text, b text, s1 int, s2 int,
                            a2 text default null, b2 text default null) returns void language sql as $$
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type,
         team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, winner_team, status, completed_at)
  values (p_t, p_r, p_order, case when a2 is null then 'singles' else 'doubles' end,
          pg_temp.p(a), case when a2 is null then null else pg_temp.p(a2) end,
          pg_temp.p(b), case when b2 is null then null else pg_temp.p(b2) end,
          s1, s2, 'team1', 'completed', now())
$$;
-- Group order as "TB3>TB1>TB2" (standings / pool order).
create function pg_temp.rr(p_t uuid) returns text language sql stable as $$
  select string_agg(x.k, '>' order by g.rr_rank)
    from public._pl_tournament_group_order(p_t) g join _p x on x.id = g.lo
$$;
-- Final ranks as "TB1>TB2>...".
create function pg_temp.fr(p_t uuid) returns text language sql stable as $$
  select string_agg(x.k, '>' order by f.final_rank, x.k)
    from public.tournament_final_ranks f join _p x on x.id = f.user_id where f.tournament_id = p_t
$$;

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'tiebreak-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'TB Player ' || seed), now()
  from _p;
update public.profiles p set gender = 'male', rating = 3.000 + _p.seed * 0.1, singles_rating = 3.250, doubles_rating = 3.250
  from _p where p.id = _p.id;
create temp table _ids (k text primary key, id uuid);
insert into _ids values ('L', '7b0d0000-0000-4000-8000-000000000001');
insert into public.leagues (id, name, is_open, created_by)
select id, 'TB Test League', true, pg_temp.p('TB1') from _ids where k = 'L';
insert into public.league_members (league_id, user_id, role)
select (select id from _ids where k = 'L'), id, case when k = 'TB1' then 'admin' else 'member' end from _p
on conflict do nothing;


-- ════ T1 round robin: a 3-way tie W-L and ± can't break; ± beats head-to-head ═
-- TB1, TB2, TB3 each 2-1 with +2 (a cycle TB1>TB2>TB3>TB1 at 11-9, all beat TB4
-- 11-9). Seeds are 1, 2, 3, so the unset tie falls back to seed: TB1>TB2>TB3.
-- Then the admin orders it TB3, TB1, TB2.
do $$
declare v_t uuid; v_r uuid; v_x text; v_err text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values ((select id from _ids where k = 'L'), '[SIM] TB T1', pg_temp.p('TB1'), 'round_robin', 'singles', 'none', 'invite_only')
  returning id into v_t;
  insert into _ids values ('T1', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'TB1' then 'admin' else 'member' end from _p where seed <= 4;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin', 'winners') returning id into v_r;
  perform pg_temp.won(v_t, v_r, 0, 'TB1', 'TB2', 11, 9);
  perform pg_temp.won(v_t, v_r, 1, 'TB2', 'TB3', 11, 9);
  perform pg_temp.won(v_t, v_r, 2, 'TB3', 'TB1', 11, 9);
  perform pg_temp.won(v_t, v_r, 3, 'TB1', 'TB4', 11, 9);
  perform pg_temp.won(v_t, v_r, 4, 'TB2', 'TB4', 11, 9);
  perform pg_temp.won(v_t, v_r, 5, 'TB3', 'TB4', 11, 9);

  v_x := pg_temp.rr(v_t);
  perform pg_temp.ok('T1.1 3-way tie on 2-1 and +2, no admin order: seed order TB1>TB2>TB3, TB4 last', v_x = 'TB1>TB2>TB3>TB4', v_x);

  -- A member may not set it.
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('TB2'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('TB2'), pg_temp.key1('TB1'), pg_temp.key1('TB3')]);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.ok('T1.2 a non-admin cannot set the tie order (PL_TIE_NOT_ADMIN)', v_err like 'PL_TIE_NOT_ADMIN%', coalesce(v_err, 'no error'));

  -- The host sets TB3, TB1, TB2.
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('TB1'), 'role', 'authenticated')::text, true);
  perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('TB3'), pg_temp.key1('TB1'), pg_temp.key1('TB2')]);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  v_x := pg_temp.rr(v_t);
  perform pg_temp.ok('T1.3 after the admin orders the tie: TB3>TB1>TB2>TB4', v_x = 'TB3>TB1>TB2>TB4', v_x);

  perform public.compute_tournament_final_ranks(v_t);
  v_x := pg_temp.fr(v_t);
  perform pg_temp.ok('T1.4 final ranks follow the admin order', v_x = 'TB3>TB1>TB2>TB4', v_x);

  -- The admin order never beats a real difference: TB4 is still last.
  select count(*)::text into v_x from public.tournament_tie_orders where tournament_id = v_t;
  perform pg_temp.ok('T1.5 three tie orders stored', v_x = '3', v_x);
end $$;


-- ════ T2 round robin: ± decides a 2-way tie that head-to-head would flip ═══
-- TB5 beat TB6 11-9, but TB6 is 2-1 with +20 and TB5 is 2-1 with +2.
-- Old rule (2-way head-to-head first): TB5 ahead. New rule: TB6 ahead.
do $$
declare v_t uuid; v_r uuid; v_x text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values ((select id from _ids where k = 'L'), '[SIM] TB T2', pg_temp.p('TB1'), 'round_robin', 'singles', 'none', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, 'member' from _p where seed >= 5;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin', 'winners') returning id into v_r;
  perform pg_temp.won(v_t, v_r, 0, 'TB5', 'TB6', 11, 9);
  perform pg_temp.won(v_t, v_r, 1, 'TB5', 'TB8', 11, 9);
  perform pg_temp.won(v_t, v_r, 2, 'TB7', 'TB5', 11, 9);
  perform pg_temp.won(v_t, v_r, 3, 'TB6', 'TB7', 11, 0);
  perform pg_temp.won(v_t, v_r, 4, 'TB6', 'TB8', 11, 0);
  perform pg_temp.won(v_t, v_r, 5, 'TB8', 'TB7', 11, 9);
  v_x := pg_temp.rr(v_t);
  perform pg_temp.ok('T2.1 2-1 tie: point diff (+20) puts TB6 above TB5, who won their meeting', v_x like 'TB6>TB5>%', v_x);

  -- A tournament co-admin (registration role) may set it, like Create playoff.
  update public.tournament_registrations set role = 'co-admin' where tournament_id = v_t and user_id = pg_temp.p('TB5');
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('TB5'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('TB8'), pg_temp.key1('TB7')]);
    v_x := 'saved';
  exception when others then v_x := sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.ok('T2.2 a tournament co-admin can set the tie order', v_x = 'saved', v_x);
end $$;


-- ════ T3 rotating partners: rating no longer decides ══════════════════════
-- One doubles match, TB1+TB2 beat TB3+TB4 11-9. TB1 and TB2 are level on 1-0
-- and +2; TB2 has the higher PLUPR (3.2 vs 3.1). Old rule: TB2 first by rating.
-- New rule: seed (TB1) until the admin orders it; then the admin's order.
do $$
declare v_t uuid; v_r uuid; v_x text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values ((select id from _ids where k = 'L'), '[SIM] TB T3', pg_temp.p('TB1'), 'rotating_partners', 'doubles', 'none', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'TB1' then 'admin' else 'member' end from _p where seed <= 4;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  perform pg_temp.won(v_t, v_r, 0, 'TB1', 'TB3', 11, 9, 'TB2', 'TB4');

  perform public.compute_tournament_final_ranks(v_t);
  v_x := pg_temp.fr(v_t);
  perform pg_temp.ok('T3.1 level on 1-0 and +2: seed (TB1) ahead of the higher PLUPR (TB2); TB3>TB4 the same', v_x = 'TB1>TB2>TB3>TB4', v_x);

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('TB1'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('TB2'), pg_temp.key1('TB1')]);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform public.compute_tournament_final_ranks(v_t);
  v_x := pg_temp.fr(v_t);
  perform pg_temp.ok('T3.2 after the admin orders TB2 then TB1', v_x = 'TB2>TB1>TB3>TB4', v_x);
end $$;


-- ════ T5 pool play seeding: pool winners by W-L, ±, then the admin's order ═
-- Pool A = T1's games (TB1, TB2, TB3 level on 2-1 and +2; the admin orders
-- TB3 first); Pool B = T2's games (TB6 ahead of TB5 on ±). top_1_per_pool:
-- the final is TB3 v TB6.
do $$
declare v_t uuid; v_a uuid; v_b uuid; v_x text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values ((select id from _ids where k = 'L'), '[SIM] TB T5', pg_temp.p('TB1'), 'pool_play', 'singles', 'top_1_per_pool', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'TB1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Pool A', 'pool') returning id into v_a;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Pool B', 'pool') returning id into v_b;
  perform pg_temp.won(v_t, v_a, 0, 'TB1', 'TB2', 11, 9);
  perform pg_temp.won(v_t, v_a, 1, 'TB2', 'TB3', 11, 9);
  perform pg_temp.won(v_t, v_a, 2, 'TB3', 'TB1', 11, 9);
  perform pg_temp.won(v_t, v_a, 3, 'TB1', 'TB4', 11, 9);
  perform pg_temp.won(v_t, v_a, 4, 'TB2', 'TB4', 11, 9);
  perform pg_temp.won(v_t, v_a, 5, 'TB3', 'TB4', 11, 9);
  perform pg_temp.won(v_t, v_b, 6, 'TB5', 'TB6', 11, 9);
  perform pg_temp.won(v_t, v_b, 7, 'TB5', 'TB8', 11, 9);
  perform pg_temp.won(v_t, v_b, 8, 'TB7', 'TB5', 11, 9);
  perform pg_temp.won(v_t, v_b, 9, 'TB6', 'TB7', 11, 0);
  perform pg_temp.won(v_t, v_b, 10, 'TB6', 'TB8', 11, 0);
  perform pg_temp.won(v_t, v_b, 11, 'TB8', 'TB7', 11, 9);

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('TB1'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.set_tournament_tie_order(v_t, array[pg_temp.key1('TB3'), pg_temp.key1('TB1'), pg_temp.key1('TB2')]);
  perform public.generate_playoff_bracket(v_t);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  select string_agg(x.k, ',' order by x.k) into v_x
    from public.tournament_matches m
    join public.tournament_rounds r on r.id = m.round_id and r.round_type = 'finals'
    join _p x on x.id in (m.team1_player1, m.team2_player1)
   where m.tournament_id = v_t;
  perform pg_temp.ok('T5.1 top 1 per pool: final is TB3 (admin order in Pool A) v TB6 (± in Pool B)', v_x = 'TB3,TB6', coalesce(v_x, 'no final'));
end $$;


-- ════ T4 no head-to-head left in the ranking functions ═══════════════════
do $$
declare v_n int;
begin
  select count(*) into v_n from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('_pl_tournament_group_order', 'compute_tournament_final_ranks', 'generate_playoff_bracket')
     and (prosrc ilike '%h2h%' or prosrc ilike '%tied_opp%');
  perform pg_temp.ok('T4.1 no h2h in the group order, final ranks or playoff seeding', v_n = 0, v_n || ' functions');
  select count(*) into v_n from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('_pl_tournament_group_order', 'compute_tournament_final_ranks', 'generate_playoff_bracket')
     and prosrc ilike '%_pl_tie_rank%';
  perform pg_temp.ok('T4.2 all three read the admin tie order', v_n = 3, v_n || ' functions');
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
