-- ============================================================
-- Badge system
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Badge definitions
create table if not exists public.badges (
  id          uuid default gen_random_uuid() primary key,
  name        text not null unique,
  description text not null,
  icon        text not null,          -- emoji
  category    text not null check (category in ('profile', 'league')),
  criteria    jsonb,                  -- machine-readable criteria for automation
  sort_order  integer not null default 99,
  created_at  timestamptz default now()
);

alter table public.badges enable row level security;
create policy "Badges viewable by everyone" on public.badges for select using (true);
create policy "Service role can manage badges" on public.badges for all using (auth.role() = 'service_role');

-- 2. Player badge awards
create table if not exists public.player_badges (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  badge_id   uuid references public.badges(id) on delete cascade not null,
  league_id  uuid references public.leagues(id) on delete cascade, -- null = profile badge
  context    text,       -- human-readable note e.g. "Won 3 matches on Apr 19"
  earned_at  timestamptz default now(),
  is_hidden  boolean not null default false   -- player can hide this badge from others
);

alter table public.player_badges enable row level security;
-- Everyone can read (hidden=false ones are filtered at query time)
create policy "Player badges viewable by everyone" on public.player_badges for select using (true);
create policy "Users manage own badge visibility" on public.player_badges for update using (auth.uid() = user_id);
create policy "Service role can award badges" on public.player_badges for all using (auth.role() = 'service_role');

-- Prevent duplicate awards (profile badges: unique per user+badge; league badges: unique per user+badge+league)
create unique index if not exists idx_pb_profile on public.player_badges(user_id, badge_id)
  where league_id is null;
create unique index if not exists idx_pb_league on public.player_badges(user_id, badge_id, league_id)
  where league_id is not null;

-- 3. Badge privacy preference on profiles
alter table public.profiles
  add column if not exists badges_public boolean not null default true;

-- 4. Seed badge definitions
insert into public.badges (name, description, icon, category, criteria, sort_order) values
  -- Profile badges
  ('Welcome',           'Created your Pickleague account.',                                            '🎉', 'profile', '{"type":"account_created"}',              1),
  ('First Rally',       'Played your first ever match.',                                               '🏅', 'profile', '{"type":"match_count","min":1}',          2),
  ('Hot Streak',        'Won 5 consecutive matches.',                                                  '🔥', 'profile', '{"type":"win_streak","min":5}',           3),
  ('Court Hopper',      'Played at 5 or more different court locations.',                              '🌍', 'profile', '{"type":"distinct_locations","min":5}',   4),
  ('Doubles Dynamo',    'Played 20 doubles matches.',                                                  '🤝', 'profile', '{"type":"doubles_count","min":20}',       5),
  ('Singles Specialist','Played 25 singles matches.',                                                  '🎯', 'profile', '{"type":"singles_count","min":25}',       6),
  ('Top Rated',         'Reached an overall ELO of 1150 or higher.',                                  '🏆', 'profile', '{"type":"elo_threshold","min":1150}',     7),
  ('Veteran',           'Has been a Pickleague member for 30 or more days.',                           '🎖️', 'profile', '{"type":"account_age_days","min":30}',    8),
  -- League badges
  ('Hat Trick',         'Won 3 or more matches in a single day within this league.',                   '🪄', 'league',  '{"type":"wins_in_day","min":3}',          10),
  ('Home Court Hero',   'Won 5 home-court matches in this league.',                                    '🏠', 'league',  '{"type":"home_wins","min":5}',            11),
  ('League Regular',    'Played 15 or more matches in this league.',                                   '📊', 'league',  '{"type":"league_match_count","min":15}',  12),
  ('Dominant',          'Won a match 11-0 or 11-1 in this league.',                                   '⚡', 'league',  '{"type":"blowout_win","max_opp":1}',      13),
  ('League Leader',     'Reached #1 in this league''s ELO standings.',                                '👑', 'league',  '{"type":"rank_one"}',                    14),
  ('Iron Player',       'Played at least one match in 5 different calendar days in this league.',      '💪', 'league',  '{"type":"distinct_play_days","min":5}',   15),
  ('Comeback King',     'Scored at least 8 points in a losing match in this league (fought hard).',   '🔄', 'league',  '{"type":"fought_loss","min_score":8}',    16)
on conflict (name) do nothing;
