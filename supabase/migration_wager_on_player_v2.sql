-- Wagers-on-a-player, follow-up:
--   • get_wagers_on_player now returns the bettor's id (so the drill-down can
--     link to who placed it) and supports a 'season' scope.
--   • get_season_wager_totals: per-player totals scoped to one league season,
--     for the badge on the season-standings page.
--
-- Apply AFTER migration_wagers_on_player.sql.

-- Return-type changes require a drop+recreate.
drop function if exists public.get_wagers_on_player(uuid, text, uuid);
create or replace function public.get_wagers_on_player(
  p_user_id    uuid,
  p_scope_type text default null,   -- 'tournament' | 'league' | 'season' | null
  p_scope_id   uuid default null
)
returns table(
  wager_id         uuid,
  bettor_id        uuid,
  bettor_name      text,
  stake            int,
  potential_payout int,
  odds             numeric,
  status           text,
  rank             int,
  subject_type     text,
  scope_name       text,
  placed_at        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.id,
    w.user_id,
    coalesce(p.full_name, 'Someone'),
    w.stake,
    w.potential_payout,
    w.odds,
    w.status,
    coalesce((w.predicate->>'rank')::int, 1),
    w.subject_type,
    case w.subject_type
      when 'tournament_rank' then (select t.name from public.tournaments t where t.id = w.subject_id)
      else (select coalesce(ls.name, l.name || ' season')
              from public.league_seasons ls
              join public.leagues l on l.id = ls.league_id
             where ls.id = w.subject_id)
    end,
    w.placed_at
  from public.wagers w
  left join public.profiles p on p.id = w.user_id
  where w.subject_type in ('tournament_rank','period_rank','season_rank')
    and w.predicate->>'user_id' = p_user_id::text
    and w.status <> 'cancelled'
    and (
      p_scope_type is null
      or (p_scope_type = 'tournament'
          and w.subject_type = 'tournament_rank'
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'season'
          and w.subject_type in ('period_rank','season_rank')
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'league'
          and w.subject_type in ('period_rank','season_rank')
          and exists (select 1 from public.league_seasons ls
                       where ls.id = w.subject_id and ls.league_id = p_scope_id))
    )
  order by w.placed_at desc;
$$;
grant execute on function public.get_wagers_on_player(uuid, text, uuid) to authenticated;

-- Per-player totals scoped to one league season.
create or replace function public.get_season_wager_totals(p_season_id uuid)
returns table(user_id uuid, total int)
language sql
stable
security definer
set search_path = public
as $$
  select (w.predicate->>'user_id')::uuid as user_id, sum(w.stake)::int as total
  from public.wagers w
  where w.subject_type in ('period_rank','season_rank')
    and w.subject_id = p_season_id
    and w.status <> 'cancelled'
    and w.predicate ? 'user_id'
  group by w.predicate->>'user_id';
$$;
grant execute on function public.get_season_wager_totals(uuid) to authenticated;
