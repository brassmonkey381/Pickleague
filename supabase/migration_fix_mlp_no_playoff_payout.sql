-- Fix: MLP tournaments WITHOUT a playoff finals round (pure round-robin or
-- pool-play play formats) stamped champion_payout_applied_at while paying out
-- NOTHING — preview_mlp_tournament_payout required a finals round and quietly
-- returned empty, and auto_payout_mlp_tournament set the marker regardless.
-- The pot (antes) was silently stranded and marked as paid.
--
--  1. preview_mlp_tournament_payout: no-finals fallback derives the podium
--     from mlp_team_standings (sub-match wins, losses, seed).
--  2. auto_payout_mlp_tournament: never stamps the paid marker when zero
--     recipients — returns an explicit failure instead.
--
-- Found by the toolbox economy checks (MLP random, 3 teams, round robin,
-- 600-pickle pot gone). Bodies otherwise the committed/prod versions.

create or replace function public.preview_mlp_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
) language plpgsql stable security definer as $$
declare
  v_pool       integer;
  v_structure  integer[];
  v_finals     record;
  v_winner     uuid;
  v_loser      uuid;
  v_winner_name text;
  v_loser_name  text;
  v_third      uuid[];
  v_third_names text[];
  v_a_rr_diff  integer;
  v_b_rr_diff  integer;
  v_a_seed     integer;
  v_b_seed     integer;
  v_a_better   boolean;
begin
  select prize_pool, payout_structure into v_pool, v_structure
    from public.tournaments where id = p_tournament_id;
  if v_pool is null then v_pool := 0; end if;
  if v_structure is null then v_structure := '{60,25,15}'; end if;

  select tr.id as round_id, s.*
    into v_finals
    from public.tournament_rounds tr
    join lateral public._mlp_round_series_state(tr.id) s on true
   where tr.tournament_id = p_tournament_id
     and tr.round_type = 'finals'
   order by tr.round_number desc
   limit 1;
  if v_finals.team_a_id is null then
    -- No playoff finals round (pure round-robin / pool-play MLP): derive the
    -- podium from team standings. Previously this returned EMPTY — and the
    -- payout still stamped champion_payout_applied_at, silently stranding
    -- the entire pot with zero pickles distributed.
    return query
      with ordered as (
        select s.team_id, s.team_name,
               row_number() over (order by s.sub_matches_won desc, s.sub_matches_lost asc, s.seed asc nulls last, s.team_id) as rn
          from public.mlp_team_standings(p_tournament_id) s
      ),
      members as (
        select o.rn, o.team_id, o.team_name,
               array_remove(array[mt.male_1_id, mt.male_2_id, mt.female_1_id, mt.female_2_id], null) as uids
          from ordered o
          join public.mlp_teams mt on mt.id = o.team_id
      )
      select m.rn::int, m.team_id, m.team_name, m.uids,
             (select array_agg(p.full_name order by p.full_name) from public.profiles p where p.id = any(m.uids)),
             floor(v_pool * v_structure[m.rn] / 100.0)::int,
             floor(floor(v_pool * v_structure[m.rn] / 100.0) / greatest(coalesce(array_length(m.uids, 1), 0), 1))::int,
             case m.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3)
        from members m
       where m.rn <= coalesce(array_length(v_structure, 1), 0)
       order by m.rn;
    return;
  end if;

  if v_finals.a_wins <> v_finals.b_wins then
    v_a_better := v_finals.a_wins > v_finals.b_wins;
  elsif (v_finals.a_points - v_finals.b_points) <> 0 then
    v_a_better := (v_finals.a_points - v_finals.b_points) > 0;
  else
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_a_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_a_id;
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_b_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_b_id;
    if coalesce(v_a_rr_diff, 0) <> coalesce(v_b_rr_diff, 0) then
      v_a_better := coalesce(v_a_rr_diff, 0) > coalesce(v_b_rr_diff, 0);
    else
      select t.seed into v_a_seed from public.mlp_teams t where t.id = v_finals.team_a_id;
      select t.seed into v_b_seed from public.mlp_teams t where t.id = v_finals.team_b_id;
      if coalesce(v_a_seed, 999) <> coalesce(v_b_seed, 999) then
        v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
      else
        v_a_better := true;
      end if;
    end if;
  end if;

  if v_a_better then
    v_winner := v_finals.team_a_id; v_winner_name := v_finals.team_a_name;
    v_loser  := v_finals.team_b_id; v_loser_name  := v_finals.team_b_name;
  else
    v_winner := v_finals.team_b_id; v_winner_name := v_finals.team_b_name;
    v_loser  := v_finals.team_a_id; v_loser_name  := v_finals.team_a_name;
  end if;

  return query
    select 1, v_winner, v_winner_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_winner),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_winner),
           floor(v_pool * v_structure[1] / 100.0)::int as pool_share,
           floor(floor(v_pool * v_structure[1] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_winner), 0), 1))::int as share_per_user,
           0.500::numeric(6,3);

  if array_length(v_structure, 1) >= 2 then
    return query
    select 2, v_loser, v_loser_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_loser),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_loser),
           floor(v_pool * v_structure[2] / 100.0)::int,
           floor(floor(v_pool * v_structure[2] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_loser), 0), 1))::int,
           0.250::numeric(6,3);
  end if;

  if array_length(v_structure, 1) >= 3 then
    with semi_state as (
      select s.* from public.tournament_rounds tr
        join lateral public._mlp_round_series_state(tr.id) s on true
       where tr.tournament_id = p_tournament_id
         and tr.round_type = 'semifinals'
    ),
    semi_with_ctx as (
      select
        ss.*,
        coalesce(sa.sub_matches_won - sa.sub_matches_lost, 0) as a_rr_diff,
        coalesce(sb.sub_matches_won - sb.sub_matches_lost, 0) as b_rr_diff,
        coalesce(ta.seed, 999) as a_seed,
        coalesce(tb.seed, 999) as b_seed
        from semi_state ss
        left join lateral (
          select s.sub_matches_won, s.sub_matches_lost
            from public.mlp_team_standings(p_tournament_id) s
           where s.team_id = ss.team_a_id
        ) sa on true
        left join lateral (
          select s.sub_matches_won, s.sub_matches_lost
            from public.mlp_team_standings(p_tournament_id) s
           where s.team_id = ss.team_b_id
        ) sb on true
        left join public.mlp_teams ta on ta.id = ss.team_a_id
        left join public.mlp_teams tb on tb.id = ss.team_b_id
       where ss.team_a_id is not null and ss.team_b_id is not null
    ),
    losers as (
      select
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_id else team_a_id end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_id else team_a_id end)
          when a_rr_diff <> b_rr_diff                 then (case when a_rr_diff > b_rr_diff then team_b_id else team_a_id end)
          when a_seed <> b_seed                       then (case when a_seed < b_seed then team_b_id else team_a_id end)
          else team_b_id
        end as team_id,
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_name else team_a_name end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_name else team_a_name end)
          when a_rr_diff <> b_rr_diff                 then (case when a_rr_diff > b_rr_diff then team_b_name else team_a_name end)
          when a_seed <> b_seed                       then (case when a_seed < b_seed then team_b_name else team_a_name end)
          else team_b_name
        end as team_name
        from semi_with_ctx
    )
    select array_agg(l.team_id), array_agg(l.team_name)
      into v_third, v_third_names
      from losers l;

    if v_third is not null and array_length(v_third, 1) > 0 then
      return query
      select 3, l.team_id, l.team_name,
             (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                from public.mlp_teams where id = l.team_id),
             (select array_agg(p.full_name order by p.full_name)
                from public.mlp_teams t
                join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
               where t.id = l.team_id),
             floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1))::int,
             floor(floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1)) /
                    coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                     from public.mlp_teams where id = l.team_id), 0), 1))::int,
             0.100::numeric(6,3)
        from (
          select unnest(v_third) as team_id, unnest(v_third_names) as team_name
        ) l;
    end if;
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.auto_payout_mlp_tournament(p_tournament_id uuid)
 RETURNS TABLE(success boolean, total_distributed integer, recipients integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid             uuid := auth.uid();
  v_already         timestamptz;
  v_status          text;
  v_tournament_name text;
  v_total           integer := 0;
  v_recipients      integer := 0;
  v_row             record;
  v_uid_inner       uuid;
  v_place_label     text;
  v_emoji           text;
  v_summary_body    text;
  v_context         text;
  v_podium_badge    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may pay out prizes';
  end if;

  select status, champion_payout_applied_at, name
    into v_status, v_already, v_tournament_name
    from public.tournaments where id = p_tournament_id;
  if v_status <> 'completed' then
    return query select false, 0, 0, 'Tournament not yet completed.'::text; return;
  end if;
  if v_already is not null then
    return query select false, 0, 0, 'Payout already applied for this tournament.'::text; return;
  end if;

  for v_row in select * from public.preview_mlp_tournament_payout(p_tournament_id) loop
    if v_row.uids is null or array_length(v_row.uids, 1) = 0 then continue; end if;

    v_emoji := case v_row.place when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else '🏅' end;
    v_place_label := case v_row.place
                       when 1 then '1st'
                       when 2 then '2nd'
                       when 3 then '3rd'
                       else v_row.place::text || 'th'
                     end;
    v_context := format('finishing %s with %s in %s', v_place_label, v_row.team_name, v_tournament_name);

    v_podium_badge := case v_row.place
                        when 1 then 'Tournament Champion'
                        when 2 then 'Tournament Silver'
                        when 3 then 'Tournament Bronze'
                        else null end;

    foreach v_uid_inner in array v_row.uids loop
      -- Pickle payout
      if v_row.share_per_user > 0 then
        update public.profiles set pickles = pickles + v_row.share_per_user where id = v_uid_inner;
        insert into public.pickle_pot_payouts
          (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
        values ('tournament', p_tournament_id, v_uid_inner, v_row.share_per_user,
                format('Tournament #%s · %s', v_row.place, v_row.team_name), v_uid, true);
        v_total := v_total + v_row.share_per_user;
      end if;

      -- Legacy champion-badge ledger (unchanged)
      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner, v_row.team_id, v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      -- New: stackable player_badges row for the podium finish.
      if v_podium_badge is not null then
        perform public.award_profile_badge(
          v_uid_inner,
          v_podium_badge,
          format('%s — %s', v_tournament_name, v_row.team_name)
        );
      end if;

      -- PLUPR bonus
      if v_row.plupr_bonus > 0 then
        insert into public.tournament_plupr_bonuses
          (tournament_id, user_id, bonus_value, place)
        values (p_tournament_id, v_uid_inner, v_row.plupr_bonus, v_row.place)
        on conflict (tournament_id, user_id) do nothing;

        update public.profiles
           set rating = coalesce(rating, 0) + v_row.plupr_bonus
         where id = v_uid_inner;
      end if;

      -- Notifications (unchanged from migration_payout_notifications_split.sql)
      v_summary_body := format('You finished %s with %s in %s.',
                               v_place_label, v_row.team_name, v_tournament_name);
      if v_row.share_per_user > 0 then
        v_summary_body := v_summary_body || format(E'\n• 🥒 %s pickles', v_row.share_per_user);
      end if;
      v_summary_body := v_summary_body || E'\n• 🏅 Champion badge added to your profile';
      if v_row.plupr_bonus > 0 then
        v_summary_body := v_summary_body || format(E'\n• +%s PLUPR rating bonus', v_row.plupr_bonus);
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('%s Prize: %s place!', v_emoji, v_place_label),
        v_summary_body,
        p_tournament_id,
        'tournament'
      );

      if v_row.share_per_user > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('🥒 +%s pickles!', v_row.share_per_user),
          format('You received %s 🥒 for %s. Tap to see your shop balance.',
                 v_row.share_per_user, v_context),
          p_tournament_id,
          'shop'
        );
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('🏅 %s Place Badge', v_place_label),
        format('A %s champion badge was added to your profile for %s. Tap to view it.',
               v_place_label, v_context),
        v_uid_inner,
        'profile'
      );

      if v_row.plupr_bonus > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('📈 +%s PLUPR bonus', v_row.plupr_bonus),
          format('A one-time PLUPR boost of +%s was applied for %s. Tap to see your PLUPR history.',
                 v_row.plupr_bonus, v_context),
          v_uid_inner,
          'plupr_history'
        );
      end if;

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  -- Never stamp the paid marker when nothing was distributed — that
  -- permanently strands the pot while reporting success.
  if v_recipients = 0 then
    return query select false, 0, 0,
      'Nothing to distribute — no podium could be derived. Pot left intact.'::text;
    return;
  end if;

  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players, awarded badges + PLUPR bonus, sent notifications.',
           v_total, v_recipients);
end;
$function$;
