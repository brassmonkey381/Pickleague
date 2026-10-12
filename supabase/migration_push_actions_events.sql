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
