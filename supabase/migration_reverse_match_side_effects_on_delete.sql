-- ============================================================
-- Reverse downstream side-effects when a COMPLETED match is DELETED.
--
-- Why: matches can be deleted by admins correcting history, or by
-- expire_pending_matches getting extended in the future to nuke
-- already-completed-but-disputed rows. Today the side-effects
-- (rating deltas, badges, pickle reward grants, streak rows)
-- stay applied to player profiles, leaving balances/badges
-- stranded with no auditable origin.
--
-- Scope (pragmatic — DELETE only, not UPDATE corrections):
--
--   1. Ratings: subtract the stored player[N]_rating_after -
--      player[N]_rating_before delta from each player's overall +
--      facet (singles_rating / doubles_rating / mixed_doubles_rating)
--      rating. Both teammates on a doubles team got the same delta,
--      so each gets the same reversal.
--
--   2. Badges: a new player_badges.source_match_id column lets us
--      attribute match-driven badges back to the match. Each match
--      badge-award function is recreated to populate it. On delete
--      we wipe every player_badges row pointing at the deleted
--      match — and refund the +50 pickles that _grant_pickles_on_badge
--      gave for each one (50 × count_deleted per user).
--
--   3. Pickle reward grants:
--      - first_match_bonus_grants: if user has zero remaining matches
--        AFTER delete, drop the grant + refund 200 pickles.
--      - first_doubles_bonus_grants: same idea for doubles matches
--        + refund 150.
--      - court_bonus_grants: per (user, deleted.location_name) if the
--        user has no other match at that location, drop the grant
--        + refund 100.
--      - daily_play_streaks: if user has no other match on the played
--        day, delete the streak row, refund bonus_granted, AND ALSO
--        delete all later streak rows for that user. CAVEAT below.
--
-- CAVEAT — daily-streak chain breakage:
--   daily_play_streaks rows are chained — each row's streak_length
--   depends on the previous day's row. If a mid-chain day's row is
--   removed we cannot cheaply re-derive the downstream lengths
--   without replaying every later match. The pragmatic compromise:
--   when an earlier streak row is deleted, ALL later streak rows
--   for that user are also deleted. The pickles previously awarded
--   stay (they were earned), only the streak-length history is
--   wiped. Realistically this is an admin operation with audit
--   review; future plays will start a fresh chain from day 1.
--
-- All rollback steps run inside per-step EXCEPTION blocks so a
-- single failure can't block the underlying match deletion.
--
-- Run AFTER:
--   migration_shop_rewards_and_progress_badges.sql
--   migration_gate_match_triggers_on_completed.sql
-- ============================================================


-- 1. SCHEMA: source_match_id on player_badges ----------------------------
alter table public.player_badges
  add column if not exists source_match_id uuid
    references public.matches(id) on delete set null;

create index if not exists idx_player_badges_source_match_id
  on public.player_badges(source_match_id);


-- 2. RECREATE MATCH-DRIVEN BADGE FUNCTIONS to set source_match_id --------
-- All bodies are copied from migration_gate_match_triggers_on_completed.sql,
-- with each insert into public.player_badges (...) extended to also
-- set source_match_id = new.id, and each award_profile_badge() call
-- replaced with an explicit insert so we can stamp source_match_id.
-- Trigger bindings re-issued to preserve AFTER INSERT OR UPDATE OF status.

-- 2a. _award_match_badges (Perfect Game + Century) -----------------------
create or replace function public._award_match_badges()
returns trigger language plpgsql security definer as $$
declare
  v_pg_id    uuid;
  v_cn_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_count    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_pg_id from public.badges where name = 'Perfect Game';
  select id into v_cn_id from public.badges where name = 'Century';

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_pg_id is not null and v_winners is not null then
    if (new.winner_team = 'team1' and new.player1_score = 11 and new.player2_score = 0)
       or (new.winner_team = 'team2' and new.player2_score = 11 and new.player1_score = 0) then
      foreach v_uid in array v_winners loop
        insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
        values (v_uid, v_pg_id, null, format('11-0 shutout on %s', v_played), new.id);
      end loop;
    end if;
  end if;

  if v_cn_id is not null then
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(*) into v_count
        from public.matches m
       where m.player1_id  = v_uid or m.partner1_id = v_uid
          or m.player2_id  = v_uid or m.partner2_id = v_uid;
      if v_count > 0 and v_count % 100 = 0 then
        insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
        values (v_uid, v_cn_id, null, format('Hit %s career matches', v_count), new.id);
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_award_match_badges on public.matches;
create trigger trg_award_match_badges
  after insert or update of status on public.matches
  for each row execute procedure public._award_match_badges();


-- 2b. _award_underdog_badge ----------------------------------------------
create or replace function public._award_underdog_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id      uuid;
  v_winner_rating decimal;
  v_loser_rating  decimal;
  v_diff          decimal;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
  v_ctx           text;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    select id into v_badge_id from public.badges where name = 'Underdog';
    if v_badge_id is null then return new; end if;

    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 100 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_ctx := format('Beat a +%s opponent on %s', v_diff, v_played);
        if not exists (
          select 1 from public.player_badges
           where user_id = v_uid and badge_id = v_badge_id and context = v_ctx
        ) then
          insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
          values (v_uid, v_badge_id, null, v_ctx, new.id);
        end if;
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

drop trigger if exists trg_award_underdog_badge on public.matches;
create trigger trg_award_underdog_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_underdog_badge();


-- 2c. _award_cinderella_badge --------------------------------------------
create or replace function public._award_cinderella_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id      uuid;
  v_winner_rating decimal;
  v_loser_rating  decimal;
  v_diff          decimal;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
  v_ctx           text;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    select id into v_badge_id from public.badges where name = 'Cinderella';
    if v_badge_id is null then return new; end if;

    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 200 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_ctx := format('Beat a +%s favorite on %s', v_diff, v_played);
        if not exists (
          select 1 from public.player_badges
           where user_id = v_uid and badge_id = v_badge_id and context = v_ctx
        ) then
          insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
          values (v_uid, v_badge_id, null, v_ctx, new.id);
        end if;
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

drop trigger if exists trg_award_cinderella_badge on public.matches;
create trigger trg_award_cinderella_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_cinderella_badge();


-- 2d. _award_marathon_badge ----------------------------------------------
create or replace function public._award_marathon_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id uuid;
  v_winning  int;
  v_losing   int;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_ctx      text;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.winner_team is null then return new; end if;

  select id into v_badge_id from public.badges where name = 'Marathon';
  if v_badge_id is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winning := new.player1_score;
    v_losing  := new.player2_score;
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winning := new.player2_score;
    v_losing  := new.player1_score;
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  else
    return new;
  end if;

  if v_winning is null or v_winning < 12 then return new; end if;

  begin
    foreach v_uid in array v_winners loop
      v_ctx := format('%s-%s on %s', v_winning, coalesce(v_losing, 0), v_played);
      if not exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_badge_id and context = v_ctx
      ) then
        insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
        values (v_uid, v_badge_id, null, v_ctx, new.id);
      end if;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_award_marathon_badge on public.matches;
create trigger trg_award_marathon_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_marathon_badge();


-- 2e. _award_triple_crown_badge ------------------------------------------
create or replace function public._award_triple_crown_badge()
returns trigger language plpgsql security definer as $$
declare
  v_tc_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_ctx      text;
  v_has_s    boolean;
  v_has_g    boolean;
  v_has_m    boolean;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_tc_id from public.badges where name = 'Triple Crown';
  if v_tc_id is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_winners is null then return new; end if;

  foreach v_uid in array v_winners loop
    begin
      v_ctx := format('Triple Crown on %s', v_played);

      if exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_tc_id and context = v_ctx
      ) then continue; end if;

      select
        bool_or(m.match_type = 'singles'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'gendered'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'mixed')
        into v_has_s, v_has_g, v_has_m
        from public.matches m
       where coalesce(m.played_at, now())::date = v_played
         and (
           (m.winner_team = 'team1' and (m.player1_id  = v_uid or m.partner1_id = v_uid))
           or
           (m.winner_team = 'team2' and (m.player2_id  = v_uid or m.partner2_id = v_uid))
         );

      if coalesce(v_has_s, false) and coalesce(v_has_g, false) and coalesce(v_has_m, false) then
        insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
        values (v_uid, v_tc_id, null, v_ctx, new.id);
      end if;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_award_triple_crown_badge on public.matches;
create trigger trg_award_triple_crown_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_triple_crown_badge();


-- 2f. _award_globetrotter_ii_badge ---------------------------------------
create or replace function public._award_globetrotter_ii_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id uuid;
  v_uid      uuid;
  v_count    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_badge_id from public.badges where name = 'Globetrotter II';
  if v_badge_id is null then return new; end if;

  begin
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(distinct m.location_name) into v_count
        from public.matches m
       where (m.player1_id = v_uid or m.partner1_id = v_uid
              or m.player2_id = v_uid or m.partner2_id = v_uid)
         and m.location_name is not null;

      if v_count >= 10 and not exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_badge_id
      ) then
        insert into public.player_badges (user_id, badge_id, league_id, context, source_match_id)
        values (v_uid, v_badge_id, null, format('Played at %s courts', v_count), new.id);
      end if;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_award_globetrotter_ii_badge on public.matches;
create trigger trg_award_globetrotter_ii_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_globetrotter_ii_badge();


-- 3. _reverse_match_side_effects: invoked from BEFORE DELETE trigger -----
create or replace function public._reverse_match_side_effects()
returns trigger language plpgsql security definer as $$
declare
  v_match            public.matches := old;
  v_delta1           decimal;
  v_delta2           decimal;
  v_played_date      date;
  v_player_ids       uuid[];
  v_team1_ids        uuid[];
  v_team2_ids        uuid[];
  v_uid              uuid;
  v_remaining        integer;
  v_remaining_doub   integer;
  v_remaining_court  integer;
  v_remaining_day    integer;
  v_streak_row       public.daily_play_streaks;
  v_badge_count      integer;
begin
  -- Only act when reversing a COMPLETED match. Pending rows never
  -- applied side-effects (gated triggers), so nothing to undo.
  if coalesce(old.status, 'completed') <> 'completed' then
    return old;
  end if;

  v_played_date := (coalesce(old.played_at, now()))::date;
  v_team1_ids   := array_remove(array[old.player1_id, old.partner1_id], null);
  v_team2_ids   := array_remove(array[old.player2_id, old.partner2_id], null);
  v_player_ids  := array_remove(
    array[old.player1_id, old.partner1_id, old.player2_id, old.partner2_id],
    null
  );

  -- 3a. Reverse rating deltas (overall + facet) --------------------------
  begin
    if old.player1_rating_after is not null and old.player1_rating_before is not null
       and old.player2_rating_after is not null and old.player2_rating_before is not null then

      v_delta1 := old.player1_rating_after - old.player1_rating_before;
      v_delta2 := old.player2_rating_after - old.player2_rating_before;

      -- Overall rating: subtract team1's delta from team1 members, team2's from team2 members.
      foreach v_uid in array v_team1_ids loop
        update public.profiles
           set rating = greatest(2.000, rating - v_delta1)
         where id = v_uid;
      end loop;
      foreach v_uid in array v_team2_ids loop
        update public.profiles
           set rating = greatest(2.000, rating - v_delta2)
         where id = v_uid;
      end loop;

      -- Facet rating: which column was bumped depends on match_type/doubles_category.
      -- Mirror the apply path in update_plupr_ratings exactly.
      if old.match_type = 'singles' then
        if old.player1_id is not null then
          update public.profiles
             set singles_rating = greatest(2.000, singles_rating - v_delta1)
           where id = old.player1_id;
        end if;
        if old.player2_id is not null then
          update public.profiles
             set singles_rating = greatest(2.000, singles_rating - v_delta2)
           where id = old.player2_id;
        end if;
      elsif old.match_type = 'doubles' and old.doubles_category = 'gendered' then
        foreach v_uid in array v_team1_ids loop
          update public.profiles
             set doubles_rating = greatest(2.000, doubles_rating - v_delta1)
           where id = v_uid;
        end loop;
        foreach v_uid in array v_team2_ids loop
          update public.profiles
             set doubles_rating = greatest(2.000, doubles_rating - v_delta2)
           where id = v_uid;
        end loop;
      elsif old.match_type = 'doubles' and old.doubles_category = 'mixed' then
        foreach v_uid in array v_team1_ids loop
          update public.profiles
             set mixed_doubles_rating = greatest(2.000, mixed_doubles_rating - v_delta1)
           where id = v_uid;
        end loop;
        foreach v_uid in array v_team2_ids loop
          update public.profiles
             set mixed_doubles_rating = greatest(2.000, mixed_doubles_rating - v_delta2)
           where id = v_uid;
        end loop;
      end if;
    end if;
  exception when others then null;
  end;

  -- 3b. Reverse badges awarded by this match + refund per-badge pickles --
  begin
    -- For every (user, badge) row this match created, refund 50 pickles
    -- per row (the standard _grant_pickles_on_badge payout). Some
    -- match-driven badges insert without going through that trigger?
    -- They all do (it's an AFTER INSERT on player_badges) — so 1:1.
    for v_uid, v_badge_count in
      select user_id, count(*)::int
        from public.player_badges
       where source_match_id = old.id
       group by user_id
    loop
      update public.profiles
         set pickles = greatest(0, coalesce(pickles, 0) - (50 * v_badge_count))
       where id = v_uid;
    end loop;

    delete from public.player_badges where source_match_id = old.id;
  exception when others then null;
  end;

  -- 3c. first_match_bonus: if user has no other matches, drop grant + refund 200.
  begin
    foreach v_uid in array v_player_ids loop
      begin
        select count(*) into v_remaining
          from public.matches
         where id <> old.id
           and (player1_id = v_uid or partner1_id = v_uid
                or player2_id = v_uid or partner2_id = v_uid);

        if v_remaining = 0
           and exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then
          delete from public.first_match_bonus_grants where user_id = v_uid;
          update public.profiles
             set pickles = greatest(0, coalesce(pickles, 0) - 200)
           where id = v_uid;
        end if;
      exception when others then null;
      end;
    end loop;
  exception when others then null;
  end;

  -- 3d. first_doubles_bonus: same logic, doubles only, refund 150.
  begin
    if old.match_type = 'doubles' then
      foreach v_uid in array v_player_ids loop
        begin
          select count(*) into v_remaining_doub
            from public.matches
           where id <> old.id
             and match_type = 'doubles'
             and (player1_id = v_uid or partner1_id = v_uid
                  or player2_id = v_uid or partner2_id = v_uid);

          if v_remaining_doub = 0
             and exists (select 1 from public.first_doubles_bonus_grants where user_id = v_uid) then
            delete from public.first_doubles_bonus_grants where user_id = v_uid;
            update public.profiles
               set pickles = greatest(0, coalesce(pickles, 0) - 150)
             where id = v_uid;
          end if;
        exception when others then null;
        end;
      end loop;
    end if;
  exception when others then null;
  end;

  -- 3e. court_bonus: per location_name. If user has no other match at the
  --     same court, drop the grant row + refund 100.
  begin
    if old.location_name is not null then
      foreach v_uid in array v_player_ids loop
        begin
          select count(*) into v_remaining_court
            from public.matches
           where id <> old.id
             and location_name = old.location_name
             and (player1_id = v_uid or partner1_id = v_uid
                  or player2_id = v_uid or partner2_id = v_uid);

          if v_remaining_court = 0
             and exists (
               select 1 from public.court_bonus_grants
                where user_id = v_uid and location_name = old.location_name
             ) then
            delete from public.court_bonus_grants
              where user_id = v_uid and location_name = old.location_name;
            update public.profiles
               set pickles = greatest(0, coalesce(pickles, 0) - 100)
             where id = v_uid;
          end if;
        exception when others then null;
        end;
      end loop;
    end if;
  exception when others then null;
  end;

  -- 3f. daily_play_streaks: if user has no other match on v_played_date,
  --     delete that day's streak row + refund bonus_granted, AND nuke
  --     every later streak row for that user (chain breakage caveat,
  --     documented at the top of this file).
  begin
    foreach v_uid in array v_player_ids loop
      begin
        select count(*) into v_remaining_day
          from public.matches
         where id <> old.id
           and (coalesce(played_at, now()))::date = v_played_date
           and (player1_id = v_uid or partner1_id = v_uid
                or player2_id = v_uid or partner2_id = v_uid);

        if v_remaining_day = 0 then
          select * into v_streak_row
            from public.daily_play_streaks
           where user_id = v_uid and play_date = v_played_date;

          if found then
            update public.profiles
               set pickles = greatest(0, coalesce(pickles, 0) - coalesce(v_streak_row.bonus_granted, 0))
             where id = v_uid;

            -- Delete this day's row + all later rows (chain broken).
            delete from public.daily_play_streaks
             where user_id = v_uid and play_date >= v_played_date;
          end if;
        end if;
      exception when others then null;
      end;
    end loop;
  exception when others then null;
  end;

  return old;
end;
$$;
grant execute on function public._reverse_match_side_effects() to authenticated;


-- 4. BEFORE DELETE trigger -----------------------------------------------
drop trigger if exists trg_reverse_match_side_effects on public.matches;
create trigger trg_reverse_match_side_effects
  before delete on public.matches
  for each row execute procedure public._reverse_match_side_effects();


-- 5. Reload PostgREST schema cache.
notify pgrst, 'reload schema';
