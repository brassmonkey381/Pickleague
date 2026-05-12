-- ============================================================
-- persist_random_doubles_pairs — used at bracket lock-in time to write
-- the in-memory random pairings (computed during preview) to the
-- doubles_pairs table, so the pair UI reflects every team that
-- actually plays.
--
-- Idempotent-ish: silently skips any (p1, p2) where either player is
-- already on a pair in this tournament.
-- ============================================================

create or replace function public.persist_random_doubles_pairs(
  p_tournament_id uuid,
  p_pairs         jsonb        -- array of {"p1": uuid, "p2": uuid}
) returns integer
language plpgsql security definer as $$
declare
  v_uid      uuid := auth.uid();
  v_match    text;
  v_format   text;
  v_pair     jsonb;
  v_p1       uuid;
  v_p2       uuid;
  v_idx      integer := 0;
  v_created  integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select match_type, format into v_match, v_format
    from public.tournaments where id = p_tournament_id;
  if v_match is null then raise exception 'Tournament not found'; end if;
  if v_match <> 'doubles' or v_format in ('mlp', 'mlp_random', 'rotating_partners') then
    raise exception 'Format does not use fixed doubles pairs';
  end if;

  if not (public._is_tournament_admin(p_tournament_id, v_uid) or public.is_godmode_user()) then
    raise exception 'Only tournament admins can persist pairs';
  end if;

  for v_pair in select * from jsonb_array_elements(p_pairs) loop
    v_idx := v_idx + 1;
    v_p1 := (v_pair ->> 'p1')::uuid;
    v_p2 := (v_pair ->> 'p2')::uuid;
    if v_p1 is null or v_p2 is null then continue; end if;

    -- Skip if either player is already on a pair in this tournament.
    if exists (
      select 1 from public.doubles_pairs
       where tournament_id = p_tournament_id
         and v_p1 in (captain_id, partner_1_id, partner_2_id)
    ) then continue; end if;
    if exists (
      select 1 from public.doubles_pairs
       where tournament_id = p_tournament_id
         and v_p2 in (captain_id, partner_1_id, partner_2_id)
    ) then continue; end if;

    insert into public.doubles_pairs (
      tournament_id, name, captain_id, partner_1_id, partner_2_id, status, is_random_generated
    ) values (
      p_tournament_id,
      format('Random Pair %s', v_idx),
      v_p1, v_p1, v_p2, 'locked', true
    );
    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

grant execute on function public.persist_random_doubles_pairs(uuid, jsonb) to authenticated;
