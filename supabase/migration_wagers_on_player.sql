-- Wagers on a player: public totals, drill-down, and notify-on-wager.
--
-- "Wagered on a person" = rank wagers (tournament_rank / period_rank /
-- season_rank) whose predicate.user_id is the backed player. The wagers table
-- RLS stays private (bettor-only); these SECURITY DEFINER RPCs expose ONLY the
-- rank wagers on a target player (stake, bettor name, payout, condition) so the
-- public totals + drill-down work without opening up everyone's private bets.
-- Totals count every status except 'cancelled' (refunded).

-- ── Per-player totals, scoped to a tournament ──────────────────────────────
create or replace function public.get_tournament_wager_totals(p_tournament_id uuid)
returns table(user_id uuid, total int)
language sql
stable
security definer
set search_path = public
as $$
  select (w.predicate->>'user_id')::uuid as user_id, sum(w.stake)::int as total
  from public.wagers w
  where w.subject_type = 'tournament_rank'
    and w.subject_id = p_tournament_id
    and w.status <> 'cancelled'
    and w.predicate ? 'user_id'
  group by w.predicate->>'user_id';
$$;
grant execute on function public.get_tournament_wager_totals(uuid) to authenticated;

-- ── Per-player totals, scoped to a league (its seasons) ────────────────────
create or replace function public.get_league_wager_totals(p_league_id uuid)
returns table(user_id uuid, total int)
language sql
stable
security definer
set search_path = public
as $$
  select (w.predicate->>'user_id')::uuid as user_id, sum(w.stake)::int as total
  from public.wagers w
  join public.league_seasons ls on ls.id = w.subject_id
  where w.subject_type in ('period_rank','season_rank')
    and ls.league_id = p_league_id
    and w.status <> 'cancelled'
    and w.predicate ? 'user_id'
  group by w.predicate->>'user_id';
$$;
grant execute on function public.get_league_wager_totals(uuid) to authenticated;

-- ── Drill-down: individual wagers on a player (optionally scoped) ───────────
create or replace function public.get_wagers_on_player(
  p_user_id    uuid,
  p_scope_type text default null,   -- 'tournament' | 'league' | null (all)
  p_scope_id   uuid default null
)
returns table(
  wager_id         uuid,
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
      or (p_scope_type = 'league'
          and w.subject_type in ('period_rank','season_rank')
          and exists (select 1 from public.league_seasons ls
                       where ls.id = w.subject_id and ls.league_id = p_scope_id))
    )
  order by w.placed_at desc;
$$;
grant execute on function public.get_wagers_on_player(uuid, text, uuid) to authenticated;

-- ── Notify the backed player when someone wagers on them ───────────────────
create or replace function public.notify_wager_on_player()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_backed uuid;
  v_bettor text;
  v_scope  text;
  v_rank   int;
begin
  if new.subject_type not in ('tournament_rank','period_rank','season_rank') then
    return new;
  end if;

  begin
    v_backed := (new.predicate->>'user_id')::uuid;
  exception when others then
    return new;
  end;
  if v_backed is null or v_backed = new.user_id then
    return new;  -- no backed player, or you wagered on yourself
  end if;

  select full_name into v_bettor from public.profiles where id = new.user_id;
  v_rank := coalesce((new.predicate->>'rank')::int, 1);
  v_scope := case new.subject_type
    when 'tournament_rank' then (select name from public.tournaments where id = new.subject_id)
    else (select coalesce(ls.name, l.name || ' season')
            from public.league_seasons ls
            join public.leagues l on l.id = ls.league_id
           where ls.id = new.subject_id)
  end;

  -- entity_type='wager_on_me' so a tap deep-links to the backed player's wagers
  -- (entity_id = the backed/self user id). Auto-pushes via the notifications
  -- AFTER INSERT trigger.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    v_backed,
    '🎲 Someone wagered on you',
    format('%s staked %s 🥒 on you to finish #%s%s.',
           coalesce(v_bettor, 'Someone'), new.stake, v_rank,
           coalesce(' in ' || v_scope, '')),
    'wager', v_backed, 'wager_on_me'
  );
  return new;
exception when others then
  return new;  -- never block placing a wager
end;
$$;

drop trigger if exists trg_notify_wager_on_player on public.wagers;
create trigger trg_notify_wager_on_player
  after insert on public.wagers
  for each row execute function public.notify_wager_on_player();
