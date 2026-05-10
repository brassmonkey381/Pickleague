-- ============================================================
-- Convert ELO → PLUPR (Pickleague Universal Pickleball Rating) v1
--
-- Scale: 2.000 (floor) – 8.000+ (no cap), 3 decimal places.
-- Roughly DUPR-flavored:
--   * Expected outcome: 1 / (1 + 10^((opp − me) / 2.0))
--   * K factor decays with match count: <5 → 0.20, <15 → 0.12, else 0.06
--   * Score-margin factor: 0.6 + (winMargin / winScore) × 0.4
--     (close games count less, blowouts count more)
--   * Doubles uses team average for expected
--   * Per-period reset baseline: 3.250 with bonuses
--     +0.40 / +0.275 / +0.175 / +0.10 / +0.05 for ranks 1-5
--
-- Conversion baseline: 1000 ELO ≈ 3.25 PLUPR, 100 ELO ≈ 0.5 PLUPR.
--
-- This migration:
--   1. Changes all rating columns from integer to decimal(5,3)
--   2. Wipes every logged ELO value and history table
--   3. Replaces the ELO trigger + recompute fn with PLUPR equivalents
--   4. Replaces period/season RPCs with PLUPR-scale bonuses
--   5. Replays every completed match to populate new ratings
--
-- Run AFTER all prior migrations.
-- ============================================================

-- 1. Drop old trigger + functions before retyping columns ----------------
drop trigger  if exists on_match_completed                  on public.matches;
drop function if exists public.update_elo_ratings()                cascade;
drop function if exists public.recompute_doubles_ratings()         cascade;

-- 2. Retype columns ------------------------------------------------------
alter table public.profiles
  alter column rating               type decimal(6,3) using rating::decimal,
  alter column rating               set default 3.250,
  alter column singles_rating       type decimal(6,3) using singles_rating::decimal,
  alter column singles_rating       set default 3.250,
  alter column doubles_rating       type decimal(6,3) using doubles_rating::decimal,
  alter column doubles_rating       set default 3.250,
  alter column mixed_doubles_rating type decimal(6,3) using mixed_doubles_rating::decimal,
  alter column mixed_doubles_rating set default 3.250;

alter table public.matches
  alter column player1_rating_before type decimal(6,3) using player1_rating_before::decimal,
  alter column player1_rating_after  type decimal(6,3) using player1_rating_after::decimal,
  alter column player2_rating_before type decimal(6,3) using player2_rating_before::decimal,
  alter column player2_rating_after  type decimal(6,3) using player2_rating_after::decimal;

alter table public.season_snapshots
  alter column elo_at_snapshot type decimal(6,3) using elo_at_snapshot::decimal;

alter table public.season_final_standings
  alter column elo_bonus type decimal(6,3) using elo_bonus::decimal,
  alter column new_elo   type decimal(6,3) using new_elo::decimal;

alter table public.player_location_ratings
  alter column rating type decimal(6,3) using rating::decimal,
  alter column rating set default 3.250;

-- 3. Wipe all logged ELO data --------------------------------------------
truncate public.season_snapshots;
truncate public.season_final_standings;
truncate public.player_location_ratings;

update public.profiles
   set rating               = 3.250,
       singles_rating       = 3.250,
       doubles_rating       = 3.250,
       mixed_doubles_rating = 3.250;

update public.matches
   set player1_rating_before = null,
       player1_rating_after  = null,
       player2_rating_before = null,
       player2_rating_after  = null,
       doubles_category      = null;

-- 4. Update Top Rated badge for new scale --------------------------------
update public.badges
   set description = 'Reached an overall PLUPR of 4.0 or higher.',
       criteria    = '{"type":"plupr_threshold","min":4.0}'::jsonb
 where name = 'Top Rated';

-- 5. PLUPR rating trigger ------------------------------------------------
create or replace function public.update_plupr_ratings()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  PLUPR_DIV       constant decimal := 2.0;
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
  select rating into r1 from public.profiles where id = new.player1_id;
  select rating into r2 from public.profiles where id = new.player2_id;

  if new.match_type = 'doubles' then
    if new.partner1_id is not null then
      select rating into r_p1 from public.profiles where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      select rating into r_p2 from public.profiles where id = new.partner2_id;
    end if;
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

  -- Always snapshot before-rating
  new.player1_rating_before := r1;
  new.player2_rating_before := r2;

  -- Unspecified doubles: no rating impact
  if new.match_type = 'doubles' and cat = 'unspecified' then
    new.player1_rating_after := r1;
    new.player2_rating_after := r2;
    return new;
  end if;

  -- K factor decays with match count
  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.player1_id;
  if    p1_count <  5 then k_factor := 0.20;
  elsif p1_count < 15 then k_factor := 0.12;
  else                     k_factor := 0.06;
  end if;

  -- Margin factor — close games count less, blowouts more
  won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  if won1 then
    win_score  := coalesce(new.player1_score, 11);
    loss_score := coalesce(new.player2_score, 0);
  else
    win_score  := coalesce(new.player2_score, 11);
    loss_score := coalesce(new.player1_score, 0);
  end if;
  margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

  -- Expected outcome
  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));

  -- Delta from player1's perspective
  delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
  delta2 := -delta1;

  new.player1_rating_after := greatest(PLUPR_FLOOR, r1 + delta1);
  new.player2_rating_after := greatest(PLUPR_FLOOR, r2 + delta2);

  -- Apply to overall rating
  update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta1) where id = new.player1_id;
  update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta2) where id = new.player2_id;
  if new.match_type = 'doubles' then
    if new.partner1_id is not null then
      update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta1) where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta2) where id = new.partner2_id;
    end if;
  end if;

  -- Apply to split ratings
  if new.match_type = 'singles' then
    update public.profiles set singles_rating = greatest(PLUPR_FLOOR, singles_rating + delta1) where id = new.player1_id;
    update public.profiles set singles_rating = greatest(PLUPR_FLOOR, singles_rating + delta2) where id = new.player2_id;
  elsif cat = 'gendered' then
    update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta1) where id = new.player1_id;
    update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta2) where id = new.player2_id;
    if new.partner1_id is not null then
      update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta1) where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta2) where id = new.partner2_id;
    end if;
  elsif cat = 'mixed' then
    update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta1) where id = new.player1_id;
    update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta2) where id = new.player2_id;
    if new.partner1_id is not null then
      update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta1) where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta2) where id = new.partner2_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger on_match_completed
  before insert on public.matches
  for each row execute procedure public.update_plupr_ratings();

-- 6. Recompute every completed match in chronological order --------------
create or replace function public.recompute_all_plupr()
returns void language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  PLUPR_BASE      constant decimal := 3.250;
  PLUPR_DIV       constant decimal := 2.0;
  m               record;
  r1              decimal; r_p1 decimal;
  r2              decimal; r_p2 decimal;
  team1_avg       decimal; team2_avg decimal;
  expected1       decimal;
  k_factor        decimal;
  margin_factor   decimal;
  win_score       integer; loss_score integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
  -- per-user match counter for K factor (uses actual count up to that match)
begin
  -- Reset profiles
  update public.profiles
     set rating               = PLUPR_BASE,
         singles_rating       = PLUPR_BASE,
         doubles_rating       = PLUPR_BASE,
         mixed_doubles_rating = PLUPR_BASE;

  -- Wipe location ratings + match snapshots
  truncate public.player_location_ratings;
  update public.matches
     set player1_rating_before = null,
         player1_rating_after  = null,
         player2_rating_before = null,
         player2_rating_after  = null;

  -- Reclassify all doubles matches by current gender data
  update public.matches
     set doubles_category = public.classify_doubles_match(player1_id, partner1_id, player2_id, partner2_id)
   where match_type = 'doubles';

  -- Walk matches in chronological order
  for m in (
    select * from public.matches
     where status = 'completed'
     order by played_at asc, created_at asc
  ) loop
    select rating into r1 from public.profiles where id = m.player1_id;
    select rating into r2 from public.profiles where id = m.player2_id;
    r_p1 := PLUPR_BASE; r_p2 := PLUPR_BASE;

    if m.match_type = 'doubles' then
      if m.partner1_id is not null then
        select rating into r_p1 from public.profiles where id = m.partner1_id;
      end if;
      if m.partner2_id is not null then
        select rating into r_p2 from public.profiles where id = m.partner2_id;
      end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
    else
      team1_avg := r1;
      team2_avg := r2;
    end if;

    -- Always store before-rating snapshots
    update public.matches
       set player1_rating_before = r1, player2_rating_before = r2
     where id = m.id;

    -- Skip rating impact for unspecified doubles
    if m.match_type = 'doubles' and m.doubles_category = 'unspecified' then
      update public.matches
         set player1_rating_after = r1, player2_rating_after = r2
       where id = m.id;
      continue;
    end if;

    -- Match-count based K factor (count matches BEFORE this one)
    select count(*) into p1_count
      from public.matches mx
     where (mx.player1_id = m.player1_id or mx.partner1_id = m.player1_id
            or mx.player2_id = m.player1_id or mx.partner2_id = m.player1_id)
       and (mx.played_at, mx.created_at) < (m.played_at, m.created_at)
       and mx.status = 'completed';
    if    p1_count <  5 then k_factor := 0.20;
    elsif p1_count < 15 then k_factor := 0.12;
    else                     k_factor := 0.06;
    end if;

    won1 := (m.winner_team = 'team1') or (m.winner_id = m.player1_id);
    if won1 then
      win_score := coalesce(m.player1_score, 11); loss_score := coalesce(m.player2_score, 0);
    else
      win_score := coalesce(m.player2_score, 11); loss_score := coalesce(m.player1_score, 0);
    end if;
    margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
    delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
    delta2 := -delta1;

    -- Apply to overall rating
    update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta1) where id = m.player1_id;
    update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta2) where id = m.player2_id;
    if m.match_type = 'doubles' then
      if m.partner1_id is not null then
        update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta1) where id = m.partner1_id;
      end if;
      if m.partner2_id is not null then
        update public.profiles set rating = greatest(PLUPR_FLOOR, rating + delta2) where id = m.partner2_id;
      end if;
    end if;

    -- Split ratings
    if m.match_type = 'singles' then
      update public.profiles set singles_rating = greatest(PLUPR_FLOOR, singles_rating + delta1) where id = m.player1_id;
      update public.profiles set singles_rating = greatest(PLUPR_FLOOR, singles_rating + delta2) where id = m.player2_id;
    elsif m.doubles_category = 'gendered' then
      update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta1) where id in (m.player1_id, m.partner1_id);
      update public.profiles set doubles_rating = greatest(PLUPR_FLOOR, doubles_rating + delta2) where id in (m.player2_id, m.partner2_id);
    elsif m.doubles_category = 'mixed' then
      update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta1) where id in (m.player1_id, m.partner1_id);
      update public.profiles set mixed_doubles_rating = greatest(PLUPR_FLOOR, mixed_doubles_rating + delta2) where id in (m.player2_id, m.partner2_id);
    end if;

    -- Snapshot after-rating (re-read to capture floor clamps)
    select rating into r1 from public.profiles where id = m.player1_id;
    select rating into r2 from public.profiles where id = m.player2_id;
    update public.matches
       set player1_rating_after = r1, player2_rating_after = r2
     where id = m.id;
  end loop;
end;
$$;

-- 7. Replace lock_season_period with PLUPR-scaled bonuses ---------------
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
        p.rating,
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
      join public.profiles p on p.id = lm.user_id
      left join public.matches m
        on  m.league_id   = v_league_id
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, p.rating
    )
    select user_id, rating, wins, losses
      from player_stats
     order by wins desc, rating desc
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

    -- Period-end soft reset to PLUPR base + bonus
    v_bonus := case
      when v_rank = 1 then 0.400
      when v_rank = 2 then 0.275
      when v_rank = 3 then 0.175
      when v_rank = 4 then 0.100
      when v_rank = 5 then 0.050
      else 0.000
    end;
    v_new_rating := 3.250 + v_bonus;
    update public.profiles
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating
     where id = v_rec.user_id;
  end loop;

  update public.league_seasons
     set status = 'active'
   where id = p_season_id and status = 'upcoming';
end;
$$;

-- 8. Replace complete_season with PLUPR-scaled bonuses ------------------
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

    update public.profiles
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating
     where id = v_player.user_id;

    v_badge := case v_rank
      when 1 then 'Season Crown'
      when 2 then 'Season Silver'
      when 3 then 'Season Bronze'
      else null end;
    if v_badge is not null then
      perform public.award_league_badge(v_player.user_id, v_league_id, v_badge, v_season_name);
    end if;

    if exists (
      select 1 from public.season_snapshots
       where season_id = p_season_id and user_id = v_player.user_id
       group by user_id
      having count(*) filter (where rank_at_snapshot = 1) = v_period_count
         and count(*) = v_period_count
    ) then
      perform public.award_league_badge(v_player.user_id, v_league_id, 'Period Sweeper', v_season_name);
    end if;
  end loop;

  update public.league_seasons
     set status = 'completed', elo_reset_applied = true
   where id = p_season_id;
end;
$$;

-- 9. Run the recompute now ----------------------------------------------
select public.recompute_all_plupr();

-- 10. Grants ------------------------------------------------------------
grant execute on function public.recompute_all_plupr()                          to authenticated;
grant execute on function public.lock_season_period(uuid, integer, date)        to authenticated;
grant execute on function public.complete_season(uuid)                          to authenticated;
