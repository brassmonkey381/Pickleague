-- ============================================================
-- Venue dedup + user submissions.
-- - resolve_venue(): nearest existing venue within a radius of a point — the
--   dedup check every second source (user submissions, directory imports, Google
--   gap-fill) runs before inserting, so we never duplicate an OSM venue.
-- - suggest_venue(): a signed-in user proposes a court we're missing; dedup-checks
--   first and either returns the existing match or inserts a source='user',
--   confirmation_status='unconfirmed' row (which already shows in search_venues,
--   ranked below confirmed).
-- Ported/generalized from Doggle's resolve_google_place.
--
-- Requires: migration_add_venues.sql. Apply:
--   supabase db query --linked -f supabase/migration_add_venue_suggestions.sql
-- ============================================================

-- Nearest existing venue within p_radius_m of the point, else NULL. Physical dedup
-- ignores sport (a tennis court and a pickleball submission at the same spot are the
-- same place). 150 m default — courts are small/dense (Doggle used 250 m for parks).
create or replace function public.resolve_venue(
  p_lat double precision,
  p_lng double precision,
  p_radius_m double precision default 150
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if p_lat is null or p_lng is null then
    return null;
  end if;
  select jsonb_build_object(
    'id', vn.id, 'name', vn.name, 'sport', vn.sport, 'kind', vn.kind,
    'lat', vn.lat, 'lng', vn.lng, 'confirmation_status', vn.confirmation_status,
    'distance_meters', round(public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng)::numeric, 1)
  )
  into v
  from public.venues vn
  where public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng) <= greatest(10, p_radius_m)
  order by public.haversine_meters(p_lat, p_lng, vn.lat, vn.lng) asc
  limit 1;
  return v; -- NULL when nothing is close
end;
$$;

revoke all on function public.resolve_venue(double precision, double precision, double precision) from public;
grant execute on function public.resolve_venue(double precision, double precision, double precision) to authenticated;

-- A signed-in user proposes a missing venue. Unless p_force, returns an existing
-- nearby venue instead of creating a duplicate. New rows are source='user',
-- confirmation_status='unconfirmed', created_by = the caller.
create or replace function public.suggest_venue(
  p_name text,
  p_lat double precision,
  p_lng double precision,
  p_sports text[] default '{}',
  p_kind text default 'court',
  p_address text default null,
  p_city text default null,
  p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_existing jsonb;
  v_id text;
  v_row public.venues%rowtype;
begin
  if v_me is null then
    raise exception 'Not signed in';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Name required';
  end if;
  if p_lat is null or p_lng is null then
    raise exception 'Location required';
  end if;

  if not p_force then
    v_existing := public.resolve_venue(p_lat, p_lng);
    if v_existing is not null then
      return jsonb_build_object('status', 'exists', 'venue', v_existing);
    end if;
  end if;

  v_id := 'user:' || gen_random_uuid();
  insert into public.venues (
    id, sport, name, kind, lat, lng, address, city, source, confirmation_status, created_by
  ) values (
    v_id, coalesce(p_sports, '{}'), trim(p_name), coalesce(nullif(trim(p_kind), ''), 'court'),
    p_lat, p_lng, nullif(trim(p_address), ''), nullif(trim(p_city), ''), 'user', 'unconfirmed', v_me
  )
  returning * into v_row;

  return jsonb_build_object(
    'status', 'created',
    'venue', jsonb_build_object(
      'id', v_row.id, 'name', v_row.name, 'sport', v_row.sport, 'kind', v_row.kind,
      'lat', v_row.lat, 'lng', v_row.lng, 'confirmation_status', v_row.confirmation_status
    )
  );
end;
$$;

revoke all on function public.suggest_venue(text, double precision, double precision, text[], text, text, text, boolean) from public;
grant execute on function public.suggest_venue(text, double precision, double precision, text[], text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';
