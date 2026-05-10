-- ============================================================
-- Pickles 🥒 currency + Shop
--
-- Adds:
--   * profiles.pickles                  — current balance
--   * profiles.welcome_pickles_granted  — one-time signup bonus flag
--   * profiles.name_color               — set by purchasing a flair item
--   * shop_items                        — catalog
--   * player_shop_purchases             — what each user has bought
--   * RPC claim_welcome_pickles()       — grants 1000 on first call
--   * RPC purchase_shop_item(item_id)   — atomic deduct + insert
-- ============================================================

-- 1. Profile columns ------------------------------------------------------
alter table public.profiles
  add column if not exists pickles                  integer not null default 0,
  add column if not exists welcome_pickles_granted  boolean not null default false,
  add column if not exists name_color               text,
  -- When set, takes precedence over avatar_id for rendering (premium avatars
  -- bought from the shop store their emoji + bg directly on the profile so
  -- every render site picks them up without an extra lookup).
  add column if not exists avatar_emoji             text,
  add column if not exists avatar_bg_color          text;

-- 2. Shop catalog ---------------------------------------------------------
create table if not exists public.shop_items (
  id          uuid default gen_random_uuid() primary key,
  category    text not null check (category in ('avatar', 'cosmetic_badge', 'flair')),
  slug        text not null unique,
  name        text not null,
  description text not null,
  icon        text not null,                -- emoji or short label
  cost        integer not null check (cost >= 0),
  payload     jsonb not null default '{}'::jsonb,
  -- per-category payload schema:
  --   avatar:         { "emoji": "🥒", "bgColor": "#c8e6c9" }
  --   cosmetic_badge: { "tagline": "founding member" }
  --   flair:          { "kind": "name_color", "value": "#d4af37" }
  is_active   boolean not null default true,
  sort_order  integer not null default 99,
  created_at  timestamptz default now()
);

alter table public.shop_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='shop_items' and policyname='Shop items viewable by everyone') then
    create policy "Shop items viewable by everyone" on public.shop_items for select using (true);
  end if;
end $$;

-- 3. Purchases ------------------------------------------------------------
create table if not exists public.player_shop_purchases (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  shop_item_id  uuid references public.shop_items(id) on delete cascade not null,
  cost_paid     integer not null,
  purchased_at  timestamptz default now(),
  unique(user_id, shop_item_id)  -- can only buy each item once
);

alter table public.player_shop_purchases enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='player_shop_purchases' and policyname='Purchases viewable by everyone') then
    create policy "Purchases viewable by everyone" on public.player_shop_purchases for select using (true);
  end if;
end $$;
-- writes only via SECURITY DEFINER RPC below

-- 4. claim_welcome_pickles ------------------------------------------------
create or replace function public.claim_welcome_pickles()
returns table (granted boolean, new_balance integer)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_already   boolean;
  v_balance   integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select welcome_pickles_granted, pickles
    into v_already, v_balance
    from public.profiles
   where id = v_uid;

  if v_already then
    return query select false, v_balance;
    return;
  end if;

  update public.profiles
     set pickles                 = pickles + 1000,
         welcome_pickles_granted = true
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_balance;
end;
$$;

grant execute on function public.claim_welcome_pickles() to authenticated;

-- 5. purchase_shop_item ---------------------------------------------------
create or replace function public.purchase_shop_item(p_item_id uuid)
returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_active    boolean;
  v_balance   integer;
  v_owned     boolean;
  v_category  text;
  v_payload   jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select cost, is_active, category, payload
    into v_cost, v_active, v_category, v_payload
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 'Item not available'::text; return;
  end if;

  select exists (
    select 1 from public.player_shop_purchases
    where user_id = v_uid and shop_item_id = p_item_id
  ) into v_owned;
  if v_owned then
    return query select false, null::integer, 'Already owned'::text; return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < v_cost then
    return query select false, v_balance, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_cost
   where id = v_uid
   returning pickles into v_balance;

  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
  values (v_uid, p_item_id, v_cost);

  -- Side effects: certain item categories auto-apply on purchase.
  if v_category = 'flair' and v_payload ->> 'kind' = 'name_color' then
    update public.profiles
       set name_color = v_payload ->> 'value'
     where id = v_uid;
  elsif v_category = 'avatar' then
    update public.profiles
       set avatar_emoji    = v_payload ->> 'emoji',
           avatar_bg_color = v_payload ->> 'bgColor'
     where id = v_uid;
  end if;

  return query select true, v_balance, 'Purchased'::text;
end;
$$;

grant execute on function public.purchase_shop_item(uuid) to authenticated;

-- 6. Seed catalog ---------------------------------------------------------
--    Costs are intentionally a meaningful grind — bigger items are kept
--    out of reach with just the 1000-pickle welcome bonus.
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  -- Premium avatars
  ('avatar-pickle',     'avatar', 'Pickle',       'The official mascot. Crunchy, briny, undefeated.',     '🥒', 1000, '{"emoji":"🥒","bgColor":"#c8e6c9"}', 1),
  ('avatar-rocket',     'avatar', 'Rocket',       'Going places. Quickly.',                                '🚀', 800,  '{"emoji":"🚀","bgColor":"#bbdefb"}', 2),
  ('avatar-taco',       'avatar', 'Taco',         'Tuesdays, Wednesdays, every day really.',              '🌮', 600,  '{"emoji":"🌮","bgColor":"#ffe082"}', 3),
  ('avatar-ninja',      'avatar', 'Ninja',        'Strikes silently from the kitchen line.',              '🥷', 900,  '{"emoji":"🥷","bgColor":"#cfd8dc"}', 4),
  ('avatar-wizard',     'avatar', 'Wizard',       'Conjures third-shot drops out of thin air.',           '🧙', 1000, '{"emoji":"🧙","bgColor":"#d1c4e9"}', 5),
  ('avatar-dino',       'avatar', 'Dino',         'Old-school power game. Surprisingly nimble.',          '🦖', 700,  '{"emoji":"🦖","bgColor":"#a5d6a7"}', 6),
  ('avatar-octopus',    'avatar', 'Octopus',      'Eight arms. Eight paddles. Mathematically illegal.',   '🐙', 1200, '{"emoji":"🐙","bgColor":"#ffccbc"}', 7),
  ('avatar-flamingo',   'avatar', 'Flamingo',     'Style points. Defensive stance optional.',             '🦩', 800,  '{"emoji":"🦩","bgColor":"#fce4ec"}', 8),
  ('avatar-bee',        'avatar', 'Bee',          'Bzzzz. Stings on the third shot.',                     '🐝', 600,  '{"emoji":"🐝","bgColor":"#fff59d"}', 9),
  ('avatar-tophat',     'avatar', 'Top Hat',      'Distinguished. Probably wins more than you.',          '🎩', 1100, '{"emoji":"🎩","bgColor":"#e1bee7"}', 10),
  ('avatar-pumpkin',    'avatar', 'Pumpkin',      'Seasonal. Always slightly in season.',                 '🎃', 700,  '{"emoji":"🎃","bgColor":"#ffe0b2"}', 11),
  ('avatar-martian',    'avatar', 'Martian',      'Plays an unfamiliar style. Confusing in a good way.', '👽', 1300, '{"emoji":"👽","bgColor":"#dcedc8"}', 12),

  -- Cosmetic badges
  ('badge-pickle-patron',   'cosmetic_badge', 'Pickle Patron',   'Supports the Pickleague economy. Verified pickle enjoyer.',    '🥒', 800,  '{}', 20),
  ('badge-founding-member', 'cosmetic_badge', 'Founding Member', 'Joined while pickles were still wet. A true OG.',              '🌱', 1500, '{}', 21),
  ('badge-vip',             'cosmetic_badge', 'VIP',             'Very Important Pickler.',                                       '💎', 2000, '{}', 22),
  ('badge-coffee-sponsor',  'cosmetic_badge', 'Coffee Sponsor',  'Caffeinates the league. We see you.',                          '☕', 600,  '{}', 23),
  ('badge-night-owl',       'cosmetic_badge', 'Night Owl',       'Plays past sunset. The kitchen calls at all hours.',           '🌙', 500,  '{}', 24),
  ('badge-morning-bird',    'cosmetic_badge', 'Morning Bird',    'Already warmed up before the sun.',                            '🌅', 500,  '{}', 25),

  -- Profile flair (name colors)
  ('flair-name-gold',     'flair', 'Gold Name',     'Make your name shine.',           '🟡', 1500, '{"kind":"name_color","value":"#d4af37"}', 30),
  ('flair-name-ruby',     'flair', 'Ruby Name',     'A bold red. Statement-making.',   '🔴', 1000, '{"kind":"name_color","value":"#c62828"}', 31),
  ('flair-name-sapphire', 'flair', 'Sapphire Name', 'Cool, blue, professional.',       '🔵', 1000, '{"kind":"name_color","value":"#1565c0"}', 32),
  ('flair-name-emerald',  'flair', 'Emerald Name',  'Pickle-adjacent. Iconic.',        '🟢', 1000, '{"kind":"name_color","value":"#2e7d32"}', 33),
  ('flair-name-violet',   'flair', 'Violet Name',   'Subtle, regal, slightly chaotic.','🟣', 1000, '{"kind":"name_color","value":"#6a1b9a"}', 34),
  ('flair-name-tangerine','flair', 'Tangerine',     'Loud and proud.',                 '🟠', 1000, '{"kind":"name_color","value":"#ef6c00"}', 35)
on conflict (slug) do nothing;

-- 7. Sync existing rows to the canonical seed costs ---------------------
--    Lets us re-run the migration after a price change. Each row gets
--    set explicitly to its current intended cost so the UPDATE is
--    idempotent (running it twice produces the same result).
update public.shop_items s set cost = v.cost
  from (values
    ('avatar-pickle', 1000), ('avatar-rocket', 800),  ('avatar-taco', 600),
    ('avatar-ninja', 900),   ('avatar-wizard', 1000), ('avatar-dino', 700),
    ('avatar-octopus', 1200),('avatar-flamingo', 800),('avatar-bee', 600),
    ('avatar-tophat', 1100), ('avatar-pumpkin', 700), ('avatar-martian', 1300),
    ('badge-pickle-patron', 800), ('badge-founding-member', 1500), ('badge-vip', 2000),
    ('badge-coffee-sponsor', 600),('badge-night-owl', 500),       ('badge-morning-bird', 500),
    ('flair-name-gold', 1500),    ('flair-name-ruby', 1000),      ('flair-name-sapphire', 1000),
    ('flair-name-emerald', 1000), ('flair-name-violet', 1000),    ('flair-name-tangerine', 1000)
  ) as v(slug, cost)
 where s.slug = v.slug;
