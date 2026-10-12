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
