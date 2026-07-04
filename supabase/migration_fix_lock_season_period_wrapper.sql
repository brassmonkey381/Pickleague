-- CRITICAL: client lock_season_period was a legacy implementation that
-- ranked members by their GLOBAL profile rating and then OVERWROTE every
-- member's GLOBAL PLUPR to baseline+bonus ("update profiles set rating"),
-- and never settled period-rank wagers. One tap of "lock period" by a
-- league admin wiped the global ratings of the whole roster. The modern
-- league-scoped implementation (_lock_season_period_unchecked: snapshots
-- LEAGUE ratings, soft-resets league_player_ratings, awards bonuses,
-- settles period wagers) was only reachable via the auto-lock cron.
-- Found by the league deep sweep (snapshot stored a global-scale 7.19
-- where the league rating was 3.227, and the sweep's period wagers stayed
-- open forever).
--
-- lock_season_period is now what it should always have been: the
-- permission-checked client wrapper around the real implementation.

create or replace function public.lock_season_period(p_season_id uuid, p_period_number integer, p_snapshot_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_league_id uuid;
begin
  select league_id into v_league_id from public.league_seasons where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  if not exists (
    select 1 from public.league_members
     where league_id = v_league_id
       and user_id   = auth.uid()
       and role in ('admin', 'co-admin')
  ) and not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  perform public._lock_season_period_unchecked(p_season_id, p_period_number, p_snapshot_date);
end;
$$;
