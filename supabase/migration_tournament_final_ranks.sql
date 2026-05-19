-- Tournament final ranks: explicit finishing position per entrant per
-- tournament. tournament_champion_badges only reliably records rank-1, so
-- wagers on 2nd/3rd/Nth couldn't settle correctly. This table holds the
-- derived rank for everyone in every completed tournament.
--
-- Population: compute_tournament_final_ranks(tournament_id) runs at
-- tournament-completion time (called from _settle_wagers_for_tournament)
-- and is also exposed for ad-hoc recomputes.
--
-- Heuristic: sum wins/losses across all completed tournament_matches per
-- entrant, sort by (wins desc, losses asc, profiles.rating desc), then
-- override rank=1 with any explicit tournament_champion_badges row to
-- defend against rare advancement edge cases.

create table if not exists public.tournament_final_ranks (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  final_rank    int  not null check (final_rank > 0),
  wins          int  not null default 0,
  losses        int  not null default 0,
  computed_at   timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create index if not exists tournament_final_ranks_user_idx
  on public.tournament_final_ranks (user_id);

alter table public.tournament_final_ranks enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_final_ranks' and policyname='Final ranks readable by everyone') then
    create policy "Final ranks readable by everyone"
      on public.tournament_final_ranks for select using (true);
  end if;
end $$;

create or replace function public.compute_tournament_final_ranks(p_tournament_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  delete from tournament_final_ranks where tournament_id = p_tournament_id;

  with entrants as (
    select tr.user_id
      from tournament_registrations tr
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
  ),
  match_outcomes as (
    select tm.* from tournament_matches tm
     where tm.tournament_id = p_tournament_id
       and coalesce(tm.status, 'completed') = 'completed'
       and tm.winner_team in ('team1','team2')
  ),
  per_user as (
    select
      e.user_id,
      coalesce(sum(case
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team1' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team2' then 1
        else 0
      end), 0) as wins,
      coalesce(sum(case
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team2' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team1' then 1
        else 0
      end), 0) as losses
    from entrants e
    left join match_outcomes mo
      on e.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
    group by e.user_id
  ),
  ranked as (
    select
      pu.user_id,
      pu.wins,
      pu.losses,
      row_number() over (
        order by pu.wins desc, pu.losses asc, coalesce(p.rating, 0) desc
      ) as rk
    from per_user pu
    left join profiles p on p.id = pu.user_id
  ),
  champion_row as (
    select user_id from tournament_champion_badges
     where tournament_id = p_tournament_id
     limit 1
  ),
  with_champion as (
    select
      r.user_id,
      r.wins,
      r.losses,
      case
        when (select user_id from champion_row) is null then r.rk
        when r.user_id = (select user_id from champion_row) then 1
        when r.rk = 1 then 2
        else r.rk
      end as rk
    from ranked r
  )
  insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
  select p_tournament_id, user_id, rk, wins, losses
    from with_champion;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

grant execute on function public.compute_tournament_final_ranks(uuid) to authenticated;

-- Backfill every already-completed tournament.
do $$
declare
  t record;
begin
  for t in select id from tournaments where status = 'completed' loop
    perform public.compute_tournament_final_ranks(t.id);
  end loop;
end $$;
