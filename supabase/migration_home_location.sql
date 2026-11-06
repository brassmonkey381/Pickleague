-- ============================================================
-- Home location (2026-11-06): where a player calls home, as Doggle's
-- Settings > Location (doggle 0170 set_my_location). Brian: "Let users pick
-- their coarse home location, and assure them it's never public facing, only
-- their neighborhood shows, like Alameda, CA. Let them use GPS to pick their
-- location as well."
--
-- Outside events (migration_outside_events.sql) list the ones within 40 km
-- of it; later features can use it the same way.
--
-- Privacy:
--   * The exact point and the address they typed live in
--     profile_home_locations: RLS on, no policies, grants revoked. Only the
--     owner reads them back (get_my_home_location), and server code uses them
--     for distance.
--   * profiles.home_neighborhood ("Alameda, CA") is the only part anyone else
--     could see: the nearest US city to the point (nearest_us_city,
--     migration_add_us_cities_geocode.sql), else "City, ST" read from the
--     address, else null.
--
-- ── Client RPCs (authenticated, in the hardening allowlist) ────────────────
--   set_my_home_location(p_lat, p_lng, p_address default null) -> jsonb
--     {neighborhood, lat, lng, address}
--   get_my_home_location() -> jsonb {neighborhood, lat, lng, address, updated_at} or null
--   clear_my_home_location() -> boolean (whether there was one)
--
-- Errors carry pl:home_location.* hints.
-- Safe to re-run.
-- Run: supabase db query --linked -f supabase/migration_home_location.sql
-- ============================================================

create table if not exists public.profile_home_locations (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  lat          double precision not null,
  lng          double precision not null,
  address      text,
  neighborhood text,
  updated_at   timestamptz not null default now(),
  constraint profile_home_locations_point check (lat between -90 and 90 and lng between -180 and 180),
  constraint profile_home_locations_address check (address is null or char_length(address) <= 300)
);
alter table public.profile_home_locations enable row level security;
revoke all on table public.profile_home_locations from public, anon, authenticated;
comment on table public.profile_home_locations is
  'Home location (migration_home_location.sql): the exact point is private. RLS on, no policy: RPCs only.';

alter table public.profiles add column if not exists home_neighborhood text;
comment on column public.profiles.home_neighborhood is
  'migration_home_location.sql: "City, ST" near the player''s home location; the only part of it others may see.';

-- "Alameda, CA" for a point: the nearest US city within about 40 km, else
-- the "City, ST" in the address, else null.
create or replace function public._pl_neighborhood_for(p_lat double precision, p_lng double precision, p_address text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_near jsonb;
  v_m    text[];
begin
  begin
    v_near := public.nearest_us_city(p_lat, p_lng);
  exception when others then
    v_near := null;  -- no city table on this database
  end;
  if v_near is not null
     and public.haversine_meters(p_lat, p_lng, (v_near ->> 'lat')::double precision, (v_near ->> 'lng')::double precision) <= 40000 then
    return (v_near ->> 'city') || ', ' || (v_near ->> 'state');
  end if;
  v_m := regexp_match(coalesce(p_address, ''), '([^,]+),\s*([A-Z]{2})(\s+\d{5}(-\d{4})?)?\s*(,\s*(USA|United States))?\s*$');
  if v_m is not null then
    return btrim(v_m[1]) || ', ' || v_m[2];
  end if;
  return null;
end $$;
revoke all on function public._pl_neighborhood_for(double precision, double precision, text) from public, anon, authenticated;

create or replace function public.set_my_home_location(
  p_lat     double precision,
  p_lng     double precision,
  p_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_addr text := nullif(btrim(coalesce(p_address, '')), '');
  v_hood text;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception using message = 'Pick a place on the list, or use your location.', hint = 'pl:home_location.point';
  end if;
  if v_addr is not null and char_length(v_addr) > 300 then
    v_addr := left(v_addr, 300);
  end if;
  v_hood := public._pl_neighborhood_for(p_lat, p_lng, v_addr);

  insert into public.profile_home_locations (profile_id, lat, lng, address, neighborhood, updated_at)
  values (v_uid, p_lat, p_lng, v_addr, v_hood, now())
  on conflict (profile_id) do update
    set lat = excluded.lat, lng = excluded.lng, address = excluded.address,
        neighborhood = excluded.neighborhood, updated_at = now();
  update public.profiles set home_neighborhood = v_hood where id = v_uid;

  return jsonb_build_object('neighborhood', v_hood, 'lat', p_lat, 'lng', p_lng, 'address', v_addr);
end $$;
revoke all on function public.set_my_home_location(double precision, double precision, text) from public, anon;
grant execute on function public.set_my_home_location(double precision, double precision, text) to authenticated;

create or replace function public.get_my_home_location()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  return (
    select jsonb_build_object('neighborhood', h.neighborhood, 'lat', h.lat, 'lng', h.lng,
                              'address', h.address, 'updated_at', h.updated_at)
      from public.profile_home_locations h
     where h.profile_id = v_uid);
end $$;
revoke all on function public.get_my_home_location() from public, anon;
grant execute on function public.get_my_home_location() to authenticated;

create or replace function public.clear_my_home_location()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  delete from public.profile_home_locations where profile_id = v_uid;
  get diagnostics v_n = row_count;
  update public.profiles set home_neighborhood = null where id = v_uid;
  return v_n > 0;
end $$;
revoke all on function public.clear_my_home_location() from public, anon;
grant execute on function public.clear_my_home_location() to authenticated;
