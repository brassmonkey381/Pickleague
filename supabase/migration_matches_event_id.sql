-- Link league matches back to the league_events row that scheduled them.
-- Used by EventDetailScreen to surface matches recorded against this event
-- and to count attendance against the confirmed slot. Optional FK — older
-- league matches aren't tied to any event.

alter table public.matches
  add column if not exists event_id uuid references public.league_events(id) on delete set null;

create index if not exists matches_event_id_idx
  on public.matches (event_id) where event_id is not null;
