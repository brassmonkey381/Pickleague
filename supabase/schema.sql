-- ============================================================
-- Pickleague Database Schema  (complete, run fresh)
-- ============================================================

-- Profiles
create table public.profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  username    text unique not null,
  full_name   text not null,
  avatar_url  text,
  rating      integer not null default 1000,
  created_at  timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "Profiles viewable by everyone" on public.profiles for select using (true);
create policy "Users update own profile"      on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users for each row execute procedure public.handle_new_user();

-- Leagues
create table public.leagues (
  id          uuid default gen_random_uuid() primary key,
  name        text not null,
  description text,
  created_by  uuid references public.profiles(id) on delete set null,
  is_active   boolean default true,
  created_at  timestamptz default now()
);
alter table public.leagues enable row level security;
create policy "Leagues viewable by everyone"         on public.leagues for select using (true);
create policy "Authenticated users can create leagues" on public.leagues for insert with check (auth.uid() = created_by);
create policy "League creator can update"             on public.leagues for update using (auth.uid() = created_by);

-- League Members
create table public.league_members (
  id         uuid default gen_random_uuid() primary key,
  league_id  uuid references public.leagues(id) on delete cascade not null,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  joined_at  timestamptz default now(),
  unique(league_id, user_id)
);
alter table public.league_members enable row level security;
create policy "Members viewable by everyone" on public.league_members for select using (true);
create policy "Users can join leagues"       on public.league_members for insert with check (auth.uid() = user_id);
create policy "Users can leave leagues"      on public.league_members for delete using (auth.uid() = user_id);

-- ============================================================
-- League Events & Availability Voting
-- ============================================================

-- A proposed league play session with multiple datetime options
create table public.league_events (
  id                uuid default gen_random_uuid() primary key,
  league_id         uuid references public.leagues(id) on delete cascade not null,
  title             text not null,
  description       text,
  created_by        uuid references public.profiles(id) on delete set null,
  status            text not null default 'voting'
                      check (status in ('voting', 'scheduled', 'cancelled')),
  vote_ends_at      timestamptz not null,
  confirmed_slot_id uuid,  -- populated when voting closes
  created_at        timestamptz default now()
);
alter table public.league_events enable row level security;
create policy "Events viewable by everyone"          on public.league_events for select using (true);
create policy "League members can create events"     on public.league_events for insert with check (
  exists (select 1 from public.league_members where league_id = league_events.league_id and user_id = auth.uid())
);
create policy "Event creator can update"             on public.league_events for update using (auth.uid() = created_by);

-- Proposed time slot options for an event (2–6 slots per event)
create table public.event_slots (
  id         uuid default gen_random_uuid() primary key,
  event_id   uuid references public.league_events(id) on delete cascade not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz default now()
);
alter table public.event_slots enable row level security;
create policy "Slots viewable by everyone"       on public.event_slots for select using (true);
create policy "Event creator can insert slots"   on public.event_slots for insert with check (
  exists (select 1 from public.league_events where id = event_slots.event_id and created_by = auth.uid())
);
create policy "Event creator can delete slots"   on public.event_slots for delete using (
  exists (select 1 from public.league_events where id = event_slots.event_id and created_by = auth.uid())
);

-- Player availability votes — each row = "I can make this slot"
create table public.event_slot_votes (
  id       uuid default gen_random_uuid() primary key,
  slot_id  uuid references public.event_slots(id) on delete cascade not null,
  user_id  uuid references public.profiles(id) on delete cascade not null,
  voted_at timestamptz default now(),
  unique(slot_id, user_id)
);
alter table public.event_slot_votes enable row level security;
create policy "Votes viewable by everyone"  on public.event_slot_votes for select using (true);
create policy "Users can cast votes"        on public.event_slot_votes for insert with check (auth.uid() = user_id);
create policy "Users can retract votes"     on public.event_slot_votes for delete using (auth.uid() = user_id);

-- ============================================================
-- Matches  (singles 1v1 and doubles 2v2)
-- ============================================================
create table public.matches (
  id                    uuid default gen_random_uuid() primary key,
  league_id             uuid references public.leagues(id) on delete cascade not null,
  match_type            text not null default 'singles' check (match_type in ('singles', 'doubles')),
  -- Team 1
  player1_id            uuid references public.profiles(id) not null,
  partner1_id           uuid references public.profiles(id),  -- doubles only
  -- Team 2
  player2_id            uuid references public.profiles(id) not null,
  partner2_id           uuid references public.profiles(id),  -- doubles only
  -- Scores (per team)
  player1_score         integer check (player1_score >= 0),
  player2_score         integer check (player2_score >= 0),
  -- Result
  winner_id             uuid references public.profiles(id),  -- primary winner (singles, or team captain)
  winner_team           text check (winner_team in ('team1', 'team2')),
  status                text not null default 'completed' check (status in ('completed')),
  played_at             timestamptz default now(),
  -- ELO snapshots
  player1_rating_before integer,
  player2_rating_before integer,
  player1_rating_after  integer,
  player2_rating_after  integer,
  created_at            timestamptz default now(),
  constraint different_players check (player1_id <> player2_id)
);
alter table public.matches enable row level security;
create policy "Matches viewable by everyone"     on public.matches for select using (true);
create policy "League members can record matches" on public.matches for insert with check (
  exists (select 1 from public.league_members where league_id = matches.league_id and user_id = auth.uid())
);

-- ============================================================
-- ELO Rating Trigger
-- Handles both singles and doubles. K=32.
-- Doubles uses average team rating for expected score calc;
-- all players on a team receive the same delta.
-- ============================================================
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

  -- Store snapshots
  new.player1_rating_before := r1;
  new.player2_rating_before := r2;
  new.player1_rating_after  := r1 + delta1;
  new.player2_rating_after  := r2 + delta2;

  -- Update all players
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
