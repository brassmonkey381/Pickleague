-- migration_outside_events_visible.sql (PKL-081)
-- The app reads the outside-events launch switch to hide the Home "Events" tile and the Events page when events are
-- off (Brian 2026-11-23: "completely scrap it remove it from the app for now"). True when app_settings
-- outside_events_live is true, or for godmode (who still sees events while they are off). Nothing else changes.
create or replace function public.outside_events_visible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._pl_outside_events_live() or coalesce(public.is_godmode_user(auth.uid()), false)
$$;
revoke all on function public.outside_events_visible() from public, anon;
grant execute on function public.outside_events_visible() to authenticated;
