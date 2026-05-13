-- ============================================================
-- Shop expansion + progress-driven rewards + new badges
--
-- Consolidates 18 prior individual migration files into one
-- idempotent script. Sections:
--
--   1. Schema       — shop_items category constraint, new columns,
--                     dedupe tables used by every "first time X"
--                     reward trigger.
--   2. Shop catalog — cosmetic badges, animal avatars, food avatars,
--                     name-color flairs, profile frames.
--   3. Badge defs   — Underdog, Cinderella, Marathon, Triple Crown,
--                     Tournament Veteran I/II/III, Globetrotter II.
--   4. Functions    — pickles-per-badge, first-match bonus, first-
--                     doubles bonus, per-new-court bonus, anniversary
--                     RPC, tournament-participation bonus, daily play
--                     streak, plus the trigger functions that award
--                     the new badges.
--   5. Triggers     — wired against player_badges / matches /
--                     tournaments.
--   6. Backfills    — populate everything from existing data so
--                     historical players get what they would have
--                     earned.
--
-- Run AFTER:
--   migration_add_badges.sql
--   migration_add_season_badges.sql
--   migration_more_badges_and_stacking.sql
--   migration_add_pickles_shop.sql
--   migration_payout_notifications_split.sql
-- ============================================================


-- 1. SCHEMA --------------------------------------------------------------

-- 1a. Allow 'profile_frame' as a new shop_items category.
do $$
declare
  v_conname text;
begin
  select c.conname
    into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'shop_items'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%category%';

  if v_conname is not null then
    execute format('alter table public.shop_items drop constraint %I', v_conname);
  end if;

  alter table public.shop_items
    add constraint shop_items_category_check
    check (category in ('avatar', 'cosmetic_badge', 'flair', 'profile_frame'));
end $$;

-- 1b. profiles.profile_frame (currently equipped frame slug).
alter table public.profiles
  add column if not exists profile_frame text;

-- 1c. Dedupe tables for one-shot reward triggers.
create table if not exists public.first_match_bonus_grants (
  user_id    uuid primary key,
  granted_at timestamptz not null default now()
);

create table if not exists public.first_doubles_bonus_grants (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  granted_at timestamptz default now()
);

create table if not exists public.court_bonus_grants (
  user_id       uuid,
  location_name text,
  granted_at    timestamptz not null default now(),
  primary key (user_id, location_name)
);

create table if not exists public.anniversary_grants (
  user_id    uuid not null,
  year       integer not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, year)
);

create table if not exists public.tournament_participation_grants (
  user_id       uuid not null,
  tournament_id uuid not null,
  granted_at    timestamptz not null default now(),
  primary key (user_id, tournament_id)
);

create table if not exists public.daily_play_streaks (
  user_id        uuid    not null,
  play_date      date    not null,
  streak_length  integer not null,
  bonus_granted  integer not null,
  primary key (user_id, play_date)
);


-- 2. SHOP CATALOG --------------------------------------------------------

-- 2a. Lifestyle / personality cosmetic badges (10).
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('badge-bookworm',        'cosmetic_badge', 'Bookworm',         'Reads between rallies. Probably knows the rulebook.',          '📚', 500,  '{}', 30),
  ('badge-gym-rat',         'cosmetic_badge', 'Gym Rat',          'Lifts before lobs. Calves of legend.',                          '💪', 700,  '{}', 31),
  ('badge-dad-jokes',       'cosmetic_badge', 'Dad Jokes',        'Groan-worthy puns between every serve.',                        '👨', 600,  '{}', 32),
  ('badge-sunset-player',   'cosmetic_badge', 'Sunset Player',    'Last match of the day. Golden hour specialist.',                '🌇', 500,  '{}', 33),
  ('badge-snack-champion',  'cosmetic_badge', 'Snack Champion',   'Brings the chips. Wins hearts before points.',                  '🍿', 600,  '{}', 34),
  ('badge-trash-talker',    'cosmetic_badge', 'Trash Talker Pro', 'Verified yapper. Backed up by results, mostly.',                '🗣️', 900,  '{}', 35),
  ('badge-couch-coach',     'cosmetic_badge', 'Couch Coach',      'Best advice comes from the sidelines. Allegedly.',              '🛋️', 700,  '{}', 36),
  ('badge-lefty-pride',     'cosmetic_badge', 'Lefty Pride',      'Sinister side dominant. Opponents always forget.',              '🤚', 800,  '{}', 37),
  ('badge-yoga-master',     'cosmetic_badge', 'Yoga Master',      'Stretches before, during, and after every game.',               '🧘', 800,  '{}', 38),
  ('badge-dog-parent',      'cosmetic_badge', 'Dog Parent',       'Pup waits courtside. Best support staff in the league.',        '🐕', 700,  '{}', 39)
on conflict (slug) do nothing;

-- 2b. Animal-themed avatars (10).
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('avatar-tortoise',  'avatar', 'Tortoise',  'Slow start, unstoppable finish.',                  '🐢', 900,  '{"emoji":"🐢","bgColor":"#c8e6c9"}', 30),
  ('avatar-otter',     'avatar', 'Otter',     'Playful, slippery, surprisingly competitive.',     '🦦', 1000, '{"emoji":"🦦","bgColor":"#d7ccc8"}', 31),
  ('avatar-hedgehog',  'avatar', 'Hedgehog',  'Defensive specialist. Bristles on contact.',       '🦔', 850,  '{"emoji":"🦔","bgColor":"#ffe0b2"}', 32),
  ('avatar-sloth',     'avatar', 'Sloth',     'No-pace lobs. Maddeningly effective.',             '🦥', 800,  '{"emoji":"🦥","bgColor":"#dcedc8"}', 33),
  ('avatar-skunk',     'avatar', 'Skunk',     'Aptly named after a shutout.',                     '🦨', 1100, '{"emoji":"🦨","bgColor":"#cfd8dc"}', 34),
  ('avatar-bison',     'avatar', 'Bison',     'Powers through the middle. Immovable.',            '🦬', 1200, '{"emoji":"🦬","bgColor":"#d7ccc8"}', 35),
  ('avatar-jellyfish', 'avatar', 'Jellyfish', 'Drifts in, stings the put-away.',                  '🪼', 1400, '{"emoji":"🪼","bgColor":"#b3e5fc"}', 36),
  ('avatar-seal',      'avatar', 'Seal',      'Sleek, fast, claps after every winner.',           '🦭', 1000, '{"emoji":"🦭","bgColor":"#b2dfdb"}', 37),
  ('avatar-giraffe',   'avatar', 'Giraffe',   'Reach advantage. Lobs hit different.',             '🦒', 1100, '{"emoji":"🦒","bgColor":"#fff9c4"}', 38),
  ('avatar-crocodile', 'avatar', 'Crocodile', 'Patient at the kitchen. Strikes without warning.', '🐊', 1500, '{"emoji":"🐊","bgColor":"#c5e1a5"}', 39)
on conflict (slug) do nothing;

-- 2c. Food / drink avatars (10).
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('avatar-food-pizza',      'avatar', 'Pizza Slice',  'Cheesy. Reliable. A classic third-shot drop.',  '🍕', 900,  '{"emoji":"🍕","bgColor":"#ffe0b2"}', 50),
  ('avatar-food-avocado',    'avatar', 'Avocado',      'Smooth, green, slightly extra.',                '🥑', 800,  '{"emoji":"🥑","bgColor":"#dcedc8"}', 51),
  ('avatar-food-donut',      'avatar', 'Donut',        'Sweet, round, and absolutely glazed.',          '🍩', 750,  '{"emoji":"🍩","bgColor":"#f8bbd0"}', 52),
  ('avatar-food-burger',     'avatar', 'Burger',       'Stacked. Like your win column, hopefully.',     '🍔', 1000, '{"emoji":"🍔","bgColor":"#ffccbc"}', 53),
  ('avatar-food-sushi',      'avatar', 'Sushi',        'Precise. Disciplined. Slightly raw.',           '🍣', 1200, '{"emoji":"🍣","bgColor":"#ffe0b2"}', 54),
  ('avatar-food-pretzel',    'avatar', 'Pretzel',      'Twisted strategy. Salty attitude.',             '🥨', 700,  '{"emoji":"🥨","bgColor":"#ffe082"}', 55),
  ('avatar-food-boba',       'avatar', 'Boba',         'Chewy, bouncy, hard to put down.',              '🧋', 1100, '{"emoji":"🧋","bgColor":"#d7ccc8"}', 56),
  ('avatar-food-cookie',     'avatar', 'Cookie',       'Crumbles only when you let it.',                '🍪', 800,  '{"emoji":"🍪","bgColor":"#d7ccc8"}', 57),
  ('avatar-food-softserve',  'avatar', 'Soft Serve',   'Cool under pressure. Melts the competition.',   '🍦', 900,  '{"emoji":"🍦","bgColor":"#fff9c4"}', 58),
  ('avatar-food-watermelon', 'avatar', 'Watermelon',   'Juicy, bold, summer-tournament energy.',        '🍉', 1400, '{"emoji":"🍉","bgColor":"#ffcdd2"}', 59)
on conflict (slug) do nothing;

-- 2d. Additional name-color flairs (5).
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('flair-name-neon',    'flair', 'Neon Green',    'Glows like a kitchen-line laser.',     '🟩', 1800, '{"kind":"name_color","value":"#39ff14"}', 50),
  ('flair-name-sunset',  'flair', 'Sunset Orange', 'Golden hour on every leaderboard.',    '🌇', 2000, '{"kind":"name_color","value":"#ff6f3c"}', 51),
  ('flair-name-royal',   'flair', 'Royal Blue',    'Dignified. Slightly intimidating.',    '👑', 2200, '{"kind":"name_color","value":"#1e3a8a"}', 52),
  ('flair-name-crimson', 'flair', 'Crimson',       'Deeper than ruby. Twice as dramatic.', '🩸', 2500, '{"kind":"name_color","value":"#dc143c"}', 53),
  ('flair-name-coral',   'flair', 'Coral',         'Warm, soft, and entirely undefeated.', '🪸', 3000, '{"kind":"name_color","value":"#ff7f50"}', 54)
on conflict (slug) do nothing;

-- 2e. Profile frames (6).
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('frame-gold-wreath',     'profile_frame', 'Gold Wreath',          'Laurels for the league legend.',                '🏵️', 3000, '{"kind":"frame","emoji":"🏵️","borderColor":"#d4af37"}', 80),
  ('frame-sparkle-ring',    'profile_frame', 'Sparkle Ring',         'Shimmers when you check the leaderboard.',      '💫', 2500, '{"kind":"frame","emoji":"💫","borderColor":"#fff176"}', 81),
  ('frame-cherry-blossom',  'profile_frame', 'Cherry Blossom Frame', 'Soft petals around a hardened competitor.',     '🌸', 2000, '{"kind":"frame","emoji":"🌸","borderColor":"#f8bbd0"}', 82),
  ('frame-fire-ring',       'profile_frame', 'Fire Ring',            'For players on a heater.',                      '🔥', 3500, '{"kind":"frame","emoji":"🔥","borderColor":"#ef5350"}', 83),
  ('frame-lightning',       'profile_frame', 'Lightning Frame',      'Strikes twice. And again on the third shot.',   '⚡', 3500, '{"kind":"frame","emoji":"⚡","borderColor":"#ffca28"}', 84),
  ('frame-star',            'profile_frame', 'Star Frame',           'Twinkling border for top performers.',          '⭐', 4000, '{"kind":"frame","emoji":"⭐","borderColor":"#ffd54f"}', 85)
on conflict (slug) do nothing;


-- 3. BADGE DEFINITIONS ---------------------------------------------------
insert into public.badges (name, description, icon, category, criteria, sort_order) values
  ('Underdog',              'Won a match against a team rated 100+ PLUPR higher. Stacks per upset.',                                   '🐕', 'profile', '{"type":"rating_upset","min_diff":100}', 36),
  ('Cinderella',            'Won a match against a team rated 200+ PLUPR higher. Stacks per upset.',                                   '👠', 'profile', '{"type":"rating_upset","min_diff":200}', 37),
  ('Marathon',              'Won a match that went past 11 points (12+ to win). Stacks per qualifying win.',                           '🏃', 'profile', '{"type":"marathon_win"}',                38),
  ('Triple Crown',          'Won a singles, a gendered-doubles, and a mixed-doubles match all on the same day. Stacks per day.',      '👑', 'profile', '{"type":"triple_crown_day"}',            39),
  ('Tournament Veteran I',  'Played 5 completed tournaments.',                                                                         '🎽', 'profile', '{"type":"tournaments_played","min":5}',  40),
  ('Tournament Veteran II', 'Played 10 completed tournaments.',                                                                        '🎽', 'profile', '{"type":"tournaments_played","min":10}', 41),
  ('Tournament Veteran III','Played 25 completed tournaments.',                                                                        '🎽', 'profile', '{"type":"tournaments_played","min":25}', 42),
  ('Globetrotter II',       'Played at 10 or more different court locations.',                                                         '🌐', 'profile', '{"type":"distinct_locations","min":10}', 43)
on conflict (name) do nothing;


-- 4. FUNCTIONS -----------------------------------------------------------

-- 4a. +50 pickles every time a player earns a new badge.
create or replace function public._grant_pickles_on_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_name text;
begin
  select name into v_badge_name from public.badges where id = new.badge_id;
  if v_badge_name is null then return new; end if;

  update public.profiles set pickles = coalesce(pickles, 0) + 50 where id = new.user_id;

  begin
    perform public._notify_user(
      new.user_id,
      format('🥒 +50 pickles for earning %s!', v_badge_name),
      format('You received 50 🥒 for earning the %s badge. Tap to see your shop balance.', v_badge_name),
      new.user_id,
      'shop'
    );
  exception when others then null;
  end;

  return new;
end;
$$;
grant execute on function public._grant_pickles_on_badge() to authenticated;

-- 4b. +200 pickles one-time when a player records their very first match.
create or replace function public._grant_first_match_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_count integer;
begin
  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then
        continue;
      end if;

      select count(*) into v_count from public.matches
        where player1_id = v_uid or partner1_id = v_uid
           or player2_id = v_uid or partner2_id = v_uid;

      if v_count = 1 then
        insert into public.first_match_bonus_grants(user_id) values (v_uid)
          on conflict (user_id) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 200 where id = v_uid;

        begin
          perform public._notify_user(
            v_uid,
            '🥒 First match! +200 pickles to spend in the Shop.',
            '🥒 First match! +200 pickles to spend in the Shop.',
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;
grant execute on function public._grant_first_match_bonus() to authenticated;

-- 4c. +150 pickles one-time on a player's first doubles match.
create or replace function public._grant_first_doubles_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid         uuid;
  v_prior_count int;
begin
  if new.match_type <> 'doubles' then return new; end if;

  foreach v_uid in array array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id] loop
    if v_uid is null then continue; end if;

    if exists (select 1 from public.first_doubles_bonus_grants where user_id = v_uid) then
      continue;
    end if;

    select count(*) into v_prior_count
    from public.matches
    where id <> new.id
      and match_type = 'doubles'
      and (player1_id = v_uid or partner1_id = v_uid or player2_id = v_uid or partner2_id = v_uid);

    if v_prior_count > 0 then continue; end if;

    begin
      insert into public.first_doubles_bonus_grants (user_id) values (v_uid)
        on conflict (user_id) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 150 where id = v_uid;

      perform public._notify_user(
        v_uid,
        '🥒 First doubles match! +150 pickles.',
        'You earned 150 🥒 for playing your first doubles match. Tap to see your shop balance.',
        v_uid,
        'shop'
      );
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;
grant execute on function public._grant_first_doubles_bonus() to authenticated;

-- 4d. +100 pickles the first time you play at each new court.
create or replace function public._grant_court_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid uuid;
  v_msg text;
begin
  if new.location_name is null then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (
        select 1 from public.court_bonus_grants
        where user_id = v_uid and location_name = new.location_name
      ) then
        continue;
      end if;

      insert into public.court_bonus_grants(user_id, location_name)
        values (v_uid, new.location_name)
        on conflict (user_id, location_name) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 100 where id = v_uid;

      v_msg := '🥒 New court bonus: +100 pickles for playing at ' || new.location_name || '.';
      begin
        perform public._notify_user(v_uid, v_msg, v_msg, v_uid, 'shop');
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;
grant execute on function public._grant_court_bonus() to authenticated;

-- 4e. +500 pickles per account anniversary year. Client-callable RPC.
create or replace function public.claim_anniversary_pickles()
returns integer language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_created timestamptz;
  v_years   integer;
  v_y       integer;
  v_total   integer := 0;
begin
  if v_uid is null then return 0; end if;

  select created_at into v_created from public.profiles where id = v_uid;
  if v_created is null then return 0; end if;

  v_years := floor(extract(epoch from (now() - v_created)) / (365 * 86400))::integer;
  if v_years < 1 then return 0; end if;

  for v_y in 1..v_years loop
    begin
      if exists (select 1 from public.anniversary_grants where user_id = v_uid and year = v_y) then
        continue;
      end if;

      insert into public.anniversary_grants(user_id, year) values (v_uid, v_y)
        on conflict (user_id, year) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 500 where id = v_uid;
      v_total := v_total + 500;

      begin
        perform public._notify_user(
          v_uid,
          '🎂 Happy anniversary! +500 pickles for year ' || v_y,
          '🎂 Happy anniversary! +500 pickles for year ' || v_y,
          v_uid,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;

  return v_total;
end;
$$;
grant execute on function public.claim_anniversary_pickles() to authenticated;

-- 4f. +50 pickles to every approved participant when a tournament completes.
create or replace function public._grant_tournament_participation_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid  uuid;
  v_name text;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select name into v_name from public.tournaments where id = new.id;

  for v_uid in
    select user_id from public.tournament_registrations
     where tournament_id = new.id and status = 'approved' and user_id is not null
  loop
    begin
      if exists (
        select 1 from public.tournament_participation_grants
         where user_id = v_uid and tournament_id = new.id
      ) then
        continue;
      end if;

      insert into public.tournament_participation_grants(user_id, tournament_id)
        values (v_uid, new.id)
        on conflict (user_id, tournament_id) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 50 where id = v_uid;

      begin
        perform public._notify_user(
          v_uid,
          '🥒 Tournament played: +50 pickles',
          format('🥒 Tournament played: +50 pickles for completing %s.', coalesce(v_name, 'tournament')),
          new.id,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;
grant execute on function public._grant_tournament_participation_bonus() to authenticated;

-- 4g. Daily play-streak pickles (50 × streak, capped at 200 per day).
create or replace function public._grant_daily_streak_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid      uuid;
  v_date     date;
  v_prev_len integer;
  v_len      integer;
  v_bonus    integer;
begin
  v_date := (coalesce(new.played_at, now()))::date;
  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.daily_play_streaks where user_id = v_uid and play_date = v_date) then
        continue;
      end if;

      select streak_length into v_prev_len
        from public.daily_play_streaks
        where user_id = v_uid and play_date = v_date - 1;

      v_len   := coalesce(v_prev_len, 0) + 1;
      v_bonus := least(50 * v_len, 200);

      insert into public.daily_play_streaks(user_id, play_date, streak_length, bonus_granted)
        values (v_uid, v_date, v_len, v_bonus)
        on conflict (user_id, play_date) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;

      begin
        perform public._notify_user(
          v_uid,
          '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
          '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
          v_uid,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;
grant execute on function public._grant_daily_streak_bonus() to authenticated;

-- 4h. Underdog badge (loser team's rating - winner's >= 100).
create or replace function public._award_underdog_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 100 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        perform public.award_profile_badge(
          v_uid, 'Underdog',
          format('Beat a +%s opponent on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

-- 4i. Cinderella badge (loser team's rating - winner's >= 200).
create or replace function public._award_cinderella_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 200 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        perform public.award_profile_badge(
          v_uid, 'Cinderella',
          format('Beat a +%s favorite on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

-- 4j. Marathon badge (winning team scored 12+).
create or replace function public._award_marathon_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winning int;
  v_losing  int;
  v_played  date := coalesce(new.played_at, now())::date;
  v_winners uuid[];
  v_uid     uuid;
begin
  if new.winner_team is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winning := new.player1_score;
    v_losing  := new.player2_score;
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winning := new.player2_score;
    v_losing  := new.player1_score;
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  else
    return new;
  end if;

  if v_winning is null or v_winning < 12 then return new; end if;

  begin
    foreach v_uid in array v_winners loop
      perform public.award_profile_badge(
        v_uid, 'Marathon',
        format('%s-%s on %s', v_winning, coalesce(v_losing, 0), v_played)
      );
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;

-- 4k. Triple Crown badge (singles + gendered + mixed wins same day).
create or replace function public._award_triple_crown_badge()
returns trigger language plpgsql security definer as $$
declare
  v_tc_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_ctx      text;
  v_has_s    boolean;
  v_has_g    boolean;
  v_has_m    boolean;
begin
  select id into v_tc_id from public.badges where name = 'Triple Crown';
  if v_tc_id is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_winners is null then return new; end if;

  foreach v_uid in array v_winners loop
    begin
      v_ctx := format('Triple Crown on %s', v_played);

      if exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_tc_id and context = v_ctx
      ) then continue; end if;

      select
        bool_or(m.match_type = 'singles'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'gendered'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'mixed')
        into v_has_s, v_has_g, v_has_m
        from public.matches m
       where coalesce(m.played_at, now())::date = v_played
         and (
           (m.winner_team = 'team1' and (m.player1_id  = v_uid or m.partner1_id = v_uid))
           or
           (m.winner_team = 'team2' and (m.player2_id  = v_uid or m.partner2_id = v_uid))
         );

      if coalesce(v_has_s, false) and coalesce(v_has_g, false) and coalesce(v_has_m, false) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_tc_id, null, v_ctx);
      end if;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;

-- 4l. Tournament Veteran tiered milestones (5/10/25 completed tournaments).
create or replace function public._award_tournament_veteran_milestones()
returns trigger language plpgsql security definer as $$
declare
  v_uid      uuid;
  v_count    integer;
  v_badge    text;
  v_badge_id uuid;
begin
  if new.status <> 'completed' or coalesce(old.status, '') = 'completed' then
    return new;
  end if;

  begin
    for v_uid in
      select user_id from public.tournament_registrations
       where tournament_id = new.id and status = 'approved'
    loop
      select count(*) into v_count
        from public.tournament_registrations tr
        join public.tournaments t on t.id = tr.tournament_id
       where tr.user_id = v_uid
         and tr.status = 'approved'
         and t.status  = 'completed';

      foreach v_badge in array array['Tournament Veteran I', 'Tournament Veteran II', 'Tournament Veteran III'] loop
        if (v_badge = 'Tournament Veteran I'   and v_count >= 5)
        or (v_badge = 'Tournament Veteran II'  and v_count >= 10)
        or (v_badge = 'Tournament Veteran III' and v_count >= 25) then
          select id into v_badge_id from public.badges where name = v_badge;
          if v_badge_id is not null and not exists (
            select 1 from public.player_badges
             where user_id = v_uid and badge_id = v_badge_id
          ) then
            perform public.award_profile_badge(v_uid, v_badge, format('Completed %s tournaments', v_count));
          end if;
        end if;
      end loop;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;

-- 4m. Globetrotter II badge (10+ distinct courts, single-award milestone).
create or replace function public._award_globetrotter_ii_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id uuid;
  v_uid      uuid;
  v_count    integer;
begin
  select id into v_badge_id from public.badges where name = 'Globetrotter II';
  if v_badge_id is null then return new; end if;

  begin
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(distinct m.location_name) into v_count
        from public.matches m
       where (m.player1_id = v_uid or m.partner1_id = v_uid
              or m.player2_id = v_uid or m.partner2_id = v_uid)
         and m.location_name is not null;

      if v_count >= 10 and not exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_badge_id
      ) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_badge_id, null, format('Played at %s courts', v_count));
      end if;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;


-- 5. TRIGGERS ------------------------------------------------------------

drop trigger if exists trg_grant_pickles_on_badge                on public.player_badges cascade;
create trigger trg_grant_pickles_on_badge
  after insert on public.player_badges
  for each row execute procedure public._grant_pickles_on_badge();

drop trigger if exists trg_grant_first_match_bonus               on public.matches cascade;
create trigger trg_grant_first_match_bonus
  after insert on public.matches
  for each row execute procedure public._grant_first_match_bonus();

drop trigger if exists trg_grant_first_doubles_bonus             on public.matches cascade;
create trigger trg_grant_first_doubles_bonus
  after insert on public.matches
  for each row execute procedure public._grant_first_doubles_bonus();

drop trigger if exists trg_grant_court_bonus                     on public.matches cascade;
create trigger trg_grant_court_bonus
  after insert on public.matches
  for each row execute procedure public._grant_court_bonus();

drop trigger if exists trg_grant_daily_streak_bonus              on public.matches cascade;
create trigger trg_grant_daily_streak_bonus
  after insert on public.matches
  for each row execute procedure public._grant_daily_streak_bonus();

drop trigger if exists trg_grant_tournament_participation_bonus  on public.tournaments cascade;
create trigger trg_grant_tournament_participation_bonus
  after update of status on public.tournaments
  for each row execute procedure public._grant_tournament_participation_bonus();

drop trigger if exists trg_award_underdog_badge                  on public.matches;
create trigger trg_award_underdog_badge
  after insert on public.matches
  for each row execute procedure public._award_underdog_badge();

drop trigger if exists trg_award_cinderella_badge                on public.matches;
create trigger trg_award_cinderella_badge
  after insert on public.matches
  for each row execute procedure public._award_cinderella_badge();

drop trigger if exists trg_award_marathon_badge                  on public.matches;
create trigger trg_award_marathon_badge
  after insert on public.matches
  for each row execute procedure public._award_marathon_badge();

drop trigger if exists trg_award_triple_crown_badge              on public.matches;
create trigger trg_award_triple_crown_badge
  after insert on public.matches
  for each row execute procedure public._award_triple_crown_badge();

drop trigger if exists trg_award_tournament_veteran_milestones   on public.tournaments;
create trigger trg_award_tournament_veteran_milestones
  after update on public.tournaments
  for each row execute procedure public._award_tournament_veteran_milestones();

drop trigger if exists trg_award_globetrotter_ii_badge           on public.matches;
create trigger trg_award_globetrotter_ii_badge
  after insert on public.matches
  for each row execute procedure public._award_globetrotter_ii_badge();


-- 6. BACKFILLS -----------------------------------------------------------

-- 6a. First-match bonus.
do $$
declare v_uid uuid;
begin
  for v_uid in
    select distinct uid from (
      select player1_id as uid from public.matches
      union all select partner1_id from public.matches
      union all select player2_id from public.matches
      union all select partner2_id from public.matches
    ) s
    where uid is not null
  loop
    begin
      if exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then continue; end if;

      insert into public.first_match_bonus_grants(user_id) values (v_uid)
        on conflict (user_id) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 200 where id = v_uid;
    exception when others then null;
    end;
  end loop;
end$$;

-- 6b. First-doubles bonus.
do $$
declare v_uid uuid;
begin
  for v_uid in
    select distinct p.id
    from public.profiles p
    join public.matches m on m.match_type = 'doubles'
      and (m.player1_id = p.id or m.partner1_id = p.id or m.player2_id = p.id or m.partner2_id = p.id)
    where not exists (select 1 from public.first_doubles_bonus_grants g where g.user_id = p.id)
  loop
    begin
      insert into public.first_doubles_bonus_grants (user_id) values (v_uid)
        on conflict (user_id) do nothing;
      update public.profiles set pickles = coalesce(pickles, 0) + 150 where id = v_uid;
    exception when others then null;
    end;
  end loop;
end$$;

-- 6c. Per-court bonus.
do $$
declare r record;
begin
  for r in
    select distinct uid, location_name from (
      select player1_id as uid, location_name from public.matches
      union all select partner1_id, location_name from public.matches
      union all select player2_id, location_name from public.matches
      union all select partner2_id, location_name from public.matches
    ) s
    where uid is not null and location_name is not null
  loop
    begin
      if exists (
        select 1 from public.court_bonus_grants
        where user_id = r.uid and location_name = r.location_name
      ) then continue; end if;

      insert into public.court_bonus_grants(user_id, location_name)
        values (r.uid, r.location_name)
        on conflict (user_id, location_name) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 100 where id = r.uid;
    exception when others then null;
    end;
  end loop;
end$$;

-- 6d. Anniversary pickles.
do $$
declare
  r       record;
  v_years integer;
  v_y     integer;
begin
  for r in select id, created_at from public.profiles where created_at is not null loop
    v_years := floor(extract(epoch from (now() - r.created_at)) / (365 * 86400))::integer;
    if v_years < 1 then continue; end if;
    for v_y in 1..v_years loop
      begin
        if exists (select 1 from public.anniversary_grants where user_id = r.id and year = v_y) then continue; end if;

        insert into public.anniversary_grants(user_id, year) values (r.id, v_y)
          on conflict (user_id, year) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 500 where id = r.id;
      exception when others then null;
      end;
    end loop;
  end loop;
end$$;

-- 6e. Tournament participation pickles.
do $$
declare
  v_t   record;
  v_uid uuid;
begin
  for v_t in select id from public.tournaments where status = 'completed' loop
    for v_uid in
      select user_id from public.tournament_registrations
       where tournament_id = v_t.id and status = 'approved' and user_id is not null
    loop
      begin
        if exists (select 1 from public.tournament_participation_grants
                    where user_id = v_uid and tournament_id = v_t.id) then continue; end if;

        insert into public.tournament_participation_grants(user_id, tournament_id)
          values (v_uid, v_t.id)
          on conflict (user_id, tournament_id) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 50 where id = v_uid;
      exception when others then null;
      end;
    end loop;
  end loop;
end$$;

-- 6f. Daily play streak (chronological walk per player).
do $$
declare
  v_uid      uuid;
  v_date     date;
  v_prev_len integer;
  v_len      integer;
  v_bonus    integer;
begin
  for v_uid in
    select distinct uid from (
      select player1_id as uid from public.matches
      union all select partner1_id from public.matches
      union all select player2_id from public.matches
      union all select partner2_id from public.matches
    ) s
    where uid is not null
  loop
    for v_date in
      select distinct (played_at)::date as d from public.matches
        where player1_id = v_uid or partner1_id = v_uid
           or player2_id = v_uid or partner2_id = v_uid
        order by d asc
    loop
      begin
        if exists (select 1 from public.daily_play_streaks where user_id = v_uid and play_date = v_date) then continue; end if;

        select streak_length into v_prev_len
          from public.daily_play_streaks
          where user_id = v_uid and play_date = v_date - 1;

        v_len   := coalesce(v_prev_len, 0) + 1;
        v_bonus := least(50 * v_len, 200);

        insert into public.daily_play_streaks(user_id, play_date, streak_length, bonus_granted)
          values (v_uid, v_date, v_len, v_bonus)
          on conflict (user_id, play_date) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
      exception when others then null;
      end;
    end loop;
  end loop;
end$$;

-- 6g. Underdog badge backfill (stacks per qualifying historical match).
insert into public.player_badges (user_id, badge_id, league_id, context, earned_at)
select
  uid,
  (select id from public.badges where name = 'Underdog'),
  null,
  format('Beat a +%s opponent on %s', diff, m.played_at::date),
  m.played_at
  from public.matches m
  cross join lateral (
    select
      case when m.winner_team = 'team1'
           then m.player2_rating_before - m.player1_rating_before
           when m.winner_team = 'team2'
           then m.player1_rating_before - m.player2_rating_before
      end as diff,
      unnest(case
        when m.winner_team = 'team1' then array_remove(array[m.player1_id, m.partner1_id], null)
        when m.winner_team = 'team2' then array_remove(array[m.player2_id, m.partner2_id], null)
        else array[]::uuid[]
      end) as uid
  ) w
 where m.player1_rating_before is not null
   and m.player2_rating_before is not null
   and w.diff >= 100
   and w.uid is not null;

-- 6h. Cinderella badge backfill.
insert into public.player_badges (user_id, badge_id, league_id, context, earned_at)
select
  uid,
  (select id from public.badges where name = 'Cinderella'),
  null,
  format('Beat a +%s favorite on %s', diff, m.played_at::date),
  m.played_at
  from public.matches m
  cross join lateral (
    select
      case when m.winner_team = 'team1'
           then m.player2_rating_before - m.player1_rating_before
           when m.winner_team = 'team2'
           then m.player1_rating_before - m.player2_rating_before
      end as diff,
      unnest(case
        when m.winner_team = 'team1' then array_remove(array[m.player1_id, m.partner1_id], null)
        when m.winner_team = 'team2' then array_remove(array[m.player2_id, m.partner2_id], null)
        else array[]::uuid[]
      end) as uid
  ) w
 where m.player1_rating_before is not null
   and m.player2_rating_before is not null
   and w.diff >= 200
   and w.uid is not null;

-- 6i. Marathon badge backfill.
insert into public.player_badges (user_id, badge_id, league_id, context, earned_at)
select
  uid,
  (select id from public.badges where name = 'Marathon'),
  null,
  format('%s-%s on %s',
    greatest(m.player1_score, m.player2_score),
    least(m.player1_score, m.player2_score),
    m.played_at::date),
  m.played_at
  from public.matches m
  cross join lateral (
    select unnest(case
      when m.winner_team = 'team1' and m.player1_score >= 12
        then array_remove(array[m.player1_id, m.partner1_id], null)
      when m.winner_team = 'team2' and m.player2_score >= 12
        then array_remove(array[m.player2_id, m.partner2_id], null)
      else array[]::uuid[]
    end) as uid
  ) winners
 where uid is not null;

-- 6j. Triple Crown backfill.
with wins as (
  select
    coalesce(m.played_at, now())::date as d,
    uid,
    m.match_type,
    m.doubles_category
  from public.matches m
  cross join lateral (
    select unnest(case
      when m.winner_team = 'team1' then array_remove(array[m.player1_id, m.partner1_id], null)
      when m.winner_team = 'team2' then array_remove(array[m.player2_id, m.partner2_id], null)
      else array[]::uuid[]
    end) as uid
  ) w
  where uid is not null
),
qualifying as (
  select uid, d
    from wins
   group by uid, d
  having bool_or(match_type = 'singles')
     and bool_or(match_type = 'doubles' and doubles_category = 'gendered')
     and bool_or(match_type = 'doubles' and doubles_category = 'mixed')
)
insert into public.player_badges (user_id, badge_id, league_id, context)
select
  q.uid,
  (select id from public.badges where name = 'Triple Crown'),
  null,
  format('Triple Crown on %s', q.d)
  from qualifying q
 where not exists (
   select 1 from public.player_badges pb
    where pb.user_id  = q.uid
      and pb.badge_id = (select id from public.badges where name = 'Triple Crown')
      and pb.context  = format('Triple Crown on %s', q.d)
 );

-- 6k. Tournament Veteran I/II/III backfill.
with player_counts as (
  select tr.user_id, count(*) as n
    from public.tournament_registrations tr
    join public.tournaments t on t.id = tr.tournament_id
   where tr.status = 'approved' and t.status = 'completed'
   group by tr.user_id
),
milestones as (
  select pc.user_id, b.id as badge_id, b.name, pc.n
    from player_counts pc
    cross join public.badges b
   where (b.name = 'Tournament Veteran I'   and pc.n >= 5)
      or (b.name = 'Tournament Veteran II'  and pc.n >= 10)
      or (b.name = 'Tournament Veteran III' and pc.n >= 25)
)
insert into public.player_badges (user_id, badge_id, league_id, context)
select m.user_id, m.badge_id, null, format('Completed %s tournaments', m.n)
  from milestones m
 where not exists (
   select 1 from public.player_badges pb
    where pb.user_id = m.user_id and pb.badge_id = m.badge_id
 );

-- 6l. Globetrotter II backfill.
with player_courts as (
  select uid as user_id, count(distinct m.location_name) as n
    from public.matches m
    cross join lateral (
      select unnest(array_remove(
        array[m.player1_id, m.partner1_id, m.player2_id, m.partner2_id], null
      )) as uid
    ) p
   where m.location_name is not null
   group by uid
)
insert into public.player_badges (user_id, badge_id, league_id, context)
select
  pc.user_id,
  (select id from public.badges where name = 'Globetrotter II'),
  null,
  format('Played at %s courts', pc.n)
  from player_courts pc
 where pc.n >= 10
   and not exists (
     select 1 from public.player_badges pb
      where pb.user_id = pc.user_id
        and pb.badge_id = (select id from public.badges where name = 'Globetrotter II')
   );


-- 7. Reload PostgREST schema cache.
notify pgrst, 'reload schema';
