-- Checks for migration_godmode_anon_revoke.sql. Run AFTER the migration, inside
-- one transaction that is rolled back (state\godmode-anon-fix-apply.ps1 wraps it:
-- begin; <migration>; <this file>; rollback;). Returns one row per check.
create temp table _gm_results (check_name text, passed boolean) on commit drop;

-- 1-2. Grants: anon has none of the 20; authenticated and service_role keep all.
insert into _gm_results
select 'anon_has_none', count(*) filter (where has_function_privilege('anon', s::regprocedure, 'execute')) = 0
from unnest(array[
  'public.admin_review_venue(text,text,text,text[],text,text,text)','public.complete_season(uuid)',
  'public.confirm_match(uuid)','public.godmode_approve_all_invitees(uuid)',
  'public.godmode_auto_pair_doubles_for_tournament(uuid)','public.godmode_confirm_my_mlp_invites(uuid)',
  'public.godmode_dedupe_mlp_team_members(uuid)','public.godmode_delete_league(uuid)',
  'public.godmode_delete_tournament(uuid)','public.godmode_force_fill_mlp_teams(uuid)',
  'public.godmode_gift_pickles(uuid,integer,text)','public.godmode_simulate_fill_matches(uuid)',
  'public.list_admin_venue_reviews()','public.lock_season_period(uuid,integer,date)',
  'public.mlp_invite(uuid,uuid,text)','public.mlp_respond_to_join(uuid,boolean)',
  'public.pair_invite(uuid,uuid,text)','public.pair_respond_to_join(uuid,boolean)',
  'public.persist_random_doubles_pairs(uuid,jsonb)','public.tournament_respond_to_invite(uuid,boolean)'
]) s;

insert into _gm_results
select 'signed_in_and_server_keep_all',
       count(*) filter (where has_function_privilege('authenticated', s::regprocedure, 'execute')
                          and has_function_privilege('service_role', s::regprocedure, 'execute')) = 20
from unnest(array[
  'public.admin_review_venue(text,text,text,text[],text,text,text)','public.complete_season(uuid)',
  'public.confirm_match(uuid)','public.godmode_approve_all_invitees(uuid)',
  'public.godmode_auto_pair_doubles_for_tournament(uuid)','public.godmode_confirm_my_mlp_invites(uuid)',
  'public.godmode_dedupe_mlp_team_members(uuid)','public.godmode_delete_league(uuid)',
  'public.godmode_delete_tournament(uuid)','public.godmode_force_fill_mlp_teams(uuid)',
  'public.godmode_gift_pickles(uuid,integer,text)','public.godmode_simulate_fill_matches(uuid)',
  'public.list_admin_venue_reviews()','public.lock_season_period(uuid,integer,date)',
  'public.mlp_invite(uuid,uuid,text)','public.mlp_respond_to_join(uuid,boolean)',
  'public.pair_invite(uuid,uuid,text)','public.pair_respond_to_join(uuid,boolean)',
  'public.persist_random_doubles_pairs(uuid,jsonb)','public.tournament_respond_to_invite(uuid,boolean)'
]) s;

-- 3. A signed-out caller is refused before the function runs (no league named
--    here exists, so even a pass-through would delete nothing).
do $$
begin
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    set local role anon;
    perform public.godmode_delete_league('00000000-0000-0000-0000-00000000dead'::uuid);
    reset role;
    insert into _gm_results values ('anon_refused_delete_league', false);
  exception when insufficient_privilege then
    insert into _gm_results values ('anon_refused_delete_league', true);
  end;
end $$;

-- 4. A signed-in non-admin still reaches the function and gets its own refusal
--    (not a permission error), so signed-in behaviour is unchanged.
do $$
begin
  begin
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}', true);
    set local role authenticated;
    perform public.godmode_delete_league('00000000-0000-0000-0000-00000000dead'::uuid);
    reset role;
    insert into _gm_results values ('signed_in_non_admin_refused_by_function', false);
  exception
    when insufficient_privilege then
      insert into _gm_results values ('signed_in_non_admin_refused_by_function', false);
    when others then
      insert into _gm_results values ('signed_in_non_admin_refused_by_function', true);
  end;
end $$;

reset role;
select check_name, passed from _gm_results order by check_name;
