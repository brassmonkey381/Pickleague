-- ============================================================
-- Fix: generate_mlp_bracket inserts into tournament_rounds without a
-- round_type, which is NOT NULL. Repoint to 'winners' (each team-vs-team
-- pairing is its own round on the winners bracket of the round-robin).
-- ============================================================

create or replace function public.generate_mlp_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_round_id uuid;
  v_team_count integer;
  v_matches_created integer := 0;
  v_team_a record;
  v_team_b record;
  v_round_no integer;
  v_match_order integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate the bracket';
  end if;

  select count(*) into v_team_count
    from public.mlp_teams
   where tournament_id = p_tournament_id and status = 'locked';

  if v_team_count < 2 then
    raise exception 'Need at least 2 locked teams (got %)', v_team_count;
  end if;

  -- Wipe any prior MLP-generated matches/rounds for this tournament.
  delete from public.tournament_matches where tournament_id = p_tournament_id;
  delete from public.tournament_rounds   where tournament_id = p_tournament_id;

  -- Assign seeds to teams (in-order for now).
  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
  )
  update public.mlp_teams t
     set seed = s.rn
    from seeded s
   where t.id = s.id;

  v_round_no := 0;
  for v_team_a in (
    select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
     order by seed
  ) loop
    for v_team_b in (
      select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
        from public.mlp_teams
       where tournament_id = p_tournament_id and status = 'locked'
         and seed > v_team_a.seed
       order by seed
    ) loop
      v_round_no := v_round_no + 1;

      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (
        p_tournament_id,
        v_round_no,
        format('%s vs %s', v_team_a.name, v_team_b.name),
        'winners'
      )
      returning id into v_round_id;

      -- 1. Men's doubles
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_1_id, v_team_a.male_2_id, v_team_b.male_1_id, v_team_b.male_2_id
      );
      v_matches_created := v_matches_created + 1;

      -- 2. Women's doubles
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.female_1_id, v_team_a.female_2_id, v_team_b.female_1_id, v_team_b.female_2_id
      );
      v_matches_created := v_matches_created + 1;

      -- 3. Mixed 1 (male_1 + female_1 vs male_1 + female_1)
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_1_id, v_team_a.female_1_id, v_team_b.male_1_id, v_team_b.female_1_id
      );
      v_matches_created := v_matches_created + 1;

      -- 4. Mixed 2 (male_2 + female_2 vs male_2 + female_2)
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_2_id, v_team_a.female_2_id, v_team_b.male_2_id, v_team_b.female_2_id
      );
      v_matches_created := v_matches_created + 1;
    end loop;
  end loop;

  -- Flip tournament status so the schedule UI renders.
  update public.tournaments set status = 'active'
   where id = p_tournament_id and status = 'registration';

  return v_matches_created;
end;
$$;

grant execute on function public.generate_mlp_bracket(uuid) to authenticated;
