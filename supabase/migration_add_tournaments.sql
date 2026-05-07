-- ============================================================
-- Tournament system
-- Run in Supabase SQL Editor
-- ============================================================

create table if not exists public.tournaments (
  id                uuid default gen_random_uuid() primary key,
  league_id         uuid references public.leagues(id) on delete cascade,
  name              text not null,
  description       text,
  created_by        uuid references public.profiles(id) on delete set null,
  -- Format
  format            text not null check (format in (
    'round_robin', 'single_elimination', 'double_elimination',
    'pool_play', 'mlp', 'rotating_partners'
  )),
  match_type        text not null default 'singles' check (match_type in ('singles','doubles')),
  seeding           text not null default 'random' check (seeding in ('random','elo')),
  pool_count        integer not null default 1,
  partner_rotation  text check (partner_rotation in ('every_match','every_round')),
  registration_mode text not null default 'request' check (registration_mode in ('request','invite_only')),
  max_players       integer,
  -- All tournaments are closed/private
  status            text not null default 'registration'
                      check (status in ('registration','active','completed','cancelled')),
  -- Schedule / location
  start_time        timestamptz,
  location_name     text,
  location_lat      double precision,
  location_lng      double precision,
  created_at        timestamptz default now()
);

alter table public.tournaments enable row level security;
create policy "Tournaments viewable by everyone"    on public.tournaments for select using (true);
create policy "Authenticated users can create"      on public.tournaments for insert with check (auth.uid() = created_by);
create policy "Creator can update tournament"       on public.tournaments for update using (auth.uid() = created_by);

-- Registrations (pending → approved / rejected)
create table if not exists public.tournament_registrations (
  id              uuid default gen_random_uuid() primary key,
  tournament_id   uuid references public.tournaments(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) on delete cascade not null,
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected')),
  seed            integer,    -- ELO rank at registration time
  registered_at   timestamptz default now(),
  unique(tournament_id, user_id)
);

alter table public.tournament_registrations enable row level security;
create policy "Registrations viewable by everyone"        on public.tournament_registrations for select using (true);
create policy "Users can register themselves"             on public.tournament_registrations for insert with check (auth.uid() = user_id);
create policy "Creator can manage registrations"          on public.tournament_registrations for update using (
  exists (select 1 from public.tournaments where id = tournament_registrations.tournament_id and created_by = auth.uid())
);
create policy "Users can withdraw own registration"       on public.tournament_registrations for delete using (auth.uid() = user_id);

-- Rounds (pool rounds, bracket rounds, etc.)
create table if not exists public.tournament_rounds (
  id              uuid default gen_random_uuid() primary key,
  tournament_id   uuid references public.tournaments(id) on delete cascade not null,
  round_number    integer not null,
  label           text not null,   -- "Pool A Round 1", "Semifinals", etc.
  round_type      text not null check (round_type in (
    'pool','winners','losers','quarterfinals','semifinals','finals','consolation'
  )),
  created_at      timestamptz default now()
);

alter table public.tournament_rounds enable row level security;
create policy "Rounds viewable by everyone" on public.tournament_rounds for select using (true);
create policy "Creator can manage rounds"   on public.tournament_rounds for all using (
  exists (select 1 from public.tournaments where id = tournament_rounds.tournament_id and created_by = auth.uid())
);

-- Tournament matches (separate from league matches, no ELO impact)
create table if not exists public.tournament_matches (
  id              uuid default gen_random_uuid() primary key,
  tournament_id   uuid references public.tournaments(id) on delete cascade not null,
  round_id        uuid references public.tournament_rounds(id) on delete cascade,
  match_order     integer not null default 0,
  match_type      text not null default 'singles' check (match_type in ('singles','doubles')),
  team1_player1   uuid references public.profiles(id),
  team1_player2   uuid references public.profiles(id),
  team2_player1   uuid references public.profiles(id),
  team2_player2   uuid references public.profiles(id),
  team1_score     integer,
  team2_score     integer,
  winner_team     text check (winner_team in ('team1','team2')),
  status          text not null default 'pending'
                    check (status in ('pending','in_progress','completed')),
  scheduled_at    timestamptz,
  created_at      timestamptz default now()
);

alter table public.tournament_matches enable row level security;
create policy "Tournament matches viewable by everyone" on public.tournament_matches for select using (true);
create policy "Creator can manage tournament matches"   on public.tournament_matches for all using (
  exists (select 1 from public.tournaments where id = tournament_matches.tournament_id and created_by = auth.uid())
);
create policy "Participants can update scores"         on public.tournament_matches for update using (
  auth.uid() in (team1_player1, team1_player2, team2_player1, team2_player2)
);
