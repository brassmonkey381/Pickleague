-- Smarter league-event reminders. Builds on migration_notification_generators.sql.
--
-- Changes:
--   1. remind_event_starts() now fires TWICE (like drill sessions):
--        • 'event_start'      — once, 2–24h before start  ("in the next 24 hours")
--        • 'event_start_soon' — once, 0–2h before start    ("in about 2 hours")
--      The two windows are disjoint so a given (event,user) matches at most one
--      per cron tick; distinct ledger kinds make each fire exactly once.
--   2. NEW remind_event_record_results() — nudges confirmed attendees to record
--      results 3–24h after the event started, but only while NO match has been
--      logged against the event yet. Pairs with the 24h "live/open" window the
--      app shows on the event card.
--   3. Event reminders now carry entity_type='event' (entity_id = event id), so
--      tapping the push/notification deep-links straight to the EventDetail page
--      (confirmed time + "Record a match" button) instead of the league.
--      `type` stays 'league' for the coarse push fallback; the precise gate is
--      still category='notifyEventReminders'.
--   4. run_notification_reminders() dispatcher calls the new function.
--
-- Idempotent: re-running replaces the functions and re-points the cron job's
-- target function (the schedule itself is unchanged).

-- ── Upcoming scheduled league events — 24h AND ~2h reminders ───────────────
create or replace function public.remind_event_starts()
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
      le.title,
      case f.kind when 'event_start_soon' then 'in about 2 hours'
                  else 'in the next 24 hours' end as label
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '📅 Event reminder: ' || r.title,
      'Your league event is coming up ' || r.label || '. Tap to view details.',
      'league', r.event_id, 'event', 'notifyEventReminders'
    );
  end loop;
exception when others then null;
end $$;

-- ── Post-start "record your results" nudge ─────────────────────────────────
-- Confirmed attendees, 3–24h after the start, while the event still has zero
-- recorded matches. reminder_log + the zero-match guard keep it to one nudge.
create or replace function public.remind_event_record_results()
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
    select f.user_id, f.entity_id as event_id, le.title
    from fresh f
    join public.league_events le on le.id = f.entity_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '📝 How did it go? Record your results',
      'Your event "' || r.title || '" has started — record your match results so ratings update.',
      'league', r.event_id, 'event', 'notifyEventReminders'
    );
  end loop;
exception when others then null;
end $$;

-- ── Dispatcher (adds the new record-results pass) ──────────────────────────
create or replace function public.run_notification_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.remind_drill_sessions();
  perform public.remind_event_starts();
  perform public.remind_event_record_results();
  perform public.remind_tournament_starts();
  perform public.remind_vote_closings();
end $$;
