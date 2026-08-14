-- ============================================================
-- Event voting: a "Can't make it" option, and a minimum-players threshold
-- that cancels the event if nobody can agree on a time.
--
-- 1. "Can't make it" is its own table rather than an extra event_slots row.
--    event_slots.starts_at / ends_at are NOT NULL and every query orders by
--    starts_at, so a pseudo-slot would need fake timestamps and would leak
--    into the winner query, the slot list, and the schedule UI. A separate
--    table cannot win a vote by construction, which is exactly the
--    "informational only" requirement.
--
-- 2. min_players is null by default, meaning no threshold and the previous
--    behaviour. When set, the best slot must reach it or the event cancels.
-- ============================================================

alter table public.league_events
  add column if not exists min_players integer
    check (min_players is null or min_players > 0);

comment on column public.league_events.min_players is
  'Minimum voters that must agree on a single slot for the event to happen. '
  'Null means no minimum. Checked against the WINNING slot when voting closes; '
  'below it the event is cancelled rather than scheduled.';

-- ── "Can't make it" ──────────────────────────────────────────
create table if not exists public.event_declines (
  id          uuid default gen_random_uuid() primary key,
  event_id    uuid references public.league_events(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  declined_at timestamptz default now(),
  unique(event_id, user_id)
);

alter table public.event_declines enable row level security;

-- Mirrors the event_slot_votes policies: public to read (the whole point is
-- that the league can see who is out), self-service to write.
create policy "Declines viewable by everyone" on public.event_declines
  for select using (true);
create policy "Users can decline an event"    on public.event_declines
  for insert with check (auth.uid() = user_id);
create policy "Users can undo their decline"  on public.event_declines
  for delete using (auth.uid() = user_id);

create index if not exists event_declines_event_idx on public.event_declines (event_id);

-- ── Declining and voting are mutually exclusive ──────────────
-- Enforced by trigger rather than in the client, so it holds no matter which
-- surface writes the row. "I can't make it" and "I can make Tuesday" are
-- contradictory, and showing both would make the decline list untrustworthy.
create or replace function public._clear_votes_on_decline()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.event_slot_votes v
   using public.event_slots s
   where v.slot_id = s.id
     and s.event_id = new.event_id
     and v.user_id  = new.user_id;
  return new;
end $$;
revoke execute on function public._clear_votes_on_decline() from public, anon, authenticated;

drop trigger if exists event_decline_clears_votes on public.event_declines;
create trigger event_decline_clears_votes
  after insert on public.event_declines
  for each row execute function public._clear_votes_on_decline();

create or replace function public._clear_decline_on_vote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.event_declines d
   using public.event_slots s
   where s.id       = new.slot_id
     and d.event_id = s.event_id
     and d.user_id  = new.user_id;
  return new;
end $$;
revoke execute on function public._clear_decline_on_vote() from public, anon, authenticated;

drop trigger if exists event_vote_clears_decline on public.event_slot_votes;
create trigger event_vote_clears_decline
  after insert on public.event_slot_votes
  for each row execute function public._clear_decline_on_vote();

-- ── Finalization, shared by the cron job and the manual close ─
-- Previously the cron function and the client's "Close voting" button each
-- implemented the winner rule separately, so min_players would have had to be
-- written twice and could drift. One internal function now owns it.
--
-- Returns the resulting status ('scheduled' | 'cancelled') or null when there
-- was nothing to do.
create or replace function public._finalize_one_event(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
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

  -- Winning slot: most votes, tie-break on earliest start.
  select s.id, count(v.id)
    into winner, winner_votes
  from public.event_slots s
  left join public.event_slot_votes v on v.slot_id = s.id
  where s.event_id = r.id
  group by s.id, s.starts_at
  order by count(v.id) desc, s.starts_at asc
  limit 1;

  if winner is null then
    return null;  -- no slots proposed; leave it alone
  end if;

  -- Not enough people could agree on any single time. Note this tests the BEST
  -- slot, not the total turnout: ten people who all voted for different times
  -- still cannot field a game.
  if r.min_players is not null and winner_votes < r.min_players then
    update public.league_events
       set status = 'cancelled'
     where id = r.id and status = 'voting';

    if not found then
      return null;  -- finalized by someone else in between
    end if;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    select lm.user_id,
           '❌ Event cancelled: ' || r.title,
           'Voting closed without enough players agreeing on a time.',
           'league', r.league_id, 'league', 'notifyEventReminders'
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

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
  select lm.user_id,
         '📅 Event scheduled: ' || r.title,
         'Voting has closed and a time is confirmed. Tap to see the schedule.',
         'league', r.league_id, 'league', 'notifyEventReminders'
  from public.league_members lm
  where lm.league_id = r.league_id;

  return 'scheduled';
end $$;
revoke execute on function public._finalize_one_event(uuid) from public, anon, authenticated;

create or replace function public.finalize_closed_event_votes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select le.id
    from public.league_events le
    where le.status = 'voting'
      and le.vote_ends_at <= now()
      and exists (select 1 from public.event_slots s where s.event_id = le.id)
  loop
    begin
      perform public._finalize_one_event(r.id);
    exception when others then null;  -- one bad event must not stall the rest
    end;
  end loop;
end $$;

-- Client-callable manual close. Matches the existing RLS on league_events
-- ("Event creator can update"), and now applies the same min_players rule the
-- cron job does — closing early can cancel, exactly as letting it run out would.
create or replace function public.close_event_vote(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select created_by into v_creator from public.league_events where id = p_event_id;
  if v_creator is null then
    raise exception 'Event not found';
  end if;
  if v_creator <> auth.uid() then
    raise exception 'Only the event creator can close voting';
  end if;

  return public._finalize_one_event(p_event_id);
end $$;
revoke all on function public.close_event_vote(uuid) from public;
grant execute on function public.close_event_vote(uuid) to authenticated;
