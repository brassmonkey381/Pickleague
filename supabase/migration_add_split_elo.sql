-- Split ELO + location ratings
-- Run in Supabase SQL Editor

-- 1. Add split ratings to profiles
alter table public.profiles
  add column if not exists singles_rating integer not null default 1000,
  add column if not exists doubles_rating integer not null default 1000;

-- Initialize to current overall rating
update public.profiles set singles_rating = rating, doubles_rating = rating;

-- 2. Player location ratings table
create table if not exists public.player_location_ratings (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  location_name text not null,
  match_type    text not null check (match_type in ('singles', 'doubles')),
  rating        integer not null default 1000,
  wins          integer not null default 0,
  losses        integer not null default 0,
  updated_at    timestamptz default now(),
  unique(user_id, location_name, match_type)
);

alter table public.player_location_ratings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='player_location_ratings' and policyname='Location ratings viewable by everyone') then
    create policy "Location ratings viewable by everyone" on public.player_location_ratings for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='player_location_ratings' and policyname='Users can manage own location ratings') then
    create policy "Users can manage own location ratings" on public.player_location_ratings for all using (auth.uid() = user_id);
  end if;
end $$;

-- 3. Update ELO trigger to also update split ratings
create or replace function public.update_elo_ratings()
returns trigger language plpgsql security definer as $$
declare
  r1        integer; r_p1  integer := 0;
  r2        integer; r_p2  integer := 0;
  sr1       integer; sr2   integer; -- split ratings
  team1_avg float;   team2_avg float;
  expected1 float;
  k         integer := 32;
  delta1    integer; delta2 integer;
  won1      boolean;
begin
  select rating into r1 from public.profiles where id = new.player1_id;
  select rating into r2 from public.profiles where id = new.player2_id;

  if new.match_type = 'doubles' then
    if new.partner1_id is not null then
      select rating into r_p1 from public.profiles where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      select rating into r_p2 from public.profiles where id = new.partner2_id;
    end if;
    team1_avg := (r1 + r_p1)::float / 2.0;
    team2_avg := (r2 + r_p2)::float / 2.0;
    -- Use split ratings for expected score
    select doubles_rating into sr1 from public.profiles where id = new.player1_id;
    select doubles_rating into sr2 from public.profiles where id = new.player2_id;
  else
    team1_avg := r1::float;
    team2_avg := r2::float;
    select singles_rating into sr1 from public.profiles where id = new.player1_id;
    select singles_rating into sr2 from public.profiles where id = new.player2_id;
  end if;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
  won1      := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  delta1    := round(k * (case when won1 then 1.0 else 0.0 end - expected1));
  delta2    := -delta1;

  -- Snapshot overall ratings
  new.player1_rating_before := r1;
  new.player2_rating_before := r2;
  new.player1_rating_after  := r1 + delta1;
  new.player2_rating_after  := r2 + delta2;

  -- Update overall ratings
  update public.profiles set rating = r1 + delta1 where id = new.player1_id;
  update public.profiles set rating = r2 + delta2 where id = new.player2_id;

  -- Update split ratings
  if new.match_type = 'singles' then
    update public.profiles set singles_rating = singles_rating + delta1 where id = new.player1_id;
    update public.profiles set singles_rating = singles_rating + delta2 where id = new.player2_id;
  else
    update public.profiles set doubles_rating = doubles_rating + delta1 where id = new.player1_id;
    update public.profiles set doubles_rating = doubles_rating + delta2 where id = new.player2_id;
    if new.partner1_id is not null then
      update public.profiles set rating = r_p1 + delta1, doubles_rating = doubles_rating + delta1 where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set rating = r_p2 + delta2, doubles_rating = doubles_rating + delta2 where id = new.partner2_id;
    end if;
  end if;

  return new;
end;
$$;
