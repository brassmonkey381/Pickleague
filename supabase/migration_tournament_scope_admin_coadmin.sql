-- migration_tournament_scope_admin_coadmin.sql (PKL-064)
-- A tournament co-admin was refused "+ Contribute" and "Award" on the pot card (PKL-060 R7 live, 2026-11-22): every
-- tournament action gated on is_scope_admin('tournament', id) let in only the host or a league admin. Its tournament
-- branch now uses _pl_tournament_can_manage (migration_tournament_payout_coadmin.sql), so these all allow the host,
-- a league admin, a tournament admin or co-admin, and godmode: contribute_pickles_to_pool, award_pickles_from_pool,
-- distribute_tournament_pool, set_tournament_pickle_config, admin_complete_tournament, create_invite_code,
-- revoke_invite_code, send_invite_code_to_users and the invite_codes policy "Scope admins manage codes".
-- League and season scopes are unchanged. The rest is the live definition as of 2026-11-22.

CREATE OR REPLACE FUNCTION public.is_scope_admin(p_scope_type text, p_scope_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_league_id uuid;
begin
  if v_uid is null then return false; end if;

  if p_scope_type = 'league' then
    v_league_id := p_scope_id;
  elsif p_scope_type = 'season' then
    select league_id into v_league_id from public.league_seasons where id = p_scope_id;
  elsif p_scope_type = 'tournament' then
    -- PKL-064: the host or a league admin (as before), plus an approved tournament admin / co-admin and godmode:
    -- the same people as Pay out, Generate playoff and Set tie order (_pl_tournament_can_manage, PKL-056).
    return public._pl_tournament_can_manage(p_scope_id);
  else
    return false;
  end if;

  if v_league_id is null then return false; end if;
  return exists (
    select 1 from public.league_members
    where league_id = v_league_id and user_id = v_uid and role in ('admin','co-admin')
  );
end;
$function$;
