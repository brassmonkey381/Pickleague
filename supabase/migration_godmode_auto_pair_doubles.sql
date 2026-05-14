-- ============================================================
-- godmode_auto_pair_doubles_for_tournament — godmode shortcut to
-- pair up all approved, unpaired players in a regular doubles
-- tournament (round-robin / single-elim / double-elim / pool-play).
--
-- Pairs are inserted with status='locked' so they're ready for the
-- bracket to be generated immediately. If the approved roster has
-- an odd count, the last shuffled user is returned as
-- leftover_user_id (still unpaired).
--
-- MLP tournaments use a separate team-fill flow
-- (godmode_force_fill_mlp_teams) so this RPC refuses to run on
-- mlp / mlp_random.
-- ============================================================

create or replace function public.godmode_auto_pair_doubles_for_tournament(
  p_tournament_id uuid
) returns table (pairs_created integer, leftover_user_id uuid, message text)
language plpgsql security definer as $$
declare
  v_match     text;
  v_format    text;
  v_unpaired  uuid[];
  v_count     integer;
  v_pairs     integer := 0;
  v_leftover  uuid;
  v_i         integer;
  v_p1        uuid;
  v_p2        uuid;
begin
  if not public.is_godmode_user(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select match_type, format into v_match, v_format
    from public.tournaments where id = p_tournament_id;
  if v_match is null then raise exception 'Tournament not found'; end if;
  if v_match <> 'doubles' then
    raise exception 'Tournament is not doubles (match_type=%)', v_match;
  end if;
  if v_format in ('mlp', 'mlp_random') then
    raise exception 'MLP tournaments use the team-fill flow, not pair auto-fill';
  end if;

  -- Approved players not already on a pair in this tournament.
  with already_paired as (
    select unnest(array[captain_id, partner_1_id, partner_2_id]) as uid
      from public.doubles_pairs where tournament_id = p_tournament_id
  )
  select array_agg(tr.user_id order by random())
    into v_unpaired
    from public.tournament_registrations tr
   where tr.tournament_id = p_tournament_id
     and tr.status        = 'approved'
     and tr.user_id not in (select uid from already_paired where uid is not null);

  v_count := coalesce(array_length(v_unpaired, 1), 0);

  if v_count >= 2 then
    for v_i in 1 .. (v_count / 2) loop
      v_p1 := v_unpaired[2 * v_i - 1];
      v_p2 := v_unpaired[2 * v_i];

      insert into public.doubles_pairs (
        tournament_id, name, captain_id, partner_1_id, partner_2_id,
        is_random_generated, status
      ) values (
        p_tournament_id,
        format('Random Pair %s', v_pairs + 1),
        v_p1, v_p1, v_p2, true, 'locked'
      );
      v_pairs := v_pairs + 1;
    end loop;
  end if;

  if v_count % 2 = 1 then
    v_leftover := v_unpaired[v_count];
  end if;

  return query select v_pairs, v_leftover,
    format('Created %s pair(s).%s', v_pairs,
           case when v_leftover is not null then ' 1 player left unpaired.' else '' end)::text;
end;
$$;

grant execute on function public.godmode_auto_pair_doubles_for_tournament(uuid) to authenticated;

notify pgrst, 'reload schema';
