-- ============================================================
-- Admin (godmode): edit a court's building/area outline, and list courts by
-- outline coverage. Mirrors Doggle 0188 (save_dog_place_boundary /
-- admin_list_boundaries).
--
-- The outline is venues.boundary (GeoJSON); the venue_geom_biu trigger
-- (migration_add_venue_geofences.sql) derives boundary_geom + area_sqm. A
-- check-in fix inside boundary_geom passes regardless of distance
-- (_pl_check_fix), and resolve_court prefers the smallest containing outline.
-- The 100 m circle around the pin still counts as well.
--
-- Apply:  supabase db query --linked -f supabase/migration_admin_venue_boundary.sql
-- ============================================================

-- Save (or clear, with null) one court's outline. Returns the derived area and
-- whether the pin sits inside it, so the editor can warn about a misplaced
-- outline before anyone tries to check in.
create or replace function public.admin_save_venue_boundary(p_venue_id text, p_boundary jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_geom_null boolean;
  v_area double precision;
  v_pin_inside boolean;
begin
  if not public.is_godmode_user() then raise exception 'Admin access required'; end if;
  if p_boundary is not null and coalesce(p_boundary ->> 'type', '') not in ('Polygon', 'MultiPolygon') then
    raise exception 'An outline must be a GeoJSON Polygon or MultiPolygon';
  end if;

  update public.venues set boundary = p_boundary where id = p_venue_id;
  if not found then raise exception 'Court not found'; end if;

  select v.boundary_geom is null, v.area_sqm,
         v.boundary_geom is not null
           and extensions.st_contains(v.boundary_geom,
                 extensions.st_setsrid(extensions.st_makepoint(v.lng, v.lat), 4326))
    into v_geom_null, v_area, v_pin_inside
    from public.venues v where v.id = p_venue_id;

  if p_boundary is not null and v_geom_null then
    raise exception 'That outline isn''t a valid shape. Check that the edges don''t cross.';
  end if;
  -- A slip of the finger at low zoom can cover a city block or a town.
  if v_area > 200000 then
    raise exception 'That outline covers % m2, bigger than any club (limit 200,000 m2).', round(v_area);
  end if;

  return jsonb_build_object('id', p_venue_id, 'area_sqm', v_area,
                            'has_boundary', p_boundary is not null, 'pin_inside', coalesce(v_pin_inside, false));
end;
$$;
revoke all on function public.admin_save_venue_boundary(text, jsonb) from public, anon;
grant execute on function public.admin_save_venue_boundary(text, jsonb) to authenticated;

-- Courts (canonical rows, not rejected) with their outline status. No jsonb
-- pulled; the editor reads the one row it opens.
create or replace function public.admin_list_venue_boundaries(
  p_query  text default '',
  p_filter text default 'all',   -- all | has | missing
  p_limit  int  default 100
) returns table (
  id text, name text, city text, lat double precision, lng double precision,
  area_sqm double precision, has_boundary boolean, checkins bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_godmode_user() then raise exception 'Admin access required'; end if;
  return query
    select v.id, v.name, v.city, v.lat, v.lng, v.area_sqm,
           (v.boundary is not null) as has_boundary,
           (select count(*) from public.venue_checkins vc where vc.venue_id = v.id) as checkins
      from public.venues v
     where v.canonical_id is null
       and coalesce(v.confirmation_status, '') <> 'rejected'
       and (coalesce(p_query, '') = '' or v.name ilike '%' || p_query || '%' or v.city ilike '%' || p_query || '%')
       and (p_filter = 'all'
            or (p_filter = 'has' and v.boundary is not null)
            or (p_filter = 'missing' and v.boundary is null))
     -- Busiest courts first: those are the ones worth outlining.
     order by checkins desc, v.name
     limit greatest(1, least(coalesce(p_limit, 100), 300));
end;
$$;
revoke all on function public.admin_list_venue_boundaries(text, text, int) from public, anon;
grant execute on function public.admin_list_venue_boundaries(text, text, int) to authenticated;

notify pgrst, 'reload schema';
