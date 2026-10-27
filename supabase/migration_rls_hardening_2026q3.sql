-- RLS hardening sweep (2026-07). Three fixes, ordered by severity:
--
--   1. tournament_registrations INSERT — the old policy only checked
--      auth.uid() = user_id, so any user could insert themselves as an
--      APPROVED ADMIN of any tournament via the raw REST API, ignoring
--      invite-only mode and the new registration_closes_at deadline.
--      Now: creator bootstrap keeps full freedom (auto-registers as approved
--      admin at creation); everyone else can only self-insert a pending
--      member request into a request-mode tournament that is still in
--      'registration' and whose deadline hasn't passed. Invite acceptance,
--      invite codes, and guest joins all go through SECURITY DEFINER RPCs,
--      which bypass RLS and are unaffected.
--
--   2. league_members INSERT — same hole: any user could insert themselves
--      as admin of any league, including invite-only ones. Now: creator
--      bootstrap as admin; everyone else self-joins as plain 'member' and
--      only into open leagues. Closed-league joins go through
--      redeem_invite_code (SECURITY DEFINER), unaffected.
--
--   3. Internal SECURITY DEFINER functions — PostgREST exposes every public
--      function at /rest/v1/rpc/*, and Postgres grants EXECUTE to PUBLIC by
--      default. That let any (even anonymous) API caller directly invoke
--      internal helpers like _apply_match_deltas_to_players() or
--      recompute_all_plupr() — i.e. arbitrary rating manipulation. This
--      revokes EXECUTE from public/anon/authenticated on every SECURITY
--      DEFINER function EXCEPT the explicit allowlist of RPCs the app
--      actually calls, and grants service_role so admin scripts keep
--      working. Triggers and cron are unaffected (trigger firing doesn't
--      check EXECUTE at run time; pg_cron runs as the function owner).
--
--      ⚠ CONVENTION going forward: any new client-callable RPC must be added
--      to the allowlist below (or granted explicitly in its own migration);
--      any new internal SECURITY DEFINER helper should include
--        revoke execute on function <fn> from public, anon, authenticated;
--
-- Idempotent: drop policy if exists + create, and the revoke loop is a no-op
-- when grants are already gone.

-- ── 1. tournament_registrations INSERT ─────────────────────────────────────
-- NB: the new row's columns (status/role) are checked OUTSIDE the exists()
-- subquery — inside it, an unqualified `status` binds to tournaments.status
-- (correlated-subquery name capture), which silently broke the check.
drop policy if exists "Users can register themselves" on public.tournament_registrations;
create policy "Users can register themselves" on public.tournament_registrations
  for insert with check (
    auth.uid() = user_id
    and invited_by is null
    and (
      -- creator bootstrap: approved admin at creation
      exists (
        select 1 from public.tournaments t
        where t.id = tournament_id and t.status = 'registration' and t.created_by = auth.uid()
      )
      or (
        status = 'pending'   -- new row: no self-approval…
        and role = 'member'  -- …and no self-adminning
        and exists (
          select 1 from public.tournaments t
          where t.id = tournament_id
            and t.status = 'registration'
            and t.registration_mode = 'request'
            and (t.registration_closes_at is null or now() < t.registration_closes_at)
        )
      )
    )
  );

-- ── 2. league_members INSERT ────────────────────────────────────────────────
drop policy if exists "Users can join leagues" on public.league_members;
create policy "Users can join leagues" on public.league_members
  for insert with check (
    auth.uid() = user_id
    and (
      -- creator bootstrap as admin
      exists (select 1 from public.leagues l where l.id = league_id and l.created_by = auth.uid())
      or (
        -- open leagues: self-join as plain member only
        role = 'member'
        and exists (select 1 from public.leagues l where l.id = league_id and l.is_open)
      )
    )
  );

-- ── 3. Lock down internal SECURITY DEFINER functions ───────────────────────
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      -- Allowlist: every RPC the mobile/web client calls via supabase.rpc().
      and p.proname not in (
        'admin_complete_tournament','approve_league_join_request','auto_payout_tournament','award_pickles_from_pool',
        'calculate_wager_odds','cancel_league_event','cancel_wager','claim_daily_login_streak','claim_ftue_step',
        'claim_welcome_pickles','complete_guest_upgrade','complete_season','confirm_match',
        'contribute_pickles_to_pool','create_doubles_pair','create_guest_invite',
        'create_invite_code','create_mlp_team','current_real_world_discounts','delete_my_account',
        'deny_league_join_request',
        'distribute_season_pool','distribute_tournament_pool','drill_request_slot_starts',
        'generate_mlp_bracket',
        'generate_mlp_playoff','generate_playoff_bracket','generate_random_mlp_teams',
        'generate_random_pairs','get_guest_invite_preview','get_league_wager_totals',
        'get_my_wagers_with_details','get_season_wager_totals','get_tournament_wager_totals',
        'get_wagers_on_player','gift_real_world_item','gift_shop_item',
        'godmode_approve_all_invitees','godmode_auto_pair_doubles_for_tournament',
        'godmode_confirm_my_mlp_invites','godmode_dedupe_mlp_team_members','godmode_delete_league',
        'godmode_delete_tournament','godmode_force_accept_invitee','godmode_force_fill_mlp_teams',
        'godmode_gift_pickles','godmode_list_active_invites','godmode_set_plupr',
        'godmode_simulate_fill_matches','lock_season_period','mlp_invite','mlp_leave_team',
        'mlp_lock_team','mlp_request_join','mlp_respond_to_join','mlp_set_dreambreaker',
        'mlp_set_slot','mlp_team_standings','og_card_tz','pair_invite','pair_leave_pair','pair_lock_pair',
        'pair_request_join','pair_respond_to_join','pair_set_slot','persist_random_doubles_pairs',
        'place_wager','preview_tournament_payout','purchase_shop_item','redeem_guest_invite',
        'redeem_invite_code','redeem_real_world_item','request_league_join','revoke_invite_code',
        'send_invite_code_to_users','set_purchase_hidden','submit_drill_review',
        'tournament_invite_player','tournament_respond_to_invite',
        'withdraw_league_join_request',
        -- Called by the app but missing until 2026-10-15, so a re-run took them
        -- offline (checked live with has_function_privilege; set_pickleague_time_zone
        -- is called by the kit's timeZoneSync as set_<prefix>_time_zone).
        'accept_drill_slot','admin_review_venue','analytics_claim','analytics_touch',
        'cancel_tournament','checkin_venue','checkout_venue','claim_my_dupr_profile',
        'close_event_vote','dismiss_dupr_import','end_play_session','extend_checkin',
        'find_nearby_venue_submissions','import_my_dupr_rating','is_godmode_user',
        'list_admin_venue_reviews','moderator_eject_user','moderator_resolve_report',
        'moderator_take_down_avatar','my_dupr_match','relabel_league_home_court',
        'resolve_venue','respond_drill_request','rsvp_drill_session','search_venues',
        'set_pickleague_time_zone','start_play_session','submit_venue','vote_event_slots',
        -- Used inside RLS policies, which run them with the caller's privileges
        -- (migration_fix_policy_fn_grants.sql).
        'blocked_between','is_expired_guest','is_scope_admin',
        -- Presence Phase 1 (migration_presence_p1_*.sql).
        'cancel_friend_request','court_presence','friends_at_courts','friendship_status_with',
        'get_my_presence_settings','hide_presence_from','list_friend_requests','list_my_court_favorites',
        'list_my_friends','list_presence_hidden','remove_friend','resolve_court',
        'respond_friend_request','send_friend_request','set_close_friend','set_court_favorite',
        'set_presence_settings','suggest_friends','venue_crowd','venue_players_here',
        -- Presence Phase 1.5 (migration_validity_rules.sql).
        'my_session_validity',
        -- Court outlines editor (migration_admin_venue_boundary.sql): shipped
        -- 2026-10-17 without an entry here, so a re-run took the editor offline.
        'admin_list_venue_boundaries','admin_save_venue_boundary',
        -- Court arrival (migration_court_arrival_settings.sql,
        -- migration_court_arrival_queue.sql, migration_court_checkin_prompt.sql).
        'cancel_court_arrival','confirm_court_arrival','court_arrival_pending','court_prompt_scan',
        'enqueue_court_checkin_prompt','get_court_arrival_settings','list_starred_court_geofences',
        'queue_court_arrival','set_court_arrival_settings','set_starred_court_auto_checkin',
        -- Court discovery Phase 1 (migration_court_discovery_p1.sql).
        'get_court','list_courts_nearby',
        -- ScheduleMatchScreen (migration_schedule_match_rpc.sql).
        'schedule_league_match',
        -- Court stars capped at 3, Doggle's replace-one (migration_court_star_cap_three.sql).
        'replace_court_favorite',
        -- Routine check-ins (migration_court_routines.sql).
        'court_play_modes','delete_court_routine','get_court_routine_settings','list_my_court_routines',
        'list_profile_court_routines','move_court_routine_occurrence','save_court_routine','set_checkin_plan',
        'set_court_routine_active','set_routine_auto_checkin','skip_court_routine_occurrence',
        'suggest_court_routines','unskip_court_routine_occurrence','venue_open_to_play',
        -- Referrals (migration_referrals.sql). referral_preview is also granted
        -- to anon there (the signed-out web invite landing).
        'claim_referral','my_referral_code','my_referral_stats','referral_preview',
        -- Hide test accounts from discovery (migration_hide_test_accounts.sql).
        'discover_players','get_hide_test_accounts','set_hide_test_accounts',
        'get_profile_test_account','set_profile_test_account',
        -- Discover's search area: players and drill partners near it
        -- (migration_discover_players_near.sql, which grants it too).
        'discover_players_near',
        -- Player search by name: everyone, the players near the area first
        -- (migration_search_players.sql, which grants it too).
        'search_players',
        -- "On my way" to a court, with an ETA (migration_on_my_way.sql, which
        -- grants it too; migration_court_oneoff_plans.sql adds p_here).
        'send_on_my_way',
        -- One-off planned check-ins (migration_court_oneoff_plans.sql, which
        -- grants them too).
        'cancel_court_plan','list_my_court_plans','move_court_plan','plan_court_checkin',
        -- Plan sharing (migration_plan_sharing.sql, which grants them too).
        'confirm_court_plans','list_friend_court_plans','set_auto_share_routines','set_court_plan_shared',
        -- Closed league privacy (migration_closed_league_privacy.sql, which
        -- grants them too). _pl_can_see_league runs inside the league tables'
        -- SELECT policies, so anon and authenticated must keep EXECUTE.
        '_pl_can_see_league','get_league_preview','list_league_previews',
        -- Pickle history (migration_pickle_ledger.sql, which grants them too).
        'list_pickle_ledger','list_pickle_ledger_range','my_pickle_today',
        -- Signed-out audit, the rest (migration_anon_audit_rest.sql, which
        -- grants them too): the closed-league tournament / event / pot
        -- helpers run inside SELECT policies, so anon and authenticated keep
        -- EXECUTE. That file also keeps anon's EXECUTE to a signed-out
        -- allowlist of its own (c_anon_allow): add a signed-out RPC there too.
        '_pl_can_see_tournament','_pl_can_see_event','_pl_can_see_event_slot',
        '_pl_can_see_mlp_team','_pl_can_see_doubles_pair','_pl_can_see_pot_scope',
        -- Equip only what you own (migration_cosmetic_equip_owned.sql, which
        -- grants them too).
        'equip_shop_item','unequip_cosmetic'
        -- Deliberately NOT listed (no client caller; a re-run revokes them):
        -- backfill_venue_cities (a full-table venues UPDATE, maintenance only),
        -- send_test_push, venue_containing_point, list_venues_in_radius.
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
