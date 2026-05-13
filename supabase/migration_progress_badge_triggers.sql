-- ============================================================
-- Progress-driven auto-award for the original badges
--
-- The seven progress badges from migration_add_badges.sql
-- (First Rally, Top Rated, Veteran, Court Hopper, Singles
-- Specialist, Doubles Dynamo, Hot Streak) were historically
-- awarded only by the manual scripts/award-badges.js script.
-- This migration installs a single re-entrant evaluator and
-- wires it onto match inserts + profile-rating updates so the
-- badges hit a player's profile the moment they cross the
-- threshold. Stackable badges are unaffected — those already
-- have their own triggers.
--
-- The existing _grant_pickles_on_badge trigger fires on every
-- player_badges insert, so the +50 pickle bonus + shop
-- notification go out automatically. computeMaxTagSlots /
-- AVATARS / PLAY_TAGS on the client read earnedBadgeNames
-- live, so the Profile and UnlockProgress screens reflect new
-- awards on next focus.
--
-- Run AFTER:
--   migration_add_badges.sql
--   migration_convert_to_plupr.sql
--   migration_more_badges_and_stacking.sql
--   migration_shop_rewards_and_progress_badges.sql
-- ============================================================


-- 1. Helper: award only when not already held -----------------------------
create or replace function public._maybe_award_profile_badge(
  p_user_id    uuid,
  p_badge_name text,
  p_context    text default null
) returns boolean language plpgsql security definer as $$
declare
  v_badge_id uuid;
begin
  select id into v_badge_id from public.badges where name = p_badge_name;
  if v_badge_id is null then return false; end if;

  if exists (
    select 1 from public.player_badges
     where user_id = p_user_id and badge_id = v_badge_id
  ) then
    return false;
  end if;

  insert into public.player_badges (user_id, badge_id, league_id, context)
  values (p_user_id, v_badge_id, null, p_context);
  return true;
end;
$$;
grant execute on function public._maybe_award_profile_badge(uuid, text, text) to authenticated;


-- 2. Evaluator: checks every progress threshold for one player -----------
create or replace function public._award_progress_badges(p_user_id uuid)
returns void language plpgsql security definer as $$
declare
  v_rating         decimal;
  v_created        timestamptz;
  v_member_days    integer;
  v_total          integer;
  v_singles        integer;
  v_doubles        integer;
  v_courts         integer;
  v_max_streak     integer;
begin
  if p_user_id is null then return; end if;

  select rating, created_at into v_rating, v_created
    from public.profiles where id = p_user_id;
  if v_created is null then return; end if;

  v_member_days := floor(extract(epoch from (now() - v_created)) / 86400)::integer;

  select
    count(*)                                                                       as total,
    count(*) filter (where match_type = 'singles')                                 as singles,
    count(*) filter (where match_type = 'doubles')                                 as doubles,
    count(distinct location_name) filter (where location_name is not null)         as courts
    into v_total, v_singles, v_doubles, v_courts
    from public.matches
   where player1_id = p_user_id or partner1_id = p_user_id
      or player2_id = p_user_id or partner2_id = p_user_id;

  -- Max consecutive-wins streak via gaps-and-islands. Tiebreaker on id
  -- so ordering is stable when multiple matches share played_at.
  select coalesce(max(streak), 0) into v_max_streak
  from (
    select grp, count(*) as streak
      from (
        select
          played_at, id, won,
          sum(case when won = 0 then 1 else 0 end)
            over (order by played_at, id rows between unbounded preceding and current row) as grp
        from (
          select
            m.played_at, m.id,
            case
              when (m.winner_team = 'team1' and (m.player1_id = p_user_id or m.partner1_id = p_user_id))
                or (m.winner_team = 'team2' and (m.player2_id = p_user_id or m.partner2_id = p_user_id))
              then 1 else 0
            end as won
          from public.matches m
          where m.player1_id  = p_user_id or m.partner1_id = p_user_id
             or m.player2_id  = p_user_id or m.partner2_id = p_user_id
        ) flagged
      ) grouped
     where won = 1
     group by grp
  ) streaks;

  -- Awards (each helper call is a no-op if already held).
  if v_total >= 1 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'First Rally', format('Played %s match%s', v_total, case when v_total = 1 then '' else 'es' end)
    );
  end if;

  if v_rating is not null and v_rating >= 4.0 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Top Rated', format('Reached %s PLUPR', round(v_rating, 2))
    );
  end if;

  if v_member_days >= 30 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Veteran', format('%s days as a member', v_member_days)
    );
  end if;

  if v_courts >= 5 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Court Hopper', format('Played at %s courts', v_courts)
    );
  end if;

  if v_singles >= 25 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Singles Specialist', format('%s singles matches', v_singles)
    );
  end if;

  if v_doubles >= 20 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Doubles Dynamo', format('%s doubles matches', v_doubles)
    );
  end if;

  if v_max_streak >= 5 then
    perform public._maybe_award_profile_badge(
      p_user_id, 'Hot Streak', format('Hit a %s-match win streak', v_max_streak)
    );
  end if;
end;
$$;
grant execute on function public._award_progress_badges(uuid) to authenticated;


-- 3. Match-insert trigger: re-evaluate every player in the match ---------
create or replace function public._progress_check_on_match()
returns trigger language plpgsql security definer as $$
declare v_uid uuid;
begin
  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      perform public._award_progress_badges(v_uid);
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_progress_check_on_match on public.matches;
create trigger trg_progress_check_on_match
  after insert on public.matches
  for each row execute procedure public._progress_check_on_match();


-- 4. Rating-update trigger: covers Top Rated when PLUPR moves -----------
create or replace function public._progress_check_on_rating()
returns trigger language plpgsql security definer as $$
begin
  if new.rating is distinct from old.rating then
    begin
      perform public._award_progress_badges(new.id);
    exception when others then null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_progress_check_on_rating on public.profiles;
create trigger trg_progress_check_on_rating
  after update of rating on public.profiles
  for each row execute procedure public._progress_check_on_rating();


-- 5. Backfill — award every currently-eligible badge to every player. ----
--    The badge insert fires _grant_pickles_on_badge, so historically
--    qualified players will get +50 pickles + notification per
--    newly-awarded badge. If you'd rather backfill silently, comment
--    out _grant_pickles_on_badge for the duration of this run.
do $$
declare v_uid uuid;
begin
  for v_uid in select id from public.profiles loop
    begin
      perform public._award_progress_badges(v_uid);
    exception when others then null;
    end;
  end loop;
end$$;


notify pgrst, 'reload schema';
