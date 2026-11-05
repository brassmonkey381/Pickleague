-- Court check-ins by the outline (2026-11-05), Doggle's engine (expo-foundation
-- 1.104, state/court-arrival-doggle-parity.md "2026-11-04"). The geofence
-- circle only wakes the phone; the court's outline decides, on the phone, so
-- the phone needs the outlines:
--
--   list_starred_court_geofences()  adds `outline`: the court's mapped outline
--     as GeoJSON (Polygon or MultiPolygon, simplified to about 0.5 m), null
--     without one. Everything else is unchanged, so 1.0.4 builds on older JS
--     read it as before.
--
--   list_nearby_wake_courts(lat, lng, limit)  the nearest outlined courts
--     within 5 km that I haven't starred, nearest first: venue_id (the
--     facility's canonical id), name, lat, lng, radius_m (the outline's
--     equal-area circle, at least 100 m), distance_m (to the outline, 0
--     inside), outline. The phone fills the geofence slots its starred and
--     routine courts leave (iOS allows 20) with these, while "Ask me at other
--     courts" is on. Their wakes only ask ("Check in nearby?") once the phone
--     is on the outline: never an automatic check-in.
--
-- No coordinates are stored or logged: the point is used for this read only.
-- Re-runnable.

-- A venue's outline for the phone: Polygon / MultiPolygon only (ST_MakeValid
-- can leave a GeometryCollection, which the phone can't judge), simplified.
create or replace function public._pl_outline_json(p_geom extensions.geometry)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v extensions.geometry;
begin
  if p_geom is null then return null; end if;
  v := extensions.st_simplifypreservetopology(p_geom, 0.000005);
  if extensions.geometrytype(v) not in ('POLYGON', 'MULTIPOLYGON') then return null; end if;
  return extensions.st_asgeojson(v, 6)::jsonb;
end $$;
revoke all on function public._pl_outline_json(extensions.geometry) from public, anon, authenticated;

create or replace function public.list_starred_court_geofences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id',     v.id,
             'name',         v.name,
             'lat',          v.lat,
             'lng',          v.lng,
             'radius_m',     case when v.area_sqm > 0 then round(sqrt(v.area_sqm / pi()))::int end,
             'auto_checkin', f.auto_checkin,
             'outline',      public._pl_outline_json(v.boundary_geom))
             order by v.name, v.id)
      from public.court_favorites f
      join public.venues v on v.id = f.venue_id
     where f.user_id = v_me), '[]'::jsonb);
end $$;
revoke all on function public.list_starred_court_geofences() from public, anon;
grant execute on function public.list_starred_court_geofences() to authenticated;

create or replace function public.list_nearby_wake_courts(
  p_lat   double precision,
  p_lng   double precision,
  p_limit integer default 19
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_lim     int := greatest(1, least(coalesce(p_limit, 19), 19));
  v_radius  double precision := 5000;
  v_dlat    double precision;
  v_dlng    double precision;
  v_pt      extensions.geometry;
  v_box     extensions.geometry;
  v_starred text[];
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  -- abs() of NaN or an infinity is above every bound, so those land here too.
  -- No coordinates in the message: they are never logged.
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception using message = 'Couldn''t look for courts near you because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  v_pt  := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);
  -- Padded 10% so the box always holds the circle.
  v_dlat := (v_radius * 1.1) / 111320.0;
  v_dlng := (v_radius * 1.1) / (111320.0 * greatest(cos(radians(p_lat)), 0.01));
  v_box := extensions.st_makeenvelope(p_lng - v_dlng, p_lat - v_dlat, p_lng + v_dlng, p_lat + v_dlat, 4326);

  -- My stars, as facilities (court_prompt_scan's rule): those are fenced already.
  select array_agg(distinct coalesce(v.canonical_id, v.id)) into v_starred
    from public.court_favorites f
    join public.venues v on v.id = f.venue_id
   where f.user_id = v_me;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id',   n.canon,
             'name',       n.name,
             'lat',        n.lat,
             'lng',        n.lng,
             'radius_m',   greatest(100, round(sqrt(n.area_sqm / pi()))::int),
             'distance_m', round(n.d::numeric),
             'outline',    public._pl_outline_json(n.geom))
             order by n.d, n.canon)
      from (
       select * from (
        -- Each facility once, at its nearest outlined row.
        select distinct on (b.canon) b.*
          from (
            select coalesce(v.canonical_id, v.id) as canon, v.name, v.lat, v.lng, v.area_sqm,
                   v.boundary_geom as geom,
                   extensions.st_distance(v.boundary_geom::extensions.geography, v_pt::extensions.geography) as d
              from public.venues v
             where v.boundary_geom operator(extensions.&&) v_box
               and v.area_sqm > 0
               and v.lat is not null and v.lng is not null
               and v.sport @> array['pickleball']
               and v.confirmation_status <> 'rejected'
          ) b
         where b.d <= v_radius
           and not (b.canon = any(coalesce(v_starred, '{}')))
         order by b.canon, b.d
       ) x
       -- The limit goes here: on the aggregate below it would cut nothing.
       order by x.d, x.canon
       limit v_lim
      ) n), '[]'::jsonb);
end $$;
revoke all on function public.list_nearby_wake_courts(double precision, double precision, integer) from public, anon;
grant execute on function public.list_nearby_wake_courts(double precision, double precision, integer) to authenticated;
