-- migration_tournament_payout_coadmin.sql (PKL-056)
-- "Pay out" (auto_payout_tournament, and auto_payout_mlp_tournament which it calls) now allows the same people as
-- Generate playoff and Set tie order: the host or a league admin (_is_tournament_admin), a tournament admin or
-- co-admin (approved registration), or godmode. Before, it used is_scope_admin('tournament'), which refused a
-- tournament co-admin with "Only admins may pay out prizes" (seen live in PKL-050 R1, 2026-11-22).
-- Only the permission check changes; both bodies are otherwise the live definitions as of 2026-11-22.

create or replace function public._pl_tournament_can_manage(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    public._is_tournament_admin(p_tournament_id, auth.uid())
    or exists (
      select 1 from public.tournament_registrations r
       where r.tournament_id = p_tournament_id and r.user_id = auth.uid()
         and r.status = 'approved' and r.role in ('admin', 'co-admin'))
    or coalesce(public.is_godmode_user(), false)
  )
$$;
revoke all on function public._pl_tournament_can_manage(uuid) from public, anon, authenticated;

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
  if not public._pl_tournament_can_manage(p_tournament_id) then
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

CREATE OR REPLACE FUNCTION public.auto_payout_tournament(p_tournament_id uuid)
 RETURNS TABLE(success boolean, total_distributed integer, recipients integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  if not public._pl_tournament_can_manage(p_tournament_id) then
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

  if v_format in ('mlp', 'mlp_random') then
    return query select * from public.auto_payout_mlp_tournament(p_tournament_id);
    return;
  end if;

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

      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner,
              case when exists (select 1 from public.mlp_teams mt where mt.id = v_row.team_id)
                   then v_row.team_id else null end,
              v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      if v_row.place between 1 and 3 then
        perform public.award_profile_badge(
          v_uid_inner,
          case v_row.place when 1 then 'Tournament Champion'
                           when 2 then 'Tournament Silver'
                           else 'Tournament Bronze' end,
          format('%s — %s', v_t_name, coalesce(v_row.team_name, 'solo'))
        );
      end if;

      if v_row.plupr_bonus > 0 then
        insert into public.tournament_plupr_bonuses
          (tournament_id, user_id, bonus_value, place)
        values (p_tournament_id, v_uid_inner, v_row.plupr_bonus, v_row.place)
        on conflict (tournament_id, user_id) do nothing;
        if found then
          update public.profiles
             set rating = coalesce(rating, 0) + v_row.plupr_bonus
           where id = v_uid_inner;
        end if;
      end if;

      begin
        perform public._notify_user(
          v_uid_inner,
          format('%s Prize: %s place!', v_emoji, v_place_label),
          format('You finished %s in %s.%s', v_place_label, v_t_name,
                 case when v_row.share_per_user > 0
                      then format(' +%s 🥒.', v_row.share_per_user)
                      else '' end),
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
$function$;
