-- Run this if you already applied an earlier version of schema.sql

-- ============================================================
-- 1. League events & availability voting
-- ============================================================
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
create policy "Events viewable by everyone"         on public.league_events for select using (true);
create policy "League members can create events"    on public.league_events for insert with check (
  exists (select 1 from public.league_members where league_id = league_events.league_id and user_id = auth.uid())
);
create policy "Event creator can update"            on public.league_events for update using (auth.uid() = created_by);

create table if not exists public.event_slots (
  id         uuid default gen_random_uuid() primary key,
  event_id   uuid references public.league_events(id) on delete cascade not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz default now()
);
alter table public.event_slots enable row level security;
create policy "Slots viewable by everyone"      on public.event_slots for select using (true);
create policy "Event creator can insert slots"  on public.event_slots for insert with check (
  exists (select 1 from public.league_events where id = event_slots.event_id and created_by = auth.uid())
);

create table if not exists public.event_slot_votes (
  id       uuid default gen_random_uuid() primary key,
  slot_id  uuid references public.event_slots(id) on delete cascade not null,
  user_id  uuid references public.profiles(id) on delete cascade not null,
  voted_at timestamptz default now(),
  unique(slot_id, user_id)
);
alter table public.event_slot_votes enable row level security;
create policy "Votes viewable by everyone" on public.event_slot_votes for select using (true);
create policy "Users can cast votes"       on public.event_slot_votes for insert with check (auth.uid() = user_id);
create policy "Users can retract votes"    on public.event_slot_votes for delete using (auth.uid() = user_id);

-- ============================================================
-- 2. Doubles support on matches
-- ============================================================
alter table public.matches
  add column if not exists match_type  text not null default 'singles',
  add column if not exists partner1_id uuid references public.profiles(id),
  add column if not exists partner2_id uuid references public.profiles(id),
  add column if not exists winner_team text;

alter table public.matches drop constraint if exists matches_match_type_check;
alter table public.matches add constraint matches_match_type_check check (match_type in ('singles', 'doubles'));
alter table public.matches drop constraint if exists matches_winner_team_check;
alter table public.matches add constraint matches_winner_team_check check (winner_team in ('team1', 'team2'));

-- Drop old trigger and replace with doubles-aware version
drop trigger if exists on_match_created   on public.matches;
drop trigger if exists on_match_completed on public.matches;

create or replace function public.update_elo_ratings()
returns trigger language plpgsql security definer as $$
declare
  r1        integer; r_p1  integer := 0;
  r2        integer; r_p2  integer := 0;
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
  else
    team1_avg := r1;
    team2_avg := r2;
  end if;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
  won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  delta1 := round(k * (case when won1 then 1.0 else 0.0 end - expected1));
  delta2 := -delta1;

  new.player1_rating_before := r1;
  new.player2_rating_before := r2;
  new.player1_rating_after  := r1 + delta1;
  new.player2_rating_after  := r2 + delta2;

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

create trigger on_match_completed
  before insert on public.matches
  for each row execute procedure public.update_elo_ratings();

-- Remove old scheduled match support (no longer needed)
alter table public.matches drop column if exists scheduled_at;
alter table public.matches drop column if exists status;
