-- ============================================================
-- Match metadata: indoor/outdoor + player reliability stats
-- ============================================================

-- 1. Indoor / outdoor flag on matches (null = not recorded)
alter table public.matches
  add column if not exists is_outdoor boolean;

-- 2. Reliability inputs on profiles (maintained by trigger below)
alter table public.profiles
  add column if not exists total_matches_played integer not null default 0,
  add column if not exists last_match_at        timestamptz;

-- 3. Trigger: increment match count + update last_match_at for all 4 players
create or replace function public.update_player_match_stats()
returns trigger language plpgsql security definer as $$
begin
  update public.profiles
  set
    total_matches_played = total_matches_played + 1,
    last_match_at        = coalesce(new.played_at, now())
  where id in (
    new.player1_id,
    new.player2_id,
    new.partner1_id,
    new.partner2_id
  )
  and id is not null;
  return new;
end;
$$;

create trigger on_match_player_stats
  after insert on public.matches
  for each row execute procedure public.update_player_match_stats();

-- 4. Back-fill: set total_matches_played and last_match_at for existing players
-- (Run once; safe to re-run because of the `coalesce ... on conflict`)
update public.profiles p
set
  total_matches_played = (
    select count(*)
    from public.matches m
    where p.id in (m.player1_id, m.player2_id, m.partner1_id, m.partner2_id)
  ),
  last_match_at = (
    select max(played_at)
    from public.matches m
    where p.id in (m.player1_id, m.player2_id, m.partner1_id, m.partner2_id)
  );
