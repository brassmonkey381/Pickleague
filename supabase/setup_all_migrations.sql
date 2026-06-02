-- ============================================================================
--  Pickleague — combined push + guest migrations
--  Paste this ENTIRE file into Supabase ▸ SQL Editor ▸ new query ▸ Run.
--
--  It runs all 4 migrations in dependency order. Safe to re-run (every statement
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
--  PUSH SHARED SECRET — generates a strong secret, stores it DB-side, and PRINTS
--  it. Copy the printed value into the send-push function's PUSH_SHARED_SECRET
--  secret (step 2 above). The two must match for push delivery to work.
-- ============================================================================
update private.app_config
   set value = encode(gen_random_bytes(32), 'hex')
 where key = 'send_push_secret'
returning value as copy_this_into_push_shared_secret;
