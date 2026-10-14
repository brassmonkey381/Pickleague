-- ============================================================
-- Local day boundaries (time-zone audit, 2026-10-14). Needs
-- migration_time_zones.sql (_pickleague_tz_for), migration_local_times_in_
-- notices.sql (og_card_tz, the badge triggers' local dates),
-- migration_daily_login_and_match_game_bonuses.sql,
-- migration_reverse_match_side_effects_on_delete.sql,
-- migration_auto_lock_periods.sql and migration_prod_reconcile_2026q3.sql
-- first. Idempotent: create or replace, and two plain badge updates.
--
-- The database runs in UTC, so every "day" below was the UTC day, which
-- turns over at 5 PM PDT (4 PM PST). Now each uses a local calendar day
-- (_pickleague_tz_for; no stored zone = America/Los_Angeles):
--
--   1. claim_daily_login_streak     the player's day: two claims on one
--                                   local evening were two days' pickles, and
--                                   Mon 9 AM + Tue 6 PM was a 2-day gap
--   2. _grant_daily_streak_bonus,   each player's day: 4 PM and 6 PM PDT
--      _reverse_match_side_effects  matches were "Day 2" on one evening
--   3. auto_lock_due_periods,       the league's day (its creator's zone):
--      _lock_season_period_unchecked  periods locked at 5:05 PM PDT the day
--                                   before the date the app shows, and the
--                                   snapshot W-L bucketed matches by UTC day
--      og_card_tz                   + 'season', so the link preview's
--                                   "period N" uses the league's day too
--   4. _award_underdog_badge,       a scale bug, not a zone one: PLUPR was
--      _award_cinderella_badge      cast to integer, so neither ever fired
--
-- The app ships with it (same release): SeasonStandingsScreen,
-- useLeagueStandings and lib/seasonSummary use the device's local day for
-- "today" and bucket played_at by local day, the season card computes its
-- period in the league's zone.
--
-- Cutover (nothing is re-dated; no backfill):
--   * login streak: a stored day can be a day ahead (US evening claims) or
--     behind (a claim just after local midnight east of UTC). Both count as
--     already claimed today (see 1), so nobody is reset or paid twice.
--   * play streak: existing daily_play_streaks rows keep their UTC dates. A
--     player whose last match was a US evening (filed under tomorrow's UTC
--     date) gets no new bonus for a match on that local tomorrow, and deleting
--     an old evening match looks for its row under the local day, so its
--     bonus may not be refunded. Both are one-time, at most one day per player.
--   * season locks: already-locked periods stay locked (the cron skips them);
--     the next locks just move to 00:05 local. Applied between 00:00 and
--     07:00 UTC, nothing new is due until local midnight.
--
-- Not changed (a separate design question): the lock fires at the START of
-- the lock date, but both windows include that date (a period's live tab
-- ends at the lock date's 23:59, the next starts the day after), so matches
-- played on a lock day count in the next period's ratings but in neither
-- live tab.
--
-- Each function below is the production definition (2026-10-14) plus these
-- changes; grants are unchanged (internal helpers stay revoked, og_card_tz
-- stays anon + authenticated and is already in the lockdown allowlist).
--
-- Apply:  supabase db query --linked -f supabase/migration_local_day_boundaries.sql
-- ============================================================


-- ── 1. Daily login streak: the player's own calendar day ───────────────────
-- today and the freeze-refill month come from the player's zone. Cutover:
-- rows stamped with the UTC day are a day AHEAD for every US evening claim
-- (and a day behind for a claim just after local midnight east of UTC), so a
-- claim counts as already made when last_login_date >= today, or when a
-- reward was paid since local midnight (user_streak_rewards.awarded_at). The
-- second case also moves last_login_date up to today, so tomorrow is gap 1,
-- not a spent freeze. Nobody is reset or paid twice at the switch; a US
-- player who claimed after 5 PM yesterday has already had today's reward.

CREATE OR REPLACE FUNCTION public.claim_daily_login_streak()
 RETURNS TABLE(claimed_today boolean, streak_before integer, streak_after integer, daily_pickles integer, milestone_pickles integer, milestone_label text, used_freeze boolean, freezes_remaining integer, longest_streak integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  uid              uuid := auth.uid();
  -- Declarations run in order, so uid is set here (null -> the default zone,
  -- then the 'Not authenticated' raise below).
  v_tz             text := public._pickleague_tz_for(uid);
  today            date := (now() at time zone v_tz)::date;
  curr_month       text := to_char(now() at time zone v_tz, 'YYYY-MM');
  rec              user_login_streaks%rowtype;
  gap              int;
  v_streak_before  int := 0;
  v_streak_after   int;
  v_used_freeze    boolean := false;
  v_daily          int := 0;
  v_milestone      int := 0;
  v_milestone_lbl  text := null;
  v_freezes        int;
  v_longest        int;
  v_claimed        boolean;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select * into rec from user_login_streaks where user_id = uid for update;

  if found and rec.freezes_refilled_month <> curr_month then
    rec.freezes_remaining := 1;
    rec.freezes_refilled_month := curr_month;
  end if;

  if not found then
    v_streak_before := 0;
    v_streak_after  := 1;
    v_daily         := 50;
    v_freezes       := 1;
    v_longest       := 1;
    v_claimed       := true;
    insert into user_login_streaks (
      user_id, current_streak, longest_streak, last_login_date,
      freezes_remaining, freezes_refilled_month, total_logins
    ) values (
      uid, v_streak_after, v_longest, today, v_freezes, curr_month, 1
    );
  elsif rec.last_login_date >= today
        or exists (select 1 from user_streak_rewards r
                    where r.user_id = uid
                      and r.awarded_at >= (today::timestamp at time zone v_tz)) then
    v_streak_before := rec.current_streak;
    v_streak_after  := rec.current_streak;
    v_freezes       := rec.freezes_remaining;
    v_longest       := rec.longest_streak;
    v_claimed       := false;
    update user_login_streaks
      set freezes_remaining = rec.freezes_remaining,
          freezes_refilled_month = rec.freezes_refilled_month,
          last_login_date = greatest(rec.last_login_date, today),
          updated_at = now()
      where user_id = uid;
  else
    gap := today - rec.last_login_date;
    v_streak_before := rec.current_streak;
    if gap = 1 then
      v_streak_after := rec.current_streak + 1;
      v_freezes      := rec.freezes_remaining;
    elsif gap = 2 and rec.freezes_remaining > 0 then
      v_streak_after := rec.current_streak + 1;
      v_freezes      := rec.freezes_remaining - 1;
      v_used_freeze  := true;
    else
      v_streak_after := 1;
      v_freezes      := rec.freezes_remaining;
    end if;

    v_daily := 50;
    v_milestone := case v_streak_after
      when 3   then 25
      when 7   then 100
      when 30  then 500
      when 100 then 2000
      else 0
    end;
    v_milestone_lbl := case v_streak_after
      when 3   then '3-day streak'
      when 7   then '7-day streak'
      when 30  then '30-day streak'
      when 100 then '100-day streak'
      else null
    end;
    v_longest := greatest(rec.longest_streak, v_streak_after);
    v_claimed := true;

    update user_login_streaks
      set current_streak         = v_streak_after,
          longest_streak         = v_longest,
          last_login_date        = today,
          freezes_remaining      = v_freezes,
          freezes_refilled_month = curr_month,
          total_logins           = total_logins + 1,
          updated_at             = now()
      where user_id = uid;
  end if;

  if v_claimed then
    update profiles
      set pickles = coalesce(pickles, 0) + v_daily + v_milestone
      where id = uid;
    insert into user_streak_rewards (
      user_id, awarded_date, streak_after, daily_pickles,
      milestone_pickles, milestone_label, used_freeze
    ) values (
      uid, today, v_streak_after, v_daily,
      v_milestone, v_milestone_lbl, v_used_freeze
    );
  end if;

  return query select
    v_claimed,
    v_streak_before,
    v_streak_after,
    v_daily,
    v_milestone,
    v_milestone_lbl,
    v_used_freeze,
    v_freezes,
    v_longest;
end;
$function$;


-- ── 2. Daily play streak: each player's own calendar day ───────────────────
-- play_date is the day the match was played in THAT player's zone (two
-- players in different zones can file one match under different days). The
-- reversal on delete uses the same day, per player. Existing rows keep their
-- UTC dates: no backfill (see the cutover note at the top).

CREATE OR REPLACE FUNCTION public._grant_daily_streak_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid      uuid;
  v_date     date;
  v_prev_len integer;
  v_len      integer;
  v_bonus    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      v_date := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
      if exists (select 1 from public.daily_play_streaks where user_id = v_uid and play_date = v_date) then
        continue;
      end if;

      select streak_length into v_prev_len
        from public.daily_play_streaks
        where user_id = v_uid and play_date = v_date - 1;

      v_len   := coalesce(v_prev_len, 0) + 1;
      v_bonus := least(50 * v_len, 200);

      insert into public.daily_play_streaks(user_id, play_date, streak_length, bonus_granted)
        values (v_uid, v_date, v_len, v_bonus)
        on conflict (user_id, play_date) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;

      begin
        perform public._notify_user(
          v_uid,
          '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
          '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
          v_uid,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$function$;
revoke execute on function public._grant_daily_streak_bonus() from public, anon, authenticated;

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
revoke execute on function public._reverse_match_side_effects() from public, anon, authenticated;


-- ── 3a. Auto-lock: the league's calendar day ───────────────────────────────
-- A period locks once its snapshot date has arrived in the league's zone (the
-- creator's), so the hourly :05 run locks at 00:05 local on the lock date,
-- the moment the app's Lock button turns on (isLockDue, local midnight). It
-- was 00:05 UTC: 5:05 PM PDT the day before.

CREATE OR REPLACE FUNCTION public.auto_lock_due_periods()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_season       record;
  v_p            integer;
  v_snapshot     date;
  v_today        date;
  v_locked_count integer := 0;
begin
  for v_season in (
    select s.id, s.league_id, s.start_date, s.total_periods, s.lock_frequency_weeks,
           public._pickleague_tz_for(l.created_by) as tz
      from public.league_seasons s
      left join public.leagues l on l.id = s.league_id
     where s.status in ('upcoming', 'active')
  ) loop
    -- Today in the league's zone (no creator / no stored zone: the default).
    v_today := (now() at time zone v_season.tz)::date;
    for v_p in 1..v_season.total_periods loop
      v_snapshot := v_season.start_date + (v_p * v_season.lock_frequency_weeks) * interval '7 days';
      -- Has this period's end date already passed?
      continue when v_snapshot > v_today;
      -- Already locked?
      continue when exists (
        select 1 from public.season_snapshots
         where season_id = v_season.id and period_number = v_p
      );

      perform public._lock_season_period_unchecked(v_season.id, v_p, v_snapshot);
      v_locked_count := v_locked_count + 1;
    end loop;
  end loop;

  return v_locked_count;
end;
$function$;
revoke execute on function public.auto_lock_due_periods() from public, anon, authenticated;


-- ── 3b. A period's W-L: matches by the league's calendar day ───────────────
-- The snapshot's cumulative W-L (a tiebreak after rating) counts a match by
-- the day it was played in the league's zone, as the app's period tabs now do
-- (by the device's day). A 6:30 PM PDT match is that day's, not tomorrow's.

CREATE OR REPLACE FUNCTION public._lock_season_period_unchecked(p_season_id uuid, p_period_number integer, p_snapshot_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_baseline     numeric(4,2);
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_rating   numeric(5,2);
  v_tz           text;
begin
  select league_id, name, start_date, baseline_plupr
    into v_league_id, v_season_name, v_season_start, v_baseline
    from public.league_seasons
   where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  select public._pickleague_tz_for(l.created_by) into v_tz
    from public.leagues l where l.id = v_league_id;
  v_tz := coalesce(v_tz, public._pickleague_default_tz());

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        coalesce(lpr.rating, v_baseline) as rating,
        -- Count individual games for best-of-N matches via game_scores jsonb.
        -- Falls back to 1 W or 1 L from winner_team for single-game matches.
        coalesce(sum(case
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team1' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team2' then 1
          else 0
        end), 0) as wins,
        coalesce(sum(case
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team2' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team1' then 1
          else 0
        end), 0) as losses
      from public.league_members lm
      left join public.league_player_ratings lpr
        on  lpr.league_id = v_league_id
        and lpr.user_id   = lm.user_id
      left join public.matches m
        on  m.league_id   = v_league_id
        and coalesce(m.status, 'completed') = 'completed'
        and (m.played_at at time zone v_tz)::date between v_season_start and p_snapshot_date
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

    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0.00
    end;
    v_new_rating := v_baseline + v_bonus;
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

  perform public._settle_wagers_for_period_lock(p_season_id, p_period_number);
end;
$function$;
revoke execute on function public._lock_season_period_unchecked(uuid, integer, date) from public, anon, authenticated;


-- ── 3c. og_card_tz: + 'season' (the league's zone) ─────────────────────────
-- The season link preview (mobile/api/_lib/cards.tsx, Vercel = UTC) works out
-- "period N" from today's date; now today in the league's zone, the day the
-- auto-lock uses. Same contract as before: an IANA zone name only, the
-- default when unknown; anon for the card renderer.

CREATE OR REPLACE FUNCTION public.og_card_tz(p_type text, p_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    case p_type
      when 'event'      then (select public._pickleague_tz_for(e.created_by)
                                from public.league_events e
                               where e.id = p_id and e.created_by is not null)
      when 'tournament' then (select public._pickleague_tz_for(t.created_by)
                                from public.tournaments t
                               where t.id = p_id and t.created_by is not null)
      when 'season'     then (select public._pickleague_tz_for(l.created_by)
                                from public.league_seasons s
                                join public.leagues l on l.id = s.league_id
                               where s.id = p_id and l.created_by is not null)
    end,
    public._pickleague_default_tz()
  );
$function$;
revoke execute on function public.og_card_tz(text, uuid) from public;
grant execute on function public.og_card_tz(text, uuid) to anon, authenticated;


-- ── 4. Underdog / Cinderella: the PLUPR scale ──────────────────────────────
-- Both stored PLUPR (2.000 to 5.6xx) in integer variables before taking the
-- gap, so a 3.2 beating a 4.9 was "3 vs 5" -> 2 < 100, and neither badge has
-- ever fired (production: 0 awarded; 2 of the 4 rated matches were upsets of
-- 1.0+). The 100 / 200 thresholds are ELO points, written three days after
-- the ELO -> PLUPR switch. migration_convert_to_plupr.sql set the exchange
-- rate, "100 ELO ~ 0.5 PLUPR": v1's expected score 1 / (1 + 10^(gap / 2.0))
-- gives a 0.5 gap the 64% / 36% odds of a 100-point ELO gap, and 1.0 the
-- 76% / 24% of 200. On today's model (_plupr_expected_diff = 10 tanh(gap)) a
-- 0.5 favorite is expected to win by ~4.6 points, a 1.0 favorite by ~7.6.
-- So: Underdog = beat a rating 0.5+ higher, Cinderella = 1.0+, on numeric
-- ratings. The gap is still the nominal players' ratings (player1/2_rating_
-- before; a doubles match stores no partner rating), rounded to 2 places,
-- and the context prints it that way: "Beat a +1.78 favorite on 2026-10-12".

CREATE OR REPLACE FUNCTION public._award_cinderella_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_winner_rating numeric;
  v_loser_rating  numeric;
  v_diff          numeric;
  v_played        date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
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

    v_diff := round(v_loser_rating - v_winner_rating, 2);
    if v_diff < 1.0 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        perform public.award_profile_badge(
          v_uid, 'Cinderella',
          format('Beat a +%s favorite on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;
revoke execute on function public._award_cinderella_badge() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public._award_underdog_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_winner_rating numeric;
  v_loser_rating  numeric;
  v_diff          numeric;
  v_played        date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
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

    v_diff := round(v_loser_rating - v_winner_rating, 2);
    if v_diff < 0.5 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        perform public.award_profile_badge(
          v_uid, 'Underdog',
          format('Beat a +%s opponent on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;
revoke execute on function public._award_underdog_badge() from public, anon, authenticated;

-- The badge copy and criteria said "100+ / 200+ PLUPR" (ELO numbers). Nothing
-- reads criteria.min_diff; it is kept in step for the record.
update public.badges
   set description = 'Won a match against a team rated 0.5+ PLUPR higher. Stacks per upset.',
       criteria    = '{"type":"rating_upset","min_diff":0.5}'::jsonb
 where name = 'Underdog';
update public.badges
   set description = 'Won a match against a team rated 1.0+ PLUPR higher. Stacks per upset.',
       criteria    = '{"type":"rating_upset","min_diff":1.0}'::jsonb
 where name = 'Cinderella';
