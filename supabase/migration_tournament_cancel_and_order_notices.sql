-- migration_tournament_cancel_and_order_notices.sql (PKL-073, PKL-074)
--
-- PKL-073: after a host cancels a group match, the alerts still counted it ("your match 3 of 6" with 5 left) and its two
-- players were never told. Now _pl_tm_player_matches leaves cancelled matches out, _pl_tm_byes counts the round of a
-- cancelled match as a bye (so the usual "Bye this round" alert goes out), and the players of a cancelled match get a
-- "Match cancelled" alert with what is next for them (not for MLP dreambreakers the server cancels itself).
--
-- PKL-074: in double elimination, "Up next … your match 1 of 4" for a 4th match: the bracket's rounds are not numbered
-- in play order. For single and double elimination a player's matches are now counted in the order they were drawn.
--
-- Seen in the PKL-060 R5 and R3 runs (2026-11-23). The rest of both functions is the live definition.

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
$function$;

CREATE OR REPLACE FUNCTION public._pl_tm_byes(p_tournament uuid, p_user uuid)
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with s as (
    select s.*, m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2
      from public._pl_tm_schedule(p_tournament) s
      join public.tournament_matches m on m.id = s.match_id
     where m.status <> 'cancelled'
  ), mine as (
    select distinct s.round_id from s
     where p_user in (s.team1_player1, s.team1_player2, s.team2_player1, s.team2_player2)
  ), span as (
    select s.round_id, max(s.play_round) as last_round from s join mine using (round_id) group by s.round_id
  )
  select coalesce(array_agg(r.n order by r.n), '{}')
    from span
    cross join lateral generate_series(1, span.last_round) r(n)
   where not exists (
     select 1 from s
      where s.round_id is not distinct from span.round_id and s.play_round = r.n
        and p_user in (s.team1_player1, s.team1_player2, s.team2_player1, s.team2_player2))
$function$;

create or replace function public._pl_tm_cancel_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t   record;
  v_uid uuid;
  v_nxt text;
begin
  if new.status <> 'cancelled' or old.status is not distinct from new.status then return null; end if;
  if coalesce(new.is_dreambreaker, false) then return null; end if;
  if new.team1_player1 is null or new.team2_player1 is null then return null; end if;
  select id, name, status into v_t from public.tournaments where id = new.tournament_id;
  if v_t.id is null or v_t.status <> 'active' then return null; end if;
  foreach v_uid in array array_remove(array[new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2], null) loop
    begin
      v_nxt := public._pl_tm_next_text(v_t.id, v_uid, false);
      perform public._pl_tm_notice(
        v_uid, 'tm_cancel', new.id, v_t.id,
        '🚫 Match cancelled in ' || v_t.name,
        public._pl_tm_line(new.id, v_uid) || ' was cancelled by the host. '
          || coalesce(v_nxt, 'You have no more matches in the schedule.'));
    exception when others then
      raise warning 'cancel notice for % failed: %', v_uid, sqlerrm;
    end;
  end loop;
  return null;
exception when others then
  raise warning 'cancel notices failed for %: %', new.id, sqlerrm;
  return null;
end $$;
revoke all on function public._pl_tm_cancel_notices() from public, anon, authenticated;

drop trigger if exists trg_tm_cancel_notices on public.tournament_matches;
create trigger trg_tm_cancel_notices
  after update of status on public.tournament_matches
  for each row execute function public._pl_tm_cancel_notices();
