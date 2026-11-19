-- ============================================================
-- Tournament server persona tests: PKL-035 (PLUPR + history), PKL-036
-- (notices), PKL-037 (staged placement, auto-close), PKL-042 (rewards).
--
-- Standalone and rolled back: nothing it writes survives. Build it (splices
-- the five migrations in at the marker), then run from the linked checkout:
--   node supabase/tests/build-tournament-server-test.mjs %TEMP%\tournament_server_test.sql
--   supabase db query --linked -f %TEMP%\tournament_server_test.sql -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas: 10 temporary accounts (TP1..TP10, created inside the
-- transaction; the signup trigger makes the profiles), all gender 'male',
-- in a temporary league. They have no push tokens, and nothing commits.
-- Deferred triggers (the playoff notice) are fired with
-- SET CONSTRAINTS ALL IMMEDIATE, since this transaction never commits.
--
-- Also checked by a local PGlite run of the same migrations over the live
-- function bodies (scenarios A-E, 554 checks, 2026-11-18): see the PR notes.
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, seed int not null);
insert into _p
select 'TP' || g, ('c7a00000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, g
  from generate_series(1, 10) g;
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid);
grant select, insert, update on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
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

-- Score a match as player k (RLS: participants may update).
create function pg_temp.score(p_match uuid, s1 int, s2 int, k text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.p(k));
  update public.tournament_matches
     set team1_score = s1, team2_score = s2,
         winner_team = case when s1 > s2 then 'team1' else 'team2' end, status = 'completed'
   where id = p_match;
  perform pg_temp.as_admin();
end $$;


-- ════ The migrations under test ══════════════════════════════════════════
-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'tsrv-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'TS Player ' || seed), now()
  from _p;
update public.profiles p set gender = 'male', rating = 3.250, singles_rating = 3.250, doubles_rating = 3.250,
       total_matches_played = 20, pickles = 1000
  from _p where p.id = _p.id;

insert into _ids values ('L', 'c7b00000-0000-4000-8000-000000000001');
insert into public.leagues (id, name, is_open, created_by)
values (pg_temp.i('L'), 'TS Test League', true, pg_temp.p('TP1'));
insert into public.league_members (league_id, user_id, role)
select pg_temp.i('L'), id, case when k = 'TP1' then 'admin' else 'member' end from _p
on conflict do nothing;

create temp table _before as
select p.id, p.rating, p.singles_rating, p.doubles_rating, p.total_matches_played, p.pickles from public.profiles p
 where p.id in (select id from _p);


-- ════ T1 round robin, singles, 8 players, top_2: lock-in ═════════════════
do $$
declare v_t uuid; v_r uuid; i int; j int; o int := 0; v_n int;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, playoff_third_place, registration_mode)
  values (pg_temp.i('L'), '[SIM] TS round robin', pg_temp.p('TP1'), 'round_robin', 'singles', 'top_2', true, 'invite_only')
  returning id into v_t;
  insert into _ids values ('T', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'TP1' then 'admin' else 'member' end from _p where seed <= 8;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin Schedule', 'winners') returning id into v_r;
  -- every pair once; TPi (lower seed) is team1
  for i in 1..7 loop
    for j in i + 1..8 loop
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1)
      values (v_t, v_r, o, 'singles', pg_temp.p('TP' || i), pg_temp.p('TP' || j));
      o := o + 1;
    end loop;
  end loop;
  update public.tournaments set status = 'active' where id = v_t;

  select count(*) into v_n from public.notifications n
   where n.entity_id = v_t and n.push_data ->> 'kind' = 'tm_ready' and n.user_id in (select id from _p);
  perform pg_temp.ok('T1 lock-in: a "first match" notice for each of the 8 players', v_n = 8, v_n::text);
  select count(*) into v_n from public.push_outbox o
    join public.notifications n on n.id = o.notification_id
   where n.entity_id = v_t and n.push_data ->> 'kind' = 'tm_ready';
  perform pg_temp.ok('T1 each notice is queued as a push', v_n = 8, v_n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T1 crashed', false, sqlerrm);
end $$;


-- ════ T2 one score: PLUPR league full + overall half, count, notice ══════
do $$
declare v_m record; g1a numeric; g1b numeric; l1 numeric; c0 int; c1 int; v_n int; v_row record;
begin
  select * into v_m from public.tournament_matches
   where tournament_id = pg_temp.i('T') and team1_player1 = pg_temp.p('TP1') and team2_player1 = pg_temp.p('TP2');
  select rating, total_matches_played into g1a, c0 from public.profiles where id = pg_temp.p('TP1');
  perform pg_temp.score(v_m.id, 11, 6, 'TP1');
  select rating, total_matches_played into g1b, c1 from public.profiles where id = pg_temp.p('TP1');
  select rating into l1 from public.league_player_ratings where league_id = pg_temp.i('L') and user_id = pg_temp.p('TP1');
  select plupr_delta, plupr_global_weight, plupr_applied_at, completed_at, plupr_ratings into v_row
    from public.tournament_matches where id = v_m.id;
  perform pg_temp.ok('T2 PLUPR recorded on the row (weight 0.5 in a league)',
                     v_row.plupr_applied_at is not null and v_row.plupr_global_weight = 0.5 and v_row.completed_at is not null,
                     row_to_json(v_row)::text);
  perform pg_temp.ok('T2 league PLUPR moved by the full delta', l1 = 3.250 + v_row.plupr_delta,
                     format('league %s delta %s', l1, v_row.plupr_delta));
  perform pg_temp.ok('T2 overall PLUPR moved by half (like a league match)', abs((g1b - g1a) - v_row.plupr_delta * 0.5) < 0.001,
                     format('%s -> %s', g1a, g1b));
  perform pg_temp.ok('T2 counted once', c1 = c0 + 1, format('%s -> %s', c0, c1));
  select count(*) into v_n from public.notifications
   where user_id = pg_temp.p('TP2') and entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_score' and title like '%you lost 6-11';
  perform pg_temp.ok('T2 the opponent gets "you lost 6-11"', v_n = 1, v_n::text);
  select count(*) into v_n from public.tournament_match_bonus_grants where match_id = v_m.id and paid > 0;
  perform pg_temp.ok('T2 match pay for both players (PKL-042)', v_n = 2, v_n::text);
  -- a re-save of the same score changes nothing
  perform pg_temp.as_service();
  update public.tournament_matches set team1_score = 11 where id = v_m.id;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 re-save: no second application',
                     (select rating from public.profiles where id = pg_temp.p('TP1')) = g1b, null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 crashed', false, sqlerrm);
end $$;


-- ════ T3 the rest of the round robin: lower seed always wins ═════════════
do $$
declare v_m record; v_n int;
begin
  for v_m in select * from public.tournament_matches
              where tournament_id = pg_temp.i('T') and status <> 'completed' order by match_order loop
    perform pg_temp.score(v_m.id, 11, 4, (select k from _p where id = v_m.team1_player1));
  end loop;
  perform pg_temp.ok('T3 still active after the last RR match (playoff to draw)',
                     (select status from public.tournaments where id = pg_temp.i('T')) = 'active', null);
  select count(*) into v_n from public.notifications where entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_rr_done';
  perform pg_temp.ok('T3 "round robin done" to all 8', v_n = 8, v_n::text);
  select count(*) into v_n from public.notifications where entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_draw_due'
     and user_id = pg_temp.p('TP1');
  perform pg_temp.ok('T3 the host is told to draw the playoff', v_n = 1, v_n::text);
  perform pg_temp.ok('T3 RR order is seed order (TP1 7-0 ... TP8 0-7)',
    (select array_agg(g.lo order by g.rr_rank) from public._pl_tournament_group_order(pg_temp.i('T')) g)
      = (select array_agg(id order by seed) from _p where seed <= 8), null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 crashed', false, sqlerrm);
end $$;


-- ════ T4 the playoff draw (real RPC, as the host) + its notices ═══════════
do $$
declare v_n int; v_in int;
begin
  perform pg_temp.as_user(pg_temp.p('TP1'));
  perform public.generate_playoff_bracket(pg_temp.i('T'));
  perform pg_temp.as_admin();
  execute 'set constraints all immediate';   -- fire the deferred notice trigger now
  select count(*), count(*) filter (where title like '%You''re in the%') into v_n, v_in
    from public.notifications where entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_playoff';
  perform pg_temp.ok('T4 a playoff notice for all 8, "you''re in" for 4', v_n = 8 and v_in = 4, format('%s / %s', v_n, v_in));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 crashed', false, sqlerrm);
end $$;


-- ════ T5 Final (TP2 beats TP1) and 3PM (TP4 beats TP3): staged ranks ═════
do $$
declare v_f uuid; v_3 uuid; v_ranks uuid[]; v_pay int[]; v_n int;
begin
  select m.id into v_f from public.tournament_matches m join public.tournament_rounds r on r.id = m.round_id
   where m.tournament_id = pg_temp.i('T') and r.round_type = 'finals';
  select m.id into v_3 from public.tournament_matches m join public.tournament_rounds r on r.id = m.round_id
   where m.tournament_id = pg_temp.i('T') and r.round_type = 'third_place_match';
  perform pg_temp.score(v_f, 8, 11, 'TP1');
  perform pg_temp.ok('T5 still active until the 3PM is scored',
                     (select status from public.tournaments where id = pg_temp.i('T')) = 'active', null);
  perform pg_temp.score(v_3, 9, 11, 'TP3');
  perform pg_temp.ok('T5 completed by itself',
                     (select status from public.tournaments where id = pg_temp.i('T')) = 'completed', null);
  select array_agg(user_id order by final_rank) into v_ranks from public.tournament_final_ranks where tournament_id = pg_temp.i('T');
  perform pg_temp.ok('T5 places: Final 1-2, 3PM 3-4 (B1 fixed), 5-8 RR order',
                     v_ranks = array[pg_temp.p('TP2'), pg_temp.p('TP1'), pg_temp.p('TP4'), pg_temp.p('TP3'),
                                     pg_temp.p('TP5'), pg_temp.p('TP6'), pg_temp.p('TP7'), pg_temp.p('TP8')],
                     v_ranks::text);
  select array_agg(paid order by place) into v_pay from public.tournament_placement_grants where tournament_id = pg_temp.i('T');
  perform pg_temp.ok('T5 placement pay 150/100/100 at 8 players (PKL-042)', v_pay = array[150, 100, 100], v_pay::text);
  select count(*) into v_n from public.notifications where entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_finished';
  perform pg_temp.ok('T5 a "finished" notice for all 8', v_n = 8, v_n::text);
  perform pg_temp.ok('T5 the champion''s notice says so, with the pay',
    exists (select 1 from public.notifications where user_id = pg_temp.p('TP2') and push_data ->> 'kind' = 'tm_finished'
             and title like '%You won%' and body like '%+150%'), null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 crashed', false, sqlerrm);
end $$;


-- ════ T6 match history RPC ═══════════════════════════════════════════════
do $$
declare v_n int; v_r record;
begin
  perform pg_temp.as_user(pg_temp.p('TP3'));
  select count(*) into v_n from public.get_tournament_match_history(pg_temp.p('TP3'), null, 300);
  select * into v_r from public.get_tournament_match_history(pg_temp.p('TP3'), null, 1);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 history lists TP3''s 8 tournament matches (7 RR + 3PM)', v_n = 8, v_n::text);
  perform pg_temp.ok('T6 a row has names, tournament and PLUPR change',
    v_r.tournament_name = '[SIM] TS round robin' and v_r.player1 ->> 'full_name' is not null
      and v_r.plupr_ratings ? pg_temp.p('TP3')::text, row_to_json(v_r)::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 crashed', false, sqlerrm);
end $$;


-- ════ T7 a corrected score (service role): reversed and re-applied once ══
do $$
declare v_m record; c0 int; c1 int; d0 numeric; d1 numeric; v_n int;
begin
  select * into v_m from public.tournament_matches
   where tournament_id = pg_temp.i('T') and team1_player1 = pg_temp.p('TP5') and team2_player1 = pg_temp.p('TP6');
  d0 := v_m.plupr_delta;
  select total_matches_played into c0 from public.profiles where id = pg_temp.p('TP5');
  perform pg_temp.as_service();
  update public.tournament_matches set team1_score = 4, team2_score = 11, winner_team = 'team2' where id = v_m.id;
  perform pg_temp.as_admin();
  select plupr_delta into d1 from public.tournament_matches where id = v_m.id;
  select total_matches_played into c1 from public.profiles where id = pg_temp.p('TP5');
  perform pg_temp.ok('T7 correction re-applied with the new result, count unchanged',
                     d1 < 0 and d0 > 0 and c1 = c0, format('delta %s -> %s, count %s -> %s', d0, d1, c0, c1));
  select count(*) into v_n from public.notifications where entity_id = pg_temp.i('T') and push_data ->> 'kind' = 'tm_fix';
  perform pg_temp.ok('T7 both players told the score was corrected', v_n = 2, v_n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T7 crashed', false, sqlerrm);
end $$;


-- ════ T8 rotating partners, 10 players, doubles: all 4 players ═══════════
do $$
declare v_t uuid; v_r uuid; v_m uuid; a numeric[]; b numeric[]; v_n int; v_pay int[];
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values (pg_temp.i('L'), '[SIM] TS rotating', pg_temp.p('TP1'), 'rotating_partners', 'doubles', 'none', 'invite_only')
  returning id into v_t;
  insert into _ids values ('R', v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'TP1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2)
  values (v_t, v_r, 0, 'doubles', pg_temp.p('TP1'), pg_temp.p('TP10'), pg_temp.p('TP2'), pg_temp.p('TP9')),
         (v_t, v_r, 1, 'doubles', pg_temp.p('TP3'), pg_temp.p('TP8'), pg_temp.p('TP4'), pg_temp.p('TP7')),
         (v_t, v_r, 2, 'doubles', pg_temp.p('TP1'), pg_temp.p('TP3'), pg_temp.p('TP5'), pg_temp.p('TP6'));
  update public.tournaments set status = 'active' where id = v_t;

  select id into v_m from public.tournament_matches where tournament_id = v_t and match_order = 0;
  select array_agg(rating order by k) into a from public.profiles p join _p on _p.id = p.id where k in ('TP1','TP10','TP2','TP9');
  perform pg_temp.score(v_m, 7, 11, 'TP2');
  select array_agg(rating order by k) into b from public.profiles p join _p on _p.id = p.id where k in ('TP1','TP10','TP2','TP9');
  perform pg_temp.ok('T8 doubles: all 4 players'' overall PLUPR moved', a[1] <> b[1] and a[2] <> b[2] and a[3] <> b[3] and a[4] <> b[4],
                     format('%s -> %s', a, b));
  select count(*) into v_n from public.notifications where entity_id = v_t and push_data ->> 'kind' = 'tm_score';
  perform pg_temp.ok('T8 score notice to partner + both opponents (3; enterer TP2 also gets "up next")', v_n in (3, 4), v_n::text);
  perform pg_temp.ok('T8 the partner TP9 is told',
    exists (select 1 from public.notifications where user_id = pg_temp.p('TP9') and entity_id = v_t and push_data ->> 'kind' = 'tm_score'), null);

  perform pg_temp.score((select id from public.tournament_matches where tournament_id = v_t and match_order = 1), 11, 3, 'TP3');
  perform pg_temp.score((select id from public.tournament_matches where tournament_id = v_t and match_order = 2), 11, 5, 'TP1');
  perform pg_temp.ok('T8 completed by itself', (select status from public.tournaments where id = v_t) = 'completed', null);
  -- per-player: TP3 2-0 is the only 2-0 (TP1 lost match 0, won match 2), so TP3 is 1st
  perform pg_temp.ok('T8 per-player ranks: TP3 (2-0) first',
    (select user_id from public.tournament_final_ranks where tournament_id = v_t and final_rank = 1) = pg_temp.p('TP3'), null);
  select array_agg(paid order by place) into v_pay from public.tournament_placement_grants where tournament_id = v_t;
  perform pg_temp.ok('T8 placement pay at 10 players x1.25 = 188/125/125', v_pay = array[188, 125, 125], v_pay::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T8 crashed', false, sqlerrm);
end $$;


-- ════ T9 deleting the tournaments puts every rating and count back ═══════
do $$
declare v_bad int;
begin
  delete from public.tournaments where id in (pg_temp.i('T'), pg_temp.i('R'));
  select count(*) into v_bad from public.profiles p join _before b on b.id = p.id
   where p.rating <> b.rating or p.singles_rating <> b.singles_rating or p.doubles_rating <> b.doubles_rating
      or p.total_matches_played <> b.total_matches_played;
  perform pg_temp.ok('T9 overall/facet PLUPR and match counts restored', v_bad = 0, v_bad::text);
  select count(*) into v_bad from public.league_player_ratings
   where league_id = pg_temp.i('L') and (rating <> 3.250 or wins <> 0 or losses <> 0);
  perform pg_temp.ok('T9 league PLUPR and W-L restored', v_bad = 0, v_bad::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T9 crashed', false, sqlerrm);
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
