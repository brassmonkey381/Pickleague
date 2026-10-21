-- ============================================================
-- Court discovery, Phase 0: clean the catalog (state/court-discovery-plan.md,
-- VENUE-DUPLICATES.md).
--
-- What changes:
--   1. venues.boundary_source ('osm' | 'admin' | null). admin_save_venue_boundary
--      (same signature, same checks) now stamps 'admin', also when it clears an
--      outline, so "this court has no outline" is an admin decision too.
--      scripts/load-osm-venues.mjs leaves boundary and geofence_radius_m alone
--      on 'admin' rows. One-time backfill (only when the column is first
--      added): every row with an outline that a loader could not have written
--      (non-OSM rows), or that changed since the outline editor shipped
--      (2026-10-17), is 'admin'; older OSM outlines are 'osm'.
--   2. venue_links: hand links that _pl_dedupe_venues honours before anything
--      else. canonical_id set = "venue_id is a copy of canonical_id";
--      canonical_id null = "venue_id stands alone, never merge it
--      automatically" (undoes a bad automatic merge). RLS on, no policies:
--      written by hand (SQL editor / supabase/data_venue_links_seed.sql).
--   3. _pl_dedupe_venues(text[]) v2, one run over a sport SET (rows tagged
--      with two sports used to flip between per-sport runs). The (text) form
--      stays as a wrapper, so `select public._pl_dedupe_venues();` still works.
--      Keeps every v1 rule (<= 50 m similar names, a point inside another's
--      outline, bare pitch labels) and adds the two VENUE-DUPLICATES.md rules,
--      both within 250 m and both requiring a shared sport from the set:
--        a. identical normalised names (lowercase, punctuation -> space,
--           whitespace collapsed; digits and direction words are KEPT, so
--           'Robb Field 1' / 'Robb Field 2' and 'North X' / 'South X' differ);
--        b. a Google child POI 'X | Parent' beside a venue named 'Parent'
--           ('Pickleball Courts | Lincoln Park' <-> 'Lincoln Park', 108 m).
--      Neither new rule fires on a generic name ('Tennis Courts', 'Court 1',
--      'Pickleball Courts | Park'): one with nothing left once sport, court,
--      park, digit and direction words are removed.
--      Hand-linked rows sit out the automatic rules and take their target's
--      final canonical id (links chain); pinned rows (canonical_id null) stay
--      canonical.
--   4. _pl_purge_expired_google_venues(p_dry_run): what
--      `ingest-google-venues.mjs --purge-expired` now calls. An expired Google
--      row that anything references keeps its id, name and pin and loses its
--      cached display fields; only unreferenced rows are deleted.
--
-- Not changed: admin_save_venue_boundary and admin_list_venue_boundaries are
-- already in the migration_rls_hardening_2026q3.sql allowlist (added
-- 2026-10-19). The new functions here are internal: EXECUTE revoked from
-- public/anon/authenticated (service_role keeps it, for the scripts).
--
-- Apply order: after migration_presence_p1_schema.sql (canonical_id, v1
-- dedupe), migration_admin_venue_boundary.sql and
-- migration_add_venue_google_cache.sql. Then supabase/data_venue_links_seed.sql
-- (links + the dedupe run). A re-run of migration_presence_p1_schema.sql puts
-- the v1 body back on _pl_dedupe_venues(text): re-apply this file after it.
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_venue_data_guards.sql
-- Tested by supabase/tests/court_discovery_p0_personas.sql
-- (node supabase/tests/build-court-discovery-p0-test.mjs).
-- ============================================================


-- ── 1. venues.boundary_source ──────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'venues'
                    and column_name = 'boundary_source') then
    alter table public.venues add column boundary_source text
      check (boundary_source in ('osm', 'admin'));
    -- One-time backfill, only when the column is first added. A loader never
    -- writes an outline on a non-OSM row, and the editor shipped 2026-10-17:
    -- an OSM outline changed since then may be an admin's, so protect it.
    execute $q$
      update public.venues
         set boundary_source = case
               when source <> 'osm' or updated_at >= timestamptz '2026-10-17 00:00:00+00' then 'admin'
               else 'osm' end
       where boundary is not null
    $q$;
  end if;
end $$;
comment on column public.venues.boundary_source is
  'Who drew venues.boundary: osm (load-osm-venues.mjs) or admin (admin_save_venue_boundary). '
  'The OSM loader never overwrites boundary or geofence_radius_m on an admin row.';


-- ── 2. venue_links (hand links) ────────────────────────────────────────────
create table if not exists public.venue_links (
  venue_id     text primary key references public.venues (id) on delete cascade,
  canonical_id text references public.venues (id) on delete cascade,  -- null = keep separate
  set_by       uuid references public.profiles (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now(),
  check (canonical_id is null or canonical_id <> venue_id)
);
create index if not exists venue_links_canonical_idx on public.venue_links (canonical_id) where canonical_id is not null;
alter table public.venue_links enable row level security;   -- no policies: SQL only
revoke all on public.venue_links from anon, authenticated;
comment on table public.venue_links is
  'Hand links honoured by _pl_dedupe_venues before its automatic rules. canonical_id set: venue_id is a '
  'copy of it. canonical_id null: venue_id stands alone (never merged automatically).';


-- ── 3. Name helpers (internal) ─────────────────────────────────────────────
-- The VENUE-DUPLICATES.md normalisation: lowercase, punctuation to spaces,
-- whitespace collapsed. Digits and every word are kept.
create or replace function public._pl_venue_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9 ]', ' ', 'g')), '\s+', ' ', 'g'));
$$;
revoke all on function public._pl_venue_name_key(text) from public, anon, authenticated;

-- True when nothing distinctive is left once sport, court, park, filler,
-- digit and direction words go: 'Tennis Courts', 'Court 1', 'North Courts',
-- 'Park'. Such a name can't say two pins 250 m apart are one place.
create or replace function public._pl_venue_name_generic(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (
    select 1
      from regexp_split_to_table(public._pl_venue_name_key(p_name), ' ') t
     where t <> ''
       and t !~ '[0-9]'
       and t <> all (array[
         'court','courts','ct','cts','tennis','pickleball','pickle','ball','basketball','volleyball',
         'paddle','racquet','racket','sport','sports','park','parks','playground','field','fields',
         'center','centre','complex','facility','facilities','recreation','rec','area','public',
         'community','club','the','and','of','at','a','outdoor','outdoors','indoor','gym','game',
         'games','multi','use','multipurpose','purpose','play','hard','pitch','pitches',
         'north','south','east','west','northeast','northwest','southeast','southwest',
         'upper','lower','inner','outer','new','old','main'])
  );
$$;
revoke all on function public._pl_venue_name_generic(text) from public, anon, authenticated;


-- ── 4. _pl_dedupe_venues v2 ────────────────────────────────────────────────
-- Deterministic, non-destructive dedupe of the venues tagged with any sport
-- in p_sports (not rejected). Order:
--   1. Hand links (venue_links) take their rows out of the automatic rules.
--   2. Automatic pairs, every one needing a sport the two rows share from
--      p_sports:
--        v1  within 50 m with similar names (_pl_similar_court_names);
--        v1  an OSM point inside another venue's outline;
--        v1  bare pitch labels ('1', 'Court 3') group within 50 m (or inside
--            an outline) and each group joins ONE named venue;
--        new within 250 m, identical normalised names (neither generic);
--        new within 250 m, 'X | Parent' beside a venue named 'Parent'
--            (Parent not generic).
--      Facilities are the connected groups; each one's canonical row is the
--      one with an outline, then a Google row, then the lowest id (as v1).
--   3. Pinned rows (venue_links.canonical_id null) are canonical; linked rows
--      take their target's canonical id after step 2 (following link chains,
--      up to 10 deep).
--   4. Rows that store canonical ids are repointed (as v1).
-- Nothing is deleted. Returns how many venues' canonical_id changed.
-- Re-run after a venue ingest or a new hand link:
--   select public._pl_dedupe_venues(array['pickleball']);
create or replace function public._pl_dedupe_venues(p_sports text[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
  v_m int;
begin
  if p_sports is null or cardinality(p_sports) = 0 or array_position(p_sports, null) is not null then
    raise exception using message = '_pl_dedupe_venues needs at least one sport.', hint = 'pl:request.bad';
  end if;

  with recursive p as (
    select v.id, v.name, v.lat, v.lng, v.source, v.boundary_geom, v.sport,
           coalesce(v.name ~* '^\s*(court\s*)?#?\d+[a-z]?\s*$', false) as bare,
           public._pl_venue_name_key(v.name) as nkey,
           public._pl_venue_name_generic(v.name) as generic,
           case when v.name ~ ' \| ' then substring(v.name from '^.* \| (.+)$') end as parent
      from public.venues v
     where v.sport && p_sports
       and v.confirmation_status <> 'rejected'
       and not exists (select 1 from public.venue_links l where l.venue_id = v.id)
  ),
  near as (
    select a.id as a, b.id as b, a.bare as a_bare, b.bare as b_bare,
           public.haversine_meters(a.lat, a.lng, b.lat, b.lng) as m,
           public._pl_similar_court_names(a.name, b.name) as name_match
      from p a
      join p b on b.id <> a.id
              and abs(a.lat - b.lat) < 0.001 and abs(a.lng - b.lng) < 0.0015
     where public.haversine_meters(a.lat, a.lng, b.lat, b.lng) <= 50
       and exists (select 1 from unnest(p_sports) s where s = any (a.sport) and s = any (b.sport))
  ),
  inside as (
    select a.id as a, b.id as b, a.bare as a_bare, b.bare as b_bare
      from p a
      join p b on b.id <> a.id and b.source = 'osm' and b.boundary_geom is null
     where a.boundary_geom is not null
       and extensions.st_contains(a.boundary_geom, extensions.st_setsrid(extensions.st_makepoint(b.lng, b.lat), 4326))
       and exists (select 1 from unnest(p_sports) s where s = any (a.sport) and s = any (b.sport))
  ),
  -- The two VENUE-DUPLICATES.md rules, out to 250 m.
  wide as (
    select a.id as a, b.id as b
      from p a
      join p b on a.id < b.id
              and abs(a.lat - b.lat) < 0.0023
              and abs(a.lng - b.lng) < 0.0023 / greatest(cos(radians(a.lat)), 0.2)
     where not a.generic and not b.generic
       and (a.nkey = b.nkey
            or (a.parent is not null and not public._pl_venue_name_generic(a.parent)
                and public._pl_venue_name_key(a.parent) = b.nkey)
            or (b.parent is not null and not public._pl_venue_name_generic(b.parent)
                and public._pl_venue_name_key(b.parent) = a.nkey))
       and public.haversine_meters(a.lat, a.lng, b.lat, b.lng) <= 250
       and exists (select 1 from unnest(p_sports) s where s = any (a.sport) and s = any (b.sport))
  ),
  -- Bare court labels first group among themselves ...
  bare_edges as (
    select a, b from near where a_bare and b_bare
    union
    select a, b from inside where a_bare and b_bare
    union
    select b, a from inside where a_bare and b_bare
  ),
  bare_reach (node, other) as (
    select id, id from p where bare
    union
    select r.node, e.b from bare_reach r join bare_edges e on e.a = r.other
  ),
  bare_cluster as (
    select node, min(other) as cluster from bare_reach group by node
  ),
  -- ... then each group joins ONE named venue: a boundary that holds a member
  -- (or a named point a bare boundary holds), else the nearest within 50 m.
  anchor as (
    select distinct on (c.cluster) c.cluster, x.named
      from bare_cluster c
      join (select i.b as node, i.a as named, 0 as rk, 0::double precision as m from inside i where i.b_bare and not i.a_bare
            union all
            select i.a, i.b, 0, 0 from inside i where i.a_bare and not i.b_bare
            union all
            select n.a, n.b, 1, n.m from near n where n.a_bare and not n.b_bare) x on x.node = c.node
     order by c.cluster, x.rk, x.m, x.named
  ),
  pairs as (
    select a, b from near where not a_bare and not b_bare and name_match
    union
    select a, b from inside where not a_bare and not b_bare
    union
    select a, b from wide
    union
    select a, b from bare_edges
    union
    select cluster, named from anchor
  ),
  edges as (
    select a, b from pairs union select b, a from pairs
  ),
  reach (node, other) as (
    select id, id from p
    union
    select r.node, e.b from reach r join edges e on e.a = r.other
  ),
  canon as (
    select r.node,
           (array_agg(p.id order by (p.boundary_geom is not null) desc, (p.source = 'google') desc, p.id))[1] as rep
      from reach r join p on p.id = r.other
     group by r.node
  )
  update public.venues v
     set canonical_id = nullif(c.rep, v.id)
    from canon c
   where v.id = c.node
     and v.canonical_id is distinct from nullif(c.rep, v.id);
  get diagnostics v_n = row_count;

  -- Pinned rows stand alone (before the links, which may point at them).
  update public.venues v
     set canonical_id = null
    from public.venue_links l
   where l.venue_id = v.id and l.canonical_id is null and v.canonical_id is not null;
  get diagnostics v_m = row_count;
  v_n := v_n + v_m;

  -- Linked rows: the final canonical id of the end of their link chain.
  with recursive chain as (
    select l.venue_id, l.canonical_id as target, 1 as depth
      from public.venue_links l where l.canonical_id is not null
    union all
    select c.venue_id, l.canonical_id, c.depth + 1
      from chain c join public.venue_links l on l.venue_id = c.target
     where l.canonical_id is not null and c.depth < 10
  ),
  last_hop as (
    select distinct on (c.venue_id) c.venue_id, c.target
      from chain c order by c.venue_id, c.depth desc
  ),
  want as (
    select h.venue_id, nullif(coalesce(t.canonical_id, t.id), h.venue_id) as canon
      from last_hop h join public.venues t on t.id = h.target
  )
  update public.venues v
     set canonical_id = w.canon
    from want w
   where v.id = w.venue_id and v.canonical_id is distinct from w.canon;
  get diagnostics v_m = row_count;
  v_n := v_n + v_m;

  -- Rows that promise a canonical id.
  update public.venue_checkins c set venue_id = v.canonical_id
    from public.venues v where v.id = c.venue_id and v.canonical_id is not null;
  update public.play_sessions s set venue_id = v.canonical_id
    from public.venues v where v.id = s.venue_id and v.canonical_id is not null;
  update public.leagues l set home_venue_id = v.canonical_id
    from public.venues v where v.id = l.home_venue_id and v.canonical_id is not null;
  update public.court_locations cl set venue_id = v.canonical_id
    from public.venues v where v.id = cl.venue_id and v.canonical_id is not null;
  insert into public.court_favorites (user_id, venue_id, created_at)
  select f.user_id, v.canonical_id, f.created_at
    from public.court_favorites f join public.venues v on v.id = f.venue_id
   where v.canonical_id is not null
  on conflict do nothing;
  delete from public.court_favorites f
   using public.venues v
   where v.id = f.venue_id and v.canonical_id is not null;
  return v_n;
end $$;
revoke all on function public._pl_dedupe_venues(text[]) from public, anon, authenticated;

-- The v1 call shape. No default on the text[] form above, so a bare
-- `select public._pl_dedupe_venues();` resolves here unambiguously.
create or replace function public._pl_dedupe_venues(p_sport text default 'pickleball')
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public._pl_dedupe_venues(array[coalesce(p_sport, 'pickleball')]);
end $$;
revoke all on function public._pl_dedupe_venues(text) from public, anon, authenticated;


-- ── 5. admin_save_venue_boundary stamps 'admin' ────────────────────────────
-- migration_admin_venue_boundary.sql, unchanged but for boundary_source.
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

  update public.venues set boundary = p_boundary, boundary_source = 'admin' where id = p_venue_id;
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


-- ── 6. Expired Google rows: clear what's referenced, delete the rest ───────
-- Google's terms: place_id may be kept; display fields are a 30-day cache.
-- A venue is referenced when anything points at it: check-ins, stars, a
-- league home court, a play session, a drill court location, a submission
-- affirmation, a hand link (either side), another venue's canonical_id (it
-- is a canonical row), its own canonical_id (it is an alias), or an admin
-- outline. Deleting one of those would cascade its check-ins and stars away
-- and null the rest. (pl_pending_arrivals has no FK on purpose and lives
-- minutes; its processor already handles a court that disappears.)
create or replace function public._pl_venue_referenced(p_venue text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.venues v
                  where v.id = p_venue and (v.canonical_id is not null or v.boundary_source = 'admin'))
      or exists (select 1 from public.venues a where a.canonical_id = p_venue)
      or exists (select 1 from public.venue_checkins c where c.venue_id = p_venue)
      or exists (select 1 from public.court_favorites f where f.venue_id = p_venue)
      or exists (select 1 from public.leagues l where l.home_venue_id = p_venue)
      or exists (select 1 from public.play_sessions s where s.venue_id = p_venue)
      or exists (select 1 from public.court_locations cl where cl.venue_id = p_venue)
      or exists (select 1 from public.venue_submission_affirmations sa where sa.affirmed_venue_id = p_venue)
      or exists (select 1 from public.venue_links k where k.venue_id = p_venue or k.canonical_id = p_venue);
$$;
revoke all on function public._pl_venue_referenced(text) from public, anon, authenticated;

-- What `ingest-google-venues.mjs --purge-expired` calls. Expired Google rows
-- that are referenced keep id, name, pin, external_id and source_url and lose
-- address, website, phone and opening_hours; details_expires_at goes null (an
-- ingest refresh stamps it again). Only unreferenced rows are deleted, and the
-- delete re-checks, so a check-in landing meanwhile keeps its court. With
-- p_dry_run (the default) nothing is written.
-- Returns {dry_run, expired, cleared, deleted, kept_ids, deleted_ids} (ids:
-- the first 50 of each).
create or replace function public._pl_purge_expired_google_venues(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dry     boolean := coalesce(p_dry_run, true);
  v_expired int;
  v_ref     text[];
  v_free    text[];
  v_cleared int;
  v_deleted int;
begin
  select count(*)::int,
         coalesce(array_agg(x.id order by x.id) filter (where x.referenced), '{}'),
         coalesce(array_agg(x.id order by x.id) filter (where not x.referenced), '{}')
    into v_expired, v_ref, v_free
    from (select v.id, public._pl_venue_referenced(v.id) as referenced
            from public.venues v
           where v.source = 'google' and v.details_expires_at < now()) x;

  if v_dry then
    v_cleared := cardinality(v_ref);
    v_deleted := cardinality(v_free);
  else
    delete from public.venues v
     where v.id = any (v_free) and not public._pl_venue_referenced(v.id);
    get diagnostics v_deleted = row_count;
    update public.venues v
       set address = null, website = null, phone = null, opening_hours = null, details_expires_at = null
     where v.source = 'google' and v.details_expires_at < now();
    get diagnostics v_cleared = row_count;
  end if;

  return jsonb_build_object('dry_run', v_dry, 'expired', v_expired,
                            'cleared', v_cleared, 'deleted', v_deleted,
                            'kept_ids', to_jsonb(v_ref[1:50]), 'deleted_ids', to_jsonb(v_free[1:50]));
end $$;
revoke all on function public._pl_purge_expired_google_venues(boolean) from public, anon, authenticated;
grant execute on function public._pl_purge_expired_google_venues(boolean) to service_role;

notify pgrst, 'reload schema';
