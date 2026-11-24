-- migration_mlp_dreambreaker_rotation.sql (PKL-086)
--
-- Brian 2026-11-24: "why is dreambreaker just a singles 1v1 match? Shouldn't it be a rotating, MLP scoring, every 4
-- points, singles 1v1 ... we just need the order of play of the match, or let the players pick and enter the final
-- score, first to 21 win by 2."
-- 1. tournament_matches.db_order_team1 / db_order_team2: each team's 4 players in order of play (new Dreambreakers).
--    _insert_mlp_pairing_matches always writes the Dreambreaker now (no captain pick needed); the default order is the
--    captain's pick first, then the roster. Old one-player Dreambreakers (db_order_* null) are unchanged.
-- 2. mlp_set_dreambreaker_order(p_match_id, p_team, p_order): the team's captain, a team member, or a tournament
--    admin reorders a team's 4 before any score.
-- 3. A rotating Dreambreaker's score must be a rally game to 21, win by 2: the winner has 21 and leads by 2+, or more
--    than 21 and leads by exactly 2 (21-19, 24-22; not 21-20, 25-21). One final score, no point by point.
-- 4. Player stats skip it: no PLUPR, no player match count, no match pay. It counts for the team only: its winner
--    takes the matchup (PKL-084 standings).

alter table public.tournament_matches
  add column if not exists db_order_team1 uuid[],
  add column if not exists db_order_team2 uuid[];

create or replace function public._mlp_db_default_order(p_first uuid, p_roster uuid[])
returns uuid[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(x order by (x is distinct from p_first), k), '{}'::uuid[])
    from unnest(p_roster) with ordinality as r(x, k) where x is not null
$$;
revoke all on function public._mlp_db_default_order(uuid, uuid[]) from public, anon, authenticated;

create or replace function public._mlp_valid_rally21(a integer, b integer)
returns boolean language sql immutable set search_path = '' as $$
  select a is not null and b is not null and a >= 0 and b >= 0 and a <> b
     and greatest(a, b) >= 21 and abs(a - b) >= 2 and (greatest(a, b) = 21 or abs(a - b) = 2)
$$;
grant execute on function public._mlp_valid_rally21(integer, integer) to authenticated;

create or replace function public._mlp_db_score_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(new.is_dreambreaker, false) and new.db_order_team1 is not null and new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed'
          or (old.team1_score, old.team2_score) is distinct from (new.team1_score, new.team2_score)) then
    if not public._mlp_valid_rally21(new.team1_score, new.team2_score) then
      raise exception 'A Dreambreaker is one rally game to 21, win by 2 (for example 21-19 or 24-22); got %-%',
        new.team1_score, new.team2_score using errcode = '22023';
    end if;
    if new.winner_team is distinct from (case when new.team1_score > new.team2_score then 'team1' else 'team2' end) then
      raise exception 'Dreambreaker winner does not match the score' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_mlp_db_score_guard on public.tournament_matches;
create trigger trg_mlp_db_score_guard before insert or update on public.tournament_matches
  for each row execute function public._mlp_db_score_guard();

create or replace function public.mlp_set_dreambreaker_order(p_match_id uuid, p_team integer, p_order uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  m record; t record; v_uid uuid := auth.uid(); v_cur uuid[];
begin
  if p_team not in (1, 2) then raise exception 'p_team must be 1 or 2' using errcode = '22023'; end if;
  select * into m from public.tournament_matches where id = p_match_id for update;
  if m.id is null or not coalesce(m.is_dreambreaker, false) or m.db_order_team1 is null then
    raise exception 'not a rotating Dreambreaker' using errcode = '22023';
  end if;
  if m.status <> 'pending' or m.team1_score is not null or m.team2_score is not null then
    raise exception 'the Dreambreaker has started or is over; its order is locked' using errcode = '22023';
  end if;
  v_cur := case when p_team = 1 then m.db_order_team1 else m.db_order_team2 end;
  select * into t from public.mlp_teams mt where mt.tournament_id = m.tournament_id
     and v_cur[1] in (mt.male_1_id, mt.male_2_id, mt.female_1_id, mt.female_2_id) limit 1;
  if t.id is null then raise exception 'team not found' using errcode = '22023'; end if;
  if not (v_uid in (t.captain_id, t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
          or public._is_tournament_admin(m.tournament_id, v_uid)) then
    raise exception 'only this team or a tournament admin can set its order' using errcode = '42501';
  end if;
  if cardinality(p_order) <> cardinality(v_cur)
     or (select count(distinct x) from unnest(p_order) x) <> cardinality(v_cur)
     or exists (select 1 from unnest(p_order) x where x <> all (v_cur)) then
    raise exception 'the order must list each of the team''s players once' using errcode = '22023';
  end if;
  if p_team = 1 then
    update public.tournament_matches set db_order_team1 = p_order, team1_player1 = p_order[1] where id = p_match_id;
  else
    update public.tournament_matches set db_order_team2 = p_order, team2_player1 = p_order[1] where id = p_match_id;
  end if;
  return p_order;
end $$;
revoke all on function public.mlp_set_dreambreaker_order(uuid, integer, uuid[]) from public, anon;
grant execute on function public.mlp_set_dreambreaker_order(uuid, integer, uuid[]) to authenticated;

CREATE OR REPLACE FUNCTION public._insert_mlp_pairing_matches(p_tournament_id uuid, p_round_id uuid, p_team_a record, p_team_b record, p_start_order integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_ord_a uuid[];
  v_ord_b uuid[];
  v_order integer := p_start_order;
  v_db_a  uuid;
  v_db_b  uuid;
begin
  -- 1. Men's
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_1_id, p_team_a.male_2_id, p_team_b.male_1_id, p_team_b.male_2_id
  );
  -- 2. Women's
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.female_1_id, p_team_a.female_2_id, p_team_b.female_1_id, p_team_b.female_2_id
  );
  -- 3. Mixed 1
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_1_id, p_team_a.female_1_id, p_team_b.male_1_id, p_team_b.female_1_id
  );
  -- 4. Mixed 2
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_2_id, p_team_a.female_2_id, p_team_b.male_2_id, p_team_b.female_2_id
  );

  -- 5. Dreambreaker (PKL-086): all 4 players of each team play singles in an order of play, rotating every 4 rally
  --    points, one rally-scored game to 21, win by 2. Default order: the captain's Dreambreaker pick first (if any),
  --    then the roster (men's slots, women's slots). Each team can reorder before a score (mlp_set_dreambreaker_order).
  --    team1_player1 / team2_player1 hold each order's first player, so lists that show one player still work.
  select dreambreaker_player_id into v_db_a from public.mlp_teams where id = p_team_a.id;
  select dreambreaker_player_id into v_db_b from public.mlp_teams where id = p_team_b.id;
  v_ord_a := public._mlp_db_default_order(v_db_a, array[p_team_a.male_1_id, p_team_a.male_2_id, p_team_a.female_1_id, p_team_a.female_2_id]);
  v_ord_b := public._mlp_db_default_order(v_db_b, array[p_team_b.male_1_id, p_team_b.male_2_id, p_team_b.female_1_id, p_team_b.female_2_id]);
  if cardinality(v_ord_a) > 0 and cardinality(v_ord_b) > 0 then
    v_order := v_order + 1;
    insert into public.tournament_matches (
      tournament_id, round_id, match_order, match_type, status,
      team1_player1, team1_player2, team2_player1, team2_player2,
      is_dreambreaker, db_order_team1, db_order_team2
    ) values (
      p_tournament_id, p_round_id, v_order, 'singles', 'pending',
      v_ord_a[1], null, v_ord_b[1], null,
      true, v_ord_a, v_ord_b
    );
  end if;

  return v_order;
end;
$function$;

CREATE OR REPLACE FUNCTION public._pl_tm_plupr()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  GLOBAL_WEIGHT constant numeric := 0.5;
  v_is      boolean;
  v_was     boolean := false;
  v_changed boolean := false;
  v_league  uuid;
  v_w       numeric;
  r1 numeric; r_p1 numeric := 3.250;
  r2 numeric; r_p2 numeric := 3.250;
  t1avg numeric; t2avg numeric;
  cat text; fcat text;
  p1_count integer;
  s1 integer; s2 integer;
  d1 numeric;
  v_r jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    if old.plupr_applied_at is not null then
      perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    end if;
    return old;
  end if;

  -- Server-owned columns: whatever a client sent is replaced.
  if tg_op = 'INSERT' then
    new.completed_at := null;
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  else
    new.completed_at := old.completed_at;
    new.plupr_delta := old.plupr_delta; new.plupr_league_id := old.plupr_league_id;
    new.plupr_global_weight := old.plupr_global_weight; new.plupr_category := old.plupr_category;
    new.plupr_ratings := old.plupr_ratings; new.plupr_applied_at := old.plupr_applied_at;
    v_was := old.status = 'completed' and old.winner_team is not null
             and old.team1_player1 is not null and old.team2_player1 is not null;
  end if;

  v_is := new.status = 'completed' and new.winner_team in ('team1', 'team2')
          and new.team1_player1 is not null and new.team2_player1 is not null
          and not (coalesce(new.is_dreambreaker, false) and new.db_order_team1 is not null); -- PKL-086: a rotating Dreambreaker moves no one's PLUPR

  if tg_op = 'UPDATE' and v_was and v_is then
    v_changed := (new.team1_score, new.team2_score, new.winner_team, new.match_type,
                  new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2,
                  new.team1_player1_gender_override, new.team1_player2_gender_override,
                  new.team2_player1_gender_override, new.team2_player2_gender_override)
                 is distinct from
                 (old.team1_score, old.team2_score, old.winner_team, old.match_type,
                  old.team1_player1, old.team1_player2, old.team2_player1, old.team2_player2,
                  old.team1_player1_gender_override, old.team1_player2_gender_override,
                  old.team2_player1_gender_override, old.team2_player2_gender_override);
    if not v_changed then return new; end if;            -- a re-save: nothing to do
    if old.plupr_applied_at is null then return new; end if;  -- completed before this file (or unspecified doubles): leave it
  end if;

  -- Undo what this row applied when it stops counting or its result changed.
  if tg_op = 'UPDATE' and old.plupr_applied_at is not null and (not v_is or v_changed) then
    perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  end if;

  if not v_is then
    new.completed_at := null;
    return new;
  end if;
  if not v_was then new.completed_at := now(); end if;

  -- Apply. Same rating math as update_plupr_for_tournament_match.
  select league_id into v_league from public.tournaments where id = new.tournament_id;
  v_w := case when v_league is not null then GLOBAL_WEIGHT else 1.0 end;

  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    t1avg := (r1 + r_p1) / 2.0;
    t2avg := (r2 + r_p2) / 2.0;
    cat := public._classify_doubles_with_overrides(
      new.team1_player1, new.team1_player1_gender_override,
      new.team1_player2, new.team1_player2_gender_override,
      new.team2_player1, new.team2_player1_gender_override,
      new.team2_player2, new.team2_player2_gender_override);
    fcat := cat;
  else
    t1avg := r1; t2avg := r2; cat := null; fcat := 'singles';
  end if;

  new.plupr_category := fcat;
  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  -- A correction: this match is already in the count; K reads the count before it.
  if v_was then p1_count := greatest(0, p1_count - 1); end if;

  if new.winner_team = 'team1' then
    s1 := coalesce(new.team1_score, 11); s2 := coalesce(new.team2_score, 7);
  else
    s1 := coalesce(new.team1_score, 7);  s2 := coalesce(new.team2_score, 11);
  end if;

  d1 := public._plupr_delta(p1_count,
          ((s1 - s2)::numeric - public._plupr_expected_diff(t1avg, t2avg)) / 10.0);

  v_r := v_r || jsonb_build_object(new.team1_player1::text,
           public._pl_tm_apply_one(v_league, new.team1_player1, d1, v_w, fcat));
  v_r := v_r || jsonb_build_object(new.team2_player1::text,
           public._pl_tm_apply_one(v_league, new.team2_player1, -d1, v_w, fcat));
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team1_player2::text,
               public._pl_tm_apply_one(v_league, new.team1_player2, d1, v_w, fcat));
    end if;
    if new.team2_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team2_player2::text,
               public._pl_tm_apply_one(v_league, new.team2_player2, -d1, v_w, fcat));
    end if;
  end if;

  -- League W-L by the match result (PKL-048). Each entry records it so a
  -- correction or delete takes back exactly what was added.
  if v_league is not null then
    perform public._pl_league_wl(v_league, new.team1_player1, new.winner_team = 'team1', 1);
    perform public._pl_league_wl(v_league, new.team2_player1, new.winner_team = 'team2', 1);
    v_r := jsonb_set(v_r, array[new.team1_player1::text, 'won'], to_jsonb(new.winner_team = 'team1'));
    v_r := jsonb_set(v_r, array[new.team2_player1::text, 'won'], to_jsonb(new.winner_team = 'team2'));
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then
        perform public._pl_league_wl(v_league, new.team1_player2, new.winner_team = 'team1', 1);
        v_r := jsonb_set(v_r, array[new.team1_player2::text, 'won'], to_jsonb(new.winner_team = 'team1'));
      end if;
      if new.team2_player2 is not null then
        perform public._pl_league_wl(v_league, new.team2_player2, new.winner_team = 'team2', 1);
        v_r := jsonb_set(v_r, array[new.team2_player2::text, 'won'], to_jsonb(new.winner_team = 'team2'));
      end if;
    end if;
  end if;

  new.plupr_delta := d1;
  new.plupr_league_id := v_league;
  new.plupr_global_weight := v_w;
  new.plupr_ratings := v_r;
  new.plupr_applied_at := now();
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public._pl_count_completed_tournament_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old_counts boolean := false;
  v_new_counts boolean := false;
  v_old_ids    uuid[];
  v_new_ids    uuid[];
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_counts := old.status = 'completed' and old.winner_team is not null and not (coalesce(old.is_dreambreaker, false) and old.db_order_team1 is not null)
                    and not (old.match_type = 'doubles'
                             and coalesce(public.classify_doubles_match(old.team1_player1, old.team1_player2,
                                                                        old.team2_player1, old.team2_player2), '') = 'unspecified');
    v_old_ids := array_remove(array[old.team1_player1, old.team2_player1,
                   case when old.match_type = 'doubles' then old.team1_player2 end,
                   case when old.match_type = 'doubles' then old.team2_player2 end], null);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_counts := new.status = 'completed' and new.winner_team is not null and not (coalesce(new.is_dreambreaker, false) and new.db_order_team1 is not null)
                    and not (new.match_type = 'doubles'
                             and coalesce(public.classify_doubles_match(new.team1_player1, new.team1_player2,
                                                                        new.team2_player1, new.team2_player2), '') = 'unspecified');
    v_new_ids := array_remove(array[new.team1_player1, new.team2_player1,
                   case when new.match_type = 'doubles' then new.team1_player2 end,
                   case when new.match_type = 'doubles' then new.team2_player2 end], null);
  end if;

  if v_old_counts and v_new_counts and v_old_ids = v_new_ids then
    return null;
  end if;
  if v_old_counts then perform public._pl_bump_match_count(v_old_ids, -1, null); end if;
  if v_new_counts then
    perform public._pl_bump_match_count(v_new_ids, 1, coalesce(new.scheduled_at, new.created_at));
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public._grant_tournament_match_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid;
  v_games   integer;
  v_bonus   integer;
  v_rows    integer;
  v_players uuid[];
  v_n       integer;
begin
  if (coalesce(new.is_dreambreaker, false) and new.db_order_team1 is not null) then return new; end if; -- PKL-086: no per-player match pay for a team Dreambreaker
  if new.status <> 'completed' or new.winner_team is null
     or new.team1_player1 is null or new.team2_player1 is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then return new; end if;

  v_games := least(greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1), 5);
  select array_agg(u order by u) into v_players
    from unnest(array[new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2]) as u
   where u is not null;

  foreach v_uid in array v_players loop
    begin
      -- The same curve as _grant_match_game_bonus: 40 for the day's first 3
      -- paid matches (league or tournament), then 35, 30, ... 5, then 0.
      v_n := public._pl_paid_matches_today(v_uid, new.id) + 1;
      v_bonus := case when v_n <= 3 then 40 else greatest(40 - 5 * (v_n - 3), 0) end;
      if public._pl_paid_group_matches(v_uid, v_players, coalesce(new.completed_at, now()), new.id) >= 3 then
        v_bonus := 0;
      end if;
      v_bonus := greatest(least(v_bonus, public._pl_play_cap_left(v_uid)), 0);

      insert into public.tournament_match_bonus_grants (match_id, user_id, games, paid)
      values (new.id, v_uid, v_games, v_bonus)
      on conflict (match_id, user_id) do nothing;
      get diagnostics v_rows = row_count;
      if v_rows > 0 and v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
      end if;
    exception when others then
      raise warning 'tournament match pay failed for % on %: %', v_uid, new.id, sqlerrm;
    end;
  end loop;
  return new;
end $function$;
