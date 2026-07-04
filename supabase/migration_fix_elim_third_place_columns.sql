-- Fix: migration_elim_third_place_payout's 3rd-place branches referenced
-- tournament_matches columns that don't exist (player1_id / partner1_id /
-- player2_id / partner2_id — the real columns are team1_player1 /
-- team1_player2 / team2_player1 / team2_player2, used correctly elsewhere in
-- the same function). plpgsql only resolves columns at execution, so the bug
-- hid until a 3+-slot payout structure ran an elimination payout, then the
-- WHOLE payout aborted with "column tm.player2_id does not exist". Found by
-- a toolbox economy run rolling 50/30/20 on single-elim doubles.
-- Body otherwise identical to migration_elim_third_place_payout.

create or replace function public.preview_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
)
language plpgsql stable security definer as $$
declare
  v_format       text;
  v_match_type   text;
  v_pool         integer;
  v_structure    integer[];
  v_slots        integer;
  v_final        record;
  v_winner_uids  uuid[];
  v_loser_uids   uuid[];
  v_winner_pair  uuid;
  v_loser_pair   uuid;
  v_third        record;
  v_third_sides  integer;
begin
  select t.format, t.match_type, coalesce(t.prize_pool, 0),
         coalesce(t.payout_structure, '{60,25,15}')
    into v_format, v_match_type, v_pool, v_structure
    from public.tournaments t where t.id = p_tournament_id;

  if v_format is null then return; end if;
  v_slots := coalesce(array_length(v_structure, 1), 0);
  if v_slots = 0 then return; end if;

  -- ── MLP delegates to its dedicated RPC ────────────────────────
  if v_format in ('mlp', 'mlp_random') then
    return query
      select p.place, p.team_id, p.team_name, p.uids, p.user_names,
             p.pool_share, p.share_per_user, p.plupr_bonus
        from public.preview_mlp_tournament_payout(p_tournament_id) p;
    return;
  end if;

  -- ── Single / double elimination — finals / grand_final winner ─
  if v_format in ('single_elimination', 'double_elimination') then
    select tm.id,
           tm.team1_player1, tm.team1_player2,
           tm.team2_player1, tm.team2_player2,
           tm.winner_team
      into v_final
      from public.tournament_matches tm
      join public.tournament_rounds  tr on tr.id = tm.round_id
     where tr.tournament_id = p_tournament_id
       and tr.round_type in ('finals', 'grand_final')
       and tm.status = 'completed'
       and tm.winner_team in ('team1', 'team2')
     order by tr.round_number desc, tm.match_order desc
     limit 1;

    if v_final.id is null then return; end if;

    if v_final.winner_team = 'team1' then
      v_winner_uids := array_remove(array[v_final.team1_player1, v_final.team1_player2], null);
      v_loser_uids  := array_remove(array[v_final.team2_player1, v_final.team2_player2], null);
    else
      v_winner_uids := array_remove(array[v_final.team2_player1, v_final.team2_player2], null);
      v_loser_uids  := array_remove(array[v_final.team1_player1, v_final.team1_player2], null);
    end if;

    if v_match_type = 'doubles' and array_length(v_winner_uids, 1) >= 2 then
      select dp.id into v_winner_pair from public.doubles_pairs dp
       where dp.tournament_id = p_tournament_id
         and (
              (dp.partner_1_id = v_winner_uids[1] and dp.partner_2_id = v_winner_uids[2])
           or (dp.partner_1_id = v_winner_uids[2] and dp.partner_2_id = v_winner_uids[1])
         )
       limit 1;
    end if;
    if v_match_type = 'doubles' and array_length(v_loser_uids, 1) >= 2 then
      select dp.id into v_loser_pair from public.doubles_pairs dp
       where dp.tournament_id = p_tournament_id
         and (
              (dp.partner_1_id = v_loser_uids[1] and dp.partner_2_id = v_loser_uids[2])
           or (dp.partner_1_id = v_loser_uids[2] and dp.partner_2_id = v_loser_uids[1])
         )
       limit 1;
    end if;

    return query select
      1,
      v_winner_pair,
      coalesce(
        (select name from public.doubles_pairs where id = v_winner_pair),
        (select string_agg(p.full_name, ' & ' order by p.full_name)
           from public.profiles p where p.id = any(v_winner_uids))
      ),
      v_winner_uids,
      (select array_agg(p.full_name order by p.full_name)
         from public.profiles p where p.id = any(v_winner_uids)),
      floor(v_pool * v_structure[1] / 100.0)::int,
      floor(floor(v_pool * v_structure[1] / 100.0)
            / greatest(coalesce(array_length(v_winner_uids, 1), 0), 1))::int,
      0.500::numeric(6,3);

    if v_slots >= 2 then
      return query select
        2,
        v_loser_pair,
        coalesce(
          (select name from public.doubles_pairs where id = v_loser_pair),
          (select string_agg(p.full_name, ' & ' order by p.full_name)
             from public.profiles p where p.id = any(v_loser_uids))
        ),
        v_loser_uids,
        (select array_agg(p.full_name order by p.full_name)
           from public.profiles p where p.id = any(v_loser_uids)),
        floor(v_pool * v_structure[2] / 100.0)::int,
        floor(floor(v_pool * v_structure[2] / 100.0)
              / greatest(coalesce(array_length(v_loser_uids, 1), 0), 1))::int,
        0.250::numeric(6,3);
    end if;

    -- 3rd place. Previously undistributed for elimination formats, silently
    -- stranding that share of the pot. Double elim: the loser of the last
    -- losers-bracket match is an unambiguous #3. Single elim: the two
    -- semifinal losers tie for 3rd and SPLIT its share.
    if v_slots >= 3 then
      if v_format = 'double_elimination' then
        select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team
          into v_third
          from public.tournament_matches tm
          join public.tournament_rounds tr on tr.id = tm.round_id
         where tr.tournament_id = p_tournament_id
           and tr.round_type = 'losers'
           and tm.status = 'completed' and tm.winner_team in ('team1','team2')
         order by tr.round_number desc, tm.match_order desc
         limit 1;
        if v_third.winner_team is not null then
          return query select
            3, null::uuid,
            (select string_agg(p.full_name, ' & ' order by p.full_name) from public.profiles p
              where p.id = any(case when v_third.winner_team = 'team1'
                                    then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                                    else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end)),
            case when v_third.winner_team = 'team1'
                 then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                 else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end,
            (select array_agg(p.full_name order by p.full_name) from public.profiles p
              where p.id = any(case when v_third.winner_team = 'team1'
                                    then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                                    else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end)),
            floor(v_pool * v_structure[3] / 100.0)::int,
            floor(floor(v_pool * v_structure[3] / 100.0)
                  / greatest(case when v_third.winner_team = 'team1'
                                  then coalesce(array_length(array_remove(array[v_third.team2_player1, v_third.team2_player2], null), 1), 0)
                                  else coalesce(array_length(array_remove(array[v_third.team1_player1, v_third.team1_player2], null), 1), 0) end, 1))::int,
            0.100::numeric(6,3);
        end if;
      else
        -- single elim: losers of the round directly below the finals round
        select count(*)::int into v_third_sides
          from public.tournament_matches tm
          join public.tournament_rounds tr on tr.id = tm.round_id
          join public.tournament_rounds fin on fin.tournament_id = tr.tournament_id and fin.round_type = 'finals'
         where tr.tournament_id = p_tournament_id
           and tr.round_type = 'winners' and tr.round_number = fin.round_number - 1
           and tm.status = 'completed' and tm.winner_team in ('team1','team2');
        if coalesce(v_third_sides, 0) > 0 then
          return query
            select 3, null::uuid,
                   (select string_agg(p.full_name, ' & ' order by p.full_name) from public.profiles p where p.id = any(l.uids)),
                   l.uids,
                   (select array_agg(p.full_name order by p.full_name) from public.profiles p where p.id = any(l.uids)),
                   floor(v_pool * v_structure[3] / 100.0 / v_third_sides)::int,
                   floor(floor(v_pool * v_structure[3] / 100.0 / v_third_sides)
                         / greatest(coalesce(array_length(l.uids, 1), 0), 1))::int,
                   0.100::numeric(6,3)
              from (
                select case when tm.winner_team = 'team1'
                            then array_remove(array[tm.team2_player1, tm.team2_player2], null)
                            else array_remove(array[tm.team1_player1, tm.team1_player2], null) end as uids
                  from public.tournament_matches tm
                  join public.tournament_rounds tr on tr.id = tm.round_id
                  join public.tournament_rounds fin on fin.tournament_id = tr.tournament_id and fin.round_type = 'finals'
                 where tr.tournament_id = p_tournament_id
                   and tr.round_type = 'winners' and tr.round_number = fin.round_number - 1
                   and tm.status = 'completed' and tm.winner_team in ('team1','team2')
              ) l
             where coalesce(array_length(l.uids, 1), 0) > 0;
        end if;
      end if;
    end if;

    return;
  end if;

  -- ── Round robin / pool play (singles) ─────────────────────────
  if v_format in ('round_robin', 'pool_play') and v_match_type = 'singles' then
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed'
              and ((m.team1_player1 = r.user_id and m.winner_team = 'team1')
                or (m.team2_player1 = r.user_id and m.winner_team = 'team2'))
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team2_player1 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  -- ── Round robin / pool play (doubles) ─────────────────────────
  if v_format in ('round_robin', 'pool_play') and v_match_type = 'doubles' then
    return query
      with pair_uids as (
        select dp.id as pair_id, dp.name, dp.captain_id,
               dp.partner_1_id, dp.partner_2_id,
               array_remove(array[dp.partner_1_id, dp.partner_2_id], null) as uids
          from public.doubles_pairs dp
         where dp.tournament_id = p_tournament_id
           and dp.partner_1_id is not null
           and dp.partner_2_id is not null
      ),
      stats as (
        select
          pu.pair_id, pu.name, pu.uids, pu.captain_id,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1'
                and ((m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                  or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)))
              or
              (m.winner_team = 'team2'
                and ((m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                  or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when (m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when (m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from pair_uids pu
        left join public.tournament_matches m
          on m.tournament_id = p_tournament_id
        group by pu.pair_id, pu.name, pu.uids, pu.captain_id, pu.partner_1_id, pu.partner_2_id
      ),
      ranked as (
        select s.pair_id, s.name, s.uids,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(cp.rating, 0) desc, s.pair_id) as rn
          from stats s
          left join public.profiles cp on cp.id = s.captain_id
      )
      select r.rn::int as place,
             r.pair_id as team_id,
             r.name as team_name,
             r.uids as uids,
             (select array_agg(p.full_name order by p.full_name)
                from public.profiles p where p.id = any(r.uids)) as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(floor(v_pool * v_structure[r.rn] / 100.0) / greatest(array_length(r.uids, 1), 1))::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  -- ── Rotating partners: per-individual wins ────────────────────
  if v_format = 'rotating_partners' then
    -- The podium must match the STORED final standings (tournament_final_ranks
    -- is computed at completion, settles wagers, and is what the app shows).
    -- Re-deriving here with different tiebreakers (point_diff vs losses)
    -- crowned the wrong champion whenever wins tied. Fall back to the local
    -- stats only when final ranks are missing.
    if exists (select 1 from public.tournament_final_ranks fr where fr.tournament_id = p_tournament_id) then
      return query
        select fr.final_rank::int as place,
               null::uuid as team_id,
               p.full_name as team_name,
               array[fr.user_id]::uuid[] as uids,
               array[p.full_name]::text[] as user_names,
               floor(v_pool * v_structure[fr.final_rank] / 100.0)::int as pool_share,
               floor(v_pool * v_structure[fr.final_rank] / 100.0)::int as share_per_user,
               case fr.final_rank when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
          from public.tournament_final_ranks fr
          join public.profiles p on p.id = fr.user_id
         where fr.tournament_id = p_tournament_id
           and fr.final_rank <= v_slots
         order by fr.final_rank;
      return;
    end if;
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1' and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id))
              or
              (m.winner_team = 'team2' and (m.team2_player1 = r.user_id or m.team2_player2 = r.user_id))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id or m.team2_player2 = r.user_id
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
           or m.team2_player1 = r.user_id or m.team2_player2 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;
end;
$$;
