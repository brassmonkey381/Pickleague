-- ============================================================
-- Mixed Doubles support
--   * profiles.gender — required for new users (collected at register);
--     existing users must set via Profile screen
--   * profiles.mixed_doubles_rating — split ELO for 2v2 mixed
--   * matches.doubles_category — 'gendered' | 'mixed' | 'unspecified'
--     (null for singles); derived in update_elo_ratings() trigger
--
-- Rules:
--   gendered    = all 4 players have the same non-null, non-prefer-not gender
--   mixed       = all 4 players have a non-null, non-prefer-not gender
--                 but they're NOT all the same
--   unspecified = at least one player has null gender or 'prefer-not-to-say'
--
-- Unspecified doubles matches do NOT update any ELO column (overall,
-- singles, doubles, or mixed). Once all 4 players have set a gender, an
-- admin can call public.recompute_doubles_ratings() to redo the replay.
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- 1. Add gender + mixed_doubles_rating to profiles ------------------------
alter table public.profiles
  add column if not exists gender text
    check (gender in ('male', 'female', 'other', 'prefer-not-to-say')),
  add column if not exists mixed_doubles_rating integer not null default 1000;

-- 2. Add doubles_category to matches --------------------------------------
alter table public.matches
  add column if not exists doubles_category text
    check (doubles_category in ('gendered', 'mixed', 'unspecified'));

-- 3. Pass gender through from auth.users metadata into profiles -----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, full_name, gender)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username',  split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'gender', '')
  );
  return new;
end;
$$;

-- 4. Helper: classify a doubles match by 4 user IDs -----------------------
create or replace function public.classify_doubles_match(
  p1 uuid, p1_partner uuid, p2 uuid, p2_partner uuid
) returns text language plpgsql stable as $$
declare
  g text[];
  has_unknown boolean;
  distinct_count integer;
begin
  select array_agg(coalesce(gender, '__null__'))
    into g
    from public.profiles
    where id = any(array[p1, p1_partner, p2, p2_partner]);

  -- Any unset or prefer-not-to-say → unspecified
  has_unknown := exists (
    select 1 from unnest(g) x
    where x = '__null__' or x = 'prefer-not-to-say'
  );
  if has_unknown then
    return 'unspecified';
  end if;

  select count(distinct x) into distinct_count from unnest(g) x;
  if distinct_count = 1 then
    return 'gendered';
  else
    return 'mixed';
  end if;
end;
$$;

-- 5. Replace the ELO trigger ---------------------------------------------
--    * Classifies doubles matches via classify_doubles_match()
--    * Stores result in new.doubles_category
--    * Routes ELO update to singles_rating / doubles_rating /
--      mixed_doubles_rating; unspecified updates nothing (overall too)
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
  cat       text;
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

    cat := public.classify_doubles_match(new.player1_id, new.partner1_id, new.player2_id, new.partner2_id);
    new.doubles_category := cat;
  else
    team1_avg := r1::float;
    team2_avg := r2::float;
    new.doubles_category := null;
    cat := null;
  end if;

  -- Always snapshot before-rating; if unspecified we keep after = before
  new.player1_rating_before := r1;
  new.player2_rating_before := r2;

  if new.match_type = 'doubles' and cat = 'unspecified' then
    new.player1_rating_after := r1;
    new.player2_rating_after := r2;
    return new;
  end if;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
  won1      := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
  delta1    := round(k * (case when won1 then 1.0 else 0.0 end - expected1));
  delta2    := -delta1;

  new.player1_rating_after := r1 + delta1;
  new.player2_rating_after := r2 + delta2;

  -- Overall rating updates for singles, gendered doubles, mixed doubles
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

  -- Split rating updates
  if new.match_type = 'singles' then
    update public.profiles set singles_rating = singles_rating + delta1 where id = new.player1_id;
    update public.profiles set singles_rating = singles_rating + delta2 where id = new.player2_id;
  elsif cat = 'gendered' then
    update public.profiles set doubles_rating = doubles_rating + delta1 where id = new.player1_id;
    update public.profiles set doubles_rating = doubles_rating + delta2 where id = new.player2_id;
    if new.partner1_id is not null then
      update public.profiles set doubles_rating = doubles_rating + delta1 where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set doubles_rating = doubles_rating + delta2 where id = new.partner2_id;
    end if;
  elsif cat = 'mixed' then
    update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta1 where id = new.player1_id;
    update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta2 where id = new.player2_id;
    if new.partner1_id is not null then
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta1 where id = new.partner1_id;
    end if;
    if new.partner2_id is not null then
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta2 where id = new.partner2_id;
    end if;
  end if;

  return new;
end;
$$;

-- 6. Reclassify all existing doubles matches & wipe doubles ratings -------
--    Idempotent: safe to re-run after players set their genders.
create or replace function public.recompute_doubles_ratings()
returns void language plpgsql security definer as $$
declare
  m record;
  r1 integer; r2 integer; r_p1 integer; r_p2 integer;
  team1_avg float; team2_avg float;
  expected1 float; delta1 integer;
  k integer := 32;
  won1 boolean;
  cat text;
begin
  -- Reset both doubles ratings
  update public.profiles
     set doubles_rating       = 1000,
         mixed_doubles_rating = 1000;

  -- Reclassify every doubles match by current profile genders
  update public.matches
     set doubles_category = public.classify_doubles_match(player1_id, partner1_id, player2_id, partner2_id)
   where match_type = 'doubles';

  -- Replay in chronological order, updating only the relevant split column
  for m in
    select * from public.matches
     where match_type = 'doubles'
       and status     = 'completed'
       and doubles_category in ('gendered', 'mixed')
     order by played_at asc, created_at asc
  loop
    if m.doubles_category = 'gendered' then
      select doubles_rating into r1   from public.profiles where id = m.player1_id;
      select doubles_rating into r_p1 from public.profiles where id = m.partner1_id;
      select doubles_rating into r2   from public.profiles where id = m.player2_id;
      select doubles_rating into r_p2 from public.profiles where id = m.partner2_id;
    else  -- mixed
      select mixed_doubles_rating into r1   from public.profiles where id = m.player1_id;
      select mixed_doubles_rating into r_p1 from public.profiles where id = m.partner1_id;
      select mixed_doubles_rating into r2   from public.profiles where id = m.player2_id;
      select mixed_doubles_rating into r_p2 from public.profiles where id = m.partner2_id;
    end if;

    team1_avg := (coalesce(r1, 1000) + coalesce(r_p1, 1000))::float / 2.0;
    team2_avg := (coalesce(r2, 1000) + coalesce(r_p2, 1000))::float / 2.0;
    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
    won1      := (m.winner_team = 'team1') or (m.winner_id = m.player1_id);
    delta1    := round(k * (case when won1 then 1.0 else 0.0 end - expected1));

    if m.doubles_category = 'gendered' then
      update public.profiles set doubles_rating = doubles_rating + delta1
        where id in (m.player1_id, m.partner1_id);
      update public.profiles set doubles_rating = doubles_rating - delta1
        where id in (m.player2_id, m.partner2_id);
    else
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta1
        where id in (m.player1_id, m.partner1_id);
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating - delta1
        where id in (m.player2_id, m.partner2_id);
    end if;
  end loop;
end;
$$;

-- 7. Run the recompute now -----------------------------------------------
select public.recompute_doubles_ratings();
