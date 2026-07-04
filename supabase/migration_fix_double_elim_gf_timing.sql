-- FIX: grand final seeded from the wrong losers-bracket round.
--
-- migration_fix_double_elim_advance.sql taught the LOSERS branch that a
-- single-winner LB round is only the LB final once its round_number reaches
-- (2K - 2) (K = WB round count). But the WINNERS branch (WB final completes
-- → "check if LB final winner exists") and _de_create_grand_final itself
-- still used the old heuristic: "last LB round with exactly one decisive
-- match". When the WB final and an LB consolidation round complete in the
-- same sweep (N=8: WB R3 + LB R3), the WB-final handler fired first, took
-- the LB R3 winner as the grand finalist, and created the GF — while the
-- real losers final (LB R4: LB R3 winner vs the WB-final loser) was created
-- afterwards and played FOR NOTHING. Found by the double-elim invariant
-- sweep: the losers-final WINNER was eliminated with one loss and the
-- losers-final LOSER reached the grand final (3 losses).
--
-- Fix in the shared helper (protects both call sites): refuse to build the
-- GF unless the candidate LB-final round is at (2K - 2) or later. The
-- premature winners-branch call becomes a no-op; the losers-branch call
-- after the true LB final completes builds the GF with the right finalist.
-- Body otherwise verbatim from migration_double_elim_advancement.sql.

create or replace function public._de_create_grand_final(
  p_tournament_id uuid,
  p_match_type    text
) returns void language plpgsql security definer as $$
declare
  v_wb_round_id   uuid;
  v_lb_round_id   uuid;
  v_wb_match      record;
  v_lb_match      record;
  v_wb_p1a uuid; v_wb_p1b uuid;
  v_lb_p1a uuid; v_lb_p1b uuid;
  v_gf_round_id   uuid;
  v_wb_rounds     integer;
  v_lb_num        integer;
begin
  select tr.id into v_wb_round_id
    from public.tournament_rounds tr
   where tr.tournament_id = p_tournament_id
     and tr.round_type    = 'winners'
     and (
       select count(*) from public.tournament_matches tm
        where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
     ) = 1
   order by tr.round_number desc
   limit 1;
  if v_wb_round_id is null then return; end if;

  select * into v_wb_match
    from public.tournament_matches
   where round_id = v_wb_round_id
     and winner_team in ('team1','team2')
   limit 1;

  select tr.id into v_lb_round_id
    from public.tournament_rounds tr
   where tr.tournament_id = p_tournament_id
     and tr.round_type    = 'losers'
     and (
       select count(*) from public.tournament_matches tm
        where tm.round_id = tr.id and tm.winner_team in ('team1','team2')
     ) = 1
     and not exists (
       select 1 from public.tournament_rounds tr2
        where tr2.tournament_id = p_tournament_id
          and tr2.round_type    = 'losers'
          and tr2.round_number  > tr.round_number
     )
   order by tr.round_number desc
   limit 1;
  if v_lb_round_id is null then return; end if;

  -- (FIX) The WB final's loser drops into LB round (2K - 2); only THAT round
  -- (or later) is the losers final. An earlier single-match consolidation
  -- round (LB R3 for N=8, LB R1 for N=4) still owes its winner a drop-in
  -- match, so seeding the GF from it plays the real losers final for nothing.
  select max(round_number) into v_wb_rounds
    from public.tournament_rounds
   where tournament_id = p_tournament_id and round_type = 'winners';
  select round_number into v_lb_num
    from public.tournament_rounds where id = v_lb_round_id;
  if v_lb_num < (2 * coalesce(v_wb_rounds, 1) - 2) then return; end if;

  select * into v_lb_match
    from public.tournament_matches
   where round_id = v_lb_round_id
     and winner_team in ('team1','team2')
   limit 1;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type    = 'grand_final'
       and round_number  = 1
  ) then return; end if;

  v_gf_round_id := public._de_get_or_create_round(
    p_tournament_id, 1, 'grand_final', 'Grand Final');

  v_wb_p1a := case when v_wb_match.winner_team = 'team1' then v_wb_match.team1_player1 else v_wb_match.team2_player1 end;
  v_wb_p1b := case when v_wb_match.winner_team = 'team1' then v_wb_match.team1_player2 else v_wb_match.team2_player2 end;
  v_lb_p1a := case when v_lb_match.winner_team = 'team1' then v_lb_match.team1_player1 else v_lb_match.team2_player1 end;
  v_lb_p1b := case when v_lb_match.winner_team = 'team1' then v_lb_match.team1_player2 else v_lb_match.team2_player2 end;

  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type,
    team1_player1, team1_player2,
    team2_player1, team2_player2,
    status
  ) values (
    p_tournament_id, v_gf_round_id, 0, p_match_type,
    v_wb_p1a, v_wb_p1b,  -- team1 = WB finalist (the "undefeated" side)
    v_lb_p1a, v_lb_p1b,  -- team2 = LB finalist
    'pending'
  );
end;
$$;
-- Internal helper — called by the advancement trigger, never by clients.
revoke execute on function public._de_create_grand_final(uuid, text) from public, anon, authenticated;
