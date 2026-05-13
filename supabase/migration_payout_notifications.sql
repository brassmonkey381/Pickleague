-- ============================================================
-- Send each prize-winner a notification spelling out exactly
-- what they received (pickles + badge + PLUPR bonus) when the
-- admin triggers auto_payout_mlp_tournament.
--
-- Run AFTER migration_tournament_auto_close_payout.sql.
-- ============================================================

create or replace function public.auto_payout_mlp_tournament(p_tournament_id uuid)
returns table (success boolean, total_distributed integer, recipients integer, message text)
language plpgsql security definer as $$
declare
  v_uid            uuid := auth.uid();
  v_already        timestamptz;
  v_status         text;
  v_tournament_name text;
  v_total          integer := 0;
  v_recipients     integer := 0;
  v_row            record;
  v_uid_inner      uuid;
  v_place_label    text;
  v_emoji          text;
  v_body           text;
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

    -- Pretty place label for the notification body.
    v_emoji := case v_row.place when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else '🏅' end;
    v_place_label := case v_row.place
                       when 1 then '1st'
                       when 2 then '2nd'
                       when 3 then '3rd'
                       else v_row.place::text || 'th'
                     end;

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

      -- Champion badge
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

      -- Build the per-user notification body. Lists every prize line
      -- they actually received, so the body is accurate even when the
      -- pool was 0 (badge + PLUPR only) or PLUPR bonus was 0.
      v_body := format('You finished %s with %s in %s.',
                       v_place_label, v_row.team_name, v_tournament_name);
      if v_row.share_per_user > 0 then
        v_body := v_body || format(E'\n• 🥒 %s pickles', v_row.share_per_user);
      end if;
      v_body := v_body || E'\n• 🏅 Champion badge added to your profile';
      if v_row.plupr_bonus > 0 then
        v_body := v_body || format(E'\n• +%s PLUPR rating bonus', v_row.plupr_bonus);
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('%s Prize: %s place!', v_emoji, v_place_label),
        v_body,
        p_tournament_id,
        'tournament'
      );

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  -- Drain pool, stamp idempotency timestamp
  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players, awarded badges + PLUPR bonus, sent notifications.',
           v_total, v_recipients);
end;
$$;

grant execute on function public.auto_payout_mlp_tournament(uuid) to authenticated;

notify pgrst, 'reload schema';
