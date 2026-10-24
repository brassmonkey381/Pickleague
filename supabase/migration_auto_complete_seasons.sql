-- ============================================================
-- Seasons complete themselves (2026-10-24). Needs
-- migration_fix_complete_season_league_scoped.sql (complete_season's body,
-- checked against live 2026-10-24: identical), migration_time_zones.sql
-- (_pickleague_tz_for) and migration_auto_lock_periods.sql (pg_cron) first.
-- Idempotent: create or replace, and the cron job is unscheduled before it
-- is scheduled again.
--
-- The bug: a season's periods lock on their own (pickleague-auto-lock-periods,
-- hourly at :05), but nothing ever COMPLETED a season. Only an admin's
-- "Complete season" button (SeasonStandingsScreen) called complete_season, so
-- a season whose admin never pressed it stayed 'active' forever: the league
-- page said "Final standings soon" with no date, no final standings or
-- Season Crown / Silver / Bronze were saved, the end-of-season PLUPR reset
-- never ran, and the admin could not start the next season (LeagueDetail only
-- offers "Start a season" when none is active). Live on 2026-10-24: The
-- League, Season 1 (May 27 - Aug 19, all 12 periods locked) was still active
-- two months after its end.
--
--   1. _complete_season_unchecked(uuid): complete_season's body without the
--      admin check (the lock_season_period / _lock_season_period_unchecked
--      split). One change: the season row is read FOR UPDATE, so an admin's
--      press and the job can never both complete (and reset) one season; the
--      second waits, then gets "ELO reset has already been applied".
--   2. complete_season(uuid): the same auth check and errors in the same
--      order, then the helper. Grants untouched (create or replace keeps them).
--      One security fix: a signed-out / anon caller is now refused. The old
--      check went NULL for them (is_godmode_user() is NULL without a user) and
--      let them complete any season; see section 2.
--   3. auto_complete_due_seasons(): completes every 'active' season whose
--      end_date has PASSED in the league's local day (its creator's zone,
--      like auto_lock_due_periods), i.e. from 00:00 local the day after
--      end_date, once nothing due is left to lock: every period whose lock
--      date has arrived is locked, and at least one is (complete_season
--      refuses a season with no snapshots). A season with a due period still
--      unlocked waits for the auto-lock (:05) and is completed by the next run.
--      Each season runs in its own subtransaction: one that fails is rolled
--      back, logged with RAISE WARNING and retried next hour; the others still
--      complete. (auto_lock_due_periods has no per-season guard, so one bad
--      season stops that whole run; this one does not copy that.)
--   4. Its own cron job, pickleague-auto-complete-seasons, hourly at :08.
--      Separate from the auto-lock job, as every scheduled job here is (one
--      job per function, unscheduled then scheduled): a failing lock run then
--      never blocks completions, and auto_lock_due_periods is not rewritten.
--      :08 runs after the :05 lock, so a season whose last lock is due is
--      locked first. In practice the last lock falls on end_date (when the
--      weeks divide evenly), a day before the season is due here.
--
-- Everything complete_season does still happens, through the same code: the
-- median-rank final standings (season_final_standings), the league-scoped
-- PLUPR reset (baseline + 0.20 / 0.15 / 0.10 / 0.05 / 0.02), the Season Crown
-- / Silver / Bronze and Period Sweeper badges, and through the player_badges
-- triggers the +150 pickles, the "+150 pickles" notification (and its push)
-- and badge-unlocked shop items. Not automatic (unchanged): handing out a
-- season pot (distribute_season_pool stays an admin action).
--
-- Cutover: the first run after this is applied completes every active season
-- already past its end (live 2026-10-24: The League, Season 1 only), with its
-- reset applied late: league ratings (league_player_ratings) for that league
-- go to baseline + final-rank bonus, replacing whatever league matches since
-- its last lock moved them to. Global PLUPR (profiles) is never touched.
--
-- Grants: both new functions are internal (no client EXECUTE; service_role
-- keeps it, as the hardening sweep gives every SECURITY DEFINER function).
-- complete_season stays in migration_rls_hardening_2026q3.sql's allowlist.
--
-- Apply:  supabase db query --linked -f supabase/migration_auto_complete_seasons.sql
-- Test:   node supabase/tests/build-auto-complete-seasons-test.mjs <out.sql>
--         supabase db query --linked -f <out.sql> -o csv   (rolled back)
-- ============================================================


-- ── 1. The body, without the admin check ───────────────────────────────────
-- complete_season (migration_fix_complete_season_league_scoped.sql) from
-- "Season not found" on, minus the admin check, plus FOR UPDATE on the
-- season row. search_path '': every name below is schema-qualified, and so
-- are the ones in award_league_badge and the player_badges triggers it fires
-- (_grant_pickles_on_badge, _notify_user, _grant_unlock_items_on_badge),
-- which inherit it.
create or replace function public._complete_season_unchecked(p_season_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_baseline     numeric(4,2);
  v_reset_done   boolean;
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_plupr    numeric(5,2);
  v_badge        text;
begin
  -- FOR UPDATE: a second caller (the admin's button and the hourly job at
  -- once) waits here, then reads elo_reset_applied = true and stops.
  select league_id, name, baseline_plupr, elo_reset_applied
    into v_league_id, v_season_name, v_baseline, v_reset_done
    from public.league_seasons
    where id = p_season_id
    for update;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if v_reset_done then
    raise exception 'ELO reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one period before completing the season';
  end if;

  select count(distinct period_number) into v_period_count
    from public.season_snapshots
    where season_id = p_season_id;

  for v_player in (
    with medians as (
      select
        user_id,
        percentile_cont(0.5) within group (order by rank_at_snapshot) as median_rank
      from public.season_snapshots
      where season_id = p_season_id
      group by user_id
    )
    select user_id, median_rank
      from medians
      order by median_rank asc
  ) loop
    v_rank  := v_rank + 1;
    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0
    end;
    v_new_plupr := v_baseline + v_bonus;

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_plupr
    ) on conflict (season_id, user_id) do update
      set final_rank  = excluded.final_rank,
          median_rank = excluded.median_rank,
          elo_bonus   = excluded.elo_bonus,
          new_elo     = excluded.new_elo;

    -- LEAGUE-scoped end-of-season soft reset. Mirrors the period-lock reset
    -- across every rating facet; global profiles.rating is untouched.
    update public.league_player_ratings
       set rating               = v_new_plupr,
           singles_rating       = v_new_plupr,
           doubles_rating       = v_new_plupr,
           mixed_doubles_rating = v_new_plupr,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_player.user_id;

    v_badge := case v_rank
      when 1 then 'Season Crown'
      when 2 then 'Season Silver'
      when 3 then 'Season Bronze'
      else null end;
    if v_badge is not null then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, v_badge, v_season_name
      );
    end if;

    if exists (
      select 1
      from   public.season_snapshots
      where  season_id = p_season_id
        and  user_id   = v_player.user_id
      group  by user_id
      having count(*) filter (where rank_at_snapshot = 1) = count(*)
         and count(*) >= 1
    ) then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, 'Period Sweeper', v_season_name
      );
    end if;
  end loop;

  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;
revoke execute on function public._complete_season_unchecked(uuid) from public, anon, authenticated;
grant execute on function public._complete_season_unchecked(uuid) to service_role;


-- ── 2. complete_season: the admin check, then the body ─────────────────────
-- Same errors in the same order as before: Season not found, then the admin
-- check (admins / co-admins, God mode, service_role), then the helper's.
-- One fix (found by this file's test, G3): the check was
--   not exists (admin row) and not public.is_godmode_user() and role <> 'service_role'
-- and is_godmode_user() is NULL when auth.uid() is null (signed out, or the
-- anon key, which has EXECUTE here). NULL made the whole condition NULL, so
-- the raise was skipped and ANY signed-out caller could complete ANY season
-- (and reset its league's ratings). Now a NULL counts as "not God mode".
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id uuid;
begin
  select league_id into v_league_id
    from public.league_seasons
    where id = p_season_id;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if not exists (
    select 1 from public.league_members
    where  league_id = v_league_id
      and  user_id   = auth.uid()
      and  role in ('admin', 'co-admin')
  ) and not coalesce(public.is_godmode_user(), false) and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only admins and co-admins can complete a season';
  end if;

  perform public._complete_season_unchecked(p_season_id);
end;
$$;


-- ── 3. The walker ──────────────────────────────────────────────────────────
-- Returns how many seasons it completed. "Due": active, reset not applied,
-- end_date before today in the league's zone, every period whose lock date
-- has arrived locked, and at least one period locked.
create or replace function public.auto_complete_due_seasons()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season    record;
  v_today     date;
  v_completed integer := 0;
begin
  for v_season in (
    select s.id, s.name, s.start_date, s.end_date, s.total_periods, s.lock_frequency_weeks,
           public._pickleague_tz_for(l.created_by) as tz
      from public.league_seasons s
      left join public.leagues l on l.id = s.league_id
     where s.status = 'active'
       and not s.elo_reset_applied
     order by s.end_date, s.id
  ) loop
    -- Today in the league's zone (no creator / no stored zone: the default).
    v_today := (now() at time zone v_season.tz)::date;
    -- Not over yet: the season runs to the end of its end_date.
    continue when v_season.end_date >= v_today;
    -- Nothing locked at all: complete_season would refuse it.
    continue when not exists (
      select 1 from public.season_snapshots where season_id = v_season.id
    );
    -- A period whose lock date has arrived is still unlocked: the auto-lock
    -- (:05) takes it first; the next run completes the season.
    continue when exists (
      select 1
        from generate_series(1, coalesce(v_season.total_periods, 0)) as g(p)
       where v_season.start_date + g.p * v_season.lock_frequency_weeks * 7 <= v_today
         and not exists (
           select 1 from public.season_snapshots ss
            where ss.season_id = v_season.id and ss.period_number = g.p
         )
    );

    begin
      -- Re-checked under a row lock: an admin completing it right now holds
      -- the row (skip it), or has just completed it (no longer active).
      perform 1 from public.league_seasons
        where id = v_season.id and status = 'active' and not elo_reset_applied
        for update skip locked;
      if found then
        perform public._complete_season_unchecked(v_season.id);
        v_completed := v_completed + 1;
      end if;
    exception when others then
      -- Rolled back to the start of this block (this season only); retried
      -- next run.
      raise warning 'auto_complete_due_seasons: season % (%) not completed: %',
        v_season.id, v_season.name, sqlerrm;
    end;
  end loop;

  return v_completed;
end;
$$;
revoke execute on function public.auto_complete_due_seasons() from public, anon, authenticated;
grant execute on function public.auto_complete_due_seasons() to service_role;


-- ── 4. Schedule: hourly at :08 (after the :05 auto-lock) ───────────────────
-- Unscheduled first, so a re-run replaces it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pickleague-auto-complete-seasons') then
    perform cron.unschedule('pickleague-auto-complete-seasons');
  end if;
  perform cron.schedule('pickleague-auto-complete-seasons', '8 * * * *',
    $c$ select public.auto_complete_due_seasons(); $c$);
end $$;

notify pgrst, 'reload schema';
