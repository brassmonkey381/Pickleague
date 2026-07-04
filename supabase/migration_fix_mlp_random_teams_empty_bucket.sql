-- Fix: generate_random_mlp_teams crashed whenever any gender bucket was
-- empty — array_length('{}', 1) is NULL in Postgres, so with zero wildcards
-- (the common case) v_total/v_team_count went NULL and the final FOR loop
-- raised "upper bound of FOR loop cannot be null". Every array_length(x, 1)
-- is now cardinality(x), which returns 0 for empty arrays.
-- Found by the toolbox flow simulator (MLP + random teams). Idempotent.

create or replace function public.generate_random_mlp_teams(
  p_tournament_id uuid,
  p_mode          text default 'random'
) returns integer language plpgsql security definer as $$
declare
  v_uid              uuid := auth.uid();
  v_format           text;
  v_team_count       integer;
  v_total            integer;
  v_pure_males       uuid[];
  v_pure_females     uuid[];
  v_wildcards        uuid[];
  v_remaining_names  text[];
  v_team_name        text;
  v_male_pool        uuid[];
  v_female_pool      uuid[];
  v_need_male        integer;
  v_need_female      integer;
  v_short_male       integer;
  v_short_female     integer;
  v_wild_avail       integer;
  v_wild_to_male     integer;
  v_wild_to_female   integer;
  v_extras           integer;
  v_male_1           uuid;
  v_male_2           uuid;
  v_female_1         uuid;
  v_female_2         uuid;
  i                  integer;
  v_order_clause     text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate teams';
  end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format <> 'mlp_random' then
    raise exception 'Use this only for MLP / Random Teams tournaments (got %)', v_format;
  end if;

  -- Reset any prior teams.
  delete from public.mlp_teams where tournament_id = p_tournament_id;

  -- ── 1. Bucket players by gender, ordered by mode. ─────────────────
  -- 'snake' orders by PLUPR desc within each bucket so the snake-draft
  -- pairs strongest with weakest. 'random' shuffles each bucket.
  if p_mode = 'snake' then
    select array_agg(tr.user_id order by p.rating desc) into v_pure_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender in ('male', 'other');
    select array_agg(tr.user_id order by p.rating desc) into v_pure_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender = 'female';
    select array_agg(tr.user_id order by p.rating desc) into v_wildcards
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and (p.gender is null or p.gender = 'prefer-not-to-say');
  else
    select array_agg(tr.user_id order by random()) into v_pure_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender in ('male', 'other');
    select array_agg(tr.user_id order by random()) into v_pure_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender = 'female';
    select array_agg(tr.user_id order by random()) into v_wildcards
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and (p.gender is null or p.gender = 'prefer-not-to-say');
  end if;

  v_pure_males   := coalesce(v_pure_males,   '{}'::uuid[]);
  v_pure_females := coalesce(v_pure_females, '{}'::uuid[]);
  v_wildcards    := coalesce(v_wildcards,    '{}'::uuid[]);

  v_total := cardinality(v_pure_males)
           + cardinality(v_pure_females)
           + cardinality(v_wildcards);
  v_team_count := v_total / 4;

  if v_team_count < 2 then
    raise exception 'Need at least 8 approved players for 2 teams (got %)', v_total;
  end if;

  -- ── 2. Decide where each wildcard goes ────────────────────────────
  v_need_male    := v_team_count * 2;
  v_need_female  := v_team_count * 2;
  v_short_male   := greatest(0, v_need_male   - cardinality(v_pure_males));
  v_short_female := greatest(0, v_need_female - cardinality(v_pure_females));
  v_wild_avail   := cardinality(v_wildcards);

  -- Pour wildcards into the shorter side first; any leftover splits evenly.
  if v_short_male + v_short_female <= v_wild_avail then
    v_wild_to_male   := v_short_male;
    v_wild_to_female := v_short_female;
    -- Distribute any leftover wildcards as evenly as possible.
    v_extras := v_wild_avail - v_wild_to_male - v_wild_to_female;
    v_wild_to_male   := v_wild_to_male   + (v_extras / 2);
    v_wild_to_female := v_wild_to_female + (v_extras - v_extras / 2);
  else
    -- Not enough wildcards to cover both shortfalls — give to the side that
    -- needs more, proportionally.
    if v_short_male = 0 then
      v_wild_to_male := 0;
      v_wild_to_female := v_wild_avail;
    elsif v_short_female = 0 then
      v_wild_to_male := v_wild_avail;
      v_wild_to_female := 0;
    else
      v_wild_to_male := round(v_wild_avail::numeric
                              * v_short_male / (v_short_male + v_short_female))::int;
      v_wild_to_female := v_wild_avail - v_wild_to_male;
    end if;
  end if;

  -- ── 3. Build the male / female slot pools ─────────────────────────
  v_male_pool   := v_pure_males   || v_wildcards[1:v_wild_to_male];
  v_female_pool := v_pure_females || v_wildcards[(v_wild_to_male + 1):(v_wild_to_male + v_wild_to_female)];

  -- ── 4. Pull a shuffled batch of unique team names ─────────────────
  select array_agg(name order by random()) into v_remaining_names
    from (
      select name from public.mlp_team_name_pool order by random() limit v_team_count
    ) s;

  -- ── 5. Create the teams ───────────────────────────────────────────
  for i in 1 .. v_team_count loop
    if p_mode = 'snake' then
      v_male_1   := v_male_pool  [i];
      v_male_2   := v_male_pool  [2 * v_team_count - i + 1];
      v_female_1 := v_female_pool[i];
      v_female_2 := v_female_pool[2 * v_team_count - i + 1];
    else
      v_male_1   := v_male_pool  [(i - 1) * 2 + 1];
      v_male_2   := v_male_pool  [(i - 1) * 2 + 2];
      v_female_1 := v_female_pool[(i - 1) * 2 + 1];
      v_female_2 := v_female_pool[(i - 1) * 2 + 2];
    end if;

    v_team_name := coalesce(v_remaining_names[i], 'Team ' || i);

    -- Insert the team. Empty slots are allowed (legacy column nullability)
    -- so partial teams are still written when wildcards weren't enough.
    insert into public.mlp_teams (
      tournament_id, name, status, is_random_generated,
      male_1_id, male_2_id, female_1_id, female_2_id
    ) values (
      p_tournament_id, v_team_name, 'locked', true,
      v_male_1, v_male_2, v_female_1, v_female_2
    );
  end loop;

  return v_team_count;
end;
$$;
