-- ============================================================
-- Tournament auto-close + auto-payout (MLP _playoff variants)
--
-- When the finals series in an MLP playoff tournament is decided
-- (one team has more rotation wins than there are rotations left,
-- or all 4 rotations are completed), the tournament status flips
-- to 'completed' automatically. An admin then taps "Pay Out
-- Prizes" in the app, which calls auto_payout_mlp_tournament:
--   * Resolves WINNING TEAMS from the bracket (teams are the unit)
--     - 1st: finals winning team
--     - 2nd: finals losing team
--     - 3rd: semifinal losing teams (tied) — when 4+ teams
--   * Each TEAM receives its place's % of the pool (e.g. 1st = 60% of
--     pool). That team prize is then split equally among the team's
--     members — for a 4-player MLP team in 1st with structure [60,25,15]
--     and a 1000🥒 pool, each member receives floor(600 / 4) = 150🥒.
--   * Stamps champion badges on each winner's profile
--   * Adds a one-time PLUPR rating bonus (1st: +0.5, 2nd: +0.25, 3rd: +0.10)
--   * Drains prize_pool by the total distributed
--   * Idempotent: sets tournaments.champion_payout_applied_at
--
-- Run AFTER migration_mlp_auto_advance_playoff.sql.
-- ============================================================


-- 1. Schema --------------------------------------------------------------
alter table public.tournaments
  add column if not exists champion_payout_applied_at timestamptz;

create table if not exists public.tournament_champion_badges (
  id            uuid default gen_random_uuid() primary key,
  tournament_id uuid references public.tournaments(id) on delete cascade not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  team_id       uuid references public.mlp_teams(id) on delete set null,
  team_name     text,
  place         integer not null check (place >= 1),
  awarded_at    timestamptz default now(),
  unique (tournament_id, user_id)
);
alter table public.tournament_champion_badges enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_champion_badges' and policyname='Champion badges viewable by everyone') then
    create policy "Champion badges viewable by everyone" on public.tournament_champion_badges for select using (true);
  end if;
end $$;

create table if not exists public.tournament_plupr_bonuses (
  id            uuid default gen_random_uuid() primary key,
  tournament_id uuid references public.tournaments(id) on delete cascade not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  bonus_value   numeric(6,3) not null,
  place         integer not null,
  applied_at    timestamptz default now(),
  unique (tournament_id, user_id)
);
alter table public.tournament_plupr_bonuses enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_plupr_bonuses' and policyname='PLUPR bonuses viewable by everyone') then
    create policy "PLUPR bonuses viewable by everyone" on public.tournament_plupr_bonuses for select using (true);
  end if;
end $$;


-- 2. Helper: identify the two MLP teams in a playoff round ----------------
--    Returns (team_a_id, team_b_id, a_wins, b_wins, a_points, b_points,
--             total_completed, total_matches).
--    Matches the round's first sub-match's player IDs back to mlp_teams rows.
drop function if exists public._mlp_round_series_state(uuid);
create or replace function public._mlp_round_series_state(p_round_id uuid)
returns table (
  team_a_id uuid, team_b_id uuid,
  team_a_name text, team_b_name text,
  a_wins integer, b_wins integer,
  a_points integer, b_points integer,
  total_completed integer, total_matches integer
) language plpgsql stable as $$
declare
  v_t_id   uuid;
  v_first  record;
begin
  -- Get the tournament_id (needed to scope mlp_teams lookup)
  select tournament_id into v_t_id from public.tournament_rounds where id = p_round_id;

  select team1_player1, team1_player2, team2_player1, team2_player2
    into v_first
    from public.tournament_matches
   where round_id = p_round_id
   order by match_order asc
   limit 1;
  if v_first is null then return; end if;

  return query
  with team_a as (
    select id, name from public.mlp_teams
     where tournament_id = v_t_id
       and (male_1_id   in (v_first.team1_player1, v_first.team1_player2)
         or male_2_id   in (v_first.team1_player1, v_first.team1_player2)
         or female_1_id in (v_first.team1_player1, v_first.team1_player2)
         or female_2_id in (v_first.team1_player1, v_first.team1_player2))
     limit 1
  ),
  team_b as (
    select id, name from public.mlp_teams
     where tournament_id = v_t_id
       and (male_1_id   in (v_first.team2_player1, v_first.team2_player2)
         or male_2_id   in (v_first.team2_player1, v_first.team2_player2)
         or female_1_id in (v_first.team2_player1, v_first.team2_player2)
         or female_2_id in (v_first.team2_player1, v_first.team2_player2))
     limit 1
  ),
  agg as (
    select
      count(*) filter (where status = 'completed' and winner_team = 'team1')::int as a_wins,
      count(*) filter (where status = 'completed' and winner_team = 'team2')::int as b_wins,
      coalesce(sum(team1_score) filter (where status = 'completed'), 0)::int as a_points,
      coalesce(sum(team2_score) filter (where status = 'completed'), 0)::int as b_points,
      count(*) filter (where status = 'completed')::int as total_completed,
      count(*)::int as total_matches
    from public.tournament_matches
    where round_id = p_round_id
  )
  select
    (select id from team_a),
    (select id from team_b),
    (select name from team_a),
    (select name from team_b),
    agg.a_wins, agg.b_wins,
    agg.a_points, agg.b_points,
    agg.total_completed, agg.total_matches
  from agg;
end;
$$;


-- 3. Auto-close trigger --------------------------------------------------
--    When a 'finals' match completes and the series is decided, flip the
--    tournament status to 'completed'. Wrapped in EXCEPTION so a quirky
--    state can never block the score update itself.
create or replace function public._maybe_auto_close_mlp_tournament()
returns trigger language plpgsql security definer as $$
declare
  v_round_type   text;
  v_state        record;
  v_clinch       integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select round_type into v_round_type
    from public.tournament_rounds where id = new.round_id;
  if v_round_type <> 'finals' then return new; end if;

  begin
    select * into v_state from public._mlp_round_series_state(new.round_id);
    if v_state is null then return new; end if;

    -- Clinch threshold: > half the rotations (e.g. 3 of 4)
    v_clinch := v_state.total_matches / 2 + 1;

    if v_state.a_wins >= v_clinch
       or v_state.b_wins >= v_clinch
       or v_state.total_completed >= v_state.total_matches then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status <> 'completed';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$$;

drop trigger if exists trg_auto_close_mlp_tournament on public.tournament_matches;
create trigger trg_auto_close_mlp_tournament
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._maybe_auto_close_mlp_tournament();


-- 4. Preview RPC ---------------------------------------------------------
--    Returns the would-be payout. Pure read — used by the modal preview.
--    Shape: place | team_id | team_name | uids | share_per_user | plupr_bonus
create or replace function public.preview_mlp_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
) language plpgsql stable security definer as $$
declare
  v_pool       integer;
  v_structure  integer[];
  v_finals     record;
  v_winner     uuid;
  v_loser      uuid;
  v_winner_name text;
  v_loser_name  text;
  v_third      uuid[];
  v_third_names text[];
  v_a_rr_diff  integer;
  v_b_rr_diff  integer;
  v_a_seed     integer;
  v_b_seed     integer;
  v_a_better   boolean;   -- true when team A wins the tiebreaker cascade
begin
  select prize_pool, payout_structure into v_pool, v_structure
    from public.tournaments where id = p_tournament_id;
  if v_pool is null then v_pool := 0; end if;
  if v_structure is null then v_structure := '{60,25,15}'; end if;

  -- Find the finals round + state (rotation wins + points)
  select tr.id as round_id, s.*
    into v_finals
    from public.tournament_rounds tr
    join lateral public._mlp_round_series_state(tr.id) s on true
   where tr.tournament_id = p_tournament_id
     and tr.round_type = 'finals'
   order by tr.round_number desc
   limit 1;
  if v_finals.team_a_id is null then return; end if;

  -- Tiebreaker cascade for the finals series:
  --   1. More rotation wins
  --   2. Better finals point differential (a_points - b_points)
  --   3. Better pool/RR record (sub_matches_won - sub_matches_lost from
  --      mlp_team_standings — i.e. how each team performed before the finals)
  --   4. Higher seed (lower seed number)
  if v_finals.a_wins <> v_finals.b_wins then
    v_a_better := v_finals.a_wins > v_finals.b_wins;
  elsif (v_finals.a_points - v_finals.b_points) <> 0 then
    v_a_better := (v_finals.a_points - v_finals.b_points) > 0;
  else
    -- Pull RR record for each team. Alias the SRF so `team_id` isn't
    -- ambiguous with the function's OUT column of the same name.
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_a_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_a_id;
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_b_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_b_id;
    if coalesce(v_a_rr_diff, 0) <> coalesce(v_b_rr_diff, 0) then
      v_a_better := coalesce(v_a_rr_diff, 0) > coalesce(v_b_rr_diff, 0);
    else
      -- Final fallback: seed (lower seed number = higher seed)
      select t.seed into v_a_seed from public.mlp_teams t where t.id = v_finals.team_a_id;
      select t.seed into v_b_seed from public.mlp_teams t where t.id = v_finals.team_b_id;
      if coalesce(v_a_seed, 999) <> coalesce(v_b_seed, 999) then
        v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
      else
        v_a_better := true; -- truly identical; arbitrary
      end if;
    end if;
  end if;

  if v_a_better then
    v_winner := v_finals.team_a_id; v_winner_name := v_finals.team_a_name;
    v_loser  := v_finals.team_b_id; v_loser_name  := v_finals.team_b_name;
  else
    v_winner := v_finals.team_b_id; v_winner_name := v_finals.team_b_name;
    v_loser  := v_finals.team_a_id; v_loser_name  := v_finals.team_a_name;
  end if;

  -- 1st place — pool_share goes to the team; team prize is split equally among members
  return query
    select 1, v_winner, v_winner_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_winner),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_winner),
           floor(v_pool * v_structure[1] / 100.0)::int as pool_share,
           floor(floor(v_pool * v_structure[1] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_winner), 0), 1))::int as share_per_user,
           0.500::numeric(6,3);

  -- 2nd place
  if array_length(v_structure, 1) >= 2 then
    return query
    select 2, v_loser, v_loser_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_loser),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_loser),
           floor(v_pool * v_structure[2] / 100.0)::int,
           floor(floor(v_pool * v_structure[2] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_loser), 0), 1))::int,
           0.250::numeric(6,3);
  end if;

  -- 3rd place — semifinal losers. When multiple teams tie for 3rd, the
  -- place's % is split between the teams; within each team the team's
  -- share is then split equally among its members.
  if array_length(v_structure, 1) >= 3 then
    with semi_state as (
      select s.* from public.tournament_rounds tr
        join lateral public._mlp_round_series_state(tr.id) s on true
       where tr.tournament_id = p_tournament_id
         and tr.round_type = 'semifinals'
    ),
    -- Same tiebreaker cascade as finals: rotation wins → point differential.
    -- If still tied at this point, arbitrarily call team_a the winner so the
    -- loser slot is still populated for the 3rd-place payout.
    losers as (
      select
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_id else team_a_id end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_id else team_a_id end)
          else team_b_id
        end as team_id,
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_name else team_a_name end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_name else team_a_name end)
          else team_b_name
        end as team_name
        from semi_state
       where team_a_id is not null and team_b_id is not null
    )
    select array_agg(l.team_id), array_agg(l.team_name)
      into v_third, v_third_names
      from losers l;

    if v_third is not null and array_length(v_third, 1) > 0 then
      return query
      select 3, l.team_id, l.team_name,
             (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                from public.mlp_teams where id = l.team_id),
             (select array_agg(p.full_name order by p.full_name)
                from public.mlp_teams t
                join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
               where t.id = l.team_id),
             floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1))::int,
             floor(floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1)) /
                    coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                     from public.mlp_teams where id = l.team_id), 0), 1))::int,
             0.100::numeric(6,3)
        from (
          select unnest(v_third) as team_id, unnest(v_third_names) as team_name
        ) l;
    end if;
  end if;
end;
$$;


-- 5. Auto-payout RPC -----------------------------------------------------
create or replace function public.auto_payout_mlp_tournament(p_tournament_id uuid)
returns table (success boolean, total_distributed integer, recipients integer, message text)
language plpgsql security definer as $$
declare
  v_uid           uuid := auth.uid();
  v_already       timestamptz;
  v_status        text;
  v_total         integer := 0;
  v_recipients    integer := 0;
  v_row           record;
  v_uid_inner     uuid;
  v_full_name     text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may pay out prizes';
  end if;

  select status, champion_payout_applied_at into v_status, v_already
    from public.tournaments where id = p_tournament_id;
  if v_status <> 'completed' then
    return query select false, 0, 0, 'Tournament not yet completed.'::text; return;
  end if;
  if v_already is not null then
    return query select false, 0, 0, 'Payout already applied for this tournament.'::text; return;
  end if;

  for v_row in select * from public.preview_mlp_tournament_payout(p_tournament_id) loop
    if v_row.uids is null or array_length(v_row.uids, 1) = 0 then continue; end if;

    foreach v_uid_inner in array v_row.uids loop
      -- Pickle payout (per user)
      if v_row.share_per_user > 0 then
        update public.profiles set pickles = pickles + v_row.share_per_user where id = v_uid_inner;
        insert into public.pickle_pot_payouts
          (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
        values ('tournament', p_tournament_id, v_uid_inner, v_row.share_per_user,
                format('Tournament #%s · %s', v_row.place, v_row.team_name), v_uid, true);
        v_total := v_total + v_row.share_per_user;
      end if;

      -- Champion badge
      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner, v_row.team_id, v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      -- PLUPR bonus
      if v_row.plupr_bonus > 0 then
        insert into public.tournament_plupr_bonuses
          (tournament_id, user_id, bonus_value, place)
        values (p_tournament_id, v_uid_inner, v_row.plupr_bonus, v_row.place)
        on conflict (tournament_id, user_id) do nothing;

        update public.profiles
           set rating = coalesce(rating, 0) + v_row.plupr_bonus
         where id = v_uid_inner;
      end if;

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  -- Drain pool
  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players, awarded badges + PLUPR bonus.', v_total, v_recipients);
end;
$$;


-- 6. Grants --------------------------------------------------------------
grant execute on function public._mlp_round_series_state(uuid) to authenticated;
grant execute on function public.preview_mlp_tournament_payout(uuid) to authenticated;
grant execute on function public.auto_payout_mlp_tournament(uuid) to authenticated;

-- Tell PostgREST to reload the schema cache so the new RPCs are callable.
notify pgrst, 'reload schema';
