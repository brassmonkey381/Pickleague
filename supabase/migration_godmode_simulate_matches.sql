-- ============================================================
-- Godmode helper: fill all pending tournament_matches in a tournament
-- with random scores. Used for end-to-end simulation testing.
--
-- Behavior:
--   * Iterates over every pending tournament_match in match_order.
--   * Picks a random winner. Loser score is 0..9, winner score is 11.
--   * Each UPDATE fires update_plupr_for_tournament_match → PLUPR
--     applies to whichever scope (league or global) the trigger picks.
--   * On the LAST pool/RR completion, _maybe_auto_advance_mlp_playoff
--     fires → playoff rounds get generated automatically. You can then
--     re-run this function and it'll fill those playoff matches too.
-- ============================================================

create or replace function public.godmode_simulate_fill_matches(
  p_tournament_id uuid
) returns integer language plpgsql security definer as $$
declare
  v_uid          uuid := auth.uid();
  v_match        record;
  v_team1_won    boolean;
  v_win_score    integer := 11;
  v_loss_score   integer;
  v_filled       integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then
    raise exception 'Only godmode users can simulate match fills';
  end if;

  for v_match in (
    select id from public.tournament_matches
     where tournament_id = p_tournament_id
       and status = 'pending'
       and team1_player1 is not null
       and team2_player1 is not null
     order by match_order
  ) loop
    v_team1_won  := random() < 0.5;
    v_loss_score := floor(random() * 10)::int;  -- 0..9

    update public.tournament_matches
       set team1_score = case when v_team1_won then v_win_score else v_loss_score end,
           team2_score = case when v_team1_won then v_loss_score else v_win_score end,
           winner_team = case when v_team1_won then 'team1' else 'team2' end,
           status      = 'completed'
     where id = v_match.id;

    v_filled := v_filled + 1;
  end loop;

  return v_filled;
end;
$$;

revoke all on function public.godmode_simulate_fill_matches(uuid) from public;
grant execute on function public.godmode_simulate_fill_matches(uuid) to authenticated;
