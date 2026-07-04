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
        'admin_complete_tournament','auto_payout_tournament','award_pickles_from_pool',
        'calculate_wager_odds','cancel_wager','claim_daily_login_streak','claim_ftue_step',
        'claim_welcome_pickles','complete_guest_upgrade','complete_season','confirm_match',
        'contribute_pickles_to_pool','create_doubles_pair','create_guest_invite',
        'create_invite_code','create_mlp_team','current_real_world_discounts','delete_my_account',
        'distribute_season_pool','distribute_tournament_pool','generate_mlp_bracket',
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
        'mlp_set_slot','mlp_team_standings','pair_invite','pair_leave_pair','pair_lock_pair',
        'pair_request_join','pair_respond_to_join','pair_set_slot','persist_random_doubles_pairs',
        'place_wager','preview_tournament_payout','purchase_shop_item','redeem_guest_invite',
        'redeem_invite_code','redeem_real_world_item','revoke_invite_code',
        'send_invite_code_to_users','set_purchase_hidden','submit_drill_review',
        'tournament_invite_player','tournament_respond_to_invite'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
