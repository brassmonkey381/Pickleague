-- ============================================================
-- Paddle tracking system
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Paddle brands (seeded)
create table if not exists public.paddle_brands (
  id         uuid default gen_random_uuid() primary key,
  name       text not null unique,
  sort_order integer not null default 99,
  created_at timestamptz default now()
);
alter table public.paddle_brands enable row level security;
create policy "Brands readable by everyone" on public.paddle_brands for select using (true);

insert into public.paddle_brands (name, sort_order) values
  ('JOOLA',           1),
  ('Selkirk',         2),
  ('CRBN',            3),
  ('Gearbox',         4),
  ('Paddletek',       5),
  ('Engage',          6),
  ('Franklin',        7),
  ('Head',            8),
  ('Vatic Pro',       9),
  ('Electrum',       10),
  ('ProKennex',      11),
  ('Onix',           12),
  ('ProLite',        13),
  ('Gamma',          14),
  ('Babolat',        15),
  ('Volair',         16),
  ('Bread & Butter', 17),
  ('11SIX24',        18),
  ('Gruvn',          19),
  ('Honolulu',       20)
on conflict (name) do nothing;

-- 2. Player paddles (their quiver)
create table if not exists public.player_paddles (
  id           uuid default gen_random_uuid() primary key,
  user_id      uuid references public.profiles(id) on delete cascade not null,
  brand_id     uuid references public.paddle_brands(id) on delete restrict not null,
  model_name   text not null,
  thickness_mm numeric,   -- e.g. 13, 14, 16
  is_default   boolean not null default false,
  created_at   timestamptz default now(),
  unique(user_id, brand_id, model_name)
);
alter table public.player_paddles enable row level security;
create policy "Paddles readable by everyone"       on public.player_paddles for select using (true);
create policy "Users manage own paddles"           on public.player_paddles for all using (auth.uid() = user_id);

-- 3. Paddle used per player per match (auto-filled from default, editable within 72h)
create table if not exists public.match_paddle_usage (
  id             uuid default gen_random_uuid() primary key,
  match_id       uuid references public.matches(id) on delete cascade not null,
  user_id        uuid references public.profiles(id) on delete cascade not null,
  paddle_id      uuid references public.player_paddles(id) on delete set null,
  can_edit_until timestamptz not null,   -- played_at + 72h
  created_at     timestamptz default now(),
  unique(match_id, user_id)
);
alter table public.match_paddle_usage enable row level security;
create policy "Paddle usage readable by everyone" on public.match_paddle_usage for select using (true);
create policy "Users manage own paddle usage"     on public.match_paddle_usage for all using (auth.uid() = user_id);
