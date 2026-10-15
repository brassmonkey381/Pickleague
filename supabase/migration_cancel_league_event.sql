-- Cancel an event from the app, with two choices the organizer makes each time:
--   p_notify  tell the league it is off (default). Off for "I made a mistake
--             and am remaking it" — nobody gets a push for a typo.
--   p_remove  delete it instead of leaving a Cancelled row in the events list.
--             Also clears the "New vote" notices it already put in inboxes,
--             so a remade event doesn't sit beside its broken twin. Recorded
--             matches survive (matches.event_id is ON DELETE SET NULL).
--
-- Who: the event's creator, or a league admin / co-admin / the league creator.
-- An already-cancelled event can still be removed (p_remove), which is how an
-- organizer clears one cancelled before this existed.
--
-- Returns 'cancelled' or 'removed'.

create or replace function public.cancel_league_event(
  p_event_id uuid,
  p_notify   boolean default true,
  p_remove   boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_me    uuid := auth.uid();
  v_rcpt  record;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  select le.id, le.league_id, le.title, le.status, le.created_by,
         s.starts_at as confirmed_at
    into r
    from public.league_events le
    left join public.event_slots s on s.id = le.confirmed_slot_id
   where le.id = p_event_id
   for update of le;
  if not found then
    raise exception 'Event not found';
  end if;

  if r.created_by is distinct from v_me
     and not exists (select 1 from public.leagues l
                      where l.id = r.league_id and l.created_by = v_me)
     and not exists (select 1 from public.league_members m
                      where m.league_id = r.league_id and m.user_id = v_me
                        and m.role in ('admin', 'co-admin')) then
    raise exception 'Only the organizer or a league admin can cancel this event';
  end if;

  if r.status = 'cancelled' and not p_remove then
    return 'cancelled';  -- nothing to do; and never re-announce it
  end if;

  -- Announce first, while the row (and its confirmed time) still exists. An
  -- already-cancelled event was announced (or deliberately not) back then.
  if p_notify and r.status <> 'cancelled' then
    for v_rcpt in
      select lm.user_id
        from public.league_members lm
       where lm.league_id = r.league_id
         and lm.user_id <> v_me
         and (lm.expires_at is null or lm.expires_at > now())
    loop
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
      values (
        v_rcpt.user_id,
        '❌ Event cancelled: ' || r.title,
        case when r.confirmed_at is not null
          then 'The organizer cancelled it. It was set for '
               || public._pickleague_local_label(r.confirmed_at, public._pickleague_tz_for(v_rcpt.user_id)) || '.'
          else 'The organizer cancelled it.'
        end,
        'league',
        -- A removed event has no screen to open; send them to the league.
        case when p_remove then r.league_id else r.id end,
        case when p_remove then 'league' else 'event' end,
        'notifyLeagueUpdates'
      );
    end loop;
  end if;

  if p_remove then
    -- Keep the cancel notices (sent just now, or when it was cancelled
    -- earlier) but point them at the league; drop every other notice
    -- (votes, reminders) that would open a screen that no longer exists.
    update public.notifications
       set entity_type = 'league', entity_id = r.league_id
     where entity_type = 'event' and entity_id = r.id
       and title like '❌ Event cancelled:%';
    delete from public.notifications
     where entity_type = 'event' and entity_id = r.id;
    delete from public.reminder_log where entity_id = r.id;
    delete from public.league_events where id = r.id;  -- slots, votes, declines, guest invites cascade
    return 'removed';
  end if;

  update public.league_events set status = 'cancelled' where id = r.id;
  return 'cancelled';
end $$;

revoke all on function public.cancel_league_event(uuid, boolean, boolean) from public, anon;
grant execute on function public.cancel_league_event(uuid, boolean, boolean) to authenticated;
