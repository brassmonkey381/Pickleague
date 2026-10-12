-- ============================================================================
--  Pickleague — combined push + guest migrations
--  Paste this ENTIRE file into Supabase ▸ SQL Editor ▸ new query ▸ Run.
--
--  It runs all 13 migrations in dependency order (the last 8: push actions, 1.0.4). Safe to re-run (every statement
--  is create-if-not-exists / create-or-replace).
--
--  The SQL Editor canNOT do these 3 non-SQL steps — do them after this succeeds:
--    1. Deploy the Edge Function:
--         supabase functions deploy send-push --no-verify-jwt
--       (or Dashboard ▸ Edge Functions ▸ deploy from the supabase/functions/send-push code)
--    2. Set the function secret: Dashboard ▸ Edge Functions ▸ send-push ▸ Secrets ▸
--         add  PUSH_SHARED_SECRET = <the value printed at the very bottom of this run>
--    3. Enable Anonymous sign-ins: Dashboard ▸ Authentication ▸ Sign In / Providers ▸
--         Anonymous Sign-Ins ▸ Enable.
-- ============================================================================


-- ============================================================================
-- FILE: migration_push_notifications.sql
-- ============================================================================

-- Push notifications foundation
--
-- Every row inserted into public.notifications fans out a phone push via the
-- `send-push` Edge Function. Because this rides on an AFTER INSERT trigger, ALL
-- existing notification sources (the ~19 RPCs/triggers across the app) get push
-- delivery for free — no call-site changes needed.
--
-- Delivery is gated per-user by the `user_preferences.prefs` JSONB blob:
--   pushEnabled (master) + per-category flags (notifyMatchResults, etc.).
-- That gating happens in the Edge Function, which reads prefs server-side.
--
-- ── One-time setup after applying this migration ───────────────────────────
--  1. supabase functions deploy send-push --no-verify-jwt
--  2. Pick a random secret, then set it in BOTH places so they match:
--       update private.app_config set value = '<SECRET>' where key = 'send_push_secret';
--       supabase secrets set PUSH_SHARED_SECRET=<SECRET>
--  3. Enable the pg_net extension (this migration does it, but confirm in dashboard).
--  4. Configure EAS push credentials (APNs key + FCM v1 service account) so
--     standalone builds actually deliver. Expo Go works without them for testing.

create extension if not exists pg_net;

-- ── Device push tokens (one row per device per user) ───────────────────────
create table if not exists public.push_tokens (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  token       text not null unique,
  platform    text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens(user_id);

alter table public.push_tokens enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (select)') then
    create policy "Users manage own push tokens (select)" on public.push_tokens
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (insert)') then
    create policy "Users manage own push tokens (insert)" on public.push_tokens
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (update)') then
    create policy "Users manage own push tokens (update)" on public.push_tokens
      for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (delete)') then
    create policy "Users manage own push tokens (delete)" on public.push_tokens
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ── Private config: Edge Function URL + shared secret ──────────────────────
-- RLS-enabled with NO policies → unreadable by anon/authenticated. Only
-- SECURITY DEFINER functions (and the service role) can read it.
create schema if not exists private;
create table if not exists private.app_config (
  key   text primary key,
  value text not null
);
alter table private.app_config enable row level security;

insert into private.app_config (key, value) values
  ('send_push_url', 'https://qwsmhztzfgbtzieulkgu.supabase.co/functions/v1/send-push')
  on conflict (key) do nothing;
insert into private.app_config (key, value) values
  ('send_push_secret', 'CHANGE_ME_TO_A_RANDOM_SECRET')
  on conflict (key) do nothing;

-- ── Fan-out trigger: notification insert → Edge Function ───────────────────
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_config where key = 'send_push_url';
  select value into v_secret from private.app_config where key = 'send_push_secret';
  if v_url is null then
    return new;
  end if;

  -- Fire-and-forget. pg_net queues the request; we never block the insert.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-push-secret', coalesce(v_secret, '')
    ),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
exception when others then
  -- A push failure must never roll back the in-app notification insert.
  return new;
end $$;

drop trigger if exists trg_notification_push on public.notifications;
create trigger trg_notification_push
  after insert on public.notifications
  for each row execute function public.handle_notification_push();


-- ============================================================================
-- FILE: migration_notification_generators.sql
-- ============================================================================

-- Notification generators: new event/tournament/vote announcements + time-based
-- reminders. Every row inserted here also fans out a phone push via the
-- AFTER INSERT trigger from migration_push_notifications.sql.
--
-- Per-toggle gating: we add a nullable `category` column to notifications that
-- names the exact user-preference key (e.g. 'notifyEventReminders'). The
-- send-push function reads it; rows without a category fall back to a coarser
-- map keyed on `type`. This lets distinct toggles (Event reminders vs League
-- announcements) gate push independently even though both share type='league'.
--
-- Lead times (change the interval literals below to tune):
--   drill session reminder ....... 24h AND 2h before start
--   league event start reminder .. 24h before start (matches Settings copy)
--   tournament start reminder .... 24h before start
--   vote-closing reminder ........ 6h before vote_ends_at (non-voters only)
--
-- NOT built (missing prerequisites — see notes):
--   • "new tournament for a league I BOOKMARKED" — no bookmark/follow feature
--     exists yet. Members of the tournament's league ARE notified below.
--   • "tournament registration closing soon" — tournaments have no
--     registration-deadline column. Add `registration_closes_at timestamptz`
--     then mirror remind_tournament_starts() to build it.

-- ── Per-category gating column ─────────────────────────────────────────────
alter table public.notifications add column if not exists category text;

-- ── Idempotency ledger for cron reminders ─────────────────────────────────
-- One row per (reminder kind, entity, user). Used with INSERT ... ON CONFLICT
-- DO NOTHING RETURNING so each reminder is delivered exactly once.
create table if not exists public.reminder_log (
  kind       text not null,
  entity_id  uuid not null,
  user_id    uuid not null,
  sent_at    timestamptz not null default now(),
  primary key (kind, entity_id, user_id)
);
-- Internal bookkeeping only. RLS on with no policies → no client access; the
-- SECURITY DEFINER reminder functions (and the cron role) bypass RLS.
alter table public.reminder_log enable row level security;

-- ════════════════════════════════════════════════════════════════════════
--  EVENT-DRIVEN: announcements fired by inserts
-- ════════════════════════════════════════════════════════════════════════

-- New tournament opened in a league → notify that league's members.
create or replace function public.notify_new_tournament()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if new.league_id is null then
    return new;  -- standalone tournament, no league audience
  end if;

  for r in
    select lm.user_id
    from public.league_members lm
    where lm.league_id = new.league_id
      and (new.created_by is null or lm.user_id <> new.created_by)
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🏆 New tournament: ' || new.name,
      'A new tournament just opened in your league. Tap to register.',
      'tournament', new.id, 'tournament', 'notifyTournamentUpdates'
    );
  end loop;
  return new;
exception when others then
  -- Never let a notification failure roll back the tournament creation.
  return new;
end $$;

drop trigger if exists trg_notify_new_tournament on public.tournaments;
create trigger trg_notify_new_tournament
  after insert on public.tournaments
  for each row execute function public.notify_new_tournament();

-- New scheduling vote opened in a league → notify that league's members.
create or replace function public.notify_new_event_vote()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if new.status <> 'voting' then
    return new;
  end if;

  for r in
    select lm.user_id
    from public.league_members lm
    where lm.league_id = new.league_id
      and (new.created_by is null or lm.user_id <> new.created_by)
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🗳️ New vote: ' || new.title,
      'Your league opened a scheduling vote. Cast your vote before it closes.',
      'league', new.league_id, 'league', 'notifyLeagueUpdates'
    );
  end loop;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_notify_new_event_vote on public.league_events;
create trigger trg_notify_new_event_vote
  after insert on public.league_events
  for each row execute function public.notify_new_event_vote();

-- ════════════════════════════════════════════════════════════════════════
--  TIME-BASED: reminders run hourly by pg_cron
-- ════════════════════════════════════════════════════════════════════════

-- Upcoming drill sessions (both players), reminded twice: 24h and 2h before.
-- The two windows use distinct ledger kinds so each fires exactly once, and are
-- bounded to not overlap (24h window is >2h out) so a single session never
-- triggers both reminders on the same cron tick.
create or replace function public.remind_drill_sessions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with windows as (
      select * from (values
        ('drill_session_24h', interval '2 hours', interval '24 hours'),
        ('drill_session_2h',  interval '0 hours', interval '2 hours')
      ) as w(kind, lo, hi)
    ),
    due as (
      select w.kind, ds.id, u.user_id
      from public.drill_sessions ds
      cross join lateral (values (ds.player1_id), (ds.player2_id)) as u(user_id)
      cross join windows w
      where ds.starts_at is not null
        and ds.starts_at >  now() + w.lo
        and ds.starts_at <= now() + w.hi
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select
      entity_id,
      user_id,
      case kind when 'drill_session_2h' then 'in about 2 hours'
                else 'in the next 24 hours' end as label
    from fresh
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🥒 Drill session coming up',
      'You have a drill session ' || r.label || '. Tap to view details.',
      'drill', r.entity_id, 'drill', null
    );
  end loop;
exception when others then null;
end $$;

-- Upcoming scheduled league events (only players who said they can attend).
create or replace function public.remind_event_starts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with due as (
      select le.id as event_id, v.user_id
      from public.league_events le
      join public.event_slots es      on es.id = le.confirmed_slot_id
      join public.event_slot_votes v  on v.slot_id = es.id
      where le.status = 'scheduled'
        and es.starts_at >  now()
        and es.starts_at <= now() + interval '24 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'event_start', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, le.league_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '📅 Event reminder: ' || r.title,
      'Your league event is coming up in the next 24 hours.',
      'league', r.league_id, 'league', 'notifyEventReminders'
    );
  end loop;
exception when others then null;
end $$;

-- Upcoming tournaments (approved registrants).
create or replace function public.remind_tournament_starts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with due as (
      select t.id as tournament_id, tr.user_id
      from public.tournaments t
      join public.tournament_registrations tr
        on tr.tournament_id = t.id and tr.status = 'approved'
      where t.start_time is not null
        and t.status in ('registration', 'active')
        and t.start_time >  now()
        and t.start_time <= now() + interval '24 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'tournament_start', tournament_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id, t.name
    from fresh f
    join public.tournaments t on t.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🏆 Tournament starting soon: ' || r.name,
      'Your tournament starts in the next 24 hours. Tap for details.',
      'tournament', r.entity_id, 'tournament', 'notifyTournamentUpdates'
    );
  end loop;
exception when others then null;
end $$;

-- Scheduling votes about to close (only members who haven't voted yet).
create or replace function public.remind_vote_closings()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with due as (
      select le.id as event_id, le.league_id, le.title, lm.user_id
      from public.league_events le
      join public.league_members lm on lm.league_id = le.league_id
      where le.status = 'voting'
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '6 hours'
        and not exists (
          select 1
          from public.event_slot_votes v
          join public.event_slots s on s.id = v.slot_id
          where s.event_id = le.id and v.user_id = lm.user_id
        )
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'vote_closing', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, le.league_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '🗳️ Vote closing soon: ' || r.title,
      'Voting closes within 6 hours and you haven''t voted yet. Tap to weigh in.',
      'league', r.league_id, 'league', 'notifyEventReminders'
    );
  end loop;
exception when others then null;
end $$;

-- ── Dispatcher + hourly schedule ──────────────────────────────────────────
create or replace function public.run_notification_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.remind_drill_sessions();
  perform public.remind_event_starts();
  perform public.remind_tournament_starts();
  perform public.remind_vote_closings();
end $$;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'pickleague-notification-reminders') then
    perform cron.schedule(
      'pickleague-notification-reminders',
      '10 * * * *',
      $cron$ select public.run_notification_reminders(); $cron$
    );
  end if;
end $$;


-- ============================================================================
-- FILE: migration_guest_event_invites.sql
-- ============================================================================

-- Guest invites to a league event vote
--
-- A league member picks phone contacts and sends ONE group text with a shared
-- link (https://pickleague.club/g/<token>). Each tapper lands on a page that
-- shows the invited roster, picks their name, gets a 7-day guest pass (temporary
-- league membership + an anonymous auth session), and is dropped on the vote.
--
-- Guests authenticate via Supabase ANONYMOUS sign-in, so every existing RLS rule
-- keyed on auth.uid() (voting, reading the league as a member, etc.) just works.
--
-- ── Infra prerequisite (one-time) ──────────────────────────────────────────
--   Enable Authentication → Providers → "Anonymous sign-ins" in Supabase.
--   The feature is inert until that is on.

-- ── Temporary membership: NULL expires_at = permanent; guests get now()+7d ──
alter table public.league_members
  add column if not exists expires_at timestamptz;

-- ── Guest flags on the profile ─────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_guest boolean not null default false,
  add column if not exists guest_expires_at timestamptz;

-- ── handle_new_user: tolerate anonymous users (no email / no metadata) ──────
-- Anonymous auth.users rows have a NULL email, which made full_name resolve to
-- NULL and violate the NOT NULL constraint. Add a 'Guest' fallback. The username
-- path already falls back to 'player' (length-0 base), so it's unchanged here.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_base      text;
  v_candidate text;
  v_n         int := 1;
  v_gender    text;
begin
  v_base := lower(regexp_replace(
              coalesce(new.raw_user_meta_data->>'username',
                       split_part(new.email, '@', 1)),
              '[^a-z0-9]', '', 'g'
            ));
  if length(coalesce(v_base, '')) = 0 then
    v_base := 'player';
  end if;

  v_candidate := v_base;
  while exists (select 1 from public.profiles where username = v_candidate) loop
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  end loop;

  v_gender := coalesce(new.raw_user_meta_data->>'gender', 'prefer-not-to-say');
  if v_gender not in ('male','female','other','prefer-not-to-say') then
    v_gender := 'prefer-not-to-say';
  end if;

  insert into public.profiles (id, username, full_name, gender)
  values (
    new.id,
    v_candidate,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(split_part(new.email, '@', 1), ''),
      'Guest'
    ),
    v_gender
  );
  return new;
end;
$$;

-- ── Guest invites table ────────────────────────────────────────────────────
create table if not exists public.guest_invites (
  id            uuid default gen_random_uuid() primary key,
  token         text not null unique,
  league_id     uuid not null references public.leagues(id) on delete cascade,
  event_id      uuid not null references public.league_events(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete set null,
  invited_names text[] not null default '{}',
  expires_at    timestamptz not null default (now() + interval '7 days'),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists guest_invites_token_idx on public.guest_invites(token);

-- RLS: only the creator can read/manage rows directly. The pre-auth landing page
-- reads its preview through the SECURITY DEFINER RPC below, never the table.
alter table public.guest_invites enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='guest_invites' and policyname='Creator manages own guest invites') then
    create policy "Creator manages own guest invites" on public.guest_invites
      for all using (auth.uid() = created_by) with check (auth.uid() = created_by);
  end if;
end $$;

-- ── RPC: preview (callable pre-auth by the anon role) ──────────────────────
create or replace function public.get_guest_invite_preview(p_token text)
returns table (
  valid         boolean,
  league_name   text,
  event_id      uuid,
  event_title   text,
  invited_names text[],
  expires_at    timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.guest_invites;
begin
  select * into v_inv
  from public.guest_invites
  where upper(token) = upper(p_token)
  limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    return query select false, null::text, null::uuid, null::text, null::text[], null::timestamptz;
    return;
  end if;

  return query
    select true,
           l.name,
           e.id,
           e.title,
           v_inv.invited_names,
           v_inv.expires_at
    from public.leagues l
    join public.league_events e on e.id = v_inv.event_id
    where l.id = v_inv.league_id;
end;
$$;

grant execute on function public.get_guest_invite_preview(text) to anon, authenticated;

-- ── RPC: create (inviter, must be a league member) ─────────────────────────
create or replace function public.create_guest_invite(
  p_league_id     uuid,
  p_event_id      uuid,
  p_invited_names text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_token text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = auth.uid()
  ) then
    raise exception 'Only league members can invite guests';
  end if;
  if not exists (
    select 1 from public.league_events
    where id = p_event_id and league_id = p_league_id
  ) then
    raise exception 'Event does not belong to this league';
  end if;

  -- Use core gen_random_uuid() (pg_catalog, always on search_path) rather than
  -- pgcrypto's gen_random_bytes/encode, which live in the `extensions` schema
  -- and would not resolve under this function's `search_path = public`.
  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));  -- 12-char URL-safe token

  insert into public.guest_invites (token, league_id, event_id, created_by, invited_names)
  values (v_token, p_league_id, p_event_id, auth.uid(), coalesce(p_invited_names, '{}'));

  return v_token;
end;
$$;

grant execute on function public.create_guest_invite(uuid, uuid, text[]) to authenticated;

-- ── RPC: redeem (guest, after anonymous sign-in) ───────────────────────────
create or replace function public.redeem_guest_invite(p_token text, p_name text)
returns table (
  league_id   uuid,
  league_name text,
  event_id    uuid,
  event_title text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv  public.guest_invites;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Only an anonymous (guest) session may redeem. Without this, a real user who
  -- called this RPC directly would have their profile overwritten (is_guest=true,
  -- name, 7-day expiry) and get signed out / cron-removed. The client never calls
  -- this for a real user, but the server must enforce it too.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    raise exception 'Only a guest session can redeem a guest invite';
  end if;

  select * into v_inv
  from public.guest_invites
  where upper(token) = upper(p_token)
  limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    raise exception 'This guest invite is no longer valid';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');

  -- Stamp the guest's profile (name + guest flag + expiry).
  update public.profiles
  set full_name        = coalesce(v_name, full_name),
      is_guest         = true,
      guest_expires_at = v_inv.expires_at
  where id = auth.uid();

  -- Temporary league membership (idempotent if they re-tap the link).
  insert into public.league_members (league_id, user_id, role, expires_at)
  values (v_inv.league_id, auth.uid(), 'member', v_inv.expires_at)
  on conflict (league_id, user_id) do nothing;

  return query
    select l.id, l.name, e.id, e.title
    from public.leagues l
    join public.league_events e on e.id = v_inv.event_id
    where l.id = v_inv.league_id;
end;
$$;

grant execute on function public.redeem_guest_invite(text, text) to authenticated;

-- ── Cleanup: drop expired temporary memberships (daily) ────────────────────
create or replace function public.cleanup_expired_guests()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.league_members
  where expires_at is not null and expires_at < now();
end;
$$;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'pickleague-cleanup-expired-guests') then
    perform cron.schedule(
      'pickleague-cleanup-expired-guests',
      '15 3 * * *',
      $cron$ select public.cleanup_expired_guests(); $cron$
    );
  end if;
end $$;


-- ============================================================================
-- FILE: migration_guest_expiry_enforcement.sql
-- ============================================================================

-- Server-side enforcement of guest-pass expiry
--
-- Follow-up to migration_guest_event_invites.sql. Previously, an expired guest's
-- anonymous session kept working: RLS only checks auth.uid(), and the temporary
-- league_members row lingered until a once-daily cron removed it. So an expired
-- guest could still cast votes. This migration closes that two ways:
--
--   1. An RLS guard blocks expired guests from casting votes even while they
--      still hold a (≤1h) valid access token.
--   2. The cleanup job now DELETES the expired anonymous auth.users row (instead
--      of just the membership). FK cascades remove their profile, membership,
--      votes, and push tokens, and GoTrue drops their sessions/refresh tokens —
--      so no new access token can be issued. It now runs hourly, not daily.
--
-- Residual window: an already-issued access token stays valid until it expires
-- (~1h). The vote guard covers the one write that matters in that window; other
-- member-gated actions stop once the hourly delete removes their membership.

-- ── Predicate: is this user an expired guest? (RLS-safe) ───────────────────
create or replace function public.is_expired_guest(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = p_uid
      and is_guest
      and guest_expires_at is not null
      and guest_expires_at < now()
  );
$$;

grant execute on function public.is_expired_guest(uuid) to anon, authenticated;

-- ── Block expired guests from voting (live-token window) ───────────────────
drop policy if exists "Users can cast votes" on public.event_slot_votes;
create policy "Users can cast votes" on public.event_slot_votes
  for insert with check (
    auth.uid() = user_id
    and not public.is_expired_guest(auth.uid())
  );

-- ── Full revocation: delete expired anonymous users (cascades) ─────────────
create or replace function public.cleanup_expired_guests()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Deleting the anonymous auth.users row cascades to the profile and, through
  -- it, to league_members / event_slot_votes / push_tokens, and GoTrue drops the
  -- user's sessions + refresh tokens. The `u.is_anonymous` guard guarantees we
  -- never delete a real account even if a profile were somehow mis-flagged.
  delete from auth.users u
  using public.profiles p
  where p.id = u.id
    and u.is_anonymous
    and p.is_guest
    and p.guest_expires_at is not null
    and p.guest_expires_at < now();
end;
$$;

-- ── Run it hourly (was daily) ──────────────────────────────────────────────
do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-cleanup-expired-guests') then
    perform cron.unschedule('pickleague-cleanup-expired-guests');
  end if;
  perform cron.schedule(
    'pickleague-cleanup-expired-guests',
    '15 * * * *',
    $cron$ select public.cleanup_expired_guests(); $cron$
  );
end $$;


-- ============================================================================
-- FILE: migration_push_outbox.sql  (replaces the direct pg_net push with the outbox)
-- ============================================================================

-- ============================================================
-- Push outbox + per-device deliveries + receipts (work order Phase 7c).
-- Built from the foundation server kit's push_outbox.template.sql
-- (@just-messin-around/expo-foundation 1.34.0), adapted to Pickleague:
--   - one outbox row per notifications row, keyed by notification_id (unique),
--     so enqueue is idempotent
--   - the shared secret stays in private.app_config (send_push_secret), which
--     has no anon/authenticated access, instead of Vault
--   - extra failed-row retry with backoff, receipt polling, retention
--
-- BEFORE: notifications INSERT -> pg_net -> send-push. A failed pg_net call or
-- an Expo 5xx lost the push for good.
-- AFTER:  notifications INSERT -> push_outbox row (same transaction)
--           -> outbox INSERT webhook (pg_net, the fast path)
--           -> every 2 min a drain re-sends anything still pending.
-- send-push claims a row (pending -> sending) before sending, so the webhook
-- and the drain can never send the same row at once. Delivery is
-- at-least-once: every push carries data.outboxId and the app dedupes on it.
--
-- Rollout order (state/live-features-server.ps1 does this):
--   1. apply this file      (rows queue as 'pending'; the old function 400s
--                            on the new payload, nothing is lost)
--   2. deploy send-push     (the drain then sends everything pending)
--
-- Apply:  supabase db query --linked -f supabase/migration_push_outbox.sql
-- ============================================================

create table if not exists public.push_outbox (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid unique references public.notifications (id) on delete cascade,
  recipient_id    uuid not null references public.profiles (id) on delete cascade,
  channel         text not null default 'push' check (channel in ('push', 'email')),
  kind            text not null,                -- notifications.type
  category        text,                         -- notifications.category (pref gate)
  entity_type     text,
  entity_id       uuid,
  title           text not null,
  body            text not null,
  deep_link       text,                         -- "<entity_type>/<entity_id or ->"
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed', 'expired')),
  error           text,
  expires_at      timestamptz,
  attempts        int not null default 0,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists push_outbox_pending_idx on public.push_outbox (created_at) where status = 'pending';
create index if not exists push_outbox_sending_idx on public.push_outbox (claimed_at) where status = 'sending';
create index if not exists push_outbox_failed_idx  on public.push_outbox (claimed_at) where status = 'failed';
create index if not exists push_outbox_created_idx on public.push_outbox (created_at);
alter table public.push_outbox enable row level security;   -- no client policies: service role only

create table if not exists public.push_deliveries (
  outbox_id          uuid not null references public.push_outbox (id) on delete cascade,
  token              text not null,
  ticket_id          text,
  status             text not null check (status in ('ok', 'error')),
  error              text,
  receipt_checked_at timestamptz,
  created_at         timestamptz not null default now(),
  primary key (outbox_id, token)
);
create index if not exists push_deliveries_receipt_idx on public.push_deliveries (created_at)
  where status = 'ok' and receipt_checked_at is null;
alter table public.push_deliveries enable row level security;

-- Stamp claims on the database clock, whichever path claimed.
create or replace function public._push_stamp_claim() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'sending' and old.status is distinct from 'sending' then
    new.claimed_at := now();
    new.attempts := old.attempts + 1;
  end if;
  return new;
end $$;
revoke all on function public._push_stamp_claim() from public, anon, authenticated;
drop trigger if exists push_stamp_claim on public.push_outbox;
create trigger push_stamp_claim before update of status on public.push_outbox
  for each row execute function public._push_stamp_claim();

create or replace function public.claim_pending_push(p_limit int default 50)
returns setof public.push_outbox
language sql volatile security definer set search_path = '' as $$
  with picked as materialized (
    select p.id from public.push_outbox p
     where p.status = 'pending'
     order by p.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 100))
     for update skip locked
  )
  update public.push_outbox o set status = 'sending'
    from picked where o.id = picked.id and o.status = 'pending'
  returning o.*;
$$;
revoke execute on function public.claim_pending_push(int) from public, anon, authenticated;
grant execute on function public.claim_pending_push(int) to service_role;

create or replace function public.release_push_claims(p_ids uuid[])
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v int;
begin
  update public.push_outbox
     set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
   where id = any(p_ids) and status = 'sending';
  get diagnostics v = row_count;
  return v;
end $$;
revoke execute on function public.release_push_claims(uuid[]) from public, anon, authenticated;
grant execute on function public.release_push_claims(uuid[]) to service_role;

-- When a push stops being worth sending: a match confirm after its deadline,
-- an event vote after voting closes. Anything else never expires.
create or replace function public._push_expires_at(p_entity_type text, p_entity_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case p_entity_type
    when 'match' then (select m.confirm_deadline from public.matches m
                        where m.id = p_entity_id and m.status = 'pending')
    when 'event' then (select e.vote_ends_at from public.league_events e
                        where e.id = p_entity_id and e.status = 'voting')
  end;
$$;
revoke all on function public._push_expires_at(text, uuid) from public, anon, authenticated;

-- A signed-in user may test-push only their own devices.
create or replace function public.send_test_push() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.push_outbox (recipient_id, kind, title, body)
  values (auth.uid(), 'test', 'Test notification', 'Push notifications are working.')
  returning id into v;
  return v;
end $$;
revoke execute on function public.send_test_push() from public, anon;
grant execute on function public.send_test_push() to authenticated;

-- ── Enqueue: the notifications trigger now writes the outbox row ───────────
-- Same transaction as the notification. Wrapped so a push problem can never
-- roll back the in-app notification.
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.push_outbox
      (notification_id, recipient_id, kind, category, entity_type, entity_id, title, body, deep_link, expires_at)
    values (
      new.id, new.user_id, coalesce(new.type, 'info'), new.category, new.entity_type, new.entity_id,
      coalesce(nullif(new.title, ''), 'Pickleague'), coalesce(new.body, ''),
      case when new.entity_type is not null then new.entity_type || '/' || coalesce(new.entity_id::text, '-') end,
      public._push_expires_at(new.entity_type, new.entity_id)
    )
    on conflict (notification_id) do nothing;
  exception when others then
    raise warning 'push outbox enqueue failed for notification %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.handle_notification_push() from public, anon, authenticated;
-- trg_notification_push (AFTER INSERT ON notifications) already calls this.

-- ── Fast path: outbox INSERT webhook ────────────────────────────────────────
-- Sends only the outbox id; send-push re-reads and claims the row. Reads the
-- URL and secret at call time, never stored in a definition. A failure here
-- never blocks the insert; the drain sends the row.
create or replace function public._push_post(p_body jsonb, p_timeout_ms int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_config where key = 'send_push_url';
  select value into v_secret from private.app_config where key = 'send_push_secret';
  if v_url is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := p_body,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(v_secret, '')),
    timeout_milliseconds := p_timeout_ms
  );
end $$;
revoke all on function public._push_post(jsonb, int) from public, anon, authenticated;

create or replace function public._push_webhook() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public._push_post(
      jsonb_build_object('type', tg_op, 'table', tg_table_name, 'schema', tg_table_schema,
                         'record', jsonb_build_object('id', new.id), 'old_record', null),
      5000);
  exception when others then
    raise warning 'push webhook enqueue failed for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._push_webhook() from public, anon, authenticated;
drop trigger if exists push_webhook on public.push_outbox;
create trigger push_webhook after insert on public.push_outbox
  for each row execute function public._push_webhook();

-- ── Drain, retry, reaper, expiry (every 2 minutes) ──────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.push_drain() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Reaper: a row stuck in 'sending' (its invocation died) goes back to
  -- pending, up to 3 claims. May re-send: at-least-once.
  update public.push_outbox
     set status = case when attempts >= 3 then 'failed' else 'pending' end,
         error  = case when attempts >= 3 then 'Stuck in sending after ' || attempts || ' claims; gave up' else error end
   where status = 'sending' and coalesce(claimed_at, created_at) < now() - interval '10 minutes';

  -- Retry with backoff (2, 4 min after the 1st and 2nd attempt), at most 3
  -- attempts. push_deliveries makes a retry send only to devices that failed.
  -- A recipient with no devices is not worth retrying.
  update public.push_outbox
     set status = 'pending'
   where status = 'failed'
     and attempts < 3
     and error is distinct from 'No push tokens for recipient'
     and claimed_at < now() - make_interval(mins => power(2, attempts)::int)
     and (expires_at is null or expires_at > now());

  update public.push_outbox set status = 'expired'
   where status in ('pending', 'failed') and expires_at is not null and expires_at <= now();

  if exists (select 1 from public.push_outbox where status = 'pending') then
    perform public._push_post(jsonb_build_object('processPending', true), 60000);
  end if;
end $$;
revoke all on function private.push_drain() from public, anon, authenticated;

-- Receipts (Expo has them ~15 min after sending): a receipt error marks that
-- device's delivery 'error' and DeviceNotRegistered prunes the token.
create or replace function private.push_poll_receipts() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.push_deliveries
              where status = 'ok' and receipt_checked_at is null
                and created_at < now() - interval '15 minutes') then
    perform public._push_post(jsonb_build_object('pollReceipts', true), 60000);
  end if;
end $$;
revoke all on function private.push_poll_receipts() from public, anon, authenticated;

-- Keep 30 days of history.
create or replace function private.push_prune() returns void
language sql security definer set search_path = '' as $$
  delete from public.push_outbox
   where created_at < now() - interval '30 days'
     and status in ('sent', 'expired', 'failed');
$$;
revoke all on function private.push_prune() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-push-drain') then
    perform cron.unschedule('pickleague-push-drain');
  end if;
  perform cron.schedule('pickleague-push-drain', '*/2 * * * *', $c$ select private.push_drain(); $c$);

  if exists (select 1 from cron.job where jobname = 'pickleague-push-receipts') then
    perform cron.unschedule('pickleague-push-receipts');
  end if;
  perform cron.schedule('pickleague-push-receipts', '*/30 * * * *', $c$ select private.push_poll_receipts(); $c$);

  if exists (select 1 from cron.job where jobname = 'pickleague-push-prune') then
    perform cron.unschedule('pickleague-push-prune');
  end if;
  perform cron.schedule('pickleague-push-prune', '40 4 * * *', $c$ select private.push_prune(); $c$);
end $$;

-- Health check (oldest pending/sending older than 15 min = drain or secret broken):
--   select status, count(*), min(created_at) from public.push_outbox
--    where created_at > now() - interval '1 day' group by status;


-- ============================================================================
-- FILE: migration_push_data.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- push_data: what a generator tells send-push about one push (push actions,
-- 2026-10-11 audit). Additive and idempotent; safe to re-run.
--
-- notifications.push_data (jsonb, nullable) is copied to push_outbox.push_data
-- by handle_notification_push. send-push reads a small, fixed set of keys:
--   kind       which push this is ('event_record', 'drill_chat', ...). Several
--              pushes share an entity (a drill chat and the drill request it
--              belongs to are both drill/<request id>), so the entity alone
--              cannot pick the right buttons.
--   deep_link  where a tap goes, when that is not "<entity_type>/<entity_id>"
--              (e.g. 'drill_chat/<id>' opens the chat thread itself)
--   + a few ids the buttons need (invite_code, partner_id, ...).
--
-- SECURITY: clients may INSERT notifications (self, and admins to their
-- members; TournamentDetail inserts bracket notices). Unfiltered, a client
-- could put any category or link on someone's push. A BEFORE trigger drops
-- push_data on every client write, so only SECURITY DEFINER generators (which
-- run as the function owner) can set it.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_data.sql
-- ============================================================

alter table public.notifications add column if not exists push_data jsonb;
alter table public.push_outbox   add column if not exists push_data jsonb;

-- NOT security definer on purpose: current_user must be the caller's role.
create or replace function public._notifications_strip_client_push_data()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.push_data := null;
    else
      new.push_data := old.push_data;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._notifications_strip_client_push_data() from public, anon, authenticated;

drop trigger if exists trg_notifications_strip_client_push_data on public.notifications;
create trigger trg_notifications_strip_client_push_data
  before insert or update of push_data on public.notifications
  for each row execute function public._notifications_strip_client_push_data();

-- Same as migration_push_outbox.sql, plus push_data and its deep_link override.
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.push_outbox
      (notification_id, recipient_id, kind, category, entity_type, entity_id, title, body, deep_link, expires_at, push_data)
    values (
      new.id, new.user_id, coalesce(new.type, 'info'), new.category, new.entity_type, new.entity_id,
      coalesce(nullif(new.title, ''), 'Pickleague'), coalesce(new.body, ''),
      coalesce(
        nullif(new.push_data ->> 'deep_link', ''),
        case when new.entity_type is not null then new.entity_type || '/' || coalesce(new.entity_id::text, '-') end
      ),
      public._push_expires_at(new.entity_type, new.entity_id),
      new.push_data
    )
    on conflict (notification_id) do nothing;
  exception when others then
    raise warning 'push outbox enqueue failed for notification %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.handle_notification_push() from public, anon, authenticated;
-- trg_notification_push (AFTER INSERT ON notifications) already calls this.


-- ============================================================================
-- FILE: migration_time_zones.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Per-user time zones (foundation server kit time_zone.template.sql, filled
-- with prefix 'pickleague', recipients public.profiles). Idempotent.
--
-- Why now: drill_sessions.starts_at was built from the wall-clock slot as if
-- it were UTC (migration_drill_start_time_fix.sql uses _pickleague_tz_for),
-- and push bodies that print times need the recipient's zone. The app
-- reports its zone through set_pickleague_time_zone after sign-in
-- (mobile/src/lib/timeZoneSync.ts). No stored zone = America/Los_Angeles.
--
-- Apply:  supabase db query --linked -f supabase/migration_time_zones.sql
-- ============================================================

-- Vendored from @just-messin-around/expo-foundation@1.37.0 (server kit). Edit upstream, then re-vendor.
-- Each user's time zone, for local times in push bodies (foundation server kit).
-- Placeholders: pickleague, public.profiles.
--
-- Push bodies are built in SQL by the producer and sent as is, so a time in a
-- body has to be formatted in the RECIPIENT's zone at enqueue time. The device
-- reports its IANA zone (deviceTimeZone() in /platform/push) through
-- set_pickleague_time_zone; producers read it with _pickleague_tz_for and
-- format with _pickleague_local_label / _pickleague_option_list. A user with
-- no stored zone, or an invalid one, gets America/Los_Angeles
-- (_pickleague_default_tz: change it there).
--
-- Its own table, not a column on public.profiles: the zone stays private to its
-- owner (profiles are often world-readable), and the recipients table's
-- policies and guard triggers are not touched.
--
-- _pickleague_local_label formats exactly like formatOptionLabel() in
-- /push/optionVote ("Sat Oct 18, 9 AM", "Sat Oct 18, 9:30 AM"), so a body built
-- here and a confirmation notice built on the device read the same.

create table if not exists public.pickleague_time_zones (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  tz         text not null,
  updated_at timestamptz not null default now()
);
alter table public.pickleague_time_zones enable row level security;
drop policy if exists pickleague_time_zones_own on public.pickleague_time_zones;
create policy pickleague_time_zones_own on public.pickleague_time_zones for select to authenticated
  using (profile_id = (select auth.uid()));
-- Writes go through set_pickleague_time_zone only (it validates the zone).

create or replace function public._pickleague_default_tz()
returns text language sql immutable set search_path = '' as $$ select 'America/Los_Angeles'::text $$;

-- True for a zone Postgres knows by IANA name ('America/New_York', 'Etc/GMT+5').
-- POSIX strings ('UTC+5', 'EST5EDT'-style offsets) are refused: Postgres reads
-- their sign the opposite way round from the device.
create or replace function public._pickleague_valid_tz(p_tz text)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  if p_tz is null or length(p_tz) > 64 or p_tz !~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$' then
    return false;
  end if;
  perform now() at time zone p_tz;
  return true;
exception when others then
  return false;
end $$;

-- The caller's device zone. Returns false (stores nothing) for an invalid zone.
create or replace function public.set_pickleague_time_zone(p_tz text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public._pickleague_valid_tz(p_tz) then return false; end if;
  insert into public.pickleague_time_zones (profile_id, tz, updated_at)
  values (auth.uid(), p_tz, now())
  on conflict (profile_id) do update set tz = excluded.tz, updated_at = now()
  where pickleague_time_zones.tz is distinct from excluded.tz;
  return true;
end $$;
revoke execute on function public.set_pickleague_time_zone(text) from public, anon;
grant execute on function public.set_pickleague_time_zone(text) to authenticated;

-- A recipient's zone, else the default. For producers (service role / definer code).
create or replace function public._pickleague_tz_for(p_profile uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select z.tz from public.pickleague_time_zones z where z.profile_id = p_profile),
    public._pickleague_default_tz()
  );
$$;
revoke execute on function public._pickleague_tz_for(uuid) from public, anon, authenticated;
grant execute on function public._pickleague_tz_for(uuid) to service_role;

-- "Sat Oct 18, 9 AM" / "Sat Oct 18, 9:30 AM" in p_tz (an invalid or null zone
-- uses the default). English names regardless of lc_time (no TM prefix).
create or replace function public._pickleague_local_label(p_at timestamptz, p_tz text default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp;
begin
  if p_at is null then return null; end if;
  begin
    v_local := p_at at time zone coalesce(nullif(p_tz, ''), public._pickleague_default_tz());
  exception when others then
    v_local := p_at at time zone public._pickleague_default_tz();
  end;
  return to_char(v_local, 'Dy Mon FMDD, FMHH12')
      || case when extract(minute from v_local) = 0 then '' else to_char(v_local, ':MI') end
      || ' ' || to_char(v_local, 'AM');
end $$;

-- The numbered list for a vote body, like formatOptionList(): "1) ...\n2) ...".
-- Pass the times in button order (order by starts_at, id).
create or replace function public._pickleague_option_list(p_starts timestamptz[], p_tz text default null, p_sep text default E'\n')
returns text language sql stable set search_path = '' as $$
  select string_agg(s.n::text || ') ' || public._pickleague_local_label(s.t, p_tz), p_sep order by s.n)
  from unnest(p_starts) with ordinality as s(t, n);
$$;


-- ============================================================================
-- FILE: migration_drill_start_time_fix.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Drill sessions start at the right time (2026-10-11 audit; verified
-- 2026-10-12 with read-only queries). Needs migration_time_zones.sql first.
-- Idempotent.
--
-- THE BUG: create_drill_session_on_accept built starts_at as
--   (session_date)::timestamp + slot * 30 min
-- a timestamp WITHOUT a zone, cast to timestamptz in the session zone. The
-- database zone is UTC (show timezone = UTC; no role or database override),
-- so a 9:00 AM slot (slots are wall-clock half hours on the requester's
-- device, 0 = midnight) was stored as 09:00 UTC = 2:00 AM Pacific (PDT).
-- Everything that reads starts_at fired about 7 hours early (8 in winter):
-- the 24 h / 2 h reminders, send-push's "upcoming" check for the On my way
-- buttons, and the app's local "starting now" notice. The app's own labels
-- were right, because they print session_date + session_slot.
--
-- THE FIX: read the wall-clock slot in the REQUESTER's time zone (their 7-day
-- grid produced the dates), via _pickleague_tz_for (America/Los_Angeles until
-- the app has reported a zone). The backfill of upcoming sessions is a
-- separate, reviewable step: supabase/backfill_drill_start_times.sql.
--
-- Apply:  supabase db query --linked -f supabase/migration_drill_start_time_fix.sql
-- ============================================================

-- A wall-clock slot on a date, in a zone -> the real instant.
create or replace function public._drill_slot_starts_at(p_date date, p_slot integer, p_tz text default null)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp := p_date::timestamp + (p_slot * interval '30 minutes');
begin
  if p_date is null or p_slot is null then return null; end if;
  begin
    return v_local at time zone coalesce(nullif(p_tz, ''), public._pickleague_default_tz());
  exception when others then
    return v_local at time zone public._pickleague_default_tz();
  end;
end $$;
revoke all on function public._drill_slot_starts_at(date, integer, text) from public, anon, authenticated;

-- "Sat Oct 18, 9 AM" / "Sat Oct 18, 9:30 AM" for a wall-clock slot: the same
-- format as the foundation's formatOptionLabel and _pickleague_local_label.
-- No zone involved: the slot already is local time.
create or replace function public._drill_slot_label(p_date date, p_slot integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_date is null or p_slot is null then null else
    to_char(t, 'Dy Mon FMDD, FMHH12')
    || case when extract(minute from t) = 0 then '' else to_char(t, ':MI') end
    || ' ' || to_char(t, 'AM')
  end
  from (select p_date::timestamp + (coalesce(p_slot, 0) * interval '30 minutes') as t) s;
$$;
revoke all on function public._drill_slot_label(date, integer) from public, anon, authenticated;

-- Production definition (2026-10-12) with starts_at computed in the
-- requester's zone, and an explicit search_path.
create or replace function public.create_drill_session_on_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_date text;
  v_slot integer;
  v_len  integer;
begin
  if old.status = 'pending' and new.status = 'accepted' and new.accepted_slot is not null then
    v_date := new.accepted_slot ->> 'date';
    v_slot := (new.accepted_slot ->> 'slot')::int;
    v_len  := coalesce(new.length_minutes, 60);
    if v_date is null or v_slot is null then return new; end if;

    insert into public.drill_sessions (
      request_id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes
    ) values (
      new.id, new.from_user_id, new.to_user_id,
      v_date::date, v_slot,
      public._drill_slot_starts_at(v_date::date, v_slot, public._pickleague_tz_for(new.from_user_id)),
      v_len
    )
    on conflict do nothing;
  end if;
  return new;
end;
$function$;


-- ============================================================================
-- FILE: migration_push_actions_events.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Event pushes point at the EVENT, and say which push they are (push actions,
-- 2026-10-11 audit). Needs migration_push_data.sql first. Idempotent.
--
-- Before: New vote / Vote closing soon / Event scheduled / Event cancelled were
-- entity 'league', so a tap opened LeagueDetail (with the push title as its
-- header) and send-push never offered buttons. Now they are entity
-- 'event' (tap -> EventDetail) and carry push_data.kind, which send-push uses
-- to pick the buttons:
--   event_vote_opened / event_vote_closing  -> Can't make it (numbered vote
--                                              buttons: migration_event_vote_buttons.sql)
--   event_scheduled                         -> I'm in / Can't make it
--                                              (Can't make it only if you
--                                              already voted for that time)
--   event_cancelled                         -> organizer: Pick new times (opens)
--   event_start                             -> Can't make it
--   event_record ("How did it go?")         -> Record result (opens MatchEntry)
--   event_nudge_vote                        -> organizer: Text group, Close vote
--                                              (both open the app)
--   event_nudge_tomorrow / _today           -> organizer: Text group (opens)
--   (a plain tap on a nudge opens the text composer, as its body promises)
--
-- Also: Vote closing soon no longer goes to members who said Can't make it,
-- or to the organizer (who gets the organizer nudge instead).
--
-- Bodies are unchanged here; the vote times in the body come with the
-- numbered vote buttons.
--
-- Each function below is the production definition (pg_get_functiondef,
-- 2026-10-12) with only the entity / push_data / recipient changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_events.sql
-- ============================================================

-- ── New vote ────────────────────────────────────────────────────────────────
create or replace function public.notify_new_event_vote()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  if new.status <> 'voting' then
    return new;
  end if;

  for r in
    select lm.user_id
    from public.league_members lm
    where lm.league_id = new.league_id
      and (new.created_by is null or lm.user_id <> new.created_by)
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🗳️ New vote: ' || new.title,
      'Your league opened a scheduling vote. Cast your vote before it closes.',
      'league', new.id, 'event', 'notifyLeagueUpdates',
      jsonb_build_object('kind', 'event_vote_opened', 'league_id', new.league_id)
    );
  end loop;
  return new;
exception when others then
  return new;
end $function$;

-- ── Vote closing soon ───────────────────────────────────────────────────────
create or replace function public.remind_vote_closings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with due as (
      select le.id as event_id, le.league_id, le.title, lm.user_id
      from public.league_events le
      join public.league_members lm on lm.league_id = le.league_id
      where le.status = 'voting'
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '6 hours'
        -- The organizer gets the organizer nudge (Text group / Close vote).
        and (le.created_by is null or lm.user_id <> le.created_by)
        and not exists (
          select 1
          from public.event_slot_votes v
          join public.event_slots s on s.id = v.slot_id
          where s.event_id = le.id and v.user_id = lm.user_id
        )
        -- "Can't make it" is an answer: don't tell them they haven't voted.
        and not exists (
          select 1 from public.event_declines d
          where d.event_id = le.id and d.user_id = lm.user_id
        )
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'vote_closing', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as event_id, le.league_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🗳️ Vote closing soon: ' || r.title,
      'Voting closes within 6 hours and you haven''t voted yet. Tap to weigh in.',
      'league', r.event_id, 'event', 'notifyEventReminders',
      jsonb_build_object('kind', 'event_vote_closing', 'league_id', r.league_id)
    );
  end loop;
exception when others then null;
end $function$;

-- ── Event scheduled / cancelled (vote finalized) ───────────────────────────
-- The status is updated BEFORE the notifications are inserted, so
-- _push_expires_at (which expires event pushes at vote_ends_at only while the
-- event is still 'voting') leaves these pushes unexpired.
create or replace function public._finalize_one_event(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r            record;
  winner       uuid;
  winner_votes integer;
begin
  select le.id, le.league_id, le.title, le.min_players
    into r
    from public.league_events le
   where le.id = p_event_id and le.status = 'voting';

  if not found then
    return null;
  end if;

  select s.id, count(v.id)
    into winner, winner_votes
  from public.event_slots s
  left join public.event_slot_votes v on v.slot_id = s.id
  where s.event_id = r.id
  group by s.id, s.starts_at
  order by count(v.id) desc, s.starts_at asc
  limit 1;

  if winner is null then
    return null;
  end if;

  if r.min_players is not null and winner_votes < r.min_players then
    update public.league_events
       set status = 'cancelled'
     where id = r.id and status = 'voting';

    if not found then
      return null;
    end if;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    select lm.user_id,
           '❌ Event cancelled: ' || r.title,
           'Voting closed without enough players agreeing on a time.',
           'league', r.id, 'event', 'notifyEventReminders',
           jsonb_build_object('kind', 'event_cancelled', 'league_id', r.league_id)
    from public.league_members lm
    where lm.league_id = r.league_id;

    return 'cancelled';
  end if;

  update public.league_events
     set status = 'scheduled', confirmed_slot_id = winner
   where id = r.id and status = 'voting';

  if not found then
    return null;
  end if;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
  select lm.user_id,
         '📅 Event scheduled: ' || r.title,
         'Voting has closed and a time is confirmed. Tap to see the schedule.',
         'league', r.id, 'event', 'notifyEventReminders',
         jsonb_build_object('kind', 'event_scheduled', 'league_id', r.league_id)
  from public.league_members lm
  where lm.league_id = r.league_id;

  return 'scheduled';
end $function$;

-- ── Event reminders (24 h / 2 h) ────────────────────────────────────────────
create or replace function public.remind_event_starts()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with windows as (
      select * from (values
        ('event_start',      interval '2 hours', interval '24 hours'),
        ('event_start_soon', interval '0 hours', interval '2 hours')
      ) as w(kind, lo, hi)
    ),
    due as (
      select w.kind, le.id as event_id, v.user_id
      from public.league_events le
      join public.event_slots es      on es.id = le.confirmed_slot_id
      join public.event_slot_votes v  on v.slot_id = es.id
      cross join windows w
      where le.status = 'scheduled'
        and es.starts_at >  now() + w.lo
        and es.starts_at <= now() + w.hi
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, event_id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select
      f.user_id,
      f.entity_id as event_id,
      le.league_id,
      le.title,
      case f.kind when 'event_start_soon' then 'in about 2 hours'
                  else 'in the next 24 hours' end as label
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '📅 Event reminder: ' || r.title,
      'Your league event is coming up ' || r.label || '. Tap to view details.',
      'league', r.event_id, 'event', 'notifyEventReminders',
      jsonb_build_object('kind', 'event_start', 'league_id', r.league_id)
    );
  end loop;
exception when others then null;
end $function$;

-- ── "How did it go?" ────────────────────────────────────────────────────────
create or replace function public.remind_event_record_results()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with due as (
      select le.id as event_id, v.user_id
      from public.league_events le
      join public.event_slots es      on es.id = le.confirmed_slot_id
      join public.event_slot_votes v  on v.slot_id = es.id
      where le.status = 'scheduled'
        and es.starts_at <= now() - interval '3 hours'
        and es.starts_at >  now() - interval '24 hours'
        and not exists (select 1 from public.matches m where m.event_id = le.id)
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'event_record', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as event_id, le.league_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '📝 How did it go? Record your results',
      'Your event "' || r.title || '" has started — record your match results so ratings update.',
      'league', r.event_id, 'event', 'notifyEventReminders',
      jsonb_build_object('kind', 'event_record', 'league_id', r.league_id)
    );
  end loop;
exception when others then null;
end $function$;

-- ── Organizer nudges ────────────────────────────────────────────────────────
create or replace function public.remind_event_organizer_nudges()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with due as (
      select le.id            as event_id,
             le.created_by    as user_id,
             'event_nudge_vote'::text as kind,
             le.title         as title,
             le.league_id     as league_id
      from public.league_events le
      where le.status = 'voting'
        and le.created_by is not null
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '2 hours'
        and exists (select 1 from public.event_slots s where s.event_id = le.id)
      union all
      select le.id, le.created_by, 'event_nudge_tomorrow', le.title, le.league_id
      from public.league_events le
      join public.event_slots es on es.id = le.confirmed_slot_id
      where le.status = 'scheduled'
        and le.created_by is not null
        and es.starts_at >  now() + interval '14 hours'
        and es.starts_at <= now() + interval '30 hours'
      union all
      select le.id, le.created_by, 'event_nudge_today', le.title, le.league_id
      from public.league_events le
      join public.event_slots es on es.id = le.confirmed_slot_id
      where le.status = 'scheduled'
        and le.created_by is not null
        and es.starts_at >  now()
        and es.starts_at <= now() + interval '10 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, event_id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select f.kind, f.user_id, f.entity_id as event_id, d.title, d.league_id
    from fresh f
    join due d on d.event_id = f.entity_id and d.kind = f.kind
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      case r.kind
        when 'event_nudge_vote'     then '📣 Voting closes soon: ' || r.title
        when 'event_nudge_tomorrow' then '📣 ' || r.title || ' is tomorrow'
        else                             '📣 ' || r.title || ' is today'
      end,
      case r.kind
        when 'event_nudge_vote'     then 'Tap to text your group a reminder to lock in their times.'
        when 'event_nudge_tomorrow' then 'Tap to text your group the confirmed time.'
        else                             'Tap to text your group that it is happening today.'
      end,
      'league', r.event_id, 'event', 'notifyEventReminders',
      -- The body says "Tap to text your group": the 1.0.4 app reads the kind and
      -- opens the composer (EventDetail with the nudge open). The link stays
      -- event/<id>, so a 1.0.3 phone still opens the event.
      jsonb_build_object('kind', r.kind, 'league_id', r.league_id)
    );
  end loop;
exception when others then null;
end $function$;


-- ============================================================================
-- FILE: migration_push_actions_drill.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Drill pushes and their buttons (push actions, 2026-10-11 audit).
-- Needs migration_push_data.sql, migration_time_zones.sql and
-- migration_drill_start_time_fix.sql first. Idempotent.
--
--   Drill request    the proposed times are listed in the body, numbered by
--                    time. 1 time: Accept / Decline. 2 times: 1st time /
--                    2nd time / Decline. 3 times: 1st / 2nd / 3rd time.
--                    4+: Decline (pick in the app). The picks go through the
--                    new accept_drill_slot RPC (refuses past times; replays
--                    say 'already').
--   Accepted         the requester gets Open chat (opens), with the time in
--   / declined       the body / Find another partner (opens).
--   Drill chat       Reply from the lock screen; the tap opens the thread
--                    (push_data.kind = 'drill_chat', which also tells it from
--                    the request push on the same entity; the link stays
--                    drill/<id>, so 1.0.3 phones keep their old landing).
--                    Lock-screen replies are idempotent through client_key.
--   Partner RSVP     "can't make it" offers Find a new time (opens, partner
--                    prefilled) instead of On my way; copy no longer points
--                    at a reschedule flow that doesn't exist.
--   Reminders        tagged, so send-push can tell them from RSVP notices.
--
-- Each trigger/RPC below is the production definition (2026-10-12) plus
-- these changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_drill.sql
-- ============================================================

-- ── Lock-screen replies land once ───────────────────────────────────────────
alter table public.drill_request_messages add column if not exists client_key text;
create unique index if not exists drill_request_messages_client_key_idx
  on public.drill_request_messages (client_key) where client_key is not null;

-- ── accept_drill_slot: accept one proposed time from the lock screen ────────
-- p_slot_index is 0-based in TIME order (date, then slot), the order the push
-- body numbers them in. p_slot is the slot the push showed; if the request's
-- times changed since, it refuses rather than accept a time the player never
-- saw. Replays: the same time already accepted returns 'already'.
create or replace function public.accept_drill_slot(p_request uuid, p_slot_index integer, p_slot jsonb default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_req  public.drill_requests%rowtype;
  v_pick jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.drill_requests where id = p_request for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.to_user_id <> v_uid then raise exception 'Only the invited player can respond'; end if;
  if public.blocked_between(v_req.from_user_id, v_req.to_user_id) then raise exception 'Request not found'; end if;

  if p_slot_index is null or p_slot_index < 0 then raise exception 'Pick a time in the app'; end if;
  select e.value into v_pick
    from jsonb_array_elements(coalesce(v_req.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
   where jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
   order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord
  offset p_slot_index
   limit 1;
  if v_pick is null then raise exception 'Pick a time in the app'; end if;

  if p_slot is not null
     and (v_pick ->> 'date' is distinct from p_slot ->> 'date'
          or (v_pick ->> 'slot')::int is distinct from (p_slot ->> 'slot')::int) then
    raise exception 'The proposed times changed. Pick a time in the app';
  end if;

  if v_req.status = 'accepted' then
    if v_req.accepted_slot ->> 'date' = v_pick ->> 'date'
       and (v_req.accepted_slot ->> 'slot')::int = (v_pick ->> 'slot')::int then
      return 'already';
    end if;
    raise exception 'Already accepted for another time';
  end if;
  if v_req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;

  if public._drill_slot_starts_at((v_pick ->> 'date')::date, (v_pick ->> 'slot')::int,
                                  public._pickleague_tz_for(v_req.from_user_id)) <= now() then
    raise exception 'That time has passed. Pick another time in the app';
  end if;

  -- The UPDATE fires create_drill_session_on_accept and notify_on_drill_response.
  update public.drill_requests
     set status = 'accepted', responded_at = now(), accepted_slot = v_pick
   where id = p_request;
  return 'accepted';
end $$;
revoke execute on function public.accept_drill_slot(uuid, integer, jsonb) from public, anon;
grant execute on function public.accept_drill_slot(uuid, integer, jsonb) to authenticated;

-- ── New drill request: the times in the body ────────────────────────────────
create or replace function public.notify_on_drill_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sender_name text;
  v_n           integer;
  v_list        text;
  v_first       text;
  v_body        text;
  v_msg         text := nullif(trim(coalesce(new.message, '')), '');
begin
  select full_name into v_sender_name from public.profiles where id = new.from_user_id;

  -- Numbered by time: the same order as the buttons (send-push) and as
  -- accept_drill_slot's index.
  select count(*),
         string_agg(s.n::text || ') ' || s.label, E'\n' order by s.n),
         min(s.label) filter (where s.n = 1)
    into v_n, v_list, v_first
    from (
      select row_number() over (order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord) as n,
             public._drill_slot_label((e.value ->> 'date')::date, (e.value ->> 'slot')::int) as label
        from jsonb_array_elements(coalesce(new.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
       where jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
    ) s;

  v_body := case
    when coalesce(v_n, 0) = 0 then 'Open Pickleague to see the proposed times.'
    when v_n = 1 then v_first
    when v_n <= 3 then 'Which time works?' || E'\n' || v_list
    else 'Pick a time in the app:' || E'\n' || v_list
  end;
  if v_msg is not null then
    v_body := v_body || E'\n' || '"' || left(v_msg, 80) || '"';
  end if;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    new.to_user_id,
    '🥒 ' || coalesce(v_sender_name, 'Someone') || ' wants to drill',
    v_body,
    'drill',
    new.id,
    'drill',
    false,
    jsonb_build_object('kind', 'drill_request')
  );
  return new;
end;
$function$;

-- ── Accepted / declined, to the requester ───────────────────────────────────
create or replace function public.notify_on_drill_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_responder_name text;
  v_title          text;
  v_body           text;
  v_when           text;
begin
  if old.status = 'pending' and new.status in ('accepted','declined') then
    select full_name into v_responder_name from public.profiles where id = new.to_user_id;
    if new.status = 'accepted' then
      v_when := public._drill_slot_label((new.accepted_slot ->> 'date')::date, (new.accepted_slot ->> 'slot')::int);
      v_title := '✅ ' || coalesce(v_responder_name, 'Your drill partner') || ' accepted!';
      v_body  := case when v_when is not null
                   then 'Drill session is on: ' || v_when || '. Open the chat to pick where to play.'
                   else 'Drill session is on. Tap to see the time.' end;
    else
      v_title := coalesce(v_responder_name, 'Your drill partner') || ' declined';
      v_body  := 'Maybe try another time or partner?';
    end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
    values (new.from_user_id, v_title, v_body, 'drill', new.id, 'drill', false,
            jsonb_build_object('kind', 'drill_response'));
  end if;
  return new;
end;
$function$;

-- ── Drill chat ──────────────────────────────────────────────────────────────
create or replace function public.notify_on_drill_chat()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_req        record;
  v_recipient  uuid;
  v_sender     text;
begin
  select * into v_req from public.drill_requests where id = new.request_id;
  if v_req.id is null then return new; end if;

  v_recipient := case when new.sender_id = v_req.from_user_id then v_req.to_user_id else v_req.from_user_id end;
  select full_name into v_sender from public.profiles where id = new.sender_id;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    v_recipient,
    '💬 ' || coalesce(v_sender, 'Someone') || ' replied',
    left(new.body, 120),
    'drill',
    new.request_id,
    'drill',
    false,
    -- kind = drill_chat: the 1.0.4 app opens the thread itself. The link stays
    -- drill/<request id>, so a 1.0.3 phone still opens the requests list.
    jsonb_build_object('kind', 'drill_chat')
  );
  return new;
exception when others then
  -- Notification failures shouldn't block the message itself.
  return new;
end;
$function$;

-- ── On my way / Can't make it, to the partner ───────────────────────────────
create or replace function public.rsvp_drill_session(p_session uuid, p_status text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_ses     public.drill_sessions%rowtype;
  v_partner uuid;
  v_prev    text;
  v_name    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_status not in ('on_my_way', 'cant_make_it') then raise exception 'Bad status'; end if;

  select * into v_ses from public.drill_sessions where id = p_session;
  if v_ses.id is null then raise exception 'Session not found'; end if;
  if v_uid not in (v_ses.player1_id, v_ses.player2_id) then
    raise exception 'Only the two players can answer';
  end if;
  v_partner := case when v_uid = v_ses.player1_id then v_ses.player2_id else v_ses.player1_id end;

  select status into v_prev from public.drill_session_rsvps
   where session_id = p_session and user_id = v_uid;
  if v_prev = p_status then return 'already'; end if;  -- replay: no second notice

  insert into public.drill_session_rsvps (session_id, user_id, status, updated_at)
  values (p_session, v_uid, p_status, now())
  on conflict (session_id, user_id) do update set status = excluded.status, updated_at = now();

  -- Tell the partner, once per change of answer.
  select full_name into v_name from public.profiles where id = v_uid;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, push_data)
  values (
    v_partner,
    case p_status when 'on_my_way' then '🥒 ' || coalesce(v_name, 'Your partner') || ' is on the way'
                  else '🥒 ' || coalesce(v_name, 'Your partner') || ' can''t make it' end,
    case p_status when 'on_my_way' then 'Your drill session is still on.'
                  else 'They can''t make your drill session. Find a new time with them.' end,
    'drill', p_session, 'drill',
    jsonb_build_object('kind', 'drill_rsvp', 'rsvp_status', p_status)
  );
  return p_status;
end $function$;

-- ── 24 h / 2 h reminders ────────────────────────────────────────────────────
create or replace function public.remind_drill_sessions()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with windows as (
      select * from (values
        ('drill_session_24h', interval '2 hours', interval '24 hours'),
        ('drill_session_2h',  interval '0 hours', interval '2 hours')
      ) as w(kind, lo, hi)
    ),
    due as (
      select w.kind, ds.id, u.user_id
      from public.drill_sessions ds
      cross join lateral (values (ds.player1_id), (ds.player2_id)) as u(user_id)
      cross join windows w
      where ds.starts_at is not null
        and ds.starts_at >  now() + w.lo
        and ds.starts_at <= now() + w.hi
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select
      entity_id,
      user_id,
      case kind when 'drill_session_2h' then 'in about 2 hours'
                else 'in the next 24 hours' end as label
    from fresh
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🥒 Drill session coming up',
      'You have a drill session ' || r.label || '. Tap to view details.',
      'drill', r.entity_id, 'drill', null,
      jsonb_build_object('kind', 'drill_session_reminder')
    );
  end loop;
exception when others then null;
end $function$;


-- ============================================================================
-- FILE: migration_push_actions_match_tournament.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Match, tournament and league-invite pushes (push actions, 2026-10-11
-- audit). Needs migration_push_data.sql first. Idempotent.
--
--   Match confirm        the score is in the body (Confirm settles it and
--                        moves ratings; it now also needs unlock)
--   Tournament invite    the entry fee is in the body when there is one
--                        (Accept charges it and needs unlock; Decline added)
--   New tournament /     tagged so send-push can offer Request to join to
--   registration closing someone eligible; the fee is in the body
--   League invite code   push_data carries the code: a Join button, and a tap
--                        that joins (the same auto-redeem as the in-app list)
--   Deleted tournament / league refunds
--                        open the Shop (your balance) instead of a page that
--                        no longer exists
--
-- Each function below is the production definition (2026-10-12) plus these
-- changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_match_tournament.sql
-- ============================================================

-- ── Match confirm: the score in the body ────────────────────────────────────
create or replace function public._notify_pending_match()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_recipient uuid;
  v_entering  text;
  v_league    text;
  v_others    uuid[];
  v_mine      integer;
  v_theirs    integer;
  v_score     text;
begin
  if new.status <> 'pending' then return new; end if;

  select full_name into v_entering from public.profiles
    where id = coalesce(new.team1_confirmed_by, new.team2_confirmed_by, new.player1_id);
  select name into v_league from public.leagues where id = new.league_id;

  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;

    -- The score from this recipient's side: Confirm settles exactly this.
    if v_recipient in (new.player1_id, new.partner1_id) then
      v_mine := new.player1_score; v_theirs := new.player2_score;
    else
      v_mine := new.player2_score; v_theirs := new.player1_score;
    end if;
    v_score := case
      when v_mine is null or v_theirs is null then 'no score entered'
      when v_mine > v_theirs then format('you won %s-%s', v_mine, v_theirs)
      when v_mine < v_theirs then format('you lost %s-%s', v_mine, v_theirs)
      else format('a %s-%s tie', v_mine, v_theirs)
    end;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, category)
    values (
      v_recipient,
      '🥒 Match needs your team to confirm',
      format('%s entered a match in %s: %s. Confirm within an hour if that''s right.',
             coalesce(v_entering, 'A player'), coalesce(v_league, 'a league'), v_score),
      'match', new.id, 'match', false,
      'notifyMatchConfirms'
    );
  end loop;

  return new;
exception when others then
  return new;
end;
$function$;

-- ── Tournament invite: the entry fee in the body ────────────────────────────
create or replace function public.tournament_invite_player(p_tournament_id uuid, p_user_id uuid)
returns table(success boolean, message text, invite_token text)
language plpgsql
security definer
as $function$
declare
  v_uid             uuid := auth.uid();
  v_tournament_name text;
  v_inviter_name    text;
  v_is_admin        boolean;
  v_existing_status text;
  v_code_id         uuid;
  v_code_token      text;
  v_ante            integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then
    return query select false, 'Pick a player'::text, null::text; return;
  end if;
  if p_user_id = v_uid then
    return query select false, 'You can''t invite yourself'::text, null::text; return;
  end if;

  -- Caller authority check (creator, tournament admin/co-admin, or league admin).
  select t.name, coalesce(t.pickle_ante, 0), exists (
    select 1 from public.tournaments tt
    where tt.id = p_tournament_id
      and (
        tt.created_by = v_uid
        or exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = tt.id and tr.user_id = v_uid
            and tr.role in ('admin','co-admin') and tr.status = 'approved'
        )
        or (tt.league_id is not null and exists (
          select 1 from public.league_members
          where league_id = tt.league_id and user_id = v_uid and role in ('admin','co-admin')
        ))
      )
  )
  into v_tournament_name, v_ante, v_is_admin
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_tournament_name is null then
    return query select false, 'Tournament not found'::text, null::text; return;
  end if;
  if not v_is_admin then
    return query select false, 'Only tournament admins can invite'::text, null::text; return;
  end if;

  select full_name into v_inviter_name from public.profiles where id = v_uid;

  insert into public.invite_codes
    (scope_type, scope_id, created_by, max_uses, expires_at, pickle_subsidy)
  values
    ('tournament', p_tournament_id, v_uid, 1, now() + interval '7 days', 0)
  returning id, token into v_code_id, v_code_token;

  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already in this tournament'::text, null::text; return;
  elsif v_existing_status = 'pending' then
    update public.tournament_registrations
       set invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    insert into public.tournament_registrations
      (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
    values (p_tournament_id, p_user_id, 'pending', v_uid, v_code_id);
  else
    update public.tournament_registrations
       set status                  = 'pending',
           invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  -- The fee is charged when the invite is accepted (also from the lock
  -- screen), so say it before they press anything.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    format('🎟️ Tournament invite: %s', v_tournament_name),
    format(
      '%s invited you to "%s".%s Tap to accept or decline, or use invite code %s if you''d rather join by code.',
      coalesce(v_inviter_name, 'A tournament admin'),
      v_tournament_name,
      case when v_ante > 0 then format(' Entry fee: %s 🥒, charged when you accept.', v_ante) else '' end,
      v_code_token
    ),
    'tournament',
    p_tournament_id,
    'tournament'
  );

  return query select true, 'Invited'::text, v_code_token;
end;
$function$;

-- ── Invite-code broadcast: league codes ride in push_data; tournament fee ───
create or replace function public.send_invite_code_to_users(p_code_id uuid, p_user_ids uuid[])
returns table(success boolean, sent integer, skipped integer, message text)
language plpgsql
security definer
as $function$
declare
  v_uid          uuid := auth.uid();
  v_code         public.invite_codes%rowtype;
  v_inviter      text;
  v_scope_name   text;
  v_scope_label  text;   -- "league" / "tournament"
  v_sent         integer := 0;
  v_skipped      integer := 0;
  v_user_id      uuid;
  v_existing     text;
  v_fee          integer := 0;
  v_fee_text     text := '';
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, 0, 0, 'Pick at least one player'::text; return;
  end if;

  select * into v_code from public.invite_codes where id = p_code_id;
  if v_code.id is null then
    return query select false, 0, 0, 'Code not found'::text; return;
  end if;
  if not v_code.is_active then
    return query select false, 0, 0, 'This code has been revoked'::text; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 0, 0, 'This code has expired'::text; return;
  end if;
  if not public.is_scope_admin(v_code.scope_type, v_code.scope_id) then
    return query select false, 0, 0, 'Only scope admins can broadcast invites'::text; return;
  end if;

  v_scope_label := v_code.scope_type;
  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
  elsif v_code.scope_type = 'tournament' then
    select name, greatest(coalesce(pickle_ante, 0) - least(coalesce(v_code.pickle_subsidy, 0), coalesce(pickle_ante, 0)), 0)
      into v_scope_name, v_fee
      from public.tournaments where id = v_code.scope_id;
    if v_fee > 0 then
      v_fee_text := format(' Entry fee: %s 🥒, charged when you accept.', v_fee);
    end if;
  end if;
  if v_scope_name is null then
    return query select false, 0, 0, 'Scope not found'::text; return;
  end if;

  select full_name into v_inviter from public.profiles where id = v_uid;

  foreach v_user_id in array p_user_ids loop
    begin
      if v_user_id is null or v_user_id = v_uid then
        v_skipped := v_skipped + 1; continue;
      end if;
      if not exists (select 1 from public.profiles where id = v_user_id) then
        v_skipped := v_skipped + 1; continue;
      end if;

      if v_code.scope_type = 'league' then
        if exists (
          select 1 from public.league_members
          where league_id = v_code.scope_id and user_id = v_user_id
        ) then
          v_skipped := v_skipped + 1; continue;
        end if;
      elsif v_code.scope_type = 'tournament' then
        select status into v_existing
          from public.tournament_registrations
          where tournament_id = v_code.scope_id and user_id = v_user_id;
        if v_existing = 'approved' then
          v_skipped := v_skipped + 1; continue;
        end if;

        if v_existing is null then
          insert into public.tournament_registrations
            (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
          values
            (v_code.scope_id, v_user_id, 'pending', v_uid, v_code.id);
        else
          update public.tournament_registrations
             set status                  = 'pending',
                 invited_by              = v_uid,
                 redeemed_invite_code_id = v_code.id
           where tournament_id = v_code.scope_id and user_id = v_user_id;
        end if;
      end if;

      -- Body keeps the human-readable token (and the in-app list still reads
      -- it from there). A league code also rides in push_data, so the push's
      -- Join button and tap can redeem it.
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, push_data)
      values (
        v_user_id,
        format('🎟️ Invite: %s', v_scope_name),
        format(
          '%s invited you to the %s "%s".%s Tap to open it, or use invite code %s to join.',
          coalesce(v_inviter, 'An admin'),
          v_scope_label,
          v_scope_name,
          v_fee_text,
          v_code.token
        ),
        v_scope_label,
        v_code.scope_id,
        v_scope_label,
        case when v_code.scope_type = 'league'
          then jsonb_build_object('kind', 'league_invite', 'invite_code', v_code.token)
          else jsonb_build_object('kind', 'tournament_invite')
        end
      );

      v_sent := v_sent + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select true, v_sent, v_skipped,
    case when v_sent = 0 then 'No invites sent — everyone you picked is already in.'
         else format('Sent %s invite%s%s.',
              v_sent,
              case when v_sent = 1 then '' else 's' end,
              case when v_skipped > 0 then format(' (%s skipped)', v_skipped) else '' end)
    end::text;
end;
$function$;

-- ── New tournament: tagged for Request to join; the fee in the body ─────────
create or replace function public.notify_new_tournament()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r     record;
  v_fee text := case when coalesce(new.pickle_ante, 0) > 0
                  then format(' Entry fee: %s 🥒, charged only if you''re approved.', new.pickle_ante)
                  else '' end;
begin
  if new.league_id is null then
    return new;  -- standalone tournament, no league audience
  end if;

  for r in
    select u.user_id, bool_or(u.is_member) as is_member
    from (
      select lm.user_id, true as is_member
      from public.league_members lm
      where lm.league_id = new.league_id
      union all
      select b.user_id, false
      from public.bookmarks b
      where b.target_type = 'league' and b.target_id = new.league_id
    ) u
    where new.created_by is null or u.user_id <> new.created_by
    group by u.user_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🏆 New tournament: ' || new.name,
      case when r.is_member
        then 'A new tournament just opened in your league. Tap to register.'
        else 'A new tournament just opened in a league you bookmarked. Tap to check it out.'
      end || v_fee,
      'tournament', new.id, 'tournament', 'notifyTournamentUpdates',
      jsonb_build_object('kind', 'new_tournament')
    );
  end loop;
  return new;
exception when others then
  -- Never let a notification failure roll back the tournament creation.
  return new;
end $function$;

-- ── Registration closing: tagged; the fee in the body ───────────────────────
create or replace function public.remind_tournament_registration_closings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r     record;
  v_fee integer;
begin
  for r in
    with due as (
      -- Unregistered league members (request-mode tournaments only)
      select t.id as tournament_id, lm.user_id, false as is_invitee
      from public.tournaments t
      join public.league_members lm on lm.league_id = t.league_id
      where t.status = 'registration'
        and t.registration_mode = 'request'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
        and not exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = t.id and tr.user_id = lm.user_id
        )
      union all
      -- Pending invitees who haven't accepted yet (any mode)
      select t.id, tr.user_id, true
      from public.tournaments t
      join public.tournament_registrations tr
        on tr.tournament_id = t.id
       and tr.status = 'pending'
       and tr.invited_by is not null
      where t.status = 'registration'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'registration_closing', tournament_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as tournament_id, t.name, coalesce(t.pickle_ante, 0) as ante,
           bool_or(d.is_invitee) as is_invitee
    from fresh f
    join public.tournaments t on t.id = f.entity_id
    join due d on d.tournament_id = f.entity_id and d.user_id = f.user_id
    group by f.user_id, f.entity_id, t.name, t.pickle_ante
  loop
    -- What this player would pay: an invite code's subsidy comes off the ante.
    v_fee := r.ante;
    if r.is_invitee and r.ante > 0 then
      select greatest(r.ante - least(coalesce(ic.pickle_subsidy, 0), r.ante), 0)
        into v_fee
        from public.tournament_registrations tr
        left join public.invite_codes ic on ic.id = tr.redeemed_invite_code_id
       where tr.tournament_id = r.tournament_id and tr.user_id = r.user_id;
      v_fee := coalesce(v_fee, r.ante);
    end if;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '⏳ Registration closing soon: ' || r.name,
      case when r.is_invitee
        then 'You have a pending invite and registration closes within 6 hours. Tap to respond.'
             || case when v_fee > 0 then format(' Entry fee: %s 🥒, charged when you accept.', v_fee) else '' end
        else 'Registration closes within 6 hours. Tap to request your spot.'
             || case when v_fee > 0 then format(' Entry fee: %s 🥒, charged only if you''re approved.', v_fee) else '' end
      end,
      'tournament', r.tournament_id, 'tournament', 'notifyTournamentUpdates',
      jsonb_build_object('kind', 'registration_closing')
    );
  end loop;
exception when others then null;
end $function$;

-- ── Refunds for a deleted tournament / league open the Shop ─────────────────
-- The refund notifications are written during the delete (by the shared
-- _refund_tournament_pot, inline inserts, and cascade triggers), pointing at a
-- tournament or league that is gone by commit. Called at the END of the
-- delete: every notification written in this transaction (created_at =
-- now(), the transaction's start time) whose tournament / league no longer
-- exists, and its still-pending push, is repointed at the Shop (the balance
-- the refund landed in). cancel_tournament is untouched: that tournament still
-- exists, and its page is the right landing.
create or replace function public._repoint_deleted_scope_pushes()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notifications n
     set entity_type = 'shop', entity_id = null
   where n.created_at = now()
     and ((n.entity_type = 'tournament' and not exists (select 1 from public.tournaments t where t.id = n.entity_id))
       or (n.entity_type = 'league'     and not exists (select 1 from public.leagues l     where l.id = n.entity_id)));

  update public.push_outbox o
     set entity_type = 'shop', entity_id = null, deep_link = 'shop/-'
   where o.created_at = now()
     and o.status = 'pending'
     and ((o.entity_type = 'tournament' and not exists (select 1 from public.tournaments t where t.id = o.entity_id))
       or (o.entity_type = 'league'     and not exists (select 1 from public.leagues l     where l.id = o.entity_id)));
end $$;
revoke all on function public._repoint_deleted_scope_pushes() from public, anon, authenticated;

create or replace function public.godmode_delete_tournament(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_t   record;
  v_w   record;
begin
  if not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select name, champion_payout_applied_at into v_t from public.tournaments where id = p_tournament_id;
  if v_t.name is null then return; end if;

  -- Pot contributions come back unless the pot was already distributed.
  if v_t.champion_payout_applied_at is null then
    perform public._refund_tournament_pot(p_tournament_id);
  end if;

  for v_w in
    select w.id, w.user_id, w.stake
      from public.wagers w
     where w.subject_type = 'tournament_rank'
       and w.subject_id = p_tournament_id
       and w.status = 'open'
  loop
    update public.wagers
       set status = 'cancelled', settled_at = now(),
           notes = coalesce(notes || ' · ', '') || 'refunded: tournament deleted'
     where id = v_w.id;
    update public.profiles set pickles = pickles + v_w.stake where id = v_w.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_w.user_id,
      '🎲 Wager refunded',
      format('"%s" was deleted — your %s 🥒 stake was returned.', v_t.name, v_w.stake),
      'wager', v_w.id, 'wager'
    );
  end loop;

  delete from public.tournaments where id = p_tournament_id;

  -- Refund pushes would open a tournament that no longer exists.
  perform public._repoint_deleted_scope_pushes();
end;
$function$;

create or replace function public.godmode_delete_league(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name text;
  v_user record;
  v_w    record;
begin
  if not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select name into v_name from public.leagues where id = p_league_id;
  if v_name is null then return; end if;

  for v_user in
    select c.user_id, sum(c.amount_paid)::int as paid
      from public.pickle_pot_contributions c
     where c.refunded_at is null
       and (
         (c.scope_type = 'league' and c.scope_id = p_league_id)
         or (c.scope_type = 'season' and c.scope_id in
              (select s.id from public.league_seasons s where s.league_id = p_league_id))
       )
     group by c.user_id
  loop
    update public.profiles set pickles = pickles + v_user.paid where id = v_user.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_user.user_id, '🥒 Pot refunded',
            format('%s 🥒 you put into "%s" (or its seasons) was returned.', v_user.paid, v_name),
            'league', p_league_id, 'league');
  end loop;
  update public.pickle_pot_contributions c set refunded_at = now()
   where c.refunded_at is null
     and (
       (c.scope_type = 'league' and c.scope_id = p_league_id)
       or (c.scope_type = 'season' and c.scope_id in
            (select s.id from public.league_seasons s where s.league_id = p_league_id))
     );

  for v_w in
    select w.id, w.user_id, w.stake
      from public.wagers w
     where w.subject_type = 'period_rank'
       and w.status = 'open'
       and w.subject_id in (select s.id from public.league_seasons s where s.league_id = p_league_id)
  loop
    update public.wagers
       set status = 'cancelled', settled_at = now(),
           notes = coalesce(notes || ' · ', '') || 'refunded: league deleted'
     where id = v_w.id;
    update public.profiles set pickles = pickles + v_w.stake where id = v_w.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_w.user_id, '🎲 Wager refunded',
            format('"%s" was deleted — your %s 🥒 stake was returned.', v_name, v_w.stake),
            'wager', v_w.id, 'wager');
  end loop;

  delete from public.leagues where id = p_league_id;

  -- Refund pushes (this league's, and any tournament removed with it) would
  -- open a page that no longer exists.
  perform public._repoint_deleted_scope_pushes();
end;
$function$;


-- ============================================================================
-- FILE: migration_league_join_request_push.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- League join request -> a push to the league's admins (push actions,
-- 2026-10-11 audit). Needs migration_push_data.sql first. Idempotent.
--
-- LeagueDetail has long told players "the admins have been notified" after
-- Request to join, but nothing was sent. Now every admin / co-admin gets a
-- push; the tap opens the league's members screen (the 1.0.4 app reads
-- push_data.kind; the link stays league/<id>, so 1.0.3 opens the league),
-- where requests are approved (an approval means sending an invite code, so there is no
-- one-tap Approve, on purpose).
--
-- Fires on a new pending request, and when a request goes back to pending.
-- At most one push per admin, league and requester per hour, so a
-- request / cancel / request loop can't spam the admins.
--
-- Apply:  supabase db query --linked -f supabase/migration_league_join_request_push.sql
-- ============================================================

create or replace function public.notify_league_join_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league text;
  v_name   text;
  r        record;
begin
  if new.status is distinct from 'pending' then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'pending' then return new; end if;

  select name into v_league from public.leagues where id = new.league_id;
  if v_league is null then return new; end if;
  select full_name into v_name from public.profiles where id = new.user_id;

  for r in
    select lm.user_id
      from public.league_members lm
     where lm.league_id = new.league_id
       and lm.role in ('admin', 'co-admin')
       and lm.user_id <> new.user_id
       and not exists (
         select 1 from public.notifications n
          where n.user_id = lm.user_id
            and n.entity_type = 'league'
            and n.entity_id = new.league_id
            and n.push_data ->> 'kind' = 'league_join_request'
            and n.push_data ->> 'requester_id' = new.user_id::text
            and n.created_at > now() - interval '1 hour'
       )
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🙋 Join request: ' || v_league,
      coalesce(v_name, 'A player') || ' asked to join. Tap to review requests.',
      'league', new.league_id, 'league', 'notifyLeagueUpdates',
      jsonb_build_object(
        'kind', 'league_join_request',
        'requester_id', new.user_id
      )
    );
  end loop;
  return new;
exception when others then
  -- A notification problem must never block the request itself.
  return new;
end $$;
revoke all on function public.notify_league_join_request() from public, anon, authenticated;

drop trigger if exists trg_notify_league_join_request on public.league_join_requests;
create trigger trg_notify_league_join_request
  after insert or update of status on public.league_join_requests
  for each row execute function public.notify_league_join_request();



-- ============================================================================
-- FILE: migration_event_vote_buttons.sql  (push actions, 1.0.4)
-- ============================================================================

-- ============================================================
-- Lock-screen time voting on league events (push actions, 1.0.4).
-- Needs migration_push_data.sql, migration_time_zones.sql and
-- migration_push_actions_events.sql first (this file replaces two of that
-- file's functions: notify_new_event_vote and remind_vote_closings).
-- Idempotent: create or replace / drop if exists only.
--
-- What changes:
--   1. "New vote" fires AFTER the event's times exist. It used to fire on the
--      league_events insert, before CreateEvent inserts the slots in a second
--      call, so the push could not list the times. Now a statement-level
--      trigger on event_slots sends it once per member (reminder_log
--      'event_vote_opened' dedupes the CreateEvent retry path), only while the
--      event is voting (seed scripts insert slots for scheduled events).
--   2. "New vote" and "Vote closing soon" bodies list the times, numbered by
--      start time (order by starts_at, id), in the RECIPIENT's time zone
--      (_pickleague_tz_for, America/Los_Angeles fallback). With 2 or 3 times
--      push_data carries option_ids + option_labels, and send-push attaches the
--      numbered button set (event_vote_pick2 / event_vote_pick3). 4+ times keep
--      Can't make it only; the tap opens the event.
--   3. vote_event_slots(p_event_id, p_slot_ids): the one write behind the
--      buttons. A plain insert is not enough: the event_slot_votes RLS checks
--      only the user id, so a stale push could add votes after voting closed.
--
-- Old (1.0.3) phones: the bodies read fine without buttons ("tap to open"
-- also works there); the new categories are unknown to them and show nothing.
--
-- Apply:  supabase db query --linked -f supabase/migration_event_vote_buttons.sql
-- ============================================================

-- ── The event's times, in button order, labelled in one zone ───────────────
-- { count, ids: [uuid text], labels: ["Sat Oct 18, 9 AM", ...], list: "1) ...\n2) ..." }
create or replace function public._event_vote_options(p_event_id uuid, p_tz text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'count',  count(*),
    'ids',    coalesce(jsonb_agg(s.id::text order by s.starts_at, s.id), '[]'::jsonb),
    'labels', coalesce(jsonb_agg(public._pickleague_local_label(s.starts_at, p_tz) order by s.starts_at, s.id), '[]'::jsonb),
    'list',   public._pickleague_option_list(array_agg(s.starts_at order by s.starts_at, s.id), p_tz)
  )
  from public.event_slots s
  where s.event_id = p_event_id;
$$;
revoke all on function public._event_vote_options(uuid, text) from public, anon, authenticated;

-- Body = lead line + numbered times + how to answer. 2 or 3 times get buttons.
create or replace function public._event_vote_body(p_lead text, p_opts jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce((p_opts ->> 'count')::int, 0) = 0 then p_lead || ' Tap to vote.'
    when (p_opts ->> 'count')::int between 2 and 3
      then p_lead || E'\n' || (p_opts ->> 'list') || E'\nPress and hold to vote, or tap to open.'
    else p_lead || E'\n' || (p_opts ->> 'list') || E'\nTap to vote.'
  end;
$$;
revoke all on function public._event_vote_body(text, jsonb) from public, anon, authenticated;

-- push_data for an event vote push: kind + league, plus the options when the
-- push gets numbered buttons (send-push re-checks them against the event).
create or replace function public._event_vote_push_data(p_kind text, p_league_id uuid, p_opts jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('kind', p_kind, 'league_id', p_league_id)
      || case when coalesce((p_opts ->> 'count')::int, 0) between 2 and 3
              then jsonb_build_object('option_ids', p_opts -> 'ids', 'option_labels', p_opts -> 'labels')
              else '{}'::jsonb end;
$$;
revoke all on function public._event_vote_push_data(text, uuid, jsonb) from public, anon, authenticated;

-- ── New vote: after the slots exist ────────────────────────────────────────
-- The old row trigger on league_events goes; its function becomes a no-op so
-- re-running migration_notification_generators.sql (which recreates that
-- trigger) can never send a second, time-less push. Re-running
-- migration_push_actions_events.sql restores a sending body but not the
-- trigger, so it is harmless too; this file runs after it in every script.
drop trigger if exists trg_notify_new_event_vote on public.league_events;

create or replace function public.notify_new_event_vote()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Superseded by notify_event_vote_opened (on event_slots). Kept as a no-op.
  return new;
end $function$;

create or replace function public.notify_event_vote_opened()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r      record;
  v_opts jsonb;
begin
  for r in
    with evs as (
      select distinct n.event_id from new_slots n
    ),
    due as (
      select distinct le.id as event_id, le.league_id, le.title, lm.user_id
      from evs
      join public.league_events le  on le.id = evs.event_id
      join public.league_members lm on lm.league_id = le.league_id
      where le.status = 'voting'
        and (le.vote_ends_at is null or le.vote_ends_at > now())
        and (le.created_by is null or lm.user_id <> le.created_by)
        and (lm.expires_at is null or lm.expires_at > now())
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'event_vote_opened', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as event_id, d.league_id, d.title
    from fresh f
    join due d on d.event_id = f.entity_id and d.user_id = f.user_id
  loop
    v_opts := public._event_vote_options(r.event_id, public._pickleague_tz_for(r.user_id));
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🗳️ New vote: ' || r.title,
      public._event_vote_body('Which times work for you?', v_opts),
      'league', r.event_id, 'event', 'notifyLeagueUpdates',
      public._event_vote_push_data('event_vote_opened', r.league_id, v_opts)
    );
  end loop;
  return null;
exception when others then
  -- Never block the slot insert: a lost announcement beats a vote with no times.
  raise warning 'notify_event_vote_opened failed: %', sqlerrm;
  return null;
end $function$;
revoke all on function public.notify_event_vote_opened() from public, anon, authenticated;

drop trigger if exists trg_notify_event_vote_opened on public.event_slots;
create trigger trg_notify_event_vote_opened
  after insert on public.event_slots
  referencing new table as new_slots
  for each statement execute function public.notify_event_vote_opened();

-- ── Vote closing soon: list the times too ──────────────────────────────────
-- Same recipients as migration_push_actions_events.sql (no voters, no
-- decliners, not the organizer); only the body and push_data change.
create or replace function public.remind_vote_closings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r      record;
  v_opts jsonb;
begin
  for r in
    with due as (
      select le.id as event_id, le.league_id, le.title, lm.user_id
      from public.league_events le
      join public.league_members lm on lm.league_id = le.league_id
      where le.status = 'voting'
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '6 hours'
        -- The organizer gets the organizer nudge (Text group / Close vote).
        and (le.created_by is null or lm.user_id <> le.created_by)
        and not exists (
          select 1
          from public.event_slot_votes v
          join public.event_slots s on s.id = v.slot_id
          where s.event_id = le.id and v.user_id = lm.user_id
        )
        -- "Can't make it" is an answer: don't tell them they haven't voted.
        and not exists (
          select 1 from public.event_declines d
          where d.event_id = le.id and d.user_id = lm.user_id
        )
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'vote_closing', event_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as event_id, le.league_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    v_opts := public._event_vote_options(r.event_id, public._pickleague_tz_for(r.user_id));
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🗳️ Vote closing soon: ' || r.title,
      public._event_vote_body('Voting closes within 6 hours and you haven''t voted yet. Which times work?', v_opts),
      'league', r.event_id, 'event', 'notifyEventReminders',
      public._event_vote_push_data('event_vote_closing', r.league_id, v_opts)
    );
  end loop;
exception when others then null;
end $function$;

-- ── The vote write behind the buttons ──────────────────────────────────────
-- Approves each slot in p_slot_ids for the caller. Returns 'voted' when at
-- least one vote was added, 'already' when every one was already counted (a
-- replayed press: delivery is at-least-once). A replay still says 'already'
-- after voting closes. Raises, with copy the app maps, for: not signed in,
-- unknown event, slots not in this event ("Pick a time"), an ended guest
-- pass, not a league member, voting closed.
-- The event_vote_clears_decline trigger still clears an earlier decline.
create or replace function public.vote_event_slots(p_event_id uuid, p_slot_ids uuid[])
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ev  record;
  v_ids uuid[];
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  select le.id, le.league_id, le.status, le.vote_ends_at
    into v_ev
    from public.league_events le
   where le.id = p_event_id;
  if not found then
    raise exception 'Event not found';
  end if;

  select array_agg(distinct x) into v_ids from unnest(p_slot_ids) as x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 or cardinality(v_ids) > 10 then
    raise exception 'Pick a time';
  end if;
  if exists (
    select 1 from unnest(v_ids) as x
    where not exists (select 1 from public.event_slots s where s.id = x and s.event_id = p_event_id)
  ) then
    raise exception 'Pick a time: the times changed';
  end if;

  -- A replay of a press that already landed.
  if not exists (
    select 1 from unnest(v_ids) as x
    where not exists (select 1 from public.event_slot_votes v where v.slot_id = x and v.user_id = v_uid)
  ) then
    return 'already';
  end if;

  if public.is_expired_guest(v_uid) then
    raise exception 'Your guest pass has ended';
  end if;
  if not exists (
    select 1 from public.league_members lm
    where lm.league_id = v_ev.league_id
      and lm.user_id = v_uid
      and (lm.expires_at is null or lm.expires_at > now())
  ) then
    raise exception 'Not a member of this league';
  end if;
  if v_ev.status <> 'voting' or (v_ev.vote_ends_at is not null and v_ev.vote_ends_at <= now()) then
    raise exception 'Voting has closed';
  end if;

  insert into public.event_slot_votes (slot_id, user_id)
  select x, v_uid from unnest(v_ids) as x
  on conflict (slot_id, user_id) do nothing;
  get diagnostics v_n = row_count;

  return case when v_n > 0 then 'voted' else 'already' end;
end $$;
revoke execute on function public.vote_event_slots(uuid, uuid[]) from public, anon;
grant execute on function public.vote_event_slots(uuid, uuid[]) to authenticated;


-- ============================================================================
--  PUSH SHARED SECRET — generates a strong secret, stores it DB-side, and PRINTS
--  it. Copy the printed value into the send-push function's PUSH_SHARED_SECRET
--  secret (step 2 above). The two must match for push delivery to work.
-- ============================================================================
update private.app_config
   set value = encode(gen_random_bytes(32), 'hex')
 where key = 'send_push_secret'
returning value as copy_this_into_push_shared_secret;
