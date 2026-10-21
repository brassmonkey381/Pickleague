-- ============================================================
-- Court discovery, Phase 1: find a court, open its page
-- (state/court-discovery-plan.md, Phase 1).
--
-- What this adds:
--   1. venues_point_geog_idx: a GiST index on each venue's point as
--      geography. list_courts_nearby spells the same expression in its
--      ST_DWithin prefilter, so the planner can use it (Doggle's 0369 pattern).
--      Haversine stays the authority on what is in range and on distance_m;
--      the prefilter only narrows the candidates (padded 1% + 25 m, because
--      PostGIS measures on the spheroid and haversine on a sphere).
--   2. list_courts_nearby(p_lat, p_lng, p_radius_m, p_sports, p_limit,
--      p_after_m, p_after_id) -> jsonb array of catalog rows, nearest first.
--        - canonical rows only (canonical_id is null), never 'rejected';
--        - a court matches a sport when it or any of its aliases is tagged
--          with one of p_sports;
--        - a blank attribute (address, surface, lights, ...) is filled from
--          the aliases (the oldest id first);
--        - keyset paging on (distance_m, id): pass the last row's distance_m
--          and id as p_after_m / p_after_id for the next page;
--        - league_count counts only leagues the caller can see: active, and
--          open or one the caller belongs to.
--      Catalog fields only. Live numbers (the crowd, the star) come from
--      venue_crowd and list_my_court_favorites, so the list can be cached for
--      a day.
--   3. get_court(p_venue) -> jsonb: one court, following canonical_id, so an
--      alias id (an old link, a league's old home court) opens its facility.
--      The list's fields plus requested_id, aliases[{id, name, source}],
--      boundary, geofence_radius_m and leagues[{id, name}] (visible ones).
--   4. Refusals reuse the existing codes: pl:auth.signed_out (no caller),
--      pl:request.bad (no coordinates, no sports, no id) and pl:court.gone
--      (an id that isn't a court any more, or a rejected one).
--   5. Grants: both RPCs are signed-in only (decision 5): revoked from public
--      and anon, granted to authenticated, and added to the allowlist in
--      migration_rls_hardening_2026q3.sql. The row builder
--      _pl_court_catalog_json is internal (execute revoked from clients).
--
-- Apply order: after migration_presence_p1_schema.sql (canonical_id,
-- leagues.home_venue_id), migration_add_venue_geofences.sql (boundary,
-- PostGIS in the extensions schema), migration_add_venue_submissions.sql
-- ('rejected') and migration_venue_data_guards.sql (Phase 0: the dedupe this
-- list relies on). Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_court_discovery_p1.sql
-- Tested by supabase/tests/court_discovery_personas.sql
-- (node supabase/tests/build-court-discovery-p1-test.mjs).
-- ============================================================


-- ── 1. The point index ─────────────────────────────────────────────────────
-- Plain CREATE INDEX (not CONCURRENTLY: that can't run in a transaction);
-- about 4,400 rows today, so it takes well under a second.
create index if not exists venues_point_geog_idx
  on public.venues
  using gist (((extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326))::extensions.geography));


-- ── 2. One court's catalog row (internal) ──────────────────────────────────
-- p_id must be a canonical row. distance_m is filled in by the caller (null
-- here). Blank text counts as missing, so an alias's address fills a ''.
create or replace function public._pl_court_catalog_json(p_id text, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', c.id,
           'name', c.name,
           'kind', c.kind,
           'sport', to_jsonb(c.sport),
           'lat', c.lat,
           'lng', c.lng,
           'address', coalesce(nullif(btrim(c.address), ''), al.address),
           'city', coalesce(nullif(btrim(c.city), ''), al.city),
           'surface', coalesce(nullif(btrim(c.surface), ''), al.surface),
           'indoor', coalesce(c.indoor, al.indoor),
           'lit', coalesce(c.lit, al.lit),
           'covered', coalesce(c.covered, al.covered),
           'access', coalesce(nullif(btrim(c.access), ''), al.access),
           'fee', coalesce(c.fee, al.fee),
           'court_count', coalesce(c.court_count, al.court_count),
           'opening_hours', coalesce(nullif(btrim(c.opening_hours), ''), al.opening_hours),
           'website', coalesce(nullif(btrim(c.website), ''), al.website),
           'phone', coalesce(nullif(btrim(c.phone), ''), al.phone),
           'attribution', c.attribution,
           'source_url', c.source_url,
           'unconfirmed', c.confirmation_status = 'unconfirmed',
           'has_boundary', c.boundary is not null,
           'alias_count', coalesce(al.n, 0),
           'league_count', (
             select count(*)
               from public.leagues l
              where l.home_venue_id in (select c.id union all select a.id from public.venues a where a.canonical_id = c.id)
                and coalesce(l.is_active, true)
                and (coalesce(l.is_open, true)
                     or exists (select 1 from public.league_members m
                                 where m.league_id = l.id and m.user_id = p_viewer
                                   and (m.expires_at is null or m.expires_at > now())))
           ),
           'distance_m', null
         )
    from public.venues c
    left join lateral (
      select count(*) as n,
             (array_agg(nullif(btrim(a.address), '') order by a.id) filter (where nullif(btrim(a.address), '') is not null))[1] as address,
             (array_agg(nullif(btrim(a.city), '') order by a.id) filter (where nullif(btrim(a.city), '') is not null))[1] as city,
             (array_agg(nullif(btrim(a.surface), '') order by a.id) filter (where nullif(btrim(a.surface), '') is not null))[1] as surface,
             (array_agg(a.indoor order by a.id) filter (where a.indoor is not null))[1] as indoor,
             (array_agg(a.lit order by a.id) filter (where a.lit is not null))[1] as lit,
             (array_agg(a.covered order by a.id) filter (where a.covered is not null))[1] as covered,
             (array_agg(nullif(btrim(a.access), '') order by a.id) filter (where nullif(btrim(a.access), '') is not null))[1] as access,
             (array_agg(a.fee order by a.id) filter (where a.fee is not null))[1] as fee,
             (array_agg(a.court_count order by a.id) filter (where a.court_count is not null))[1] as court_count,
             (array_agg(nullif(btrim(a.opening_hours), '') order by a.id) filter (where nullif(btrim(a.opening_hours), '') is not null))[1] as opening_hours,
             (array_agg(nullif(btrim(a.website), '') order by a.id) filter (where nullif(btrim(a.website), '') is not null))[1] as website,
             (array_agg(nullif(btrim(a.phone), '') order by a.id) filter (where nullif(btrim(a.phone), '') is not null))[1] as phone
        from public.venues a
       where a.canonical_id = c.id
         and a.confirmation_status <> 'rejected'
    ) al on true
   where c.id = p_id;
$$;
revoke all on function public._pl_court_catalog_json(text, uuid) from public, anon, authenticated;


-- ── 3. list_courts_nearby ──────────────────────────────────────────────────
create or replace function public.list_courts_nearby(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m double precision default 8047,
  p_sports   text[] default null,
  p_limit    int default 50,
  p_after_m  double precision default null,
  p_after_id text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  -- 100 m to 50 mi; anything else is clamped, not refused.
  v_radius double precision := greatest(100, least(coalesce(p_radius_m, 8047), 80467));
  v_limit  int := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or coalesce(cardinality(p_sports), 0) = 0 then
    raise exception using message = 'That didn''t go through because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;

  return coalesce((
    select jsonb_agg(public._pl_court_catalog_json(h.id, v_me) || jsonb_build_object('distance_m', h.d)
                     order by h.d, h.id)
      from (
        select c.id, public.haversine_meters(p_lat, p_lng, c.lat, c.lng) as d
          from public.venues c
         where c.canonical_id is null
           and c.confirmation_status <> 'rejected'
           -- Index-served prefilter. Spelled exactly as venues_point_geog_idx.
           and extensions.st_dwithin(
                 (extensions.st_setsrid(extensions.st_makepoint(c.lng, c.lat), 4326))::extensions.geography,
                 (extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326))::extensions.geography,
                 v_radius * 1.01 + 25)
           -- Haversine is the authority (the distance players see).
           and public.haversine_meters(p_lat, p_lng, c.lat, c.lng) <= v_radius
           and (c.sport && p_sports
                or exists (select 1 from public.venues a
                            where a.canonical_id = c.id
                              and a.confirmation_status <> 'rejected'
                              and a.sport && p_sports))
           and (p_after_m is null
                or public.haversine_meters(p_lat, p_lng, c.lat, c.lng) > p_after_m
                or (public.haversine_meters(p_lat, p_lng, c.lat, c.lng) = p_after_m
                    and c.id > coalesce(p_after_id, '')))
         order by d, c.id
         limit v_limit
      ) h
  ), '[]'::jsonb);
end $$;
revoke all on function public.list_courts_nearby(double precision, double precision, double precision, text[], int, double precision, text) from public, anon;
grant execute on function public.list_courts_nearby(double precision, double precision, double precision, text[], int, double precision, text) to authenticated;


-- ── 4. get_court ───────────────────────────────────────────────────────────
create or replace function public.get_court(p_venue text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_canon text;
  v_row   public.venues%rowtype;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if nullif(btrim(p_venue), '') is null then
    raise exception using message = 'That didn''t go through because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;

  select coalesce(v.canonical_id, v.id) into v_canon from public.venues v where v.id = p_venue;
  select * into v_row from public.venues v where v.id = v_canon;
  if v_row.id is null or v_row.confirmation_status = 'rejected' then
    raise exception using message = 'That court isn''t in Pickleague any more. Find it again from Courts.', hint = 'pl:court.gone';
  end if;

  return public._pl_court_catalog_json(v_row.id, v_me) || jsonb_build_object(
    'requested_id', p_venue,
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source) order by a.id)
        from public.venues a
       where a.canonical_id = v_row.id and a.confirmation_status <> 'rejected'
    ), '[]'::jsonb),
    'boundary', v_row.boundary,
    'geofence_radius_m', v_row.geofence_radius_m,
    'leagues', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name) order by lower(l.name), l.id)
        from public.leagues l
       where l.home_venue_id in (select v_row.id union all select a.id from public.venues a where a.canonical_id = v_row.id)
         and coalesce(l.is_active, true)
         and (coalesce(l.is_open, true)
              or exists (select 1 from public.league_members m
                          where m.league_id = l.id and m.user_id = v_me
                            and (m.expires_at is null or m.expires_at > now())))
    ), '[]'::jsonb)
  );
end $$;
revoke all on function public.get_court(text) from public, anon;
grant execute on function public.get_court(text) to authenticated;

notify pgrst, 'reload schema';
