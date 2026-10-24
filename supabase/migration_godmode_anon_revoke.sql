-- ============================================================
-- Signed-out callers can no longer run admin / sign-in-only RPCs
-- (2026-10-24)
--
-- The hole: is_godmode_user() is `auth.uid() = '<admin id>'`, which is NULL
-- (not false) for a caller with no user. Checks written as
--   if not public.is_godmode_user() then raise ... end if;
-- then see `not NULL` = NULL, skip the raise, and carry on. With the public
-- anon key (it ships in the web bundle) anyone could call, for example,
-- godmode_delete_league, godmode_delete_tournament or godmode_gift_pickles.
-- Every function below had EXECUTE for anon (Supabase's default privileges
-- grant it on create, and PUBLIC too for most).
--
-- The fix here: none of these is meant for a signed-out caller, so anon and
-- PUBLIC lose EXECUTE; signed-in players and the server keep it. A signed-in
-- caller always has auth.uid(), so their checks were never NULL and nothing
-- changes for them. is_godmode_user() itself is left as it is on purpose: the
-- server's own callers (cron jobs, the SQL editor, service-role scripts) have
-- no auth.uid() either and rely on today's behaviour.
--
-- Found while building migration_auto_complete_seasons.sql (which also makes
-- complete_season refuse a caller with no user).
-- ============================================================

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.admin_review_venue(text,text,text,text[],text,text,text)',
    'public.complete_season(uuid)',
    'public.confirm_match(uuid)',
    'public.godmode_approve_all_invitees(uuid)',
    'public.godmode_auto_pair_doubles_for_tournament(uuid)',
    'public.godmode_confirm_my_mlp_invites(uuid)',
    'public.godmode_dedupe_mlp_team_members(uuid)',
    'public.godmode_delete_league(uuid)',
    'public.godmode_delete_tournament(uuid)',
    'public.godmode_force_fill_mlp_teams(uuid)',
    'public.godmode_gift_pickles(uuid,integer,text)',
    'public.godmode_simulate_fill_matches(uuid)',
    'public.list_admin_venue_reviews()',
    'public.lock_season_period(uuid,integer,date)',
    'public.mlp_invite(uuid,uuid,text)',
    'public.mlp_respond_to_join(uuid,boolean)',
    'public.pair_invite(uuid,uuid,text)',
    'public.pair_respond_to_join(uuid,boolean)',
    'public.persist_random_doubles_pairs(uuid,jsonb)',
    'public.tournament_respond_to_invite(uuid,boolean)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated, service_role', sig);
  end loop;
end $$;
