-- Paddle models table — stores known models per brand
-- Feeds the model suggestion list in PaddlePickerModal

create table if not exists public.paddle_models (
  id           uuid default gen_random_uuid() primary key,
  brand_id     uuid references public.paddle_brands(id) on delete cascade not null,
  name         text not null,
  thickness_mm numeric,   -- null = varies / unknown
  notes        text,      -- e.g. "thermoformed, elongated"
  sort_order   integer not null default 99,
  created_at   timestamptz default now(),
  unique(brand_id, name)
);

alter table public.paddle_models enable row level security;
create policy "Paddle models readable by everyone" on public.paddle_models for select using (true);
create policy "Service role can manage models"     on public.paddle_models for all using (auth.role() = 'service_role');

-- Also add more brands that were missing from the original 20
insert into public.paddle_brands (name, sort_order) values
  ('Ronbus / Ripple', 21),
  ('Ripple',          22),
  ('Six Zero',        23),
  ('Diadem',          24),
  ('Legacy',          25),
  ('Vulcan',          26),
  ('Holbrook',        27),
  ('Recess',          28),
  ('ProXR',           29),
  ('Bread & Butter',  30),
  ('ACE Pickleball',  31),
  ('Vatic Pro',       32),
  ('Wilson',          33),
  ('Adidas',          34),
  ('Niupipo',         35),
  ('Proton Sports',   36),
  ('Gruvn',           37),
  ('11SIX24',         38),
  ('Volair',          39),
  ('Friday Pickleball', 40),
  ('RAD Pickleball',  41),
  ('Booma',           42)
on conflict (name) do nothing;
