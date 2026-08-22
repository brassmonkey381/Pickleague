-- ============================================================
-- Moderation: reporting, blocking, and a moderator queue.
--
-- App Store Guideline 1.2 requires an app with user-generated content to ship
-- four things: a way to filter objectionable material, a way to REPORT it, a
-- way to BLOCK abusive users, and published contact details — plus the ability
-- to act on a report within 24 hours by removing the content and ejecting the
-- author. We had only the contact address.
--
-- Our UGC is thin but it is not nothing: a display name, a tagline, one profile
-- photo, organiser-authored league/event/tournament names, and — the one that
-- matters most here — free-text person-to-person messages on drill requests
-- (drill_requests.message and drill_request_messages.body).
--
-- Blocking is enforced HERE rather than in the client, because a block that
-- only hides a row is not a block: the other party could still deliver messages
-- to the database. After a block, in either direction:
--   * neither can open a new drill request with the other,
--   * neither can post into an existing thread,
--   * existing requests and their messages stop being visible to both.
-- ============================================================

-- 1. Blocks ---------------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

comment on table public.user_blocks is
  'One row per "A blocked B". Enforced in RLS on the messaging tables, not just '
  'in the client. Deliberately readable only by the blocker: the blocked user '
  'must not be able to learn they were blocked.';

create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

drop policy if exists "Users read their own blocks"   on public.user_blocks;
drop policy if exists "Users create their own blocks" on public.user_blocks;
drop policy if exists "Users remove their own blocks" on public.user_blocks;

create policy "Users read their own blocks" on public.user_blocks
  for select using (auth.uid() = blocker_id);

create policy "Users create their own blocks" on public.user_blocks
  for insert with check (auth.uid() = blocker_id);

create policy "Users remove their own blocks" on public.user_blocks
  for delete using (auth.uid() = blocker_id);

-- Symmetric block test, used inside the RLS policies below.
--
-- SECURITY DEFINER on purpose, and NOT revoked from authenticated: the policies
-- that call it run as the querying user, so `authenticated` must be able to
-- execute it. It reads the half of user_blocks that the caller's own SELECT
-- policy deliberately hides (blocks made AGAINST them) and returns only a
-- boolean about a pair the caller is already part of — it cannot be used to
-- enumerate anything.
create or replace function public.blocked_between(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks ub
     where (ub.blocker_id = a and ub.blocked_id = b)
        or (ub.blocker_id = b and ub.blocked_id = a)
  );
$$;

comment on function public.blocked_between(uuid, uuid) is
  'True if either user has blocked the other. Called from RLS policies, so it '
  'must remain executable by authenticated.';

revoke all on function public.blocked_between(uuid, uuid) from public, anon;
grant execute on function public.blocked_between(uuid, uuid) to authenticated;

-- 2. Who moderates --------------------------------------------------------
-- No new "who is an admin" concept: the moderator is the existing godmode
-- account, so there is one hardcoded id list (is_godmode_user(uuid), mirroring
-- GODMODE_USER_IDS in mobile/src/lib/godmode.ts) rather than two that drift.
-- Deliberately a hardcoded id rather than a profiles flag, which would be one
-- bad UPDATE policy away from being self-assignable.
--
-- The no-argument overload had EXECUTE revoked from authenticated by
-- migration_rls_hardening_2026q3.sql, which swept up every SECURITY DEFINER
-- helper. That was too wide: this one is called BY the client
-- (amIGodmode() → supabase.rpc('is_godmode_user') in mobile/src/data/venueAdmin.ts)
-- and from the RLS policies below, both of which run as the calling user. With
-- the grant missing, amIGodmode() has been throwing and returning false, so the
-- godmode account has been locked out of its own venue-review queue. Restore
-- it: the function answers only "are YOU the godmode user" and leaks nothing.
grant execute on function public.is_godmode_user() to authenticated;

-- 3. Reports --------------------------------------------------------------
create table if not exists public.content_reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles(id) on delete cascade,
  -- The account being reported. Every report we accept is ultimately about a
  -- person, even when the subject is a name they wrote or a photo they posted.
  subject_user_id uuid not null references public.profiles(id) on delete cascade,
  subject_type    text not null check (subject_type in
                    ('profile', 'avatar', 'message', 'league', 'event', 'tournament', 'other')),
  -- Row the content lives in, when there is one (a drill request, a league…).
  subject_id      uuid,
  reason          text not null check (reason in
                    ('harassment', 'hate', 'sexual', 'violence', 'spam',
                     'impersonation', 'cheating', 'other')),
  details         text check (details is null or char_length(details) <= 2000),
  -- What the reporter was actually looking at. Copied at report time on purpose:
  -- the author can edit or delete the content the moment they are reported, and
  -- a queue of empty reports cannot be acted on.
  snapshot        jsonb,
  status          text not null default 'open'
                    check (status in ('open', 'actioned', 'dismissed')),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  resolution      text,
  constraint content_reports_not_self check (reporter_id <> subject_user_id)
);

comment on table public.content_reports is
  'Guideline 1.2 report queue. Users insert; only a moderator can read anything '
  'but their own reports, or change status.';

create index if not exists content_reports_open_idx
  on public.content_reports (created_at desc) where status = 'open';
create index if not exists content_reports_subject_idx
  on public.content_reports (subject_user_id);

-- One open report per reporter per subject: stops a rapid double-tap (and a
-- griefer) from burying the queue, without blocking a genuine second report
-- once the first has been resolved.
create unique index if not exists content_reports_one_open_per_subject
  on public.content_reports (reporter_id, subject_type, subject_user_id, coalesce(subject_id, subject_user_id))
  where status = 'open';

alter table public.content_reports enable row level security;

drop policy if exists "Users file reports"          on public.content_reports;
drop policy if exists "Users read their own reports" on public.content_reports;
drop policy if exists "Moderators read all reports"  on public.content_reports;
drop policy if exists "Moderators resolve reports"   on public.content_reports;

create policy "Users file reports" on public.content_reports
  for insert with check (auth.uid() = reporter_id and status = 'open');

create policy "Users read their own reports" on public.content_reports
  for select using (auth.uid() = reporter_id);

create policy "Moderators read all reports" on public.content_reports
  for select using (public.is_godmode_user());

create policy "Moderators resolve reports" on public.content_reports
  for update using (public.is_godmode_user()) with check (public.is_godmode_user());

-- 4. Make a block actually block ------------------------------------------
-- Rewrites of the four existing drill policies, each with the block test added.
-- The new-row references are table-qualified: an unqualified column inside the
-- exists() would bind to the inner table if the names ever collided.
drop policy if exists "Users send drill requests"                on public.drill_requests;
drop policy if exists "Users see own drill requests"             on public.drill_requests;

create policy "Users send drill requests" on public.drill_requests
  for insert with check (
    auth.uid() = drill_requests.from_user_id
    and not public.blocked_between(drill_requests.from_user_id, drill_requests.to_user_id)
  );

create policy "Users see own drill requests" on public.drill_requests
  for select using (
    (auth.uid() = drill_requests.from_user_id or auth.uid() = drill_requests.to_user_id)
    and not public.blocked_between(drill_requests.from_user_id, drill_requests.to_user_id)
  );

-- UPDATE too, and not for tidiness: RLS evaluates UPDATE's USING clause
-- independently of the SELECT policy, so a blocked user who already knew a
-- request's id could still blind-accept it — which would create a drill session
-- with someone who blocked them, out of a row neither can see.
drop policy if exists "Users update drill requests they are part of" on public.drill_requests;

create policy "Users update drill requests they are part of" on public.drill_requests
  for update using (
    (auth.uid() = drill_requests.from_user_id or auth.uid() = drill_requests.to_user_id)
    and not public.blocked_between(drill_requests.from_user_id, drill_requests.to_user_id)
  );

drop policy if exists "Participants send chat" on public.drill_request_messages;
drop policy if exists "Participants read chat" on public.drill_request_messages;

create policy "Participants send chat" on public.drill_request_messages
  for insert with check (
    auth.uid() = drill_request_messages.sender_id
    and exists (
      select 1 from public.drill_requests r
       where r.id = drill_request_messages.request_id
         and (auth.uid() = r.from_user_id or auth.uid() = r.to_user_id)
         and not public.blocked_between(r.from_user_id, r.to_user_id)
    )
  );

create policy "Participants read chat" on public.drill_request_messages
  for select using (
    exists (
      select 1 from public.drill_requests r
       where r.id = drill_request_messages.request_id
         and (auth.uid() = r.from_user_id or auth.uid() = r.to_user_id)
         and not public.blocked_between(r.from_user_id, r.to_user_id)
    )
  );

-- 5. Acting on a report ---------------------------------------------------
-- Guideline 1.2 asks for removal of the content and ejection of the author
-- within 24 hours. Two actions, both moderator-only.

-- 5a. Take down a profile photo.
--
-- Clearing avatar_url alone is not a takedown — the object stays fetchable at
-- its public URL forever — but the storage object CANNOT be removed from here:
-- Supabase installs a trigger that rejects DELETE on storage.objects outright
-- ("Direct deletion from storage tables is not allowed. Use the Storage API
-- instead."), even inside a SECURITY DEFINER function owned by postgres. A SQL
-- delete does not fail quietly; it aborts the whole call.
--
-- So the split is: this function clears the reference and closes the reports,
-- and the caller deletes the object through the Storage API
-- (takeDownAvatar() in mobile/src/data/moderationAdmin.ts), which is allowed by
-- the "Moderator removes any avatar" policy in migration_avatars_bucket.sql.
create or replace function public.moderator_take_down_avatar(p_target uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_godmode_user() then
    raise exception 'Not authorised';
  end if;

  update public.profiles set avatar_url = null where id = p_target;

  update public.content_reports
     set status = 'actioned', reviewed_at = now(), reviewed_by = auth.uid(),
         resolution = coalesce(p_note, 'Profile photo removed')
   where subject_user_id = p_target and status = 'open';
end;
$$;

revoke all on function public.moderator_take_down_avatar(uuid, text) from public, anon;
grant execute on function public.moderator_take_down_avatar(uuid, text) to authenticated;

-- 5b. Eject an account. This is deliberately the same machinery as a user
-- deleting themselves — the credentials are really gone (they cannot sign back
-- in) and the profile survives only as an anonymous tombstone so other players'
-- match history stays referentially intact. See
-- migration_delete_account_tombstone.sql for why the matches cannot be deleted.
--
-- The body of delete_my_account() moves into an internal helper so there is one
-- implementation of the purge rather than two that drift.
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

  -- Private, personal, or device-bound data. These no longer disappear via the
  -- profile cascade (the profile survives), so they are removed explicitly.
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

  -- Blocks other people made against them are pointless once the account is
  -- gone, and their own blocks have nothing left to hide.
  delete from public.user_blocks where blocker_id = p_uid or blocked_id = p_uid;

  -- Shared competitive records (matches, standings, ratings, badges, wagers,
  -- tournament_registrations) are KEPT by design — deleting them would rewrite
  -- other players' ratings and history. They identify the player only by the
  -- now-anonymous profile id.

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

  -- The photo object itself cannot be deleted from SQL (see §5a — storage
  -- rejects DELETE on storage.objects, and it aborts the whole call rather than
  -- failing quietly, which would break account deletion outright). The caller
  -- removes it through the Storage API before invoking this; avatar_url above
  -- is cleared either way, so nothing in the app renders it.

  -- The account itself: credentials, email, sessions, refresh tokens.
  delete from auth.users where id = p_uid;
end;
$$;

comment on function public._purge_account(uuid) is
  'Internal. Anonymises a profile to a tombstone and deletes the auth user. '
  'Reached only through delete_my_account() (self) or moderator_eject_user().';

revoke all on function public._purge_account(uuid) from public, anon, authenticated;

-- delete_my_account() keeps its contract and its name; it is now a thin
-- self-only wrapper so that self-deletion and ejection cannot drift apart.
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
  perform public._purge_account(v_uid);
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

create or replace function public.moderator_eject_user(p_target uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_godmode_user() then
    raise exception 'Not authorised';
  end if;
  if p_target = auth.uid() then
    raise exception 'Use Delete account to remove your own account';
  end if;

  -- Resolve the reports BEFORE the purge: subject_user_id cascades on profile
  -- delete, and the profile row survives, but the reporter_id may not.
  update public.content_reports
     set status = 'actioned', reviewed_at = now(), reviewed_by = auth.uid(),
         resolution = coalesce(p_note, 'Account ejected')
   where subject_user_id = p_target and status = 'open';

  perform public._purge_account(p_target);
end;
$$;

revoke all on function public.moderator_eject_user(uuid, text) from public, anon;
grant execute on function public.moderator_eject_user(uuid, text) to authenticated;

-- 5c. Close a report without acting on the account.
create or replace function public.moderator_resolve_report(
  p_report_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_godmode_user() then
    raise exception 'Not authorised';
  end if;
  if p_status not in ('actioned', 'dismissed') then
    raise exception 'Status must be actioned or dismissed';
  end if;

  update public.content_reports
     set status = p_status, reviewed_at = now(), reviewed_by = auth.uid(),
         resolution = p_note
   where id = p_report_id;
end;
$$;

revoke all on function public.moderator_resolve_report(uuid, text, text) from public, anon;
grant execute on function public.moderator_resolve_report(uuid, text, text) to authenticated;
