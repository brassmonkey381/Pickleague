-- ============================================================
-- Time-based progress badges (Veteran) auto-award
--
-- _award_progress_badges (migration_progress_badge_triggers.sql) only runs
-- on match insert (trg_progress_check_on_match) and on rating update
-- (trg_progress_check_on_rating). The Veteran badge is purely TIME-based
-- ("30+ days as a member"), so a player who crosses 30 days without playing
-- a new match or having their PLUPR move never gets it awarded: the
-- Profile / UnlockProgress bar reads 30/30 (client-computed) but there's no
-- player_badges row, so the +1 tag slot (computeMaxTagSlots, which keys off
-- earned badges) never unlocks.
--
-- Fix: a daily pg_cron job that re-evaluates every profile, plus a one-time
-- backfill so currently-eligible players are granted immediately.
--
-- SIDE EFFECT: each newly-awarded badge fires _grant_pickles_on_badge
-- (+50 pickles + a shop notification) — the normal badge-earn reward. The
-- backfill below will therefore send that to every player who has crossed a
-- threshold since the last backfill (mostly time-based Veteran).
--
-- Run AFTER: migration_progress_badge_triggers.sql
-- Requires: pg_cron (already enabled; used by auto-lock, reminders, etc.)
-- ============================================================

create extension if not exists pg_cron;

-- Evaluate every profile. Covers time-only thresholds (Veteran) that the
-- match/rating triggers never re-check. Each per-user call is wrapped so one
-- bad row can't abort the whole sweep.
create or replace function public._award_progress_badges_all()
returns void language plpgsql security definer as $$
declare v_uid uuid;
begin
  for v_uid in select id from public.profiles loop
    begin
      perform public._award_progress_badges(v_uid);
    exception when others then null;
    end;
  end loop;
end;
$$;
grant execute on function public._award_progress_badges_all() to authenticated;

-- Daily schedule at 08:00 UTC. Drop any prior schedule first (idempotent).
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'pickleague-award-progress-badges';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end$$;

select cron.schedule(
  'pickleague-award-progress-badges',
  '0 8 * * *',                                    -- daily at 08:00 UTC
  $cmd$ select public._award_progress_badges_all(); $cmd$
);

-- One-time backfill so already-eligible players (incl. Veteran) get it now.
select public._award_progress_badges_all();

notify pgrst, 'reload schema';
