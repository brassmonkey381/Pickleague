-- migration_mlp_dreambreaker_not_personal.sql (PKL-086)
-- A rotating Dreambreaker stores only each order's first player in team1_player1 / team2_player1, so it showed up as
-- a personal match for that one player ("your match 1 of 12", "Up next: the Dreambreaker") and for nobody else. It is
-- a team game kept out of player stats (Brian: "doesn't count in stats"), so the per-player match list skips it.
-- Found by the PKL-060 R2 rehearsal after the PKL-086 ship.

CREATE OR REPLACE FUNCTION public._pl_tm_player_matches(p_tournament uuid, p_user uuid)
 RETURNS TABLE(match_id uuid, pos integer, total integer, is_open boolean, round_label text, round_type text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.id,
         (row_number() over (order by
            case when t.format in ('single_elimination', 'double_elimination') then 0 else coalesce(r.round_number, 0) end,
            case when t.format in ('single_elimination', 'double_elimination') then m.created_at end,
            m.match_order, m.created_at, m.id))::int,
         (count(*) over ())::int,
         m.status not in ('completed', 'cancelled'),
         r.label, r.round_type
    from public.tournament_matches m
    left join public.tournament_rounds r on r.id = m.round_id
    join public.tournaments t on t.id = m.tournament_id
   where m.tournament_id = p_tournament
     and m.status <> 'cancelled'
     and m.team1_player1 is not null and m.team2_player1 is not null
     and p_user in (m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2)
     -- PKL-086: a rotating Dreambreaker is a team game: in no player's "match k of N" or "Up next"
     and not (coalesce(m.is_dreambreaker, false) and m.db_order_team1 is not null)
$function$;
