-- Auto-close must respect a configured playoff.
--
-- Bug (found by the toolbox flow simulator): _maybe_auto_close_non_elim_
-- tournament completed a round_robin / pool_play / rotating tournament the
-- moment every match was scored — without checking playoff_format. Non-elim
-- playoff generation is a MANUAL admin action, so a tournament configured
-- with a playoff auto-completed at the end of group play and the playoff
-- became unreachable (generate_playoff_bracket needs an active tournament).
--
-- Fix: when playoff_format ≠ 'none' and no playoff round exists yet
-- (round_type quarterfinals/semifinals/finals/third_place_match), group-play
-- completion leaves the tournament ACTIVE, awaiting playoff generation. Once
-- playoff rounds exist, the original close-when-nothing-pending logic applies.
--
-- Idempotent: create or replace (trigger binding unchanged).

create or replace function public._maybe_auto_close_non_elim_tournament()
returns trigger
language plpgsql
security definer
as $$
declare
  v_format   text;
  v_status   text;
  v_playoff  text;
  v_pending  integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    select format, status, coalesce(playoff_format, 'none')
      into v_format, v_status, v_playoff
      from public.tournaments where id = new.tournament_id;

    if v_format not in ('round_robin', 'pool_play', 'rotating_partners') then
      return new;
    end if;
    if v_status <> 'active' then return new; end if;

    -- A configured playoff must actually run before the tournament can close.
    if v_playoff <> 'none' and not exists (
      select 1 from public.tournament_rounds r
       where r.tournament_id = new.tournament_id
         and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
    ) then
      return new;
    end if;

    select count(*) into v_pending
      from public.tournament_matches
     where tournament_id = new.tournament_id
       and status <> 'completed';

    if v_pending = 0 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status = 'active';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$$;
