-- ============================================================
-- Bugfixes for migration_godmode_mlp_helpers.sql
--
-- 1. godmode_force_fill_mlp_teams: bucketing joins were missing
--    the `tournament_id` filter, so users with registrations in
--    other tournaments got counted multiple times → inflated team
--    count. Rewritten to pull genders straight from `profiles`
--    given v_remaining_ids (already filtered by tournament).
--    Also adds a final DISTINCT guard so a single user can never
--    appear twice in the bucket arrays.
--
-- 2. godmode_confirm_my_mlp_invites: was swallowing every per-
--    invite error inside EXCEPTION WHEN OTHERS, so users saw
--    "Accepted 0" with no clue why. Now returns a `details`
--    array so the UI can surface which invites failed and why.
--
-- 3. Post-condition: before returning, force-fill verifies no
--    user appears on more than one team in the tournament.
--    Raises if invariant violated.
--
-- Run AFTER migration_godmode_mlp_helpers.sql.
-- ============================================================


-- 1. Confirm-invites — return per-invite details ------------------------
drop function if exists public.godmode_confirm_my_mlp_invites(uuid);
create or replace function public.godmode_confirm_my_mlp_invites(p_tournament_id uuid)
returns table (accepted integer, failed integer, message text, details text[])
language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_req     record;
  v_acc     integer := 0;
  v_fail    integer := 0;
  v_details text[]  := '{}';
  v_name    text;
  v_err     text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then raise exception 'Godmode only'; end if;

  for v_req in
    select jr.id as req_id, jr.user_id as invitee_id, t.name as team_name
      from public.mlp_team_join_requests jr
      join public.mlp_teams t on t.id = jr.team_id
     where t.tournament_id = p_tournament_id
       and t.captain_id    = v_uid
       and jr.direction    = 'invite'
       and jr.status       = 'pending'
  loop
    select full_name into v_name from public.profiles where id = v_req.invitee_id;
    begin
      perform public.mlp_respond_to_join(v_req.req_id, true);
      v_acc := v_acc + 1;
      v_details := v_details || format('✓ %s → %s', coalesce(v_name, 'player'), v_req.team_name);
    exception when others then
      v_fail := v_fail + 1;
      v_err  := sqlerrm;
      v_details := v_details ||
        format('✗ %s → %s: %s', coalesce(v_name, 'player'), v_req.team_name, v_err);
    end;
  end loop;

  return query select v_acc, v_fail,
    case
      when v_acc = 0 and v_fail = 0 then 'No pending invites I''ve sent.'::text
      when v_fail = 0               then format('Accepted %s invite(s).', v_acc)::text
      when v_acc  = 0               then format('All %s invite(s) failed — see details.', v_fail)::text
      else                               format('Accepted %s, failed %s — see details.', v_acc, v_fail)::text
    end,
    v_details;
end;
$$;


-- 2. Force-fill — correct bucketing + uniqueness guard -----------------
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
  v_dupes            integer;
  i                  integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then raise exception 'Godmode only'; end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format not in ('mlp', 'mlp_random') then
    raise exception 'Not an MLP tournament (got %)', v_format;
  end if;

  -- ── 1. Who is approved AND not already on a team in this tournament ──
  -- DISTINCT defends against accidental dupes (shouldn't happen but the
  -- previous bug taught us to be paranoid).
  with on_team as (
    select unnest(array[captain_id, male_1_id, male_2_id, female_1_id, female_2_id]) as user_id
      from public.mlp_teams
     where tournament_id = p_tournament_id
  )
  select array_agg(distinct tr.user_id) into v_remaining_ids
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

  -- ── 2. Bucket by gender — query profiles directly (no tournament_id
  --    cross-contamination from tournament_registrations dupes) ─────
  select array_agg(p.id order by random()) into v_pure_males
    from public.profiles p
   where p.id = any(v_remaining_ids)
     and p.gender in ('male', 'other');

  select array_agg(p.id order by random()) into v_pure_females
    from public.profiles p
   where p.id = any(v_remaining_ids)
     and p.gender = 'female';

  select array_agg(p.id order by random()) into v_wildcards
    from public.profiles p
   where p.id = any(v_remaining_ids)
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

  -- ── 3. Wildcard placement (same algo as random generator) ──────────
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

  -- ── 4. Names (skip ones already in use in this tournament) ─────────
  select array_agg(name order by random()) into v_remaining_names
    from (
      select n.name
        from public.mlp_team_name_pool n
       where n.name not in (select name from public.mlp_teams where tournament_id = p_tournament_id)
       order by random()
       limit v_team_count
    ) s;

  -- ── 5. Create the teams ────────────────────────────────────────────
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

  -- ── 6. Post-condition: nobody appears on more than one team ────────
  with all_slots as (
    select unnest(array[captain_id, male_1_id, male_2_id, female_1_id, female_2_id]) as uid
      from public.mlp_teams
     where tournament_id = p_tournament_id
  )
  select count(*) into v_dupes from (
    select uid from all_slots where uid is not null
     group by uid having count(*) > 1
  ) d;

  if v_dupes > 0 then
    -- This shouldn't happen with the corrected bucketing; raise so the
    -- transaction rolls back and we don't leave a corrupt state.
    raise exception 'Duplicate team membership detected (% user(s) on >1 team) — rolling back', v_dupes;
  end if;

  return query select v_team_count, v_placed,
    format('Force-created %s team(s), placed %s players.', v_team_count, v_placed)::text;
end;
$$;


-- 3. Sweep RPC — remove duplicate team memberships from a tournament ---
--    Helper for cleanup after the v1 bug. Keeps the EARLIEST team
--    membership for each user; nulls out duplicates on later teams.
--    Returns the number of duplicate slots cleared. Godmode-only.
create or replace function public.godmode_dedupe_mlp_team_members(p_tournament_id uuid)
returns table (cleared integer, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_cleared   integer := 0;
  v_row       record;
  v_team      record;
  v_slot      text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user() then raise exception 'Godmode only'; end if;

  -- For each user that appears in any slot on >1 team, keep the slot
  -- on the team with the earliest created_at and clear the rest.
  for v_row in
    with all_slots as (
      select t.id as team_id, t.created_at, t.captain_id as uid, 'captain'::text as slot
        from public.mlp_teams t where t.tournament_id = p_tournament_id and t.captain_id  is not null
      union all
      select t.id, t.created_at, t.male_1_id,   'male_1'    from public.mlp_teams t where t.tournament_id = p_tournament_id and t.male_1_id   is not null
      union all
      select t.id, t.created_at, t.male_2_id,   'male_2'    from public.mlp_teams t where t.tournament_id = p_tournament_id and t.male_2_id   is not null
      union all
      select t.id, t.created_at, t.female_1_id, 'female_1'  from public.mlp_teams t where t.tournament_id = p_tournament_id and t.female_1_id is not null
      union all
      select t.id, t.created_at, t.female_2_id, 'female_2'  from public.mlp_teams t where t.tournament_id = p_tournament_id and t.female_2_id is not null
    ),
    ranked as (
      select team_id, slot, uid, created_at,
             row_number() over (partition by uid order by created_at asc, team_id) as rn
        from all_slots
    )
    select team_id, slot, uid from ranked where rn > 1
  loop
    if v_row.slot = 'captain' then
      update public.mlp_teams set captain_id = null where id = v_row.team_id;
    else
      execute format('update public.mlp_teams set %I_id = null where id = $1', v_row.slot)
        using v_row.team_id;
    end if;
    v_cleared := v_cleared + 1;
  end loop;

  -- Drop teams that are now completely empty (all 4 slots null after cleanup).
  delete from public.mlp_teams
   where tournament_id = p_tournament_id
     and male_1_id is null and male_2_id is null
     and female_1_id is null and female_2_id is null
     and captain_id is null;

  return query select v_cleared,
    case when v_cleared = 0 then 'No duplicates found.'::text
         else format('Cleared %s duplicate slot(s) and removed empty teams.', v_cleared)::text
    end;
end;
$$;


grant execute on function public.godmode_confirm_my_mlp_invites(uuid) to authenticated;
grant execute on function public.godmode_force_fill_mlp_teams(uuid)   to authenticated;
grant execute on function public.godmode_dedupe_mlp_team_members(uuid) to authenticated;

notify pgrst, 'reload schema';
