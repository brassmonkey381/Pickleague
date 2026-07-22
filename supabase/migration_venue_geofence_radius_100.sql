-- ============================================================
-- Bump the venue geofence radius to a 100 m floor (from the per-kind 45–90 m).
-- GPS fixes wobble 10–30 m, so 100 m is a more forgiving "am I at this court?"
-- radius. No re-ingest needed — this updates stored radii + the lookup function.
-- Point venues get >= 100 m (Google/user venues that had no radius now get 100);
-- larger venues (park 150, disc golf 250) keep their bigger radius; polygon
-- venues keep using their boundary.
-- Apply:  supabase db query --linked -f supabase/migration_venue_geofence_radius_100.sql
-- ============================================================

-- Give every point (non-polygon) venue an explicit radius of at least 100 m.
update public.venues
set geofence_radius_m = 100
where boundary is null
  and (geofence_radius_m is null or geofence_radius_m < 100);

-- Lookup: polygon geofence first, else nearest point venue within its radius
-- (floored at 100 m for anything still missing an explicit value).
create or replace function public.venue_containing_point(
  p_lat double precision, p_lng double precision
) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_id text;
begin
  select id into v_id
  from public.venues
  where boundary_geom is not null
    and ST_Contains(boundary_geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  order by area_sqm asc nulls last
  limit 1;
  if v_id is not null then return v_id; end if;

  select id into v_id
  from public.venues
  where boundary_geom is null
    and public.haversine_meters(p_lat, p_lng, lat, lng) <= greatest(coalesce(geofence_radius_m, 100), 100)
  order by public.haversine_meters(p_lat, p_lng, lat, lng) asc
  limit 1;
  return v_id;
end;
$$;

revoke all on function public.venue_containing_point(double precision, double precision) from public;
grant execute on function public.venue_containing_point(double precision, double precision) to authenticated;

notify pgrst, 'reload schema';
