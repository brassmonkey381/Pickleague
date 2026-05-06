-- Run this in the Supabase SQL Editor to fix the matches table and ELO trigger.
-- Safe to run multiple times.

-- 1. Add any missing columns to matches
alter table public.matches
  add column if not exists match_type           text not null default 'singles',
  add column if not exists partner1_id          uuid references public.profiles(id),
  add column if not exists partner2_id          uuid references public.profiles(id),
  add column if not exists winner_team          text,
  add column if not exists player1_rating_before integer,
  add column if not exists player2_rating_before integer,
  add column if not exists player1_rating_after  integer,
  add column if not exists player2_rating_after  integer;

-- 2. Add/fix constraints
alter table public.matches
  drop constraint if exists matches_match_type_check,
  drop constraint if exists matches_winner_team_check;

alter table public.matches
  add constraint matches_match_type_check  check (match_type in ('singles', 'doubles')),
  add constraint matches_winner_team_check check (winner_team in ('team1', 'team2'));

-- 3. Drop old triggers
drop trigger if exists on_match_created   on public.matches;
drop trigger if exists on_match_completed on public.matches;

-- 4. Replace ELO function (handles singles + doubles, records rating snapshots)
create or replace function public.update_elo_ratings()
returns trigger language plpgsql security definer as $$
declare
  r1        integer;
  r_p1      integer := 0;
  r2        integer;
  r_p2      integer := 0;
  team1_avg float;
  team2_avg float;
  expected1 float;
  k         integer := 32;
  delta1    integer;
  delta2    integer;
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
  else
    team1_avg := r1::float;
    team2_avg := r2::float;
  end if;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
  won1      := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  delta1    := round(k * (case when won1 then 1.0 else 0.0 end - expected1));
  delta2    := -delta1;

  -- Snapshot ratings before update
  new.player1_rating_before := r1;
  new.player2_rating_before := r2;
  new.player1_rating_after  := r1 + delta1;
  new.player2_rating_after  := r2 + delta2;

  -- Apply rating changes
  update public.profiles set rating = r1 + delta1 where id = new.player1_id;
  update public.profiles set rating = r2 + delta2 where id = new.player2_id;

  if new.match_type = 'doubles' then
    if new.partner1_id is not null then
      update public.profiles set rating = r_p1 + delta1 where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set rating = r_p2 + delta2 where id = new.partner2_id;
    end if;
  end if;

  return new;
end;
$$;

-- 5. Re-attach trigger
create trigger on_match_completed
  before insert on public.matches
  for each row execute procedure public.update_elo_ratings();

-- 6. Add league_events tables if not already there
create table if not exists public.league_events (
  id                uuid default gen_random_uuid() primary key,
  league_id         uuid references public.leagues(id) on delete cascade not null,
  title             text not null,
  description       text,
  created_by        uuid references public.profiles(id) on delete set null,
  status            text not null default 'voting' check (status in ('voting', 'scheduled', 'cancelled')),
  vote_ends_at      timestamptz not null,
  confirmed_slot_id uuid,
  created_at        timestamptz default now()
);
alter table public.league_events enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'league_events' and policyname = 'Events viewable by everyone') then
    create policy "Events viewable by everyone" on public.league_events for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'league_events' and policyname = 'League members can create events') then
    create policy "League members can create events" on public.league_events for insert with check (
      exists (select 1 from public.league_members where league_id = league_events.league_id and user_id = auth.uid())
    );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'league_events' and policyname = 'Event creator can update') then
    create policy "Event creator can update" on public.league_events for update using (auth.uid() = created_by);
  end if;
end $$;

create table if not exists public.event_slots (
  id         uuid default gen_random_uuid() primary key,
  event_id   uuid references public.league_events(id) on delete cascade not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz default now()
);
alter table public.event_slots enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'event_slots' and policyname = 'Slots viewable by everyone') then
    create policy "Slots viewable by everyone" on public.event_slots for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'event_slots' and policyname = 'Event creator can insert slots') then
    create policy "Event creator can insert slots" on public.event_slots for insert with check (
      exists (select 1 from public.league_events where id = event_slots.event_id and created_by = auth.uid())
    );
  end if;
end $$;

create table if not exists public.event_slot_votes (
  id       uuid default gen_random_uuid() primary key,
  slot_id  uuid references public.event_slots(id) on delete cascade not null,
  user_id  uuid references public.profiles(id) on delete cascade not null,
  voted_at timestamptz default now(),
  unique(slot_id, user_id)
);
alter table public.event_slot_votes enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'event_slot_votes' and policyname = 'Votes viewable by everyone') then
    create policy "Votes viewable by everyone" on public.event_slot_votes for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'event_slot_votes' and policyname = 'Users can cast votes') then
    create policy "Users can cast votes" on public.event_slot_votes for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'event_slot_votes' and policyname = 'Users can retract votes') then
    create policy "Users can retract votes" on public.event_slot_votes for delete using (auth.uid() = user_id);
  end if;
end $$;
