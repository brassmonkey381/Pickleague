-- migration_outside_events_visible_no_godmode.sql (PKL-081)
-- Brian 2026-11-23 ("hide for godmode"): while outside events are off, godmode accounts lose the Home Events tile and
-- the Events page too. outside_events_visible() now follows only app_settings.outside_events_live.
-- (Godmode keeps its other event views, e.g. the admin queues; nothing is deleted.)
create or replace function public.outside_events_visible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._pl_outside_events_live()
$$;
revoke all on function public.outside_events_visible() from public, anon;
grant execute on function public.outside_events_visible() to authenticated;
