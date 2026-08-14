-- ============================================================
-- Fix account deletion, which was broken for every user who had ever
-- played a match.
--
-- migration_add_delete_my_account.sql assumed "most other tables reference
-- profiles.id on delete cascade", so deleting auth.users would cascade the
-- whole graph away. Nine columns are NO ACTION, not CASCADE:
--
--   matches:            player1_id, player2_id, partner1_id, partner2_id, winner_id
--   tournament_matches: team1_player1, team1_player2, team2_player1, team2_player2
--
-- so the cascade hit those and aborted with
--   update or delete on table "profiles" violates foreign key constraint
--   "matches_player1_id_fkey" on table "matches"
-- Since matches.player1_id / player2_id are also NOT NULL, they cannot simply
-- be nulled out either.
--
-- Deleting the matches instead is not an option: they are shared records. They
-- carry the opponents' ELO history, league standings, and season snapshots, so
-- removing them would silently rewrite other people's ratings and results.
--
-- Approach: the profile row survives as an anonymous tombstone reading
-- "[deleted account]", while the auth user (credentials, email, sessions) is
-- genuinely deleted. Every screen renders players via profiles.full_name, so
-- one scrubbed row renames them everywhere at once with no client change.
-- ============================================================

-- 1. Let a profile outlive its auth user ---------------------------------
-- This cascade is what dragged the profile down with the auth row. Dropping it
-- is the point: a tombstone is deliberately an orphan. Profiles are still
-- created by the signup trigger, and profiles.id stays the primary key.
alter table public.profiles drop constraint if exists profiles_id_fkey;

alter table public.profiles
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'Set when the user deleted their account. The row is an anonymised tombstone '
  'kept only so shared match history stays referentially intact. Treat as '
  'not-a-real-user: exclude from player search, invites, and pickers.';

create index if not exists profiles_deleted_at_idx
  on public.profiles (deleted_at) where deleted_at is not null;

-- 2. delete_my_account ---------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- 2a. Private, personal, or device-bound data. These used to disappear via
  -- the profile cascade; because the profile now survives, they have to be
  -- removed explicitly or account deletion would leave them behind.
  delete from public.push_tokens                   where user_id      = v_uid;
  delete from public.notifications                 where user_id      = v_uid;
  delete from public.drill_request_messages        where sender_id    = v_uid;
  delete from public.drill_requests                where from_user_id = v_uid or to_user_id = v_uid;
  delete from public.drill_session_reviews         where user_id      = v_uid;
  delete from public.doubles_pair_join_requests    where user_id      = v_uid;
  delete from public.league_join_requests          where user_id      = v_uid;
  delete from public.mlp_team_join_requests        where user_id      = v_uid;
  delete from public.tournament_partner_requests   where requester_id = v_uid or requested_id = v_uid;
  delete from public.profile_claims                where profile_id   = v_uid;
  delete from public.venue_submission_affirmations where profile_id   = v_uid;
  delete from public.event_slot_votes              where user_id      = v_uid;
  delete from public.player_paddles                where user_id      = v_uid;
  delete from public.match_paddle_usage            where user_id      = v_uid;
  delete from public.player_shop_purchases         where user_id      = v_uid;
  delete from public.redemption_orders             where user_id      = v_uid;
  delete from public.ftue_grants                   where user_id      = v_uid;

  -- They are not a member of any league any more.
  delete from public.league_members                where user_id      = v_uid;

  -- Deliberately KEPT, because they are shared competitive records that other
  -- players' ratings and standings are computed from — deleting them would
  -- alter other people's history:
  --   matches, tournament_matches, league_player_ratings, player_location_ratings,
  --   season_snapshots, season_final_standings, tournament_final_ranks,
  --   tournament_champion_badges, tournament_plupr_bonuses, player_badges,
  --   wagers, pickle_pot_contributions, pickle_pot_payouts, drill_sessions.
  -- They identify the player only by the now-anonymous profile id.
  --
  -- tournament_registrations is on that list for a second, harder reason: the
  -- _freeze_active_tournament_roster() trigger refuses the delete outright
  -- while a tournament is live ("Record their remaining matches as forfeits
  -- instead"), so deleting it made account deletion fail for anyone entered in
  -- a running tournament. Keeping the row respects that rule — the slot stays
  -- in the bracket, now labelled [deleted account] — and the organiser can
  -- forfeit them out as the trigger intends.

  -- 2b. Anonymise the profile itself. gender is NOT NULL and decides whether a
  -- historical doubles match was Gendered or Mixed, so it stays; it identifies
  -- nobody once the name, handle, photo, and contact details are gone.
  update public.profiles set
    full_name             = '[deleted account]',
    username              = 'deleted_' || left(replace(v_uid::text, '-', ''), 12),
    avatar_url            = null,
    avatar_emoji          = null,
    avatar_bg_color       = null,
    profile_frame         = null,
    name_color            = null,
    list_name_style_id    = null,
    profile_name_style_id = null,
    tagline               = null,
    phone                 = null,
    dupr_id               = null,
    selected_tags         = '{}',
    availability          = '{}',
    drill_availability    = '{}'::jsonb,
    drill_shot_prefs      = '{}',
    drill_partner_prefs   = '{}',
    drill_custom_tags     = '{}',
    drilling_enabled      = false,
    badges_public         = false,
    pickles               = 0,
    is_unclaimed          = false,
    claim_source          = null,
    guest_expires_at      = null,
    deleted_at            = now()
  where id = v_uid;

  -- 2c. The account itself: credentials, email, sessions, refresh tokens.
  -- No longer cascades into profiles, so the tombstone above survives it.
  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
