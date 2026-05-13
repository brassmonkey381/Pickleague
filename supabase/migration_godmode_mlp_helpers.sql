-- ============================================================
-- Godmode helpers for MLP Fixed-Teams setup pain points.
--
-- 1. godmode_confirm_my_mlp_invites(p_tournament_id)
--    For every pending 'invite' I (the calling godmode user) have
--    sent on a team I captain in this tournament, force-accept it.
--    Reuses mlp_respond_to_join's slot-fill + notification logic.
--
-- 2. godmode_force_fill_mlp_teams(p_tournament_id)
--    Build teams of 4 from approved registrants who aren't already
--    on a team. Same wildcard-gender balancing as the random
--    generator, but APPENDS new teams instead of wiping existing
--    ones. Names come from mlp_team_name_pool with collision-safe
--    fallback. Skips silently when fewer than 4 leftover players.
-- ============================================================


-- 1. Confirm all my pending invites ------------------------------------
create or replace function public.godmode_confirm_my_mlp_invites(p_tournament_id uuid)
returns table (accepted integer, message text)
language plpgsql security definer as $$
declare
  v_uid  uuid := auth.uid();
  v_req  record;
  v_acc  integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then raise exception 'Godmode only'; end if;

  for v_req in
    select jr.id
      from public.mlp_team_join_requests jr
      join public.mlp_teams t on t.id = jr.team_id
     where t.tournament_id = p_tournament_id
       and t.captain_id    = v_uid
       and jr.direction    = 'invite'
       and jr.status       = 'pending'
  loop
    begin
      perform public.mlp_respond_to_join(v_req.id, true);
      v_acc := v_acc + 1;
    exception when others then
      -- Skip the ones that can't be accepted (full slots, no gender, etc.)
      -- without failing the whole sweep.
      null;
    end;
  end loop;

  return query select v_acc,
    case when v_acc = 0
      then 'No pending invites I could accept.'::text
      else format('Accepted %s invite(s).', v_acc)::text
    end;
end;
$$;


-- 2. Force-fill remaining teams ---------------------------------------
create or replace function public.godmode_force_fill_mlp_teams(p_tournament_id uuid)
returns table (teams_created integer, players_placed integer, message text)
language plpgsql security definer as $$
declare
  v_uid              uuid := auth.uid();
  v_format           text;
  v_remaining_ids    uuid[];
  v_pure_males       uuid[];
  v_pure_females     uuid[];
  v_wildcards        uuid[];
  v_total            integer;
  v_team_count       integer;
  v_need_male        integer;
  v_need_female      integer;
  v_short_male       integer;
  v_short_female     integer;
  v_wild_avail       integer;
  v_wild_to_male     integer;
  v_wild_to_female   integer;
  v_extras           integer;
  v_male_pool        uuid[];
  v_female_pool      uuid[];
  v_male_1           uuid;
  v_male_2           uuid;
  v_female_1         uuid;
  v_female_2         uuid;
  v_remaining_names  text[];
  v_team_name        text;
  v_placed           integer := 0;
  i                  integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then raise exception 'Godmode only'; end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format not in ('mlp', 'mlp_random') then
    raise exception 'Not an MLP tournament (got %)', v_format;
  end if;

  -- ── 1. Determine who is NOT yet on a team in this tournament ──────
  -- Gather all approved user_ids, subtract anyone occupying any slot
  -- (captain or one of the 4 slots) on an existing team.
  with on_team as (
    select unnest(array[captain_id, male_1_id, male_2_id, female_1_id, female_2_id]) as user_id
      from public.mlp_teams
     where tournament_id = p_tournament_id
  )
  select array_agg(tr.user_id) into v_remaining_ids
    from public.tournament_registrations tr
   where tr.tournament_id = p_tournament_id
     and tr.status        = 'approved'
     and tr.user_id not in (select user_id from on_team where user_id is not null);

  if v_remaining_ids is null or array_length(v_remaining_ids, 1) < 4 then
    return query select 0, 0,
      format('Not enough leftover players to form a team (need 4, have %s).',
             coalesce(array_length(v_remaining_ids, 1), 0))::text;
    return;
  end if;

  -- ── 2. Bucket by gender (random order within each bucket) ─────────
  select array_agg(tr.user_id order by random()) into v_pure_males
    from public.tournament_registrations tr
    join public.profiles p on p.id = tr.user_id
   where tr.user_id = any(v_remaining_ids)
     and p.gender in ('male', 'other');

  select array_agg(tr.user_id order by random()) into v_pure_females
    from public.tournament_registrations tr
    join public.profiles p on p.id = tr.user_id
   where tr.user_id = any(v_remaining_ids)
     and p.gender = 'female';

  select array_agg(tr.user_id order by random()) into v_wildcards
    from public.tournament_registrations tr
    join public.profiles p on p.id = tr.user_id
   where tr.user_id = any(v_remaining_ids)
     and (p.gender is null or p.gender = 'prefer-not-to-say');

  v_pure_males   := coalesce(v_pure_males,   '{}'::uuid[]);
  v_pure_females := coalesce(v_pure_females, '{}'::uuid[]);
  v_wildcards    := coalesce(v_wildcards,    '{}'::uuid[]);

  v_total      := array_length(v_pure_males, 1) + array_length(v_pure_females, 1) + array_length(v_wildcards, 1);
  v_team_count := v_total / 4;
  if v_team_count < 1 then
    return query select 0, 0, 'Leftover players cannot form a full team.'::text;
    return;
  end if;

  -- ── 3. Decide wildcard placement (same algo as random generator) ──
  v_need_male    := v_team_count * 2;
  v_need_female  := v_team_count * 2;
  v_short_male   := greatest(0, v_need_male   - array_length(v_pure_males, 1));
  v_short_female := greatest(0, v_need_female - array_length(v_pure_females, 1));
  v_wild_avail   := array_length(v_wildcards, 1);

  if v_short_male + v_short_female <= v_wild_avail then
    v_wild_to_male   := v_short_male;
    v_wild_to_female := v_short_female;
    v_extras := v_wild_avail - v_wild_to_male - v_wild_to_female;
    v_wild_to_male   := v_wild_to_male   + (v_extras / 2);
    v_wild_to_female := v_wild_to_female + (v_extras - v_extras / 2);
  else
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

  v_male_pool   := v_pure_males   || v_wildcards[1:v_wild_to_male];
  v_female_pool := v_pure_females || v_wildcards[(v_wild_to_male + 1):(v_wild_to_male + v_wild_to_female)];

  -- ── 4. Pull team names from the pool, skipping ones already in use ─
  select array_agg(name order by random()) into v_remaining_names
    from (
      select n.name
        from public.mlp_team_name_pool n
       where n.name not in (select name from public.mlp_teams where tournament_id = p_tournament_id)
       order by random()
       limit v_team_count
    ) s;

  -- ── 5. Create the teams ───────────────────────────────────────────
  for i in 1 .. v_team_count loop
    v_male_1   := v_male_pool  [(i - 1) * 2 + 1];
    v_male_2   := v_male_pool  [(i - 1) * 2 + 2];
    v_female_1 := v_female_pool[(i - 1) * 2 + 1];
    v_female_2 := v_female_pool[(i - 1) * 2 + 2];

    v_team_name := coalesce(v_remaining_names[i], 'Team ' || (i + 100));

    insert into public.mlp_teams (
      tournament_id, name, status, is_random_generated,
      male_1_id, male_2_id, female_1_id, female_2_id
    ) values (
      p_tournament_id, v_team_name, 'locked', true,
      v_male_1, v_male_2, v_female_1, v_female_2
    );

    v_placed := v_placed
              + (case when v_male_1   is not null then 1 else 0 end)
              + (case when v_male_2   is not null then 1 else 0 end)
              + (case when v_female_1 is not null then 1 else 0 end)
              + (case when v_female_2 is not null then 1 else 0 end);
  end loop;

  return query select v_team_count, v_placed,
    format('Force-created %s team(s), placed %s players.', v_team_count, v_placed)::text;
end;
$$;


-- 3. Grants -----------------------------------------------------------
grant execute on function public.godmode_confirm_my_mlp_invites(uuid) to authenticated;
grant execute on function public.godmode_force_fill_mlp_teams(uuid)   to authenticated;

notify pgrst, 'reload schema';
