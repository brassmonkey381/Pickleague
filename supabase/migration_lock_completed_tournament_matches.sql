-- Completed tournament matches are immutable.
--
-- Found by the ugly-path sweep: the "Participants can update scores" RLS
-- policy has no status guard, so EITHER player of a completed match could
-- rewrite its winner/score afterwards — after PLUPR was applied, wagers
-- settled, and the advancement trigger had already seeded the next round
-- with the original winner. The creator policy allowed the same (plus
-- deletes), just less adversarially. Nothing recomputes downstream, so any
-- such edit silently corrupts ratings, brackets and history.
--
-- Rule: once status = 'completed', the row is frozen (updates AND deletes)
-- for everyone but godmode / service_role. Score corrections need a real
-- reverse-cascade feature; until then they're an explicit admin repair.
-- Cascade deletes from tournament deletion arrive as service_role/godmode,
-- so cleanup paths are unaffected.

create or replace function public._lock_completed_tournament_match()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status <> 'completed' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Cascaded deletes (tournament or round removal) arrive with the parent
  -- row already gone — those are cleanup, not history rewrites. Direct
  -- deletes still see the parent and get blocked below.
  if tg_op = 'DELETE' and not exists (select 1 from public.tournaments where id = old.tournament_id) then
    return old;
  end if;
  if coalesce(auth.role(), '') = 'service_role' or public.is_godmode_user() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'This match is already recorded — completed tournament matches can''t be changed. Ask the organizer if a correction is needed.';
end;
$$;
revoke execute on function public._lock_completed_tournament_match() from public, anon, authenticated;

drop trigger if exists trg_lock_completed_tournament_match on public.tournament_matches;
create trigger trg_lock_completed_tournament_match
  before update or delete on public.tournament_matches
  for each row execute function public._lock_completed_tournament_match();
