-- ============================================================
-- Backfill venues.city from coordinates using the offline geocoder — city is
-- sparsely tagged in OSM (~13%), so this fills it for the rest, sharpening
-- search_venues' city matching. Reusable: re-run after future ingests to fill
-- any new null-city rows (idempotent — only touches city is null).
-- Requires: migration_add_us_cities_geocode.sql + migration_us_cities_data.sql.
-- Apply:  supabase db query --linked -f supabase/migration_backfill_venue_cities.sql
--   Re-run later:  supabase db query --linked "select public.backfill_venue_cities();"
-- ============================================================

create or replace function public.backfill_venue_cities()
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with sub as (
    select id, public.nearest_us_city(lat, lng)->>'city' as city
    from public.venues
    where city is null and lat is not null and lng is not null
  ),
  updated as (
    update public.venues v
    set city = sub.city
    from sub
    where v.id = sub.id and sub.city is not null
    returning 1
  )
  select count(*) into v_count from updated;
  return v_count;
end;
$$;

-- Service-role / maintenance only — not exposed to app clients.
revoke all on function public.backfill_venue_cities() from public;

-- Run it once now (this migration runs as the service role).
select public.backfill_venue_cities() as venues_city_backfilled;

notify pgrst, 'reload schema';
