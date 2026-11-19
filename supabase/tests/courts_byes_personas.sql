-- ============================================================
-- Courts + byes persona tests: PKL-039 (court queue, scoring gate, no courts
-- reserved) and PKL-049 (bye-round alerts).
--
-- Standalone and rolled back: nothing it writes survives. Build it (splices
-- the migration in at the marker, twice), then run from the linked checkout:
--   node supabase/tests/build-courts-byes-test.mjs %TEMP%\courts_byes_test.sql
--   supabase db query --linked -f %TEMP%\courts_byes_test.sql -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas: 10 temporary accounts CB1..CB10 (gender 'male') in a temporary
-- league. CB1 creates every tournament (the host).
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, seed int not null);
insert into _p
select 'CB' || g, ('c8c00000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, g
  from generate_series(1, 10) g;
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid);
grant select, insert, update on _ids to authenticated, anon;

-- ════ The migration under test (first: the helpers below read its columns) ═
-- @@MIGRATION@@

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.pn(int) returns uuid language sql stable as $$ select id from _p where seed = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on function pg_temp.as_admin() to authenticated;

-- Score a match as a signed-in player. Returns null, or the error text.
create function pg_temp.score_as(p_user uuid, p_match uuid, s1 int, s2 int) returns text language plpgsql as $$
declare v_err text;
begin
  perform pg_temp.as_user(p_user);
  begin
    update public.tournament_matches
       set team1_score = s1, team2_score = s2,
           winner_team = case when s1 > s2 then 'team1' else 'team2' end, status = 'completed'
     where id = p_match;
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.as_admin();
  return v_err;
end $$;

-- Notices of one kind for a player in a tournament.
create function pg_temp.notes(p_t uuid, p_user uuid, p_kind text) returns setof public.notifications language sql stable as $$
  select * from public.notifications
   where entity_id = p_t and user_id = p_user and push_data->>'kind' = p_kind order by created_at, id
$$;

-- A 10-player rotating-partners tournament: 5 rounds of 2 matches; round r
-- sits out seeds 2r-1 and 2r. p_rounds false leaves play_round null (the
-- server works it out from the draw's shape).
create function pg_temp.rp10(p_key text, p_courts text[], p_rounds boolean) returns uuid language plpgsql as $$
declare v_t uuid; v_r uuid; r int; o int := 0; pl int[]; kk int;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode, courts)
  values (pg_temp.i('L'), '[SIM] CB ' || p_key, pg_temp.p('CB1'), 'rotating_partners', 'doubles', 'none', 'invite_only', p_courts)
  returning id into v_t;
  insert into _ids values (p_key, v_t);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when _p.k = 'CB1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  for r in 1..5 loop
    select array_agg(g order by (g + r * 3) % 10, g) into pl
      from generate_series(1, 10) g where g not in (2 * r - 1, 2 * r);
    for kk in 0..1 loop
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, play_round,
             team1_player1, team1_player2, team2_player1, team2_player2)
      values (v_t, v_r, o, 'doubles', case when p_rounds then r end,
              pg_temp.pn(pl[kk * 4 + 1]), pg_temp.pn(pl[kk * 4 + 2]), pg_temp.pn(pl[kk * 4 + 3]), pg_temp.pn(pl[kk * 4 + 4]));
      o := o + 1;
    end loop;
  end loop;
  return v_t;
end $$;

-- Queue invariants right now: at most one open match per court, no player on two courts, every court a real name.
create function pg_temp.queue_ok(p_t uuid) returns text language sql stable as $$
  with live as (
    select * from public.tournament_matches
     where tournament_id = p_t and called_at is not null and status not in ('completed', 'cancelled')
  ), dup_court as (
    select court from live group by court having count(*) > 1
  ), dup_player as (
    select u from live cross join lateral (values (team1_player1), (team1_player2), (team2_player1), (team2_player2)) x(u)
     where u is not null group by u having count(*) > 1
  )
  select nullif(concat_ws('; ',
    case when exists (select 1 from dup_court) then 'a court holds two open matches' end,
    case when exists (select 1 from dup_player) then 'a player is on two courts' end,
    case when exists (select 1 from live l, public.tournaments t where t.id = p_t and not (l.court = any(t.courts)))
         then 'a match is on a court that is not listed' end), '')
$$;


-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'cbyes-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'CB Player ' || seed), now()
  from _p;
update public.profiles p set gender = 'male', rating = 3.250, singles_rating = 3.250, doubles_rating = 3.250,
       total_matches_played = 20, pickles = 2000
  from _p where p.id = _p.id;

insert into _ids values ('L', 'c8d00000-0000-4000-8000-000000000001');
insert into public.leagues (id, name, is_open, created_by)
values (pg_temp.i('L'), 'CB Test League', true, pg_temp.p('CB1'));
insert into public.league_members (league_id, user_id, role)
select pg_temp.i('L'), id, case when k = 'CB1' then 'admin' else 'member' end from _p
on conflict do nothing;


-- ════ T1 PKL-039/049: two courts, the whole tournament through the queue ═
do $$
declare v_t uuid; v_n int; v_m record; v_err text; v_bad text := ''; v_steps int := 0; v_note record; v_x text;
        v_stale int[] := '{}';
begin
  v_t := pg_temp.rp10('T1', array['1', '2'], true);
  update public.tournaments set status = 'active' where id = v_t;

  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and called_at is not null;
  perform pg_temp.ok('T1.1 lock-in calls one match per court (2)', v_n = 2, v_n || ' called');
  select string_agg(match_order || '@' || court, ',' order by match_order) into v_x
    from public.tournament_matches where tournament_id = v_t and called_at is not null;
  perform pg_temp.ok('T1.2 the first two matches go to Court 1 and Court 2', v_x = '0@1,1@2', v_x);

  select count(*) into v_n from public.notifications where entity_id = v_t and push_data->>'kind' = 'tm_court';
  perform pg_temp.ok('T1.3 lock-in sends no separate court push (the first-match alert says it)', v_n = 0, v_n || ' tm_court');

  -- a player on Court 1 at lock-in
  select m.team1_player1 as u, m.court into v_m from public.tournament_matches m where tournament_id = v_t and match_order = 0;
  select * into v_note from pg_temp.notes(v_t, v_m.u, 'tm_ready') limit 1;
  perform pg_temp.ok('T1.4 first-match alert on a court: "you''re on Court 1" + "now"',
    v_note.title like '%is on: you''re on Court 1' and v_note.body like '%You''re on Court 1 now.%' and v_note.body like '%round 1)%',
    v_note.title || ' | ' || v_note.body);

  -- CB1 sits out round 1
  select * into v_note from pg_temp.notes(v_t, pg_temp.p('CB1'), 'tm_ready') limit 1;
  perform pg_temp.ok('T1.5 sitting out round 1: "Bye in round 1: you sit out first", round 2, waits for a court',
    v_note.title like '%is on: your first match' and v_note.body like 'Bye in round 1: you sit out first. %'
      and v_note.body like '%round 2).%' and v_note.body like '%We''ll push you when a court is free.%',
    v_note.title || ' | ' || v_note.body);

  -- the gate: a player of an uncalled match cannot score it
  select * into v_m from public.tournament_matches where tournament_id = v_t and called_at is null order by match_order limit 1;
  v_err := pg_temp.score_as(v_m.team1_player1, v_m.id, 11, 5);
  perform pg_temp.ok('T1.6 a player cannot score a match not yet called (PL_TM_NOT_CALLED)',
    v_err like 'PL_TM_NOT_CALLED%' and (select status from public.tournament_matches where id = v_m.id) <> 'completed', v_err);

  -- the guard: a player's write to court / called_at is ignored
  perform pg_temp.as_user(v_m.team1_player1);
  update public.tournament_matches set court = '9', called_at = now() where id = v_m.id;
  perform pg_temp.as_admin();
  select count(*) into v_n from public.tournament_matches where id = v_m.id and court is null and called_at is null;
  perform pg_temp.ok('T1.7 a player cannot set court or called_at', v_n = 1);

  -- play it all: always score the earliest called open match, as its team-1 player
  loop
    select * into v_m from public.tournament_matches
     where tournament_id = v_t and called_at is not null and status not in ('completed', 'cancelled')
     order by match_order limit 1;
    exit when v_m.id is null or v_steps > 20;
    -- the queue can finish a later round first: if this score ends its round
    -- and the next round is already over, that round's bye alert is stale
    if not exists (select 1 from public.tournament_matches x where x.tournament_id = v_t and x.play_round = v_m.play_round
                     and x.id <> v_m.id and x.status not in ('completed', 'cancelled'))
       and not exists (select 1 from public.tournament_matches x where x.tournament_id = v_t and x.play_round = v_m.play_round + 1
                     and x.status not in ('completed', 'cancelled')) then
      v_stale := v_stale || (v_m.play_round + 1);
    end if;
    v_err := pg_temp.score_as(v_m.team1_player1, v_m.id, 11, 7);
    if v_err is not null then v_bad := v_bad || ' #' || v_m.match_order || ': ' || v_err; end if;
    v_x := pg_temp.queue_ok(v_t);
    if v_x is not null then v_bad := v_bad || ' after #' || v_m.match_order || ': ' || v_x; end if;
    v_steps := v_steps + 1;
  end loop;
  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and status = 'completed';
  perform pg_temp.ok('T1.8 every match was called and scored through the queue, no court or player clash',
    v_n = 10 and v_bad = '', v_n || ' completed;' || v_bad);

  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and called_at is null;
  perform pg_temp.ok('T1.9 no match was scored without being called', v_n = 0, v_n || ' never called');

  -- court pushes: 4 per match called after lock-in (8 matches)
  select count(*) into v_n from public.notifications where entity_id = v_t and push_data->>'kind' = 'tm_court';
  perform pg_temp.ok('T1.10 each later call sends "You''re on Court N" to its 4 players (32)', v_n = 32, v_n || ' tm_court');
  select count(*) into v_n from public.notifications n join public.push_outbox o on o.notification_id = n.id
   where n.entity_id = v_t and n.push_data->>'kind' = 'tm_court';
  perform pg_temp.ok('T1.11 every court alert is queued as a push', v_n = 32, v_n || ' outbox rows');
  select * into v_note from public.notifications where entity_id = v_t and push_data->>'kind' = 'tm_court' order by created_at limit 1;
  perform pg_temp.ok('T1.12 court alert text', v_note.title like '🏓 You''re on Court _ in [SIM] CB T1'
    and v_note.body like '% vs %. Head to Court _ now.', v_note.title || ' | ' || v_note.body);

  -- Up next after a bye: CB3 plays round 1, sits out round 2, plays round 3
  select count(*) into v_n from public.notifications
   where entity_id = v_t and user_id = pg_temp.p('CB3') and push_data->>'kind' in ('tm_score', 'tm_bye')
     and body like '%Up next (round 3, after your bye in round 2): %';
  perform pg_temp.ok('T1.13 "Up next (round 3, after your bye in round 2)" for CB3', v_n >= 1, v_n || ' alerts');

  -- Bye this round: rounds 2..5, the two who sit out, once each, unless the
  -- queue played that round before the round ahead of it finished (stale)
  select string_agg(x, ' ') into v_bad from (
    select 'CB' || s.seed || ':' || count(n.id) as x
      from _p s
      left join public.notifications n on n.entity_id = v_t and n.user_id = s.id and n.push_data->>'kind' = 'tm_bye'
       and n.body like 'You sit out round ' || ((s.seed + 1) / 2) || '. %'
     group by s.seed having count(n.id) <> case when s.seed >= 3 and not ((s.seed + 1) / 2 = any(v_stale)) then 1 else 0 end) z;
  perform pg_temp.ok('T1.14 "Bye this round" once to each player who sits out rounds 2-5 (none for round 1, none for a round already over)',
    v_bad is null, coalesce(v_bad, 'stale rounds: ' || coalesce(nullif(array_to_string(v_stale, ','), ''), 'none')));
  select * into v_note from pg_temp.notes(v_t, pg_temp.p('CB5'), 'tm_bye') limit 1;
  perform pg_temp.ok('T1.15 bye alert text names the next match', v_note.title = '🪑 Bye this round in [SIM] CB T1'
    and v_note.body like 'You sit out round 3. Up next (round 4, after your bye in round 3): % (your match _ of 4).%',
    v_note.title || ' | ' || v_note.body);
  select count(*) into v_n from public.notifications n left join public.push_outbox o on o.notification_id = n.id
   where n.entity_id = v_t and n.push_data->>'kind' = 'tm_bye' and o.id is null;
  perform pg_temp.ok('T1.16 every bye alert is queued as a push', v_n = 0, v_n || ' without a push row');

  select status into v_x from public.tournaments where id = v_t;
  perform pg_temp.ok('T1.17 the tournament completes after the last match', v_x = 'completed', v_x);
end $$;


-- ════ T2 PKL-049: rounds from the draw's shape; PKL-039 host override ════
do $$
declare v_t uuid; v_bad text; v_err text; v_m record; v_n int;
begin
  v_t := pg_temp.rp10('T2', array['A'], false);
  select string_agg(m.match_order || ':' || s.play_round, ',' order by m.match_order) into v_bad
    from public._pl_tm_schedule(v_t) s join public.tournament_matches m on m.id = s.match_id
   where s.play_round <> m.match_order / 2 + 1;
  perform pg_temp.ok('T2.1 without play_round, rounds come from the draw (2 matches a round)', v_bad is null, v_bad);
  perform pg_temp.ok('T2.2 byes: CB7 sits out round 4', public._pl_tm_byes(v_t, pg_temp.p('CB7')) = array[4],
    public._pl_tm_byes(v_t, pg_temp.p('CB7'))::text);

  update public.tournaments set status = 'active' where id = v_t;
  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and court = 'A';
  perform pg_temp.ok('T2.3 a named court ("A") is used as typed', v_n = 1);
  select * into v_m from public.tournament_matches where tournament_id = v_t and called_at is null order by match_order desc limit 1;
  v_err := pg_temp.score_as(pg_temp.p('CB1'), v_m.id, 11, 4);
  perform pg_temp.ok('T2.4 the host can score a match that was not called (override)',
    v_err is null and (select status from public.tournament_matches where id = v_m.id) = 'completed', v_err);
  perform pg_temp.ok('T2.5 court label: "4" -> "Court 4", "Center" stays',
    public._pl_tm_court_label('4') = 'Court 4' and public._pl_tm_court_label('Center') = 'Center');
end $$;


-- ════ T3 PKL-039: no courts reserved = play as today ═════════════════════
do $$
declare v_t uuid; v_n int; v_err text; v_m record; v_note record;
begin
  v_t := pg_temp.rp10('T3', null, true);
  update public.tournaments set status = 'active' where id = v_t;
  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and called_at is not null;
  perform pg_temp.ok('T3.1 no courts: nothing is called', v_n = 0, v_n || ' called');
  select * into v_m from public.tournament_matches where tournament_id = v_t order by match_order desc limit 1;
  v_err := pg_temp.score_as(v_m.team1_player1, v_m.id, 11, 6);
  perform pg_temp.ok('T3.2 no courts: a player can score any match, as today', v_err is null, v_err);
  select * into v_note from pg_temp.notes(v_t, pg_temp.p('CB4'), 'tm_ready') limit 1;
  perform pg_temp.ok('T3.3 no courts: first-match alert has the round, no court words',
    v_note.body like '%round %' and v_note.body not like '%ourt%', v_note.body);
  update public.tournaments set courts = '{}' where id = v_t;
  select count(*) into v_n from public.tournament_matches where tournament_id = v_t and called_at is not null;
  perform pg_temp.ok('T3.4 an empty court list is the same as none', v_n = 0);
end $$;


-- ════ T4 PKL-049: odd round robin (5 singles), one bye each ══════════════
do $$
declare v_t uuid; v_r uuid; pl int[] := array[1, 2, 3, 4, 5, 0]; r int; i int; o int := 0; v_bad text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values (pg_temp.i('L'), '[SIM] CB T4', pg_temp.p('CB1'), 'round_robin', 'singles', 'none', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'CB1' then 'admin' else 'member' end from _p where seed <= 5;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Round Robin Schedule', 'winners') returning id into v_r;
  -- the app's circle: fix position 1, pair mirrored, skip the BYE (0), rotate
  for r in 1..5 loop
    for i in 1..3 loop
      if pl[i] <> 0 and pl[7 - i] <> 0 then
        insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1)
        values (v_t, v_r, o, 'singles', pg_temp.pn(pl[i]), pg_temp.pn(pl[7 - i]));
        o := o + 1;
      end if;
    end loop;
    pl := array[pl[1], pl[6], pl[2], pl[3], pl[4], pl[5]];
  end loop;
  select string_agg('CB' || seed || '=' || public._pl_tm_byes(v_t, id)::text, ' ') into v_bad
    from _p where seed <= 5 and cardinality(public._pl_tm_byes(v_t, id)) <> 1;
  perform pg_temp.ok('T4.1 odd round robin: every player has exactly one bye', v_bad is null, v_bad);
  select count(distinct b) into r from _p, unnest(public._pl_tm_byes(v_t, id)) b where seed <= 5;
  perform pg_temp.ok('T4.2 odd round robin: the 5 byes fall in 5 different rounds', r = 5, r || ' rounds');
end $$;


-- ════ T5 PKL-049: back-to-back byes get one alert (rehearsal 1c45e9) ═════
-- 4 rounds of 2 doubles matches, no courts. Sitting out: round 1 CB1+CB2,
-- round 2 CB9+CB10, round 3 CB9+CB4, round 4 CB5+CB6. CB9 sits out 2 and 3.
do $$
declare v_t uuid; v_r uuid; outs int[] := array[1, 2, 9, 10, 9, 4, 5, 6]; r int; kk int; o int := 0;
        pl int[]; v_m record; v_bad text; v_n int;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values (pg_temp.i('L'), '[SIM] CB T5', pg_temp.p('CB1'), 'rotating_partners', 'doubles', 'none', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'CB1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  for r in 1..4 loop
    select array_agg(g order by g) into pl from generate_series(1, 10) g
     where g not in (outs[2 * r - 1], outs[2 * r]);
    for kk in 0..1 loop
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, play_round,
             team1_player1, team1_player2, team2_player1, team2_player2)
      values (v_t, v_r, o, 'doubles', r,
              pg_temp.pn(pl[kk * 4 + 1]), pg_temp.pn(pl[kk * 4 + 2]), pg_temp.pn(pl[kk * 4 + 3]), pg_temp.pn(pl[kk * 4 + 4]));
      o := o + 1;
    end loop;
  end loop;
  perform pg_temp.ok('T5.1 CB9 sits out rounds 2 and 3', public._pl_tm_byes(v_t, pg_temp.p('CB9')) = array[2, 3],
    public._pl_tm_byes(v_t, pg_temp.p('CB9'))::text);
  update public.tournaments set status = 'active' where id = v_t;
  for v_m in select * from public.tournament_matches where tournament_id = v_t order by match_order loop
    perform pg_temp.score_as(pg_temp.p('CB1'), v_m.id, 11, 5);   -- the host scores each, in order
  end loop;

  select string_agg(x, ' ') into v_bad from (
    select 'CB' || s.seed || ':' || count(n.id) as x
      from _p s
      left join public.notifications n on n.entity_id = v_t and n.user_id = s.id and n.push_data->>'kind' = 'tm_bye'
     group by s.seed having count(n.id) <> case when s.seed in (9, 10, 4, 5, 6) then 1 else 0 end) z;
  perform pg_temp.ok('T5.2 one "Bye this round" per run of byes: CB9 once for rounds 2-3; CB10, CB4, CB5, CB6 once; none for round 1',
    v_bad is null, v_bad);
  select count(*) into v_n from pg_temp.notes(v_t, pg_temp.p('CB9'), 'tm_bye') where body like 'You sit out rounds 2 and 3. %';
  perform pg_temp.ok('T5.3 CB9''s alert names both rounds: "You sit out rounds 2 and 3."', v_n = 1, v_n || ' alerts');
end $$;


-- ════ T6 PKL-043: no bye alert for a round already over (live run 75390a) ═
-- Same 4 rounds as T5, but scored out of order the way the court queue can:
-- round 1, then round 3, then round 2, then round 4. When round 2 finishes,
-- round 3 is already over, so CB4 (bye in round 3 only) gets no alert.
-- CB9/CB10 (told after round 1) and CB5/CB6 (told after round 3) still get one.
do $$
declare v_t uuid; v_r uuid; outs int[] := array[1, 2, 9, 10, 9, 4, 5, 6]; r int; kk int; o int := 0;
        pl int[]; v_m record; v_bad text;
begin
  insert into public.tournaments (league_id, name, created_by, format, match_type, playoff_format, registration_mode)
  values (pg_temp.i('L'), '[SIM] CB T6', pg_temp.p('CB1'), 'rotating_partners', 'doubles', 'none', 'invite_only')
  returning id into v_t;
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  select v_t, id, 'approved', seed, case when k = 'CB1' then 'admin' else 'member' end from _p;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_t, 1, 'Rotating Partners Schedule', 'winners') returning id into v_r;
  for r in 1..4 loop
    select array_agg(g order by g) into pl from generate_series(1, 10) g
     where g not in (outs[2 * r - 1], outs[2 * r]);
    for kk in 0..1 loop
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, play_round,
             team1_player1, team1_player2, team2_player1, team2_player2)
      values (v_t, v_r, o, 'doubles', r,
              pg_temp.pn(pl[kk * 4 + 1]), pg_temp.pn(pl[kk * 4 + 2]), pg_temp.pn(pl[kk * 4 + 3]), pg_temp.pn(pl[kk * 4 + 4]));
      o := o + 1;
    end loop;
  end loop;
  update public.tournaments set status = 'active' where id = v_t;
  for v_m in select * from public.tournament_matches where tournament_id = v_t
              order by case play_round when 1 then 1 when 3 then 2 when 2 then 3 else 4 end, match_order loop
    perform pg_temp.score_as(pg_temp.p('CB1'), v_m.id, 11, 5);
  end loop;

  select string_agg(x, ' ') into v_bad from (
    select 'CB' || s.seed || ':' || count(n.id) as x
      from _p s
      left join public.notifications n on n.entity_id = v_t and n.user_id = s.id and n.push_data->>'kind' = 'tm_bye'
     group by s.seed having count(n.id) <> case when s.seed in (9, 10, 5, 6) then 1 else 0 end) z;
  perform pg_temp.ok('T6.1 round 3 played before round 2: no stale alert for CB4; CB9, CB10, CB5, CB6 once each',
    v_bad is null, v_bad);
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
