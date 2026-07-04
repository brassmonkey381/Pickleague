-- Require complete teams of 2 in doubles tournament matches.
--
-- Bug: doubles draws could be generated with half-filled teams (player1 set,
-- player2 null on one or both sides), producing matches that play out as 1v1
-- inside a doubles tournament. Two client paths allowed it:
--   • TournamentDetail's generate silently random-paired leftover players
--     without persisting (and dropped an odd player) — fixed client-side, and
--   • the toolbox flow simulator generated per-player draws for doubles —
--     fixed in simulations/simulate-flows.ts.
-- This trigger is the DB backstop so no future client can recreate the state.
--
-- Rule (doubles rows only): a team is either complete (both players) or fully
-- empty (a BYE side). Half-filled teams are rejected.
--   • BYE rows in elimination draws keep working (whole side null).
--   • Rotating partners always emits full foursomes (BYE pairs are dropped by
--     the generator), MLP schedule rows carry two tokens per side — both pass.
--   • Singles rows are untouched (e.g. MLP dreambreaker slots).
-- INSERT-only on purpose: bracket-advancement triggers UPDATE these rows and
-- always copy complete teams; scoping to insert avoids any interference there.
--
-- Idempotent: create or replace + drop trigger if exists.

create or replace function public._require_complete_doubles_teams()
returns trigger
language plpgsql
as $$
begin
  if new.match_type = 'doubles' then
    if (new.team1_player1 is null) <> (new.team1_player2 is null)
    or (new.team2_player1 is null) <> (new.team2_player2 is null) then
      raise exception
        'Doubles matches require complete teams of 2 (or an entirely empty side for a BYE). Pair every player before generating the draw.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_require_complete_doubles_teams on public.tournament_matches;
create trigger trg_require_complete_doubles_teams
  before insert on public.tournament_matches
  for each row execute function public._require_complete_doubles_teams();
