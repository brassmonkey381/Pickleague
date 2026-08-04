-- F4 from the 2026-08 tournament audit: manual pot distribution was not
-- team-aware.
--
-- distribute_tournament_pool mapped p_winner_uids[i] straight onto
-- payout_structure[i] and paid that whole share to ONE uid. The picker in
-- PicklePotCard lists individual players and requires one pick per paying
-- place, so in a doubles tournament an admin naming both members of the
-- winning pair paid partner #1 the 1st-place share and partner #2 the
-- 2nd-place share — the runners-up got nothing. In MLP it was worse: three of
-- the four champions were simply skipped.
--
-- Both auto-payout paths already split within a place; only the manual one did
-- not. Now each pick is resolved to the team it stands for and that place's
-- share is divided evenly across the roster:
--
--   MLP / mlp_random  -> mlp_teams (male_1, male_2, female_1, female_2)
--   anything doubles  -> doubles_pairs (partner_1, partner_2)
--   singles / no team -> the individual, exactly as before
--
-- Team size is read from the roster rather than assumed, so a pair with an
-- unfilled slot splits by however many players are actually on it.
--
-- Also guards the footgun this awareness introduces: because the picker offers
-- individuals, naming two members of the SAME team for two different places
-- would now pay that team twice. Each team is paid at most once, at its best
-- (first-listed) place, and the skip is reported back.
--
-- Integer division truncates, so a place's share may leave 1-2 🥒 of dust in
-- the pool. That is deliberate — it can never over-distribute.

create or replace function public.distribute_tournament_pool(p_tournament_id uuid, p_winner_uids uuid[])
returns table(success boolean, distributed integer, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool        integer;
  v_structure   integer[];
  v_format      text;
  v_total       integer := 0;
  v_places      integer := 0;
  v_skipped     integer := 0;
  v_place_share integer;
  v_share       integer;
  v_recipient   uuid;
  v_member      uuid;
  v_team_key    uuid;
  v_members     uuid[];
  v_paid_teams  uuid[] := '{}';
  i             integer;
begin
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may distribute';
  end if;

  select prize_pool, payout_structure, format
    into v_pool, v_structure, v_format
    from public.tournaments where id = p_tournament_id;

  if v_pool is null or v_pool = 0 then
    return query select false, 0, 'Pool is empty'::text; return;
  end if;

  for i in 1 .. least(coalesce(array_length(v_structure, 1), 0),
                      coalesce(array_length(p_winner_uids, 1), 0)) loop
    v_recipient := p_winner_uids[i];
    if v_recipient is null then continue; end if;

    v_members  := null;
    v_team_key := null;

    if v_format in ('mlp', 'mlp_random') then
      select mt.id,
             array_remove(array[mt.male_1_id, mt.male_2_id, mt.female_1_id, mt.female_2_id], null)
        into v_team_key, v_members
        from public.mlp_teams mt
       where mt.tournament_id = p_tournament_id
         and v_recipient in (mt.male_1_id, mt.male_2_id, mt.female_1_id, mt.female_2_id)
       limit 1;
    else
      select dp.id,
             array_remove(array[dp.partner_1_id, dp.partner_2_id], null)
        into v_team_key, v_members
        from public.doubles_pairs dp
       where dp.tournament_id = p_tournament_id
         and v_recipient in (dp.partner_1_id, dp.partner_2_id)
       limit 1;
    end if;

    -- Singles, or a pick with no team on record: pay the individual.
    if v_members is null or cardinality(v_members) = 0 then
      v_members  := array[v_recipient];
      v_team_key := v_recipient;
    end if;

    -- One payout per team. Without this, picking two members of the same pair
    -- for places 1 and 2 would pay that pair both shares.
    if v_team_key = any(v_paid_teams) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_paid_teams := v_paid_teams || v_team_key;

    v_place_share := floor(v_pool * v_structure[i] / 100.0);
    v_share       := floor(v_place_share / cardinality(v_members));
    if v_share <= 0 then continue; end if;

    foreach v_member in array v_members loop
      update public.profiles set pickles = pickles + v_share where id = v_member;
      insert into public.pickle_pot_payouts
        (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
      values ('tournament', p_tournament_id, v_member, v_share,
              'Tournament finish #' || i, auth.uid(), true);
      v_total := v_total + v_share;
    end loop;
    v_places := v_places + 1;
  end loop;

  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0)
   where id = p_tournament_id;

  return query select true, v_total,
    format('Distributed %s 🥒 across %s place(s)%s', v_total, v_places,
           case when v_skipped > 0
                then format(' (%s pick(s) skipped — same team already paid)', v_skipped)
                else '' end);
end;
$$;

revoke execute on function public.distribute_tournament_pool(uuid, uuid[]) from public, anon;
grant execute on function public.distribute_tournament_pool(uuid, uuid[]) to authenticated;
