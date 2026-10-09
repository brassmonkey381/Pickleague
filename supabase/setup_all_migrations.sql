-- ============================================================================
--  Pickleague — combined push + guest migrations
--  Paste this ENTIRE file into Supabase ▸ SQL Editor ▸ new query ▸ Run.
--
--  It runs all 5 migrations in dependency order. Safe to re-run (every statement
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
--  PUSH SHARED SECRET — generates a strong secret, stores it DB-side, and PRINTS
--  it. Copy the printed value into the send-push function's PUSH_SHARED_SECRET
--  secret (step 2 above). The two must match for push delivery to work.
-- ============================================================================
update private.app_config
   set value = encode(gen_random_bytes(32), 'hex')
 where key = 'send_push_secret'
returning value as copy_this_into_push_shared_secret;
