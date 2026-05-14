-- ============================================================
-- Universal tournament payout RPCs.
--
-- Surfaces the "Pay Out Prizes" button for ANY completed tournament,
-- not just MLP playoffs. Delegates to the existing MLP RPC for MLP
-- formats and derives podium from the finals/grand_final match for
-- single_elimination + double_elimination. For round_robin / pool_play
-- / rotating_partners the preview returns nothing for now (admin can
-- still distribute manually via the pickle-pot card).
--
-- Run AFTER:
--   migration_tournament_auto_close_payout.sql
--   migration_more_badges_and_stacking.sql
--   migration_payout_notifications_split.sql
-- ============================================================


-- 1. preview_tournament_payout ------------------------------------------
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
  v_final        record;
  v_winner_uids  uuid[];
  v_loser_uids   uuid[];
  v_winner_pair  uuid;
  v_loser_pair   uuid;
begin
  select format, match_type, prize_pool, payout_structure
    into v_format, v_match_type, v_pool, v_structure
    from public.tournaments
   where id = p_tournament_id;

  if v_pool      is null then v_pool := 0; end if;
  if v_structure is null then v_structure := '{60,25,15}'; end if;

  -- MLP delegates to the existing dedicated RPC (full tiebreaker cascade,
  -- 3rd-place semi-loser handling, etc.).
  if v_format in ('mlp', 'mlp_random') then
    return query select * from public.preview_mlp_tournament_payout(p_tournament_id);
    return;
  end if;

  -- Single / double elimination: champion = winner of the latest
  -- finals/grand_final completed match; runner-up = the other side.
  if v_format in ('single_elimination', 'double_elimination') then
    select tm.id, tm.player1_id, tm.partner1_id, tm.player2_id, tm.partner2_id, tm.winner_team
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
      v_winner_uids := array_remove(array[v_final.player1_id, v_final.partner1_id], null);
      v_loser_uids  := array_remove(array[v_final.player2_id, v_final.partner2_id], null);
    else
      v_winner_uids := array_remove(array[v_final.player2_id, v_final.partner2_id], null);
      v_loser_uids  := array_remove(array[v_final.player1_id, v_final.partner1_id], null);
    end if;

    -- For doubles, attach the doubles_pairs identity (id + name).
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

    -- 1st place
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

    -- 2nd place (only if the structure has at least two slots)
    if array_length(v_structure, 1) >= 2 then
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

    return;
  end if;

  -- round_robin / pool_play / rotating_partners: not yet auto-derivable.
  -- Modal shows the existing empty-state ("Can't preview a payout — finals
  -- series isn't decided yet"). Admin can distribute via the pickle-pot card.
  return;
end;
$$;
grant execute on function public.preview_tournament_payout(uuid) to authenticated;


-- 2. auto_payout_tournament ---------------------------------------------
create or replace function public.auto_payout_tournament(p_tournament_id uuid)
returns table (success boolean, total_distributed integer, recipients integer, message text)
language plpgsql security definer as $$
declare
  v_uid          uuid := auth.uid();
  v_format       text;
  v_status       text;
  v_already      timestamptz;
  v_t_name       text;
  v_row          record;
  v_uid_inner    uuid;
  v_total        integer := 0;
  v_recipients   integer := 0;
  v_place_label  text;
  v_emoji        text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may pay out prizes';
  end if;

  select format, status, champion_payout_applied_at, name
    into v_format, v_status, v_already, v_t_name
    from public.tournaments where id = p_tournament_id;

  if v_status <> 'completed' then
    return query select false, 0, 0, 'Tournament not yet completed.'::text; return;
  end if;
  if v_already is not null then
    return query select false, 0, 0, 'Payout already applied for this tournament.'::text; return;
  end if;

  -- MLP: delegate to the existing fully-featured RPC (notifications,
  -- PLUPR, ledger, champion-badges — all handled there).
  if v_format in ('mlp', 'mlp_random') then
    return query select * from public.auto_payout_mlp_tournament(p_tournament_id);
    return;
  end if;

  -- Non-MLP: walk preview rows and pay each recipient.
  for v_row in select * from public.preview_tournament_payout(p_tournament_id) loop
    if v_row.uids is null or array_length(v_row.uids, 1) = 0 then continue; end if;

    v_emoji := case v_row.place when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else '🏅' end;
    v_place_label := case v_row.place
      when 1 then '1st' when 2 then '2nd' when 3 then '3rd'
      else v_row.place::text || 'th' end;

    foreach v_uid_inner in array v_row.uids loop
      if v_row.share_per_user > 0 then
        update public.profiles set pickles = pickles + v_row.share_per_user where id = v_uid_inner;
        insert into public.pickle_pot_payouts
          (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
        values ('tournament', p_tournament_id, v_uid_inner, v_row.share_per_user,
                format('Tournament #%s · %s', v_row.place, coalesce(v_row.team_name, 'Champion')),
                v_uid, true);
        v_total := v_total + v_row.share_per_user;
      end if;

      -- Champion badge ledger (mirrors MLP flow)
      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner, v_row.team_id, v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

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

      -- Per-recipient notification (single summary line — non-MLP doesn't
      -- need the 4-way split that MLP playoff payouts use).
      begin
        perform public._notify_user(
          v_uid_inner,
          format('%s Prize: %s place!', v_emoji, v_place_label),
          format('You finished %s in %s. +%s 🥒.', v_place_label, v_t_name, v_row.share_per_user),
          p_tournament_id,
          'tournament'
        );
      exception when others then null;
      end;

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  if v_recipients = 0 then
    return query select false, 0, 0,
      'No payout produced — the finals match isn''t decided yet, or this format isn''t auto-payable. Distribute via the pickle-pot card instead.'::text;
    return;
  end if;

  update public.tournaments
     set prize_pool                = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players.', v_total, v_recipients);
end;
$$;
grant execute on function public.auto_payout_tournament(uuid) to authenticated;


notify pgrst, 'reload schema';
