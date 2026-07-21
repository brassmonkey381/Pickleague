-- ============================================================
-- Venues — multi-sport playing-location catalog (courts / gyms / complexes).
-- Scraped from OpenStreetMap (see scripts/load-osm-courts.mjs) so the app can
-- back its own location search (VenuePicker localSearch) instead of Google Places.
-- See docs/location-pipeline.md and docs/basketball-vertical.md.
--
-- Requires: public.profiles (base schema).
-- Apply:  supabase db query --linked -f supabase/migration_add_venues.sql
-- Idempotent + re-runnable.
-- ============================================================

create extension if not exists pg_trgm;

-- ── Regions (optional): nearest-center assignment target for the scraper. ──
-- Left empty for v1 (region_slug stays NULL); seed later to enable region ranking.
create table if not exists public.venue_regions (
  slug        text primary key,
  name        text not null,
  center_lat  double precision,
  center_lng  double precision,
  created_at  timestamptz not null default now()
);

-- ── Venues: one row per known playing location, keyed by a stable OSM id. ──
create table if not exists public.venues (
  id            text primary key,               -- 'osm:way/123' | 'g:<place_id>' | 'user:<uuid>' | curated slug
  sport         text[] not null default '{}',   -- e.g. '{basketball}', '{pickleball}', '{basketball,pickleball}'
  name          text not null,
  kind          text not null default 'court',  -- 'court' | 'sports_centre' | 'gym' | 'park'
  lat           double precision not null,
  lng           double precision not null,
  address       text,
  city          text,
  region_slug   text references public.venue_regions(slug) on delete set null,
  -- attributes (from OSM tags; nullable when untagged)
  surface       text,                           -- asphalt | concrete | acrylic | wood | ...
  indoor        boolean,
  lit           boolean,
  covered       boolean,
  hoops         integer,                         -- basketball
  court_count   integer,
  access        text,                           -- public | private | customers
  fee           boolean,
  operator      text,
  website       text,
  phone         text,
  opening_hours text,
  -- provenance / dedup
  source        text not null default 'osm',    -- 'osm' | 'google' | 'curated' | 'user'
  external_id   text,
  source_url    text,
  attribution   text,                           -- '© OpenStreetMap contributors' for OSM (ODbL)
  confirmation_status text not null default 'confirmed'
    check (confirmation_status in ('confirmed','unconfirmed')),
  created_by    uuid references public.profiles(id) on delete set null,  -- set for user suggestions
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists venues_sport_idx      on public.venues using gin (sport);
create index if not exists venues_region_idx     on public.venues (region_slug);
create index if not exists venues_name_trgm_idx  on public.venues using gin (name gin_trgm_ops);

-- keep updated_at fresh
create or replace function public.touch_venue()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists venue_updated_at on public.venues;
create trigger venue_updated_at
  before update on public.venues
  for each row execute procedure public.touch_venue();

-- ── RLS: world-readable; users may only *suggest* (their own unconfirmed) rows. ──
-- Canonical osm/curated rows are written by the service role, which bypasses RLS.
alter table public.venues enable row level security;
alter table public.venue_regions enable row level security;

drop policy if exists "Venues readable by everyone" on public.venues;
create policy "Venues readable by everyone"
  on public.venues for select using (true);

drop policy if exists "Users can suggest venues" on public.venues;
create policy "Users can suggest venues"
  on public.venues for insert to authenticated
  with check (
    source = 'user'
    and confirmation_status = 'unconfirmed'
    and created_by = auth.uid()
  );

drop policy if exists "Venue regions readable by everyone" on public.venue_regions;
create policy "Venue regions readable by everyone"
  on public.venue_regions for select using (true);

-- ── Haversine distance (meters). Idempotent; harmless if already present. ──
create or replace function public.haversine_meters(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe set search_path = '' as $$
  select 6371000 * 2 * asin(
    sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
    )
  );
$$;

-- ── Text search for the location picker (name/city/address + distance rank). ──
-- Sport-filtered via array overlap (venues.sport && p_sports).
create or replace function public.search_venues(
  p_query text,
  p_lat double precision default null,
  p_lng double precision default null,
  p_sports text[] default null,
  p_limit int default 8
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_term text;
  v_result jsonb;
begin
  v_term := lower(trim(p_query));
  if length(v_term) < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(row_to_json(t)::jsonb order by t.score desc, t.distance_meters asc nulls last),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      s.id, s.name, s.address, s.city, s.lat, s.lng, s.kind, s.sport,
      s.confirmation_status,
      round(s.distance_meters::numeric, 1) as distance_meters,
      round(s.score::numeric, 2) as score
    from (
      select
        c.*,
        c.text_score
          + case when c.confirmation_status = 'confirmed' then 10 else 0 end
          + case
              when p_lat is not null and p_lng is not null and c.distance_meters is not null
                then 50.0 / (1.0 + c.distance_meters / 3000.0)
              else 0
            end as score
      from (
        select
          vn.id, vn.name, coalesce(vn.address, '') as address, vn.city,
          vn.lat, vn.lng, vn.kind, vn.sport, vn.confirmation_status,
          case
            when p_lat is not null and p_lng is not null
              then public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng)
            else null
          end as distance_meters,
          case
            when lower(vn.name) = v_term then 100
            when lower(vn.name) like v_term || '%' then 80
            when lower(vn.name) like '%' || v_term || '%' then 60
            when lower(coalesce(vn.city, '')) like '%' || v_term || '%' then 40
            when lower(coalesce(vn.address, '')) like '%' || v_term || '%' then 35
            else 0
          end as text_score
        from public.venues vn
        where (p_sports is null or vn.sport && p_sports)
          and (
            lower(vn.name) like '%' || v_term || '%'
            or lower(coalesce(vn.city, '')) like '%' || v_term || '%'
            or lower(coalesce(vn.address, '')) like '%' || v_term || '%'
          )
      ) c
      where c.text_score > 0
    ) s
    limit greatest(p_limit, 1)
  ) t;

  return v_result;
end;
$$;

revoke all on function public.search_venues(text, double precision, double precision, text[], int) from public;
grant execute on function public.search_venues(text, double precision, double precision, text[], int) to authenticated;

-- ── Radius search: nearest-N within a radius; sport-filtered BEFORE the cap. ──
create or replace function public.list_venues_in_radius(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision default 5000,
  p_limit int default 100,
  p_sports text[] default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_radius double precision := greatest(100, least(p_radius_meters, 80000));
  v_lim int := greatest(1, least(p_limit, 300));
begin
  if p_lat is null or p_lng is null then
    raise exception 'Coordinates required';
  end if;
  return coalesce((
    select jsonb_agg(sub.row order by sub.distance_meters asc)
    from (
      select jsonb_build_object(
        'id', v.id, 'name', v.name, 'kind', v.kind, 'sport', v.sport,
        'lat', v.lat, 'lng', v.lng, 'address', v.address, 'city', v.city,
        'surface', v.surface, 'indoor', v.indoor, 'lit', v.lit, 'covered', v.covered,
        'hoops', v.hoops, 'court_count', v.court_count, 'access', v.access, 'fee', v.fee,
        'operator', v.operator, 'website', v.website, 'phone', v.phone,
        'opening_hours', v.opening_hours, 'source', v.source, 'source_url', v.source_url,
        'attribution', v.attribution, 'confirmation_status', v.confirmation_status,
        'distance_meters', round(public.haversine_meters(p_lat, p_lng, v.lat, v.lng)::numeric, 1)
      ) as row,
      public.haversine_meters(p_lat, p_lng, v.lat, v.lng) as distance_meters
      from public.venues v
      where (p_sports is null or v.sport && p_sports)
        and public.haversine_meters(p_lat, p_lng, v.lat, v.lng) <= v_radius
      order by public.haversine_meters(p_lat, p_lng, v.lat, v.lng) asc
      limit v_lim
    ) sub
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_venues_in_radius(double precision, double precision, double precision, int, text[]) from public;
grant execute on function public.list_venues_in_radius(double precision, double precision, double precision, int, text[]) to authenticated;

notify pgrst, 'reload schema';
