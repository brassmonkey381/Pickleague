-- Pickleague - match deletion takes back what badges actually paid (2026-10-25).
--
-- _reverse_match_side_effects (latest: migration_match_count_fix.sql) took back
-- 50 pickles per badge the deleted match awarded, but _grant_pickles_on_badge
-- has paid 150 since migration_bump_base_pickle_grants.sql (2026-05-25), so a
-- deleted match left each badge's extra 100 pickles behind. This is that body
-- with only step 3b changed: 150 per badge earned on or after 2026-05-25, 50
-- for older ones. Everything else is byte-for-byte the live definition
-- (supabase/tests/check-replaced-functions.mjs checks that before applying).
--
-- Idempotent: create or replace; the trigger that calls it is unchanged.

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
  v_refund           integer;
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
    -- For every (user, badge) row this match created, take back what
    -- _grant_pickles_on_badge paid for it (an AFTER INSERT on player_badges,
    -- so 1:1): 150 since migration_bump_base_pickle_grants.sql (2026-05-25),
    -- 50 before. v_badge_count holds the pickles to take back, not a count.
    for v_uid, v_badge_count in
      select user_id,
             sum(case when earned_at >= timestamptz '2026-05-25 00:00:00-07' then 150 else 50 end)::int
        from public.player_badges
       where source_match_id = old.id
       group by user_id
    loop
      update public.profiles
         set pickles = greatest(0, coalesce(pickles, 0) - v_badge_count)
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

        if v_remaining = 0 then
          -- Take back what the grant gave (its ledger row says how much).
          v_refund := null;
          delete from public.first_match_bonus_grants where user_id = v_uid
            returning coalesce(amount, 500) into v_refund;
          if v_refund is not null then
            update public.profiles
               set pickles = greatest(0, coalesce(pickles, 0) - v_refund)
             where id = v_uid;
          end if;
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

          if v_remaining_doub = 0 then
            v_refund := null;
            delete from public.first_doubles_bonus_grants where user_id = v_uid
              returning coalesce(amount, 150) into v_refund;
            if v_refund is not null then
              update public.profiles
                 set pickles = greatest(0, coalesce(pickles, 0) - v_refund)
               where id = v_uid;
            end if;
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
