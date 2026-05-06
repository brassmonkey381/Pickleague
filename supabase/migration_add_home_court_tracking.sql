-- ============================================================
-- Home court tracking columns on matches
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Add columns
alter table public.matches
  add column if not exists was_home_court boolean,
  add column if not exists is_home_court  boolean;

-- 2. Backfill existing matches
update public.matches m
set
  was_home_court = (m.location_name is not null and l.home_court is not null and m.location_name = l.home_court),
  is_home_court  = (m.location_name is not null and l.home_court is not null and m.location_name = l.home_court)
from public.leagues l
where m.league_id = l.id;

-- 3. Trigger: set flags on match INSERT
create or replace function public.set_match_home_court_flags()
returns trigger language plpgsql security definer as $$
declare v_home text;
begin
  select home_court into v_home from public.leagues where id = new.league_id;
  new.was_home_court := (new.location_name is not null and v_home is not null and new.location_name = v_home);
  new.is_home_court  := new.was_home_court;
  return new;
end;
$$;

drop trigger if exists trg_match_home_court on public.matches;
create trigger trg_match_home_court
  before insert on public.matches
  for each row execute function public.set_match_home_court_flags();

-- 4. Trigger: cascade-update is_home_court when league home court changes
create or replace function public.update_matches_is_home_court()
returns trigger language plpgsql security definer as $$
begin
  if new.home_court is distinct from old.home_court then
    update public.matches
    set is_home_court = (
      location_name is not null and
      new.home_court is not null and
      location_name = new.home_court
    )
    where league_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_league_home_court_changed on public.leagues;
create trigger trg_league_home_court_changed
  after update of home_court on public.leagues
  for each row execute function public.update_matches_is_home_court();
