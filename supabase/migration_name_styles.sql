-- ============================================================
-- Name Styles foundation
--
-- Adds:
--   * profiles.list_name_style_id        — equipped list-mode style (FK shop_items.slug)
--   * profiles.hero_name_style_id        — equipped hero-mode style (FK shop_items.slug)
--   * shop_items.unlock_badge_id         — when set, item is NOT purchasable; auto-granted via badge trigger
--   * shop_items.category accepts 'list_name_style' and 'hero_name_style'
--   * purchase_shop_item() — auto-equips name styles + rejects unlock-gated items
--   * trigger _grant_unlock_items_on_badge — auto-grants purchases when matching badge earned
--   * Seed rows for list styles, hero styles, and progression-unlock styles
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Profile cosmetic slots --------------------------------------------------
alter table public.profiles
  add column if not exists list_name_style_id text,
  add column if not exists hero_name_style_id text;

-- FK to shop_items.slug (nullable; deferred so we can drop styles without breaking profiles).
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_list_name_style_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_list_name_style_id_fkey
      foreign key (list_name_style_id) references public.shop_items(slug)
      on delete set null on update cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_hero_name_style_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_hero_name_style_id_fkey
      foreign key (hero_name_style_id) references public.shop_items(slug)
      on delete set null on update cascade;
  end if;
end $$;

-- 2. shop_items.unlock_badge_id ---------------------------------------------
alter table public.shop_items
  add column if not exists unlock_badge_id uuid references public.badges(id) on delete set null;

-- 3. Extend shop_items.category check to include the two new style categories
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'shop_items_category_check'
  ) then
    alter table public.shop_items drop constraint shop_items_category_check;
  end if;
  alter table public.shop_items
    add constraint shop_items_category_check
    check (category in (
      'avatar', 'cosmetic_badge', 'flair', 'profile_frame', 'real_world',
      'list_name_style', 'hero_name_style'
    ));
end $$;

-- 4. purchase_shop_item -----------------------------------------------------
-- Extended to:
--   * reject items with unlock_badge_id (those are granted by badge trigger)
--   * auto-equip name styles into profiles.{list,hero}_name_style_id
create or replace function public.purchase_shop_item(p_item_id uuid)
returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid          uuid := auth.uid();
  v_cost         integer;
  v_active       boolean;
  v_balance      integer;
  v_owned        boolean;
  v_category     text;
  v_slug         text;
  v_unlock_badge uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select cost, is_active, category, slug, unlock_badge_id
    into v_cost, v_active, v_category, v_slug, v_unlock_badge
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 'Item not available'::text; return;
  end if;
  if v_unlock_badge is not null then
    return query select false, null::integer, 'Item is unlocked by earning a badge — not purchasable'::text; return;
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

  -- Auto-equip name styles into the matching profile slot.
  if v_category = 'list_name_style' then
    update public.profiles set list_name_style_id = v_slug where id = v_uid;
  elsif v_category = 'hero_name_style' then
    update public.profiles set hero_name_style_id = v_slug where id = v_uid;
  end if;

  return query select true, v_balance, 'Purchased'::text;
end;
$$;

-- 5. Trigger: auto-grant unlock-gated items when matching badge is earned ----
create or replace function public._grant_unlock_items_on_badge()
returns trigger language plpgsql security definer as $$
begin
  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
  select NEW.user_id, si.id, 0
    from public.shop_items si
   where si.unlock_badge_id = NEW.badge_id
     and si.is_active
     and not exists (
       select 1 from public.player_shop_purchases p
        where p.user_id = NEW.user_id
          and p.shop_item_id = si.id
     );
  return NEW;
end;
$$;

drop trigger if exists trg_grant_unlock_items_on_badge on public.player_badges;
create trigger trg_grant_unlock_items_on_badge
  after insert on public.player_badges
  for each row execute function public._grant_unlock_items_on_badge();

-- 6. Seed: purchasable list name styles -------------------------------------
-- Solid colors (500p) ───────────────────────────────────────────────
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order) values
  ('list_name_style', 'list-solid-ruby',          'Ruby Name',         'Bold ruby red for your name everywhere.',    '🔴', 500,  '{"kind":"solid","color":"#e0245e"}'::jsonb, 10),
  ('list_name_style', 'list-solid-sapphire',      'Sapphire Name',     'Deep sapphire blue for your name.',           '🔵', 500,  '{"kind":"solid","color":"#1d4ed8"}'::jsonb, 11),
  ('list_name_style', 'list-solid-emerald',       'Emerald Name',      'Rich emerald green name color.',              '🟢', 500,  '{"kind":"solid","color":"#059669"}'::jsonb, 12),
  ('list_name_style', 'list-solid-royal-purple',  'Royal Purple Name', 'A regal purple name color.',                  '🟣', 500,  '{"kind":"solid","color":"#7c3aed"}'::jsonb, 13),
  ('list_name_style', 'list-solid-cyber',         'Cyber Name',        'Electric cyan for the cyberpunk in you.',     '💠', 500,  '{"kind":"solid","color":"#06b6d4"}'::jsonb, 14),
  ('list_name_style', 'list-solid-sunset-orange', 'Sunset Orange Name','Warm sunset orange for your name.',           '🟠', 500,  '{"kind":"solid","color":"#f97316"}'::jsonb, 15)
on conflict (slug) do nothing;

-- Gradients (2,500p) ────────────────────────────────────────────────
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order) values
  ('list_name_style', 'list-grad-sunset',     'Sunset Gradient',     'Warm sunset gradient across your name.',      '🌅', 2500, '{"kind":"gradient","stops":["#ff7e5f","#feb47b"],"direction":"horizontal"}'::jsonb, 20),
  ('list_name_style', 'list-grad-ocean',      'Ocean Gradient',      'Cool ocean blues gradient.',                  '🌊', 2500, '{"kind":"gradient","stops":["#2193b0","#6dd5ed"],"direction":"horizontal"}'::jsonb, 21),
  ('list_name_style', 'list-grad-forest',     'Forest Gradient',     'Deep forest greens.',                         '🌲', 2500, '{"kind":"gradient","stops":["#134e5e","#71b280"],"direction":"horizontal"}'::jsonb, 22),
  ('list_name_style', 'list-grad-lavender',   'Lavender Gradient',   'Lavender to soft pink gradient.',             '💜', 2500, '{"kind":"gradient","stops":["#8e2de2","#f093fb"],"direction":"horizontal"}'::jsonb, 23),
  ('list_name_style', 'list-grad-volcano',    'Volcano Gradient',    'Molten reds and oranges.',                    '🌋', 2500, '{"kind":"gradient","stops":["#ff416c","#ff4b2b"],"direction":"horizontal"}'::jsonb, 24),
  ('list_name_style', 'list-grad-monochrome', 'Monochrome Gradient', 'Sleek grayscale gradient.',                   '⬛', 2500, '{"kind":"gradient","stops":["#232526","#414345"],"direction":"horizontal"}'::jsonb, 25)
on conflict (slug) do nothing;

-- Glow (4,000p) ─────────────────────────────────────────────────────
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order) values
  ('list_name_style', 'list-glow-neon-pink',  'Neon Pink Glow',  'Hot pink with a glowing halo.',                  '💗', 4000, '{"kind":"glow","color":"#ec4899","radius":8}'::jsonb, 30),
  ('list_name_style', 'list-glow-cyber-blue', 'Cyber Blue Glow', 'Electric cyan with a glowing halo.',             '💎', 4000, '{"kind":"glow","color":"#22d3ee","radius":8}'::jsonb, 31),
  ('list_name_style', 'list-glow-toxic-green','Toxic Green Glow','Hazardous lime green with a glow.',              '☢️', 4000, '{"kind":"glow","color":"#84cc16","radius":8}'::jsonb, 32),
  ('list_name_style', 'list-glow-inferno',    'Inferno Glow',    'Fiery orange with a glowing halo.',              '🔥', 4000, '{"kind":"glow","color":"#f97316","radius":8}'::jsonb, 33)
on conflict (slug) do nothing;

-- Metallic (6,500p) ──────────────────────────────────────────────────
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order) values
  ('list_name_style', 'list-metal-gold-leaf',     'Gold Leaf Name',      'Polished gold leaf finish.',         '🥇', 6500, '{"kind":"metallic","base":"#d4af37","shineColor":"#fff8dc"}'::jsonb, 40),
  ('list_name_style', 'list-metal-silver-shine',  'Silver Shine Name',   'Brushed silver with a shine band.',  '🥈', 6500, '{"kind":"metallic","base":"#a3a3a3","shineColor":"#f5f5f5"}'::jsonb, 41),
  ('list_name_style', 'list-metal-bronze',        'Bronze Name',         'Antique bronze finish.',             '🥉', 6500, '{"kind":"metallic","base":"#b08d57","shineColor":"#f1d4a5"}'::jsonb, 42),
  ('list_name_style', 'list-metal-holographic-foil','Holographic Foil', 'Iridescent holographic foil.',        '🌈', 6500, '{"kind":"metallic","base":"#a78bfa","shineColor":"#fce7ff"}'::jsonb, 43)
on conflict (slug) do nothing;

-- 7. Seed: purchasable hero name styles (animated) --------------------------
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order) values
  ('hero_name_style', 'hero-anim-pulse',        'Pulse Animation',        'Hero-only: pulsing name effect.',                 '💓', 10000, '{"kind":"animated","effect":"pulse","base":"#ec4899"}'::jsonb, 60),
  ('hero_name_style', 'hero-anim-rainbow',      'Rainbow Shift',          'Hero-only: shifting rainbow effect.',             '🌈', 12000, '{"kind":"animated","effect":"rainbow","base":"#a78bfa"}'::jsonb, 61),
  ('hero_name_style', 'hero-anim-sparkle',      'Sparkle Animation',      'Hero-only: sparkling name effect.',               '✨', 12500, '{"kind":"animated","effect":"sparkle","base":"#fbbf24"}'::jsonb, 62),
  ('hero_name_style', 'hero-anim-typewriter',   'Typewriter Animation',   'Hero-only: typewriter reveal effect.',            '⌨️', 13000, '{"kind":"animated","effect":"typewriter","base":"#22d3ee"}'::jsonb, 63),
  ('hero_name_style', 'hero-anim-holographic',  'Holographic Animation',  'Hero-only: holographic shimmer effect.',          '🪩', 15000, '{"kind":"animated","effect":"holographic","base":"#a78bfa"}'::jsonb, 64)
on conflict (slug) do nothing;

-- 8. Seed: progression-unlock styles (free, badge-gated) --------------------
-- Each row sets cost=0 and unlock_badge_id = (badges.id where name=<badge>).
-- We use a single insert..select per row so we can join to badges by name.
insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'list_name_style', 'style-first-rally-glow', 'First Rally Glow',
       'Static cyan glow. Unlocked by earning the First Rally badge.',
       '⚡', 0, '{"kind":"glow","color":"#22d3ee","radius":7}'::jsonb, 100, b.id
  from public.badges b where b.name = 'First Rally'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'hero_name_style', 'style-top-rated-prismatic', 'Top Rated Prismatic',
       'Holographic in hero, gradient in lists. Unlocked by earning the Top Rated badge.',
       '🔮', 0, '{"kind":"animated","effect":"holographic","base":"#a78bfa"}'::jsonb, 101, b.id
  from public.badges b where b.name = 'Top Rated'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'hero_name_style', 'style-hot-streak-fire', 'Hot Streak Fire',
       'Pulsing red→orange. Unlocked by earning the Hot Streak badge.',
       '🔥', 0, '{"kind":"animated","effect":"pulse","base":"#ef4444"}'::jsonb, 102, b.id
  from public.badges b where b.name = 'Hot Streak'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'list_name_style', 'style-veteran-classic', 'Veteran Classic',
       'Metallic bronze. Unlocked by earning the Veteran badge.',
       '🥉', 0, '{"kind":"metallic","base":"#b08d57","shineColor":"#f1d4a5"}'::jsonb, 103, b.id
  from public.badges b where b.name = 'Veteran'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'hero_name_style', 'style-court-hopper-rainbow', 'Court Hopper Rainbow',
       'Animated rainbow shift. Unlocked by earning the Court Hopper badge.',
       '🌈', 0, '{"kind":"animated","effect":"rainbow","base":"#a78bfa"}'::jsonb, 104, b.id
  from public.badges b where b.name = 'Court Hopper'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'list_name_style', 'style-singles-specialist-solo', 'Singles Specialist Solo',
       'Solid emerald name. Unlocked by earning the Singles Specialist badge.',
       '✊', 0, '{"kind":"solid","color":"#059669"}'::jsonb, 105, b.id
  from public.badges b where b.name = 'Singles Specialist'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'list_name_style', 'style-doubles-dynamo-duo', 'Doubles Dynamo Duo',
       'Ocean gradient. Unlocked by earning the Doubles Dynamo badge.',
       '🌊', 0, '{"kind":"gradient","stops":["#2193b0","#6dd5ed"],"direction":"horizontal"}'::jsonb, 106, b.id
  from public.badges b where b.name = 'Doubles Dynamo'
on conflict (slug) do nothing;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, sort_order, unlock_badge_id)
select 'hero_name_style', 'style-champion-gold', 'Champion Gold',
       'Metallic gold with a champion shimmer. Unlocked by earning the Tournament Champion badge.',
       '👑', 0, '{"kind":"metallic","base":"#d4af37","shineColor":"#fff8dc"}'::jsonb, 107, b.id
  from public.badges b where b.name = 'Tournament Champion'
on conflict (slug) do nothing;
