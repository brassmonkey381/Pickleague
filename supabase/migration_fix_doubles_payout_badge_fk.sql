-- Fix: auto_payout_tournament (non-MLP path) crashed for DOUBLES tournaments
-- and never awarded podium badges.
--
--  1. tournament_champion_badges.team_id has an FK to mlp_teams, but the
--     doubles payout passed the doubles_pairs id — FK violation aborted the
--     ENTIRE payout (no pickles, no ledger, no notifications, marker unset).
--  2. The stackable podium player_badges (Tournament Champion / Silver /
--     Bronze) were only awarded by the MLP payout variant; non-MLP podium
--     finishers got nothing. Now mirrored here.
--
-- Found by the toolbox economy checks (doubles round robin + top_2 playoff).
-- Body is otherwise the committed/prod version verbatim. Idempotent.

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
      values (p_tournament_id, v_uid_inner,
              -- team_id's FK references mlp_teams; non-MLP doubles carried a
              -- doubles_pairs id here and crashed the whole payout. Link only
              -- real MLP teams — team_name still records the pair label.
              case when exists (select 1 from public.mlp_teams mt where mt.id = v_row.team_id)
                   then v_row.team_id else null end,
              v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      -- Stackable podium badge — mirrors the MLP payout (was MLP-only before).
      if v_row.place between 1 and 3 then
        perform public.award_profile_badge(
          v_uid_inner,
          case v_row.place when 1 then 'Tournament Champion'
                           when 2 then 'Tournament Silver'
                           else 'Tournament Bronze' end,
          format('%s — %s', v_t_name, coalesce(v_row.team_name, 'solo'))
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
