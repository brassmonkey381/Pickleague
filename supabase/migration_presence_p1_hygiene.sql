-- ============================================================
-- Presence Phase 1, file 5 of 5: account deletion clears presence, and
-- check-ins are kept 180 days. Apply order: see
-- migration_presence_p1_schema.sql (needs files 1-4).
--
-- 1. _purge_account (behind delete_my_account and moderator_eject_user, the
--    godmode delete) is the production definition (2026-10-15) plus the
--    presence and friend rows. The profile survives as a tombstone, so FK
--    cascades never fire: every per-user table is deleted explicitly, both
--    columns where a row names two people. Friends' notices about the account
--    ("wants to be friends", "accepted") go too.
-- 2. Daily cron pickleague-presence-retention (04:50 UTC): check-ins that
--    ended more than 180 days ago, friend request log rows older than 30
--    days, closed-id tombstones older than 2 days (a queued Start replays
--    within the queue's 24 h, a check-in only within its fix's 2 minutes).
--    Play sessions are kept (owner-only) for the player's own history.
--
-- Grants are unchanged: _purge_account stays internal; delete_my_account and
-- moderator_eject_user are already granted to authenticated and allowlisted.
-- ============================================================


-- ── 1. Account deletion ────────────────────────────────────────────────────
create or replace function public._purge_account(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null then
    raise exception 'No account given';
  end if;

  delete from public.push_tokens                   where user_id      = p_uid;
  delete from public.notifications                 where user_id      = p_uid;
  delete from public.drill_request_messages        where sender_id    = p_uid;
  delete from public.drill_requests                where from_user_id = p_uid or to_user_id = p_uid;
  delete from public.drill_session_reviews         where user_id      = p_uid;
  delete from public.doubles_pair_join_requests    where user_id      = p_uid;
  delete from public.league_join_requests          where user_id      = p_uid;
  delete from public.mlp_team_join_requests        where user_id      = p_uid;
  delete from public.tournament_partner_requests   where requester_id = p_uid or requested_id = p_uid;
  delete from public.profile_claims                where profile_id   = p_uid;
  delete from public.venue_submission_affirmations where profile_id   = p_uid;
  delete from public.event_slot_votes              where user_id      = p_uid;
  delete from public.player_paddles                where user_id      = p_uid;
  delete from public.match_paddle_usage            where user_id      = p_uid;
  delete from public.player_shop_purchases         where user_id      = p_uid;
  delete from public.redemption_orders             where user_id      = p_uid;
  delete from public.ftue_grants                   where user_id      = p_uid;
  delete from public.league_members                where user_id      = p_uid;
  delete from public.user_blocks where blocker_id = p_uid or blocked_id = p_uid;

  -- Presence and friends (migration_presence_p1_*.sql).
  delete from public.venue_checkins       where user_id   = p_uid;
  delete from public.play_sessions        where user_id   = p_uid;
  delete from public.presence_settings    where user_id   = p_uid;
  delete from public.presence_hidden_from where user_id   = p_uid or hidden_user_id = p_uid;
  delete from public.close_friends        where user_id   = p_uid or friend_id      = p_uid;
  delete from public.friendships          where requester_id = p_uid or addressee_id = p_uid;
  delete from public.friend_request_log   where sender_id = p_uid or addressee_id   = p_uid;
  delete from public.court_favorites      where user_id   = p_uid;
  delete from public.presence_closed_ids  where user_id   = p_uid;
  delete from public.notifications
   where entity_type = 'friend' and entity_id = p_uid
     and push_data ->> 'kind' in ('friend_request', 'friend_accepted');

  update public.profiles set
    full_name             = '[deleted account]',
    username              = 'deleted_' || left(replace(p_uid::text, '-', ''), 12),
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
  where id = p_uid;

  delete from auth.users where id = p_uid;
end;
$$;

comment on function public._purge_account(uuid) is
  'Internal. Anonymises a profile to a tombstone and deletes the auth user. '
  'Reached only through delete_my_account() (self) or moderator_eject_user().';

revoke all on function public._purge_account(uuid) from public, anon, authenticated;


-- ── 2. Retention ───────────────────────────────────────────────────────────
create or replace function public.prune_presence_history() returns void
language sql security definer set search_path = '' as $$
  delete from public.venue_checkins
   where coalesce(checked_out_at, expires_at) < now() - interval '180 days';
  delete from public.friend_request_log
   where sent_at < now() - interval '30 days';
  delete from public.presence_closed_ids
   where created_at < now() - interval '2 days';
$$;
revoke execute on function public.prune_presence_history() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-presence-retention') then
    perform cron.unschedule('pickleague-presence-retention');
  end if;
  perform cron.schedule('pickleague-presence-retention', '50 4 * * *',
    $c$ select public.prune_presence_history(); $c$);
end $$;
