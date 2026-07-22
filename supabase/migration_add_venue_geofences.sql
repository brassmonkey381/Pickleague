-- ============================================================
-- Venue geofences — a boundary polygon where OSM gives us one (pitches/areas),
-- and a radius fallback for point-only venues (OSM nodes, Google, user-added).
-- Mirrors Doggle's dog_place boundary/PostGIS setup (0184). Powers "which venue
-- am I at?" (point-in-polygon, else nearest within its geofence radius).
--
-- Populate boundaries by re-running the osmium bulk load (ingest-osm-venues.sh) —
-- load-osm-venues.mjs now emits the OSM boundary + a per-kind geofence radius.
-- (The Overpass path has no geometry, so it sets radius only.)
-- Apply:  supabase db query --linked -f supabase/migration_add_venue_geofences.sql
-- ============================================================

create extension if not exists postgis with schema extensions;

alter table public.venues
  add column if not exists boundary        jsonb,                                -- raw GeoJSON (source of truth)
  add column if not exists boundary_geom   extensions.geometry(Geometry, 4326),  -- derived, for spatial queries
  add column if not exists area_sqm        double precision,
  add column if not exists geofence_radius_m integer;                            -- radius fallback (m) for point venues

create index if not exists venues_boundary_geom_idx
  on public.venues using gist (boundary_geom);

-- Derive boundary_geom + area_sqm from the GeoJSON on write. Wrapped so a bad/huge
-- geometry can never break an upsert (it just lands with a null geom).
create or replace function public.venue_set_geom()
returns trigger
language plpgsql
set search_path = public, extensions as $$
begin
  if NEW.boundary is not null then
    begin
      NEW.boundary_geom := ST_MakeValid(ST_GeomFromGeoJSON(NEW.boundary::text));
      NEW.area_sqm := ST_Area(NEW.boundary_geom::geography);
    exception when others then
      NEW.boundary_geom := null;
      NEW.area_sqm := null;
    end;
  else
    NEW.boundary_geom := null;
  end if;
  return NEW;
end $$;

drop trigger if exists venue_geom_biu on public.venues;
create trigger venue_geom_biu
  before insert or update of boundary on public.venues
  for each row execute function public.venue_set_geom();

-- "Which venue is this point in?" Polygon geofence first (smallest containing
-- venue), else the nearest point-only venue within its radius fallback (default 60 m).
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
    and public.haversine_meters(p_lat, p_lng, lat, lng) <= coalesce(geofence_radius_m, 60)
  order by public.haversine_meters(p_lat, p_lng, lat, lng) asc
  limit 1;
  return v_id;
end;
$$;

revoke all on function public.venue_containing_point(double precision, double precision) from public;
grant execute on function public.venue_containing_point(double precision, double precision) to authenticated;

notify pgrst, 'reload schema';
