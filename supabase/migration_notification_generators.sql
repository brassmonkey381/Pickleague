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
