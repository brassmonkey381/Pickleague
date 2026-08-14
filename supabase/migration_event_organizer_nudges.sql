-- ============================================================
-- Prompt the ORGANISER to text their group at the moments that convert.
--
-- The app cannot send these texts. expo-sms (and the WhatsApp deep link) open
-- a composer from the user's own number and the user taps send — which is also
-- why they work: a text from a friend converts far better than one from a
-- shortcode. Auto-sending would mean Twilio + A2P 10DLC registration, TCPA
-- consent and STOP handling, and messages arriving from a business number.
--
-- So the server's job is timing, not delivery: notify the organiser when a
-- nudge is worth sending, deep-link them to the event, and let the client hand
-- them a finished message (mobile/src/lib/eventNudge.ts).
--
-- Aimed only at le.created_by — the person who actually has the group thread.
-- Three per event over its whole life, so this is not a notification firehose.
-- ============================================================

create or replace function public.remind_event_organizer_nudges()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with due as (
      -- Voting closes soon. Windowed rather than exact-time because the job
      -- runs hourly; reminder_log makes it fire once regardless.
      select le.id            as event_id,
             le.created_by    as user_id,
             'event_nudge_vote'::text as kind,
             le.title         as title
      from public.league_events le
      where le.status = 'voting'
        and le.created_by is not null
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '2 hours'
        and exists (select 1 from public.event_slots s where s.event_id = le.id)

      union all

      -- Confirmed and happening tomorrow. The lower bound keeps this from
      -- overlapping the day-of nudge below.
      select le.id, le.created_by, 'event_nudge_tomorrow', le.title
      from public.league_events le
      join public.event_slots es on es.id = le.confirmed_slot_id
      where le.status = 'scheduled'
        and le.created_by is not null
        and es.starts_at >  now() + interval '14 hours'
        and es.starts_at <= now() + interval '30 hours'

      union all

      -- Happening today.
      select le.id, le.created_by, 'event_nudge_today', le.title
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
    select f.kind, f.user_id, f.entity_id as event_id, d.title
    from fresh f
    join due d on d.event_id = f.entity_id and d.kind = f.kind
  loop
    -- entity_type 'event' is what NotificationsScreen routes to EventDetail,
    -- which is where the nudge buttons live.
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
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
      'league', r.event_id, 'event', 'notifyEventReminders'
    );
  end loop;
exception when others then null;
end $$;

revoke execute on function public.remind_event_organizer_nudges() from public, anon, authenticated;

-- Hourly. Separate job so it can be tuned or paused without touching the
-- existing reminder fan-out.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'pickleague-event-organizer-nudges') then
    perform cron.schedule(
      'pickleague-event-organizer-nudges',
      '7 * * * *',
      $cron$ select public.remind_event_organizer_nudges(); $cron$
    );
  end if;
end $$;
