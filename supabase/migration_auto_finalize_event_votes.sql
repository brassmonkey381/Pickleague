-- Auto-finalize league event votes once the deadline passes
--
-- Until now an event was only finalized (status -> 'scheduled' + confirmed_slot_id
-- set) when a league admin manually tapped "Close Voting & Confirm Top Slot".
-- If nobody tapped it, an event whose `vote_ends_at` had passed stayed
-- `status = 'voting'` with `confirmed_slot_id = NULL` forever — the client UI
-- shows voting as closed, but the row was never actually finalized.
--
-- This adds a server-side finalizer that runs on a schedule: any event still in
-- `voting` whose deadline has passed gets its winning slot confirmed
-- automatically, exactly the way the manual close does it (top slot by vote
-- count, ties broken by earliest start time). RLS blocks ordinary viewers from
-- updating the event (only the creator can), so a security-definer function on
-- cron is the reliable path that works regardless of who — if anyone — is
-- looking at the event when it closes.

create or replace function public.finalize_closed_event_votes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  winner  uuid;
begin
  for r in
    select le.id, le.league_id, le.title
    from public.league_events le
    where le.status = 'voting'
      and le.vote_ends_at <= now()
      and exists (select 1 from public.event_slots s where s.event_id = le.id)
  loop
    -- Winning slot: most votes, tie-break on earliest start (matches the
    -- manual close, which sorts slots by vote_count desc and takes the first).
    select s.id
      into winner
    from public.event_slots s
    left join public.event_slot_votes v on v.slot_id = s.id
    where s.event_id = r.id
    group by s.id, s.starts_at
    order by count(v.id) desc, s.starts_at asc
    limit 1;

    if winner is null then
      continue;
    end if;

    -- Guard on status = 'voting' so a concurrent manual close (or a previous
    -- run of this function) can't double-finalize the same event.
    update public.league_events
      set status = 'scheduled', confirmed_slot_id = winner
      where id = r.id and status = 'voting';

    if not found then
      continue;  -- already finalized by someone else between SELECT and UPDATE
    end if;

    -- Let the league know the time was confirmed. Rides the notifications
    -- table, so the existing push fan-out delivers it for free. The client
    -- renders the actual slot time in the user's locale, so we keep the body
    -- timezone-agnostic here.
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    select lm.user_id,
           '📅 Event scheduled: ' || r.title,
           'Voting has closed and a time is confirmed. Tap to see the schedule.',
           'league', r.league_id, 'league', 'notifyEventReminders'
    from public.league_members lm
    where lm.league_id = r.league_id;
  end loop;
exception when others then null;
end $$;

-- Run every 15 minutes so a closed vote is finalized promptly. Independent of
-- the hourly notification-reminders job (pickleague-notification-reminders).
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'pickleague-finalize-event-votes') then
    perform cron.schedule(
      'pickleague-finalize-event-votes',
      '*/15 * * * *',
      $cron$ select public.finalize_closed_event_votes(); $cron$
    );
  end if;
end $$;

-- Backfill: finalize any events that already closed before this migration ran.
select public.finalize_closed_event_votes();
