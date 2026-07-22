-- ============================================================
-- Offline US city geocoding — a us_cities lookup (city/state ↔ lat/lng) from an
-- open dataset (kelvins/US-Cities-Database, MIT, ~29.9k cities) so we can reverse-
-- geocode a venue's coordinates to a city name with no live API / rate limits.
-- Ported from Doggle (0161). Data rows load in migration_us_cities_data.sql.
--   geocode_city_state(city, state) → nearest matching lat/lng
--   nearest_us_city(lat, lng)        → closest city/state (reverse geocode)
-- Requires: haversine_meters (migration_add_venues.sql).
-- Apply, then load the data:
--   supabase db query --linked -f supabase/migration_add_us_cities_geocode.sql
--   supabase db query --linked -f supabase/migration_us_cities_data.sql
-- ============================================================

create table if not exists public.us_cities (
  id integer primary key,
  city text not null,
  state_code text not null,
  state_name text,
  lat double precision not null,
  lng double precision not null
);

create index if not exists us_cities_city_state_idx on public.us_cities (lower(city), state_code);
create index if not exists us_cities_latlng_idx on public.us_cities (lat, lng);

alter table public.us_cities enable row level security;
drop policy if exists "us_cities readable" on public.us_cities;
create policy "us_cities readable" on public.us_cities for select to authenticated using (true);

-- Forward geocode: "Alameda", "CA" → {lat,lng}. Matches 2-letter code or full state
-- name, case-insensitively.
create or replace function public.geocode_city_state(p_city text, p_state text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('lat', lat, 'lng', lng, 'city', city, 'state', state_code)
  from public.us_cities
  where lower(city) = lower(trim(coalesce(p_city, '')))
    and (lower(state_code) = lower(trim(coalesce(p_state, '')))
         or lower(state_name) = lower(trim(coalesce(p_state, ''))))
  order by id
  limit 1;
$$;

-- Reverse geocode: GPS → nearest city. Bounding-box pre-filter, then haversine.
create or replace function public.nearest_us_city(p_lat double precision, p_lng double precision)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('city', city, 'state', state_code, 'lat', lat, 'lng', lng)
  from public.us_cities
  where lat between p_lat - 1.0 and p_lat + 1.0
    and lng between p_lng - 1.5 and p_lng + 1.5
  order by public.haversine_meters(p_lat, p_lng, lat, lng)
  limit 1;
$$;

grant execute on function public.geocode_city_state(text, text) to authenticated;
grant execute on function public.nearest_us_city(double precision, double precision) to authenticated;

notify pgrst, 'reload schema';
