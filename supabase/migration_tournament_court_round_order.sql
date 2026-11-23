-- migration_tournament_court_round_order.sql (PKL-061)
-- The court queue keeps round order (Brian, 2026-11-22: "block until called! ... we need ROUNDS of match play order,
-- even within the round robin itself. Play can go ahead if it doesnt mean another team would be skipped over the match
-- they are currently waiting on playing, and preferably any team can be at most 1 round ahead of everyone else").
-- Seen in the PKL-060 R7 live run: the queue called a round-5 match right after round 1 because the round-2 match's
-- players were busy. _pl_tm_call_next now calls a scheduled match only if none of its players has an earlier-round
-- match left in the same group and its round is at most one ahead of the group's lowest open round.
-- Scoring before a call stays blocked for players (_pl_tm_court_guard, PKL-039); the host / co-admin override stays,
-- and the app now asks them first (MatchEntryScreen). Only the candidate filter changes; the rest is the live
-- definition as of 2026-11-22.

CREATE OR REPLACE FUNCTION public._pl_tm_call_next(p_tournament uuid, p_notify boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t      record;
  v_court  text;
  v_m      record;
  v_uid    uuid;
  v_called integer := 0;
  v_label  text;
begin
  -- One caller at a time per tournament.
  select id, name, status, courts into v_t from public.tournaments where id = p_tournament for update;
  if v_t.id is null or v_t.status <> 'active' or not public._pl_tm_has_courts(p_tournament) then return 0; end if;

  foreach v_court in array array_remove(v_t.courts, '') loop
    if exists (select 1 from public.tournament_matches m
                where m.tournament_id = p_tournament and m.court = v_court and m.called_at is not null
                  and m.status not in ('completed', 'cancelled')) then
      continue;
    end if;
    -- PKL-061: round order. A scheduled match (round robin, pools, rotating partners) is called only when
    --   (a) none of its players still has a match from an earlier round of the same group to play, and
    --   (b) its round is at most one ahead of the group's lowest round with an open match.
    -- So nobody is skipped past the match they are waiting for, and no one runs more than a round ahead.
    -- Playoff matches (no schedule row) keep the old order.
    with sch as (
      select s.match_id, s.round_id, s.play_round,
             array_remove(array[m2.team1_player1, m2.team1_player2, m2.team2_player1, m2.team2_player2], null) as who,
             m2.status not in ('completed', 'cancelled') as open
        from public._pl_tm_schedule(p_tournament) s
        join public.tournament_matches m2 on m2.id = s.match_id
    )
    select m.id, m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2 into v_m
      from public.tournament_matches m
      left join public.tournament_rounds r on r.id = m.round_id
      left join sch s on s.match_id = m.id
     where m.tournament_id = p_tournament
       and (s.match_id is null or (
             not exists (select 1 from sch e
                          where e.open and e.round_id is not distinct from s.round_id and e.play_round < s.play_round
                            and e.who && s.who)
             and s.play_round <= 1 + (select min(o.play_round) from sch o
                                       where o.open and o.round_id is not distinct from s.round_id)))
       and m.status not in ('completed', 'cancelled')
       and m.called_at is null
       and coalesce(m.match_type, '') <> 'bye'
       and m.team1_player1 is not null and m.team2_player1 is not null
       and not exists (
         select 1 from public.tournament_matches b
          where b.tournament_id = p_tournament and b.called_at is not null
            and b.status not in ('completed', 'cancelled')
            and array[b.team1_player1, b.team1_player2, b.team2_player1, b.team2_player2]
                && array_remove(array[m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2], null))
     order by coalesce(r.round_number, 0), coalesce(s.play_round, 0), m.match_order, m.id
     limit 1;
    exit when v_m.id is null;   -- nothing fits; the next court can't do better

    perform set_config('pl.tm_server', '1', true);
    update public.tournament_matches set court = v_court, called_at = now() where id = v_m.id;
    perform set_config('pl.tm_server', '', true);
    v_called := v_called + 1;

    if p_notify then
      v_label := public._pl_tm_court_label(v_court);
      foreach v_uid in array array_remove(array[v_m.team1_player1, v_m.team1_player2,
                                                 v_m.team2_player1, v_m.team2_player2], null) loop
        begin
          perform public._pl_tm_notice(
            v_uid, 'tm_court', v_m.id, p_tournament,
            '🏓 You''re on ' || v_label || ' in ' || v_t.name,
            public._pl_tm_line(v_m.id, v_uid) || '. Head to ' || v_label || ' now.');
        exception when others then
          raise warning 'court notice for % failed: %', v_uid, sqlerrm;
        end;
      end loop;
    end if;
    v_m := null;
  end loop;
  return v_called;
exception when others then
  perform set_config('pl.tm_server', '', true);
  raise warning 'court queue failed for %: %', p_tournament, sqlerrm;
  return 0;
end $function$;
