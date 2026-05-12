-- ============================================================
-- PLUPR weighted scoring per match context.
--
-- Old model:  one global rating (profiles.rating + facets).
--             Tournament matches didn't affect PLUPR at all.
--
-- New model:  a per-league PLUPR alongside the global one.
--             Different match contexts apply weights to each:
--
--               League match              → league 1.0,  global 0.5
--               Tournament (no league)    → global 1.0
--               Tournament inside league  → league 1.0,  global 0.0
--
--             Tournaments award top-5 bonuses on completion:
--               +0.20 / +0.13 / +0.08 / +0.05 / +0.025
--             — applied to whichever PLUPR the tournament feeds.
-- ============================================================


-- 1. Per-league PLUPR table ----------------------------------------------
create table if not exists public.league_player_ratings (
  league_id            uuid references public.leagues(id)  on delete cascade not null,
  user_id              uuid references public.profiles(id) on delete cascade not null,
  rating               decimal(6,3) not null default 3.250,
  singles_rating       decimal(6,3) not null default 3.250,
  doubles_rating       decimal(6,3) not null default 3.250,
  mixed_doubles_rating decimal(6,3) not null default 3.250,
  wins                 integer not null default 0,
  losses               integer not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (league_id, user_id)
);

alter table public.league_player_ratings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='league_player_ratings' and policyname='Ratings viewable by everyone') then
    create policy "Ratings viewable by everyone" on public.league_player_ratings
      for select using (true);
  end if;
end $$;
-- No insert/update policy: only SECURITY DEFINER triggers/RPCs modify this table.


-- 2. Seed a row when someone joins a league ------------------------------
create or replace function public._seed_league_player_rating()
returns trigger language plpgsql security definer as $$
begin
  insert into public.league_player_ratings (league_id, user_id)
  values (new.league_id, new.user_id)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_league_member_seed_rating on public.league_members;
create trigger on_league_member_seed_rating
  after insert on public.league_members
  for each row execute procedure public._seed_league_player_rating();

-- Backfill existing memberships
insert into public.league_player_ratings (league_id, user_id)
select league_id, user_id from public.league_members
on conflict do nothing;


-- 3. Track when tournament finish bonuses were applied -------------------
alter table public.tournaments
  add column if not exists bonuses_applied_at timestamptz;


-- 4. Internal helper: apply a per-player delta to a target rating bucket.
--    Splits delta into overall + the right facet column.
-- ----------------------------------------------------------------------
create or replace function public._apply_plupr_delta_to_league(
  p_league_id uuid,
  p_user_id   uuid,
  p_delta     decimal,
  p_cat       text          -- 'singles' | 'gendered' | 'mixed' | null (no facet)
) returns void language plpgsql security definer as $$
declare
  PLUPR_FLOOR constant decimal := 2.000;
begin
  if p_league_id is null or p_user_id is null then return; end if;
  -- Ensure the row exists (handles users who play before formal membership)
  insert into public.league_player_ratings (league_id, user_id)
    values (p_league_id, p_user_id) on conflict do nothing;

  update public.league_player_ratings
     set rating = greatest(PLUPR_FLOOR, rating + p_delta),
         singles_rating       = case when p_cat = 'singles'  then greatest(PLUPR_FLOOR, singles_rating       + p_delta) else singles_rating       end,
         doubles_rating       = case when p_cat = 'gendered' then greatest(PLUPR_FLOOR, doubles_rating       + p_delta) else doubles_rating       end,
         mixed_doubles_rating = case when p_cat = 'mixed'    then greatest(PLUPR_FLOOR, mixed_doubles_rating + p_delta) else mixed_doubles_rating end,
         wins   = wins   + case when p_delta > 0 then 1 else 0 end,
         losses = losses + case when p_delta < 0 then 1 else 0 end,
         updated_at = now()
   where league_id = p_league_id and user_id = p_user_id;
end;
$$;

create or replace function public._apply_plupr_delta_to_global(
  p_user_id uuid,
  p_delta   decimal,
  p_cat     text
) returns void language plpgsql security definer as $$
declare
  PLUPR_FLOOR constant decimal := 2.000;
begin
  if p_user_id is null then return; end if;
  update public.profiles
     set rating = greatest(PLUPR_FLOOR, rating + p_delta),
         singles_rating       = case when p_cat = 'singles'  then greatest(PLUPR_FLOOR, singles_rating       + p_delta) else singles_rating       end,
         doubles_rating       = case when p_cat = 'gendered' then greatest(PLUPR_FLOOR, doubles_rating       + p_delta) else doubles_rating       end,
         mixed_doubles_rating = case when p_cat = 'mixed'    then greatest(PLUPR_FLOOR, mixed_doubles_rating + p_delta) else mixed_doubles_rating end
   where id = p_user_id;
end;
$$;


-- 5. Replace update_plupr_ratings trigger on `matches`.
--    League matches: league 1.0x, global 0.5x.
--    `matches.league_id` is NOT NULL by schema, so every match has a league.
-- ----------------------------------------------------------------------
create or replace function public.update_plupr_ratings()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  PLUPR_DIV       constant decimal := 2.0;
  GLOBAL_WEIGHT   constant decimal := 0.5;  -- league matches dilute global
  r1              decimal; r_p1 decimal := 3.250;
  r2              decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected1       decimal;
  k_factor        decimal;
  margin_factor   decimal;
  win_score       integer; loss_score integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  -- Read CURRENT global ratings (used for matchup math + snapshot)
  select rating into r1 from public.profiles where id = new.player1_id;
  select rating into r2 from public.profiles where id = new.player2_id;

  if new.match_type = 'doubles' then
    if new.partner1_id is not null then select rating into r_p1 from public.profiles where id = new.partner1_id; end if;
    if new.partner2_id is not null then select rating into r_p2 from public.profiles where id = new.partner2_id; end if;
    team1_avg := (r1 + r_p1) / 2.0;
    team2_avg := (r2 + r_p2) / 2.0;
    cat := public.classify_doubles_match(new.player1_id, new.partner1_id, new.player2_id, new.partner2_id);
    new.doubles_category := cat;
  else
    team1_avg := r1;
    team2_avg := r2;
    new.doubles_category := null;
    cat := null;
  end if;

  new.player1_rating_before := r1;
  new.player2_rating_before := r2;

  -- Unspecified doubles: no rating impact
  if new.match_type = 'doubles' and cat = 'unspecified' then
    new.player1_rating_after := r1;
    new.player2_rating_after := r2;
    return new;
  end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.player1_id;
  if    p1_count <  5 then k_factor := 0.20;
  elsif p1_count < 15 then k_factor := 0.12;
  else                     k_factor := 0.06;
  end if;

  won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  if won1 then win_score := coalesce(new.player1_score, 11); loss_score := coalesce(new.player2_score, 0);
  else         win_score := coalesce(new.player2_score, 11); loss_score := coalesce(new.player1_score, 0);
  end if;
  margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
  delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
  delta2 := -delta1;

  -- Snapshot the GLOBAL post-rating (matches.player1_rating_after column).
  -- Global takes a fractional weight, so the snapshot reflects the actual
  -- amount the player's overall rating moved.
  new.player1_rating_after := greatest(PLUPR_FLOOR, r1 + delta1 * GLOBAL_WEIGHT);
  new.player2_rating_after := greatest(PLUPR_FLOOR, r2 + delta2 * GLOBAL_WEIGHT);

  -- Apply league PLUPR (full weight) to all four player slots
  perform public._apply_plupr_delta_to_league(new.league_id, new.player1_id, delta1, case when new.match_type='singles' then 'singles' else cat end);
  perform public._apply_plupr_delta_to_league(new.league_id, new.player2_id, delta2, case when new.match_type='singles' then 'singles' else cat end);
  if new.match_type = 'doubles' then
    if new.partner1_id is not null then perform public._apply_plupr_delta_to_league(new.league_id, new.partner1_id, delta1, cat); end if;
    if new.partner2_id is not null then perform public._apply_plupr_delta_to_league(new.league_id, new.partner2_id, delta2, cat); end if;
  end if;

  -- Apply global PLUPR at 0.5x weight (league matches dilute global)
  perform public._apply_plupr_delta_to_global(new.player1_id, delta1 * GLOBAL_WEIGHT, case when new.match_type='singles' then 'singles' else cat end);
  perform public._apply_plupr_delta_to_global(new.player2_id, delta2 * GLOBAL_WEIGHT, case when new.match_type='singles' then 'singles' else cat end);
  if new.match_type = 'doubles' then
    if new.partner1_id is not null then perform public._apply_plupr_delta_to_global(new.partner1_id, delta1 * GLOBAL_WEIGHT, cat); end if;
    if new.partner2_id is not null then perform public._apply_plupr_delta_to_global(new.partner2_id, delta2 * GLOBAL_WEIGHT, cat); end if;
  end if;

  return new;
end;
$$;

-- Trigger is already attached to `matches` from migration_convert_to_plupr.sql.


-- 6. New trigger on tournament_matches: fires when status flips to completed.
--    Standalone tournament   → global 1.0x.
--    League-scoped tournament → league 1.0x, global 0.0x.
-- ----------------------------------------------------------------------
create or replace function public.update_plupr_for_tournament_match()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  PLUPR_DIV       constant decimal := 2.0;
  v_league_id     uuid;
  r1 decimal; r_p1 decimal := 3.250;
  r2 decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected1       decimal;
  k_factor        decimal := 0.06;
  margin_factor   decimal;
  win_score       integer; loss_score integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  -- Only act when status transitions to completed with a recorded winner.
  if not (
    (TG_OP = 'UPDATE' and old.status <> 'completed' and new.status = 'completed')
    or (TG_OP = 'INSERT' and new.status = 'completed')
  ) then
    return new;
  end if;
  if new.winner_team is null or new.team1_player1 is null or new.team2_player1 is null then
    return new;
  end if;

  select league_id into v_league_id from public.tournaments where id = new.tournament_id;

  -- Read current GLOBAL ratings to compute expected outcome
  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    team1_avg := (r1 + r_p1) / 2.0;
    team2_avg := (r2 + r_p2) / 2.0;
    cat := public.classify_doubles_match(new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2);
  else
    team1_avg := r1; team2_avg := r2; cat := null;
  end if;

  -- Skip unspecified doubles (gender not set for one+ players)
  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  if    p1_count <  5 then k_factor := 0.20;
  elsif p1_count < 15 then k_factor := 0.12;
  else                     k_factor := 0.06;
  end if;

  won1 := new.winner_team = 'team1';
  if won1 then win_score := coalesce(new.team1_score, 11); loss_score := coalesce(new.team2_score, 0);
  else         win_score := coalesce(new.team2_score, 11); loss_score := coalesce(new.team1_score, 0);
  end if;
  margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
  delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
  delta2 := -delta1;

  if v_league_id is not null then
    -- League-scoped tournament: full delta to league PLUPR, 0 to global.
    perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player2, delta2, cat); end if;
    end if;
  else
    -- Standalone tournament: full delta to global PLUPR.
    perform public._apply_plupr_delta_to_global(new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_global(new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_global(new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_global(new.team2_player2, delta2, cat); end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_tournament_match_completed on public.tournament_matches;
create trigger on_tournament_match_completed
  after insert or update on public.tournament_matches
  for each row execute procedure public.update_plupr_for_tournament_match();


-- 7. apply_tournament_finishes — admin awards top-5 bonuses on tournament end.
--    Bonuses go to the league PLUPR if the tournament is league-scoped,
--    otherwise to the global PLUPR.  Idempotent via bonuses_applied_at.
-- ----------------------------------------------------------------------
create or replace function public.apply_tournament_finishes(
  p_tournament_id uuid,
  p_top5          uuid[]   -- length 1..5, ordered by finish: 1st, 2nd, 3rd, 4th, 5th
) returns void language plpgsql security definer as $$
declare
  BONUSES constant decimal[] := array[0.200, 0.130, 0.080, 0.050, 0.025];
  v_league_id  uuid;
  v_status     text;
  v_uid        uuid := auth.uid();
  v_is_admin   boolean;
  i            integer;
  v_user_id    uuid;
  v_bonus      decimal;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select league_id, status into v_league_id, v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then raise exception 'Tournament not found'; end if;
  if v_status <> 'completed' then raise exception 'Tournament must be completed first'; end if;

  -- Authorization: tournament admin/co-admin, creator, or league admin.
  select exists (
    select 1 from public.tournaments t
     where t.id = p_tournament_id
       and (
         t.created_by = v_uid
         or exists (
           select 1 from public.tournament_registrations tr
            where tr.tournament_id = t.id and tr.user_id = v_uid
              and tr.role in ('admin','co-admin') and tr.status = 'approved'
         )
         or (t.league_id is not null and exists (
           select 1 from public.league_members
            where league_id = t.league_id and user_id = v_uid and role in ('admin','co-admin')
         ))
       )
  ) into v_is_admin;
  if not v_is_admin then raise exception 'Only tournament admins can apply finishes'; end if;

  if exists (select 1 from public.tournaments where id = p_tournament_id and bonuses_applied_at is not null) then
    raise exception 'Bonuses have already been applied for this tournament';
  end if;

  if p_top5 is null or array_length(p_top5, 1) is null then
    raise exception 'Provide 1-5 finishers';
  end if;

  for i in 1..least(array_length(p_top5, 1), 5) loop
    v_user_id := p_top5[i];
    v_bonus   := BONUSES[i];
    if v_user_id is null then continue; end if;

    if v_league_id is not null then
      perform public._apply_plupr_delta_to_league(v_league_id, v_user_id, v_bonus, null);
    else
      perform public._apply_plupr_delta_to_global(v_user_id, v_bonus, null);
    end if;
  end loop;

  update public.tournaments set bonuses_applied_at = now() where id = p_tournament_id;
end;
$$;

grant execute on function public.apply_tournament_finishes(uuid, uuid[]) to authenticated;


-- 8. Rewrite recompute_all_plupr to walk BOTH matches and tournament_matches.
-- ----------------------------------------------------------------------
create or replace function public.recompute_all_plupr()
returns void language plpgsql security definer as $$
declare
  PLUPR_BASE  constant decimal := 3.250;
  PLUPR_DIV   constant decimal := 2.0;
  GLOBAL_WT   constant decimal := 0.5;
  rec         record;
  r1 decimal; r_p1 decimal; r2 decimal; r_p2 decimal;
  team1_avg   decimal; team2_avg decimal;
  expected1   decimal;
  k_factor    decimal;
  margin      decimal;
  win_score   integer; loss_score integer;
  delta1      decimal; delta2 decimal;
  won1        boolean;
  cat         text;
  match_idx   integer := 0;
  p1_played   integer;
begin
  -- Reset everything to base
  update public.profiles
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         total_matches_played = 0;
  update public.league_player_ratings
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         wins = 0, losses = 0;

  -- Walk all completed matches (league + tournament) interleaved by time.
  for rec in (
    with combined as (
      select
        'league_match'::text  as src,
        m.played_at           as ts,
        m.created_at          as ord,
        m.league_id           as league_id,
        m.match_type, m.doubles_category,
        m.player1_id  as t1p1, m.partner1_id as t1p2,
        m.player2_id  as t2p1, m.partner2_id as t2p2,
        m.winner_team, m.player1_score as s1, m.player2_score as s2,
        m.winner_id
      from public.matches m
      where coalesce(m.status, 'completed') = 'completed'
      union all
      select
        'tourn_match'::text                            as src,
        coalesce(tm.scheduled_at, tm.created_at)       as ts,
        tm.created_at                                  as ord,
        t.league_id                                    as league_id,
        tm.match_type,
        public.classify_doubles_match(tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2),
        tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2,
        tm.winner_team, tm.team1_score, tm.team2_score,
        null::uuid
      from public.tournament_matches tm
      join public.tournaments t on t.id = tm.tournament_id
      where tm.status = 'completed' and tm.winner_team is not null
    )
    select * from combined
    order by ts asc nulls last, ord asc
  ) loop
    match_idx := match_idx + 1;

    -- Skip unspecified doubles
    if rec.match_type = 'doubles' and rec.doubles_category = 'unspecified' then
      continue;
    end if;

    -- Read ratings (use GLOBAL for matchup math, consistent with the live trigger)
    select rating into r1 from public.profiles where id = rec.t1p1;
    select rating into r2 from public.profiles where id = rec.t2p1;
    r_p1 := 3.250; r_p2 := 3.250;
    if rec.match_type = 'doubles' then
      if rec.t1p2 is not null then select rating into r_p1 from public.profiles where id = rec.t1p2; end if;
      if rec.t2p2 is not null then select rating into r_p2 from public.profiles where id = rec.t2p2; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := rec.doubles_category;
    else
      team1_avg := r1; team2_avg := r2; cat := null;
    end if;

    select coalesce(total_matches_played, 0) into p1_played from public.profiles where id = rec.t1p1;
    if    p1_played <  5 then k_factor := 0.20;
    elsif p1_played < 15 then k_factor := 0.12;
    else                      k_factor := 0.06;
    end if;

    won1 := (rec.winner_team = 'team1') or (rec.winner_id = rec.t1p1);
    if won1 then win_score := coalesce(rec.s1, 11); loss_score := coalesce(rec.s2, 0);
    else         win_score := coalesce(rec.s2, 11); loss_score := coalesce(rec.s1, 0);
    end if;
    margin := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;
    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
    delta1 := round((k_factor * margin * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
    delta2 := -delta1;

    if rec.src = 'league_match' then
      -- league 1.0, global 0.5
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
      end if;
      perform public._apply_plupr_delta_to_global(rec.t1p1, delta1 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_global(rec.t2p1, delta2 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1 * GLOBAL_WT, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2 * GLOBAL_WT, cat); end if;
      end if;
    else  -- tourn_match
      if rec.league_id is not null then
        -- league 1.0, global 0.0
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
        end if;
      else
        -- standalone tournament: global 1.0
        perform public._apply_plupr_delta_to_global(rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_global(rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2, cat); end if;
        end if;
      end if;
    end if;

    -- Increment match counts on profiles for K-factor decay on future matches
    update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
     where id in (rec.t1p1, rec.t2p1);
    if rec.match_type='doubles' then
      update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
       where id in (rec.t1p2, rec.t2p2) and id is not null;
    end if;
  end loop;

  raise notice 'recompute_all_plupr: processed % matches', match_idx;
end;
$$;

grant execute on function public.recompute_all_plupr() to authenticated;


-- 9. Repoint lock_season_period at the LEAGUE PLUPR.
--    Under the weighted model, the league-internal season should rank and
--    soft-reset the league rating, not the global one.  The function is
--    otherwise identical to migration_standings_sort_by_plupr.sql.
-- ----------------------------------------------------------------------
create or replace function public.lock_season_period(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        decimal;
  v_new_rating   decimal;
begin
  select league_id, name, start_date
    into v_league_id, v_season_name, v_season_start
    from public.league_seasons
   where id = p_season_id;

  if v_league_id is null then raise exception 'Season not found'; end if;

  if not exists (
    select 1 from public.league_members
    where league_id = v_league_id and user_id = auth.uid()
      and role in ('admin','co-admin')
  ) then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        coalesce(lpr.rating, 3.250) as rating,
        coalesce(sum(case
          when (m.player1_id  = lm.user_id and m.winner_team = 'team1') or
               (m.partner1_id = lm.user_id and m.winner_team = 'team1') or
               (m.player2_id  = lm.user_id and m.winner_team = 'team2') or
               (m.partner2_id = lm.user_id and m.winner_team = 'team2')
          then 1 else 0 end), 0) as wins,
        coalesce(sum(case
          when (m.player1_id  = lm.user_id and m.winner_team = 'team2') or
               (m.partner1_id = lm.user_id and m.winner_team = 'team2') or
               (m.player2_id  = lm.user_id and m.winner_team = 'team1') or
               (m.partner2_id = lm.user_id and m.winner_team = 'team1')
          then 1 else 0 end), 0) as losses
      from public.league_members lm
      left join public.league_player_ratings lpr
        on  lpr.league_id = v_league_id
        and lpr.user_id   = lm.user_id
      left join public.matches m
        on  m.league_id   = v_league_id
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, lpr.rating
    )
    select user_id, rating, wins, losses
      from player_stats
     order by rating desc nulls last,
              (wins - losses) desc,
              wins desc
  ) loop
    v_rank := v_rank + 1;
    insert into public.season_snapshots (
      season_id, league_id, period_number, snapshot_date,
      user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season, losses_in_season
    ) values (
      p_season_id, v_league_id, p_period_number, p_snapshot_date,
      v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
    );

    if v_rank = 1 then
      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    -- Period-end soft reset to LEAGUE PLUPR base + bonus (no longer touches
    -- profiles.rating — global PLUPR is independent of league season cycles).
    v_bonus := case
      when v_rank = 1 then 0.400
      when v_rank = 2 then 0.275
      when v_rank = 3 then 0.175
      when v_rank = 4 then 0.100
      when v_rank = 5 then 0.050
      else 0.000
    end;
    v_new_rating := 3.250 + v_bonus;
    update public.league_player_ratings
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_rec.user_id;
  end loop;

  update public.league_seasons
     set status = 'active'
   where id = p_season_id and status = 'upcoming';
end;
$$;

grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;


-- 10. Repoint complete_season at the LEAGUE PLUPR too. Season-end bonuses
--     are a league-internal achievement and should not yank the global rating.
-- ----------------------------------------------------------------------
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        decimal;
  v_new_rating   decimal;
  v_badge        text;
begin
  select league_id, name into v_league_id, v_season_name
    from public.league_seasons where id = p_season_id;

  if v_league_id is null then raise exception 'Season not found'; end if;

  if not exists (
    select 1 from public.league_members
    where league_id = v_league_id and user_id = auth.uid()
      and role in ('admin','co-admin')
  ) then raise exception 'Only admins and co-admins can complete a season'; end if;

  if (select elo_reset_applied from public.league_seasons where id = p_season_id) then
    raise exception 'Reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one period before completing the season';
  end if;

  select count(distinct period_number) into v_period_count
    from public.season_snapshots where season_id = p_season_id;

  for v_player in (
    with medians as (
      select user_id, percentile_cont(0.5) within group (order by rank_at_snapshot) as median_rank
        from public.season_snapshots
       where season_id = p_season_id
       group by user_id
    )
    select user_id, median_rank from medians order by median_rank asc
  ) loop
    v_rank := v_rank + 1;
    v_bonus := case
      when v_rank = 1 then 0.400
      when v_rank = 2 then 0.275
      when v_rank = 3 then 0.175
      when v_rank = 4 then 0.100
      when v_rank = 5 then 0.050
      else 0.000
    end;
    v_new_rating := 3.250 + v_bonus;

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_rating
    ) on conflict (season_id, user_id) do update
      set final_rank  = excluded.final_rank,
          median_rank = excluded.median_rank,
          elo_bonus   = excluded.elo_bonus,
          new_elo     = excluded.new_elo;

    -- Reset LEAGUE PLUPR to base + bonus (not the global rating).
    update public.league_player_ratings
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_player.user_id;

    v_badge := case v_rank
      when 1 then 'Season Crown'
      when 2 then 'Season Silver'
      when 3 then 'Season Bronze'
      else null end;
    if v_badge is not null then
      perform public.award_league_badge(v_player.user_id, v_league_id, v_badge, v_season_name);
    end if;
  end loop;

  update public.league_seasons
     set status = 'completed', elo_reset_applied = true
   where id = p_season_id;
end;
$$;

grant execute on function public.complete_season(uuid) to authenticated;
