-- migration_tournament_bye_stale.sql: PKL-043 fix. No "Bye this round" alert for a round already over.
--
-- The PKL-043 live run (2026-11-19, runq 75390a, tournament 3cab2ab0) caught it:
-- with named courts the queue calls a match as soon as its players are free,
-- so round 8 was played at 21:38Z but round 7 finished at 22:00:58Z, and that
-- sent Brian "You sit out round 8" twenty minutes after round 8 was over.
-- Rule now: when a round finishes, skip the bye alerts for the next round if
-- every match of it is already completed or cancelled.
-- Same function as migration_tournament_bye_runs.sql otherwise. Safe to re-run.

create or replace function public._pl_tm_bye_notices(p_match uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t     record;
  v_m     record;
  v_r     integer;
  v_next  integer;
  v_first uuid;
  v_uid   uuid;
  v_bye   integer[];
  v_run   integer[];
  v_txt   text;
begin
  select tournament_id, round_id into v_m from public.tournament_matches where id = p_match;
  select id, name, status into v_t from public.tournaments where id = v_m.tournament_id;
  if v_t.id is null or v_t.status <> 'active' then return; end if;
  v_r := public._pl_tm_round_of(p_match);
  if v_r is null then return; end if;
  -- The round is done only when every match of it is completed or cancelled.
  if exists (select 1 from public._pl_tm_schedule(v_t.id) s
               join public.tournament_matches m on m.id = s.match_id
              where s.round_id is not distinct from v_m.round_id and s.play_round = v_r
                and m.status not in ('completed', 'cancelled')) then
    return;
  end if;
  v_next := v_r + 1;
  select s.match_id into v_first from public._pl_tm_schedule(v_t.id) s
   where s.round_id is not distinct from v_m.round_id and s.play_round = v_next
   order by s.match_order limit 1;
  if v_first is null then return; end if;   -- no next round
  -- With named courts the queue can play a later round early. If the next
  -- round is already over, a "Bye this round" alert for it is stale: skip it.
  if not exists (select 1 from public._pl_tm_schedule(v_t.id) s
                   join public.tournament_matches m on m.id = s.match_id
                  where s.round_id is not distinct from v_m.round_id and s.play_round = v_next
                    and m.status not in ('completed', 'cancelled')) then
    return;
  end if;

  for v_uid in
    select distinct u.u
      from public._pl_tm_schedule(v_t.id) s
      join public.tournament_matches m on m.id = s.match_id
      cross join lateral (values (m.team1_player1), (m.team1_player2), (m.team2_player1), (m.team2_player2)) u(u)
     where s.round_id is not distinct from v_m.round_id and u.u is not null
  loop
    begin
      v_bye := public._pl_tm_byes(v_t.id, v_uid);
      if not (v_next = any(v_bye)) then continue; end if;
      -- Already told: this round was a bye too, so the alert for this run went
      -- out when it began (or the first-match alert named a round-1 bye).
      if v_r = any(v_bye) then continue; end if;
      -- The run of consecutive byes that starts at v_next.
      select array_agg(b order by b) into v_run
        from unnest(v_bye) b
       where b >= v_next
         and b - v_next = (select count(*) from unnest(v_bye) c where c >= v_next and c < b);
      v_txt := public._pl_tm_next_text(v_t.id, v_uid, false);
      perform public._pl_tm_notice(
        v_uid, 'tm_bye', v_first, v_t.id,
        '🪑 Bye this round in ' || v_t.name,
        'You sit out ' || public._pl_tm_rounds_text(v_run) || '. '
          || coalesce(v_txt, 'Your matches are done; the final table comes when the last round is scored.'));
    exception when others then
      raise warning 'bye notice for % failed: %', v_uid, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public._pl_tm_bye_notices(uuid) from public, anon, authenticated;
