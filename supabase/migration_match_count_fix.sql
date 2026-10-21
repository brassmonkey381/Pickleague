-- ============================================================
-- Match counts: a match counts once, when it's confirmed.
--
-- Checked live (2026-10-20, read-only): on_match_player_stats is installed
-- with its old body (migration_add_match_metadata.sql): +1
-- total_matches_played and last_match_at for every player on EVERY insert,
-- whatever the status. _apply_match_deltas_to_players
-- (migration_match_confirm_flow.sql) adds 1 again when the match is
-- confirmed. So a confirmed match counted twice, a pending one that expired
-- or was turned down still counted once, and a scheduled one would count as
-- played. Every player with matches has a total above their row count.
--
-- Also: the counters that decide bonuses, badges and their reversal counted
-- every matches row for the player, so another player's pending or
-- scheduled match could cost someone the first-match bonus or break a
-- streak.
--
-- This file:
--   1. drops on_match_player_stats (nothing reads last_match_at for
--      unconfirmed matches; the function stays, revoked, unused);
--   2. _apply_match_deltas_to_players no longer counts (from
--      migration_match_confirm_flow.sql; only the count removed). It ran
--      only when deltas were applied, so an unspecified-category doubles
--      match or one with a zero delta was never counted at all;
--   3. _pl_count_completed_match (AFTER insert / status update / delete):
--      +1 and last_match_at for each player when a row becomes 'completed'
--      (a confirm, or a godmode / server insert stored completed), -1 when a
--      completed row is deleted. update_plupr_ratings reads the count for
--      the K-factor in its BEFORE INSERT branch, so it still sees the count
--      before this match;
--   4. the counters read completed matches only, each from its latest body
--      in the repo with only the filter added:
--        _grant_first_match_bonus      (migration_bump_base_pickle_grants.sql)
--        _grant_first_doubles_bonus    (migration_audit_fixes_2026q2.sql)
--        _award_match_badges           (migration_local_times_in_notices.sql)
--        _award_globetrotter_ii_badge  (migration_prod_reconcile_2026q3.sql)
--        _award_progress_badges        (migration_progress_badge_triggers.sql)
--        _reverse_match_side_effects   (migration_local_day_boundaries.sql)
--
-- Then run supabase/repair_match_counts.sql once to fix the stored totals.
-- Apply AFTER the files above (a re-run of any of them puts its old body
-- back: re-apply this one after). Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_match_count_fix.sql
-- Tested by supabase/tests/schedule_match_personas.sql (T6).
-- ============================================================


-- ── 1. No count on insert ─────────────────────────────────────────────────
drop trigger if exists on_match_player_stats on public.matches;
revoke all on function public.update_player_match_stats() from public, anon, authenticated;


-- ── 2. Applying deltas doesn't count ──────────────────────────────────────
create or replace function public._apply_match_deltas_to_players(
  p_league_id    uuid,
  p_player1_id   uuid, p_partner1_id uuid,
  p_player2_id   uuid, p_partner2_id uuid,
  p_match_type   text,
  p_cat          text,    -- 'singles' | 'gendered' | 'mixed' | null
  p_delta1       decimal,
  p_delta2       decimal
) returns void language plpgsql security definer as $$
declare
  GLOBAL_WEIGHT constant decimal := 0.5;
  v_singles_cat text := case when p_match_type = 'singles' then 'singles' else p_cat end;
begin
  -- League PLUPR: full delta on all 4 players
  perform public._apply_plupr_delta_to_league(p_league_id, p_player1_id, p_delta1, v_singles_cat);
  perform public._apply_plupr_delta_to_league(p_league_id, p_player2_id, p_delta2, v_singles_cat);
  if p_match_type = 'doubles' then
    if p_partner1_id is not null then perform public._apply_plupr_delta_to_league(p_league_id, p_partner1_id, p_delta1, p_cat); end if;
    if p_partner2_id is not null then perform public._apply_plupr_delta_to_league(p_league_id, p_partner2_id, p_delta2, p_cat); end if;
  end if;

  -- Global PLUPR: 0.5x delta (league matches dilute global)
  perform public._apply_plupr_delta_to_global(p_player1_id, p_delta1 * GLOBAL_WEIGHT, v_singles_cat);
  perform public._apply_plupr_delta_to_global(p_player2_id, p_delta2 * GLOBAL_WEIGHT, v_singles_cat);
  if p_match_type = 'doubles' then
    if p_partner1_id is not null then perform public._apply_plupr_delta_to_global(p_partner1_id, p_delta1 * GLOBAL_WEIGHT, p_cat); end if;
    if p_partner2_id is not null then perform public._apply_plupr_delta_to_global(p_partner2_id, p_delta2 * GLOBAL_WEIGHT, p_cat); end if;
  end if;

  -- total_matches_played / last_match_at: _pl_count_completed_match.
end;
$$;
revoke all on function public._apply_match_deltas_to_players(uuid, uuid, uuid, uuid, uuid, text, text, decimal, decimal)
  from public, anon, authenticated;


-- ── 3. Count a match once, when it's confirmed ────────────────────────────
create or replace function public._pl_count_completed_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'completed' then
      update public.profiles
         set total_matches_played = greatest(0, coalesce(total_matches_played, 0) - 1)
       where id in (old.player1_id, old.partner1_id, old.player2_id, old.partner2_id);
    end if;
    return old;
  end if;

  if new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    update public.profiles
       set total_matches_played = coalesce(total_matches_played, 0) + 1,
           last_match_at = greatest(last_match_at, coalesce(new.played_at, now()))
     where id in (new.player1_id, new.partner1_id, new.player2_id, new.partner2_id);
  elsif tg_op = 'UPDATE' and old.status = 'completed' and new.status <> 'completed' then
    update public.profiles
       set total_matches_played = greatest(0, coalesce(total_matches_played, 0) - 1)
     where id in (old.player1_id, old.partner1_id, old.player2_id, old.partner2_id);
  end if;
  return new;
end $$;
revoke all on function public._pl_count_completed_match() from public, anon, authenticated;

drop trigger if exists trg_count_completed_match on public.matches;
create trigger trg_count_completed_match
  after insert or delete or update of status on public.matches
  for each row execute function public._pl_count_completed_match();


-- ── 4. Counters read completed matches only ───────────────────────────────

-- _grant_first_match_bonus: from migration_bump_base_pickle_grants.sql; only status = 'completed' added.
create or replace function public._grant_first_match_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_count integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then
        continue;
      end if;

      select count(*) into v_count from public.matches
        where status = 'completed'
          and (player1_id = v_uid or partner1_id = v_uid
               or player2_id = v_uid or partner2_id = v_uid);

      if v_count = 1 then
        insert into public.first_match_bonus_grants(user_id) values (v_uid)
          on conflict (user_id) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 500 where id = v_uid;

        begin
          perform public._notify_user(
            v_uid,
            '🥒 First match! +500 pickles to spend in the Shop.',
            '🥒 First match! +500 pickles to spend in the Shop.',
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;
revoke all on function public._grant_first_match_bonus() from public, anon, authenticated;

-- _grant_first_doubles_bonus: from migration_audit_fixes_2026q2.sql; only status = 'completed' added.
create or replace function public._grant_first_doubles_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid         uuid;
  v_prior_count int;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.match_type <> 'doubles' then return new; end if;

  foreach v_uid in array array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id] loop
    if v_uid is null then continue; end if;

    if exists (select 1 from public.first_doubles_bonus_grants where user_id = v_uid) then
      continue;
    end if;

    select count(*) into v_prior_count
    from public.matches
    where id <> new.id
      and status = 'completed'
      and match_type = 'doubles'
      and (player1_id = v_uid or partner1_id = v_uid or player2_id = v_uid or partner2_id = v_uid);

    if v_prior_count > 0 then continue; end if;

    begin
      insert into public.first_doubles_bonus_grants (user_id) values (v_uid)
        on conflict (user_id) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 150 where id = v_uid;

      perform public._notify_user(
        v_uid,
        '🥒 First doubles match! +150 pickles.',
        'You earned 150 🥒 for playing your first doubles match. Tap to see your shop balance.',
        v_uid,
        'shop'
      );
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;
revoke all on function public._grant_first_doubles_bonus() from public, anon, authenticated;

-- _award_match_badges: from migration_local_times_in_notices.sql; only status = 'completed' added.
create or replace function public._award_match_badges()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_pg_id    uuid;
  v_cn_id    uuid;
  v_played   date;
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
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_pg_id, null, format('11-0 shutout on %s', v_played));
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
       where m.status = 'completed'
         and (m.player1_id  = v_uid or m.partner1_id = v_uid
              or m.player2_id  = v_uid or m.partner2_id = v_uid);
      if v_count > 0 and v_count % 100 = 0 then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_cn_id, null, format('Hit %s career matches', v_count));
      end if;
    end loop;
  end if;

  return new;
end;
$function$;
revoke all on function public._award_match_badges() from public, anon, authenticated;

-- _award_globetrotter_ii_badge: from migration_prod_reconcile_2026q3.sql; only status = 'completed' added.
CREATE OR REPLACE FUNCTION public._award_globetrotter_ii_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
         and m.location_name is not null
         and m.status = 'completed';

      if v_count >= 10 and not exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_badge_id
      ) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_badge_id, null, format('Played at %s courts', v_count));
      end if;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$function$;
revoke all on function public._award_globetrotter_ii_badge() from public, anon, authenticated;

-- _award_progress_badges: from migration_progress_badge_triggers.sql; only status = 'completed' added.
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
   where status = 'completed'
     and (player1_id = p_user_id or partner1_id = p_user_id
          or player2_id = p_user_id or partner2_id = p_user_id);

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
          where m.status = 'completed'
            and (m.player1_id  = p_user_id or m.partner1_id = p_user_id
                 or m.player2_id  = p_user_id or m.partner2_id = p_user_id)
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
revoke all on function public._award_progress_badges(uuid) from public, anon, authenticated;

-- _reverse_match_side_effects: from migration_local_day_boundaries.sql; only status = 'completed' added.
CREATE OR REPLACE FUNCTION public._reverse_match_side_effects()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  v_tz               text;
begin
  -- Only act when reversing a COMPLETED match. Pending rows never
  -- applied side-effects (gated triggers), so nothing to undo.
  if coalesce(old.status, 'completed') <> 'completed' then
    return old;
  end if;

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
           and status = 'completed'
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
             and status = 'completed'
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
             and status = 'completed'
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

  -- 3f. daily_play_streaks: v_played_date is the match's day in THIS user's
  --     zone (as _grant_daily_streak_bonus files it). If user has no other
  --     match on v_played_date (same zone),
  --     delete that day's streak row + refund bonus_granted, AND nuke
  --     every later streak row for that user (chain breakage caveat,
  --     documented at the top of this file).
  begin
    foreach v_uid in array v_player_ids loop
      begin
        v_tz          := public._pickleague_tz_for(v_uid);
        v_played_date := (coalesce(old.played_at, now()) at time zone v_tz)::date;
        select count(*) into v_remaining_day
          from public.matches
         where id <> old.id
           and status = 'completed'
           and (coalesce(played_at, now()) at time zone v_tz)::date = v_played_date
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
$function$;
revoke all on function public._reverse_match_side_effects() from public, anon, authenticated;
