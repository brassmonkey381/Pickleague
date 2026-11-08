-- ============================================================
-- Outside events: an event with no end time stays listed 3 hours after its
-- start, not 1 (Brian 2026-11-07, kit 1.113 OUTSIDE_EVENT_NO_END_MS, the same
-- in Doggle's 0523). An Interested event no longer drops out while it's on.
-- With an end time, nothing changes: listed until the end.
--
-- Replaces public._pl_outside_event_past from migration_outside_events.sql
-- (same signature, so every list, get and count reads the new window).
-- Safe to re-run.
-- Run: supabase db query --linked -f supabase/migration_outside_events_live_window.sql
-- ============================================================

create or replace function public._pl_outside_event_past(p_starts timestamptz, p_ends timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_ends is not null then p_ends <= now() else p_starts <= now() - interval '3 hours' end
$$;
revoke all on function public._pl_outside_event_past(timestamptz, timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';
