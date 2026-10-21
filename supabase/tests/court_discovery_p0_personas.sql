-- ============================================================
-- Court discovery Phase 0 persona tests (state/court-discovery-plan.md,
-- supabase/migration_venue_data_guards.sql).
--
-- NOT runnable on its own: build-court-discovery-p0-test.mjs wraps it as
--   begin; <this file up to the marker> <migration_venue_data_guards.sql,
--   twice (re-runnable)> <migration_rls_hardening_2026q3.sql re-run>
--   <the rest of this file> rollback;
-- and the last statement selects the results. Run (from the linked checkout):
--   node supabase/tests/build-court-discovery-p0-test.mjs <out.sql>
--   supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Self-contained: every test court sits in the open Pacific near 30 N, 140 W,
-- far from any real venue (T0 checks), and is deleted by the rollback. One
-- temporary account (auth.users insert; the signup trigger makes the profile)
-- stars a court for the purge test. Distances: 0.001 deg of latitude = 111 m.
-- ============================================================

-- @@MIGRATIONS@@


-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The canonical id a venue resolves to.
create function pg_temp.canon(p_id text) returns text language sql stable as $$
  select coalesce(v.canonical_id, v.id) from public.venues v where v.id = p_id
$$;
create function pg_temp.same(a text, b text) returns boolean language sql stable as $$
  select pg_temp.canon(a) = pg_temp.canon(b)
$$;

-- T0: the test area is empty, so nothing real joins a test cluster.
select pg_temp.ok('T0 no real venue near 30 N 140 W',
  not exists (select 1 from public.venues v
               where v.lat between 29.9 and 30.4 and v.lng between -140.1 and -139.9));

insert into auth.users (id, email, raw_user_meta_data) values
  ('b0000000-0000-4000-8000-0000000000a1', 'p0-star@pickleague.test', '{"full_name":"Sid Starrer"}');

-- Test courts. Every row is pickleball unless named otherwise.
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  -- T1 Lincoln Park: a Google child POI 108 m from its parent
  ('test:p0-lp-child',  array['pickleball'], 'Pickleball Courts | Lincoln Park', 'court', 30.000,    -140.0, 'google', 100),
  ('test:p0-lp-parent', array['pickleball'], 'Lincoln Park',                     'court', 30.000971, -140.0, 'google', 100),
  -- T2 identical names: 199 m merge, 260 m don't
  ('test:p0-mg-a',      array['pickleball'], 'Maple Grove Pickleball',  'court', 30.020,    -140.0, 'osm', 100),
  ('test:p0-mg-b',      array['pickleball'], 'Maple-Grove  Pickleball', 'court', 30.02179,  -140.0, 'osm', 100),
  ('test:p0-bh-a',      array['pickleball'], 'Birch Hollow Courts',     'court', 30.040,    -140.0, 'osm', 100),
  ('test:p0-bh-b',      array['pickleball'], 'Birch Hollow Courts',     'court', 30.04234,  -140.0, 'osm', 100),
  -- T3 hand links: 800 m apart (no automatic rule), plus a chain and a pin
  ('test:p0-quarry',    array['pickleball'], 'Quarry Lane Courts',      'court', 30.060,    -140.0, 'google', 100),
  ('test:p0-stone',     array['pickleball'], 'Stonebridge Rec Center',  'court', 30.0672,   -140.0, 'osm', 100),
  ('test:p0-granite',   array['tennis'],     'Granite Spur Courts',     'court', 30.0744,   -140.0, 'osm', 100),
  ('test:p0-cedar-a',   array['pickleball'], 'Cedar Point Courts',      'court', 30.080,    -140.0, 'osm', 100),
  ('test:p0-cedar-b',   array['pickleball'], 'Cedar Point Courts',      'court', 30.0809,   -140.0, 'osm', 100),
  -- T5 generic names, 120-150 m apart
  ('test:p0-tc-a',      array['pickleball'], 'Tennis Courts',            'court', 30.100,    -140.0, 'osm',    100),
  ('test:p0-tc-b',      array['pickleball'], 'Tennis Courts',            'court', 30.10135,  -140.0, 'google', 100),
  ('test:p0-park-kid',  array['pickleball'], 'Pickleball Courts | Park', 'court', 30.120,    -140.0, 'google', 100),
  ('test:p0-park',      array['pickleball'], 'Park',                     'court', 30.12108,  -140.0, 'google', 100),
  -- T6 digits and direction words, 120 m apart, plus a punctuation-only control
  ('test:p0-c1',        array['pickleball'], 'Court 1',                  'court', 30.140,    -140.0, 'osm', 100),
  ('test:p0-c2',        array['pickleball'], 'Court 2',                  'court', 30.14108,  -140.0, 'osm', 100),
  ('test:p0-lv1',       array['pickleball'], 'Lakeview Court 1',         'court', 30.160,    -140.0, 'osm', 100),
  ('test:p0-lv2',       array['pickleball'], 'Lakeview Court 2',         'court', 30.16108,  -140.0, 'osm', 100),
  ('test:p0-north',     array['pickleball'], 'North Ridge Park',         'court', 30.180,    -140.0, 'osm', 100),
  ('test:p0-south',     array['pickleball'], 'South Ridge Park',         'court', 30.18108,  -140.0, 'osm', 100),
  ('test:p0-rp2-kid',   array['pickleball'], 'Pickleball Courts | Ridge Park 2', 'court', 30.200, -140.0, 'google', 100),
  ('test:p0-rp',        array['pickleball'], 'Ridge Park',               'court', 30.20108,  -140.0, 'google', 100),
  ('test:p0-elm-a',     array['pickleball'], 'Elm Park #2',              'court', 30.220,    -140.0, 'osm', 100),
  ('test:p0-elm-b',     array['pickleball'], 'Elm Park 2',               'court', 30.22108,  -140.0, 'osm', 100),
  -- T7 one run over a sport set; a shared sport is required
  ('test:p0-oak-a',     array['pickleball','tennis'], 'Oak Hollow Courts', 'court', 30.240,  -140.0, 'osm', 100),
  ('test:p0-oak-b',     array['tennis'],              'Oak Hollow Courts', 'court', 30.2409, -140.0, 'osm', 100),
  ('test:p0-fir-a',     array['pickleball'],          'Fir Crest Courts',  'court', 30.260,  -140.0, 'osm', 100),
  ('test:p0-fir-b',     array['tennis'],              'Fir Crest Courts',  'court', 30.2609, -140.0, 'osm', 100),
  -- T4 outlines
  ('test:p0-admin',     array['pickleball'], 'Admin Outline Court',      'court', 30.280,    -140.0, 'osm', 150),
  ('test:p0-osmrow',    array['pickleball'], 'Loader Outline Court',     'court', 30.290,    -140.0, 'osm', 150),
  -- T8 purge (Google rows; expiry set below)
  ('test:p0-gp-fav',    array['pickleball'], 'Purge Starred Court',      'court', 30.300,    -140.0, 'google', 100),
  ('test:p0-gp-admin',  array['pickleball'], 'Purge Outlined Court',     'court', 30.310,    -140.0, 'google', 100),
  ('test:p0-gp-link',   array['pickleball'], 'Purge Linked Court',       'court', 30.320,    -140.0, 'google', 100),
  ('test:p0-gp-linker', array['pickleball'], 'Purge Linker Court',       'court', 30.330,    -140.0, 'osm',    100),
  ('test:p0-gp-free',   array['pickleball'], 'Purge Lonely Court',       'court', 30.340,    -140.0, 'google', 100),
  ('test:p0-gp-fresh',  array['pickleball'], 'Purge Fresh Court',        'court', 30.350,    -140.0, 'google', 100);


-- ════ T1 Lincoln Park ════════════════════════════════════════════════════
do $$
begin
  perform public._pl_dedupe_venues(array['pickleball']);
  perform pg_temp.ok('T1 the Lincoln Park pair is linked (child POI beside its parent)',
    pg_temp.same('test:p0-lp-child', 'test:p0-lp-parent'),
    format('%s m apart; child -> %s, parent -> %s',
           round(public.haversine_meters(30.000, -140.0, 30.000971, -140.0)),
           pg_temp.canon('test:p0-lp-child'), pg_temp.canon('test:p0-lp-parent')));
  perform pg_temp.ok('T1 ...beyond the v1 50 m rule (so the new rule linked it)',
    public.haversine_meters(30.000, -140.0, 30.000971, -140.0) > 50);
  -- The real pair, when the catalog has it (VENUE-DUPLICATES.md, 108 m).
  perform pg_temp.ok('T1 live catalog: Pickleball Courts | Lincoln Park <-> Lincoln Park (pickleball rows)',
    coalesce(bool_and(pg_temp.same(c.id, p.id)), true),
    case when count(*) = 0 then 'no such pickleball pair in the catalog (nothing to check)'
         else count(*) || ' pair(s): ' || string_agg(c.id || ' / ' || p.id, ', ') end)
    from public.venues c
    join public.venues p
      on p.name = 'Lincoln Park'
     and abs(p.lat - c.lat) < 0.003 and abs(p.lng - c.lng) < 0.004
     and public.haversine_meters(c.lat, c.lng, p.lat, p.lng) <= 250
   where c.name = 'Pickleball Courts | Lincoln Park'
     and c.sport @> array['pickleball'] and p.sport @> array['pickleball']
     and c.confirmation_status <> 'rejected' and p.confirmation_status <> 'rejected'
     and not exists (select 1 from public.venue_links l where l.venue_id in (c.id, p.id));
exception when others then
  perform pg_temp.ok('T1 block crashed', false, sqlerrm);
end $$;


-- ════ T2 Identical names within 250 m ════════════════════════════════════
do $$
begin
  perform pg_temp.ok('T2 identical normalised names 199 m apart merge (punctuation and spacing ignored)',
    pg_temp.same('test:p0-mg-a', 'test:p0-mg-b'));
  perform pg_temp.ok('T2 identical names 260 m apart stay separate',
    not pg_temp.same('test:p0-bh-a', 'test:p0-bh-b'));
exception when others then
  perform pg_temp.ok('T2 block crashed', false, sqlerrm);
end $$;


-- ════ T3 Hand links survive re-runs ══════════════════════════════════════
do $$
begin
  perform pg_temp.ok('T3 no automatic link 800 m apart',
    not pg_temp.same('test:p0-quarry', 'test:p0-stone'));
  perform pg_temp.ok('T3 identical names 100 m apart merge before the pin',
    pg_temp.same('test:p0-cedar-a', 'test:p0-cedar-b'));

  insert into public.venue_links (venue_id, canonical_id, note) values
    ('test:p0-quarry',  'test:p0-stone',  'test: hand link'),
    ('test:p0-granite', 'test:p0-quarry', 'test: chain through a linked row'),
    ('test:p0-cedar-b', null,             'test: keep separate');

  perform public._pl_dedupe_venues(array['pickleball']);
  perform pg_temp.ok('T3 a hand link applies on the next run',
    (select canonical_id from public.venues where id = 'test:p0-quarry') = 'test:p0-stone');
  perform public._pl_dedupe_venues(array['pickleball']);
  perform public._pl_dedupe_venues('pickleball');      -- the v1 call shape (wrapper)
  perform public._pl_dedupe_venues();                  -- and its default
  perform public._pl_dedupe_venues(array['basketball']);   -- another sport's run (no test row is basketball)
  perform pg_temp.ok('T3 the hand link survives a second run, the (text) wrapper and another sport''s run',
    (select canonical_id from public.venues where id = 'test:p0-quarry') = 'test:p0-stone');
  perform pg_temp.ok('T3 a link to a linked row follows the chain',
    (select canonical_id from public.venues where id = 'test:p0-granite') = 'test:p0-stone',
    (select coalesce(canonical_id, '(null)') from public.venues where id = 'test:p0-granite'));
  perform pg_temp.ok('T3 a pinned row (canonical_id null) is split from its automatic twin',
    not pg_temp.same('test:p0-cedar-a', 'test:p0-cedar-b')
    and (select canonical_id is null from public.venues where id = 'test:p0-cedar-b'));
  -- Live rows tagged basketball and pickleball flip back on the next
  -- pickleball run; the one after that must change nothing.
  perform public._pl_dedupe_venues(array['pickleball']);
  perform pg_temp.ok('T3 a repeat run changes nothing',
    public._pl_dedupe_venues(array['pickleball']) = 0);
exception when others then
  perform pg_temp.ok('T3 block crashed', false, sqlerrm);
end $$;


-- ════ T4 Admin outlines ══════════════════════════════════════════════════
do $$
declare
  v_poly jsonb := '{"type":"Polygon","coordinates":[[[-140.0005,30.2795],[-139.9995,30.2795],[-139.9995,30.2805],[-140.0005,30.2805],[-140.0005,30.2795]]]}';
  v_osm  jsonb := '{"type":"Polygon","coordinates":[[[-140.0003,30.2797],[-139.9997,30.2797],[-139.9997,30.2803],[-140.0003,30.2803],[-140.0003,30.2797]]]}';
  v_osm2 jsonb := '{"type":"Polygon","coordinates":[[[-140.0003,30.2897],[-139.9997,30.2897],[-139.9997,30.2903],[-140.0003,30.2903],[-140.0003,30.2897]]]}';
  v_res  jsonb;
  v_err  text;
begin
  -- Not godmode: refused, nothing stamped.
  perform pg_temp.as_user('b0000000-0000-4000-8000-0000000000a1');
  begin
    perform public.admin_save_venue_boundary('test:p0-admin', v_poly);
    v_err := 'no error';
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 a non-admin is refused', v_err = 'Admin access required', v_err);

  perform pg_temp.as_user('252a36e1-5d89-4ad2-8a3e-b786579f019a');   -- godmode
  v_res := public.admin_save_venue_boundary('test:p0-admin', v_poly);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 admin_save_venue_boundary marks the outline admin',
    (select boundary_source = 'admin' and boundary = v_poly from public.venues where id = 'test:p0-admin')
    and (v_res ->> 'has_boundary')::boolean and (v_res ->> 'pin_inside')::boolean, v_res::text);

  -- The OSM loader's SQL-mode upsert (load-osm-venues.mjs chunkSql) over an
  -- admin row and over an OSM row.
  update public.venues set boundary = v_osm2, boundary_source = 'osm' where id = 'test:p0-osmrow';
  insert into public.venues (id, sport, name, kind, lat, lng, source, boundary, boundary_source, geofence_radius_m)
  values ('test:p0-admin',  array['pickleball'], 'Admin Outline Court (OSM)',  'court', 30.280, -140.0, 'osm', v_osm, 'osm', 100),
         ('test:p0-osmrow', array['pickleball'], 'Loader Outline Court (OSM)', 'court', 30.290, -140.0, 'osm', null,  null,  100)
  on conflict (id) do update set name = excluded.name,
    boundary = case when venues.boundary_source = 'admin' then venues.boundary else excluded.boundary end,
    boundary_source = case when venues.boundary_source = 'admin' then venues.boundary_source else excluded.boundary_source end,
    geofence_radius_m = case when venues.boundary_source = 'admin' then venues.geofence_radius_m else excluded.geofence_radius_m end;
  perform pg_temp.ok('T4 a loader upsert keeps the admin outline, source and radius (and updates the rest)',
    (select boundary = v_poly and boundary_source = 'admin' and geofence_radius_m = 150
            and name = 'Admin Outline Court (OSM)' from public.venues where id = 'test:p0-admin'));
  perform pg_temp.ok('T4 ...while an OSM outline is still replaced',
    (select boundary is null and boundary_source is null and geofence_radius_m = 100
       from public.venues where id = 'test:p0-osmrow'));

  perform pg_temp.as_user('252a36e1-5d89-4ad2-8a3e-b786579f019a');
  v_res := public.admin_save_venue_boundary('test:p0-admin', null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 clearing an outline is an admin decision too',
    (select boundary is null and boundary_source = 'admin' from public.venues where id = 'test:p0-admin'), v_res::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 block crashed', false, sqlerrm);
end $$;


-- ════ T5 Generic names ═══════════════════════════════════════════════════
do $$
begin
  perform public._pl_dedupe_venues(array['pickleball']);
  perform pg_temp.ok('T5 two "Tennis Courts" 150 m apart stay separate',
    not pg_temp.same('test:p0-tc-a', 'test:p0-tc-b'));
  perform pg_temp.ok('T5 "Pickleball Courts | Park" beside "Park" stays separate',
    not pg_temp.same('test:p0-park-kid', 'test:p0-park'));
  perform pg_temp.ok('T5 _pl_venue_name_generic',
    public._pl_venue_name_generic('Tennis Courts') and public._pl_venue_name_generic('Court 1')
    and public._pl_venue_name_generic('North Courts') and public._pl_venue_name_generic('')
    and not public._pl_venue_name_generic('Lincoln Park')
    and not public._pl_venue_name_generic('Pickleball Courts | Lincoln Park'));
exception when others then
  perform pg_temp.ok('T5 block crashed', false, sqlerrm);
end $$;


-- ════ T6 Digits and direction words ══════════════════════════════════════
do $$
begin
  perform pg_temp.ok('T6 "Court 1" / "Court 2" 120 m apart stay separate',
    not pg_temp.same('test:p0-c1', 'test:p0-c2'));
  perform pg_temp.ok('T6 "Lakeview Court 1" / "Lakeview Court 2" 120 m apart stay separate',
    not pg_temp.same('test:p0-lv1', 'test:p0-lv2'));
  perform pg_temp.ok('T6 "North Ridge Park" / "South Ridge Park" 120 m apart stay separate',
    not pg_temp.same('test:p0-north', 'test:p0-south'));
  perform pg_temp.ok('T6 "Pickleball Courts | Ridge Park 2" beside "Ridge Park" stays separate',
    not pg_temp.same('test:p0-rp2-kid', 'test:p0-rp'));
  perform pg_temp.ok('T6 control: "Elm Park #2" / "Elm Park 2" (punctuation only) merge',
    pg_temp.same('test:p0-elm-a', 'test:p0-elm-b'));
  perform pg_temp.ok('T6 _pl_venue_name_key keeps digits and direction words',
    public._pl_venue_name_key('North  Ridge-Park #2') = 'north ridge park 2');
exception when others then
  perform pg_temp.ok('T6 block crashed', false, sqlerrm);
end $$;


-- ════ T7 One run over a sport set ════════════════════════════════════════
do $$
begin
  perform public._pl_dedupe_venues(array['pickleball']);
  perform pg_temp.ok('T7 a pickleball-only run leaves the tennis-only twin out',
    not pg_temp.same('test:p0-oak-a', 'test:p0-oak-b'));
  perform public._pl_dedupe_venues(array['pickleball', 'tennis']);
  perform pg_temp.ok('T7 one run over {pickleball, tennis} links twins that share tennis',
    pg_temp.same('test:p0-oak-a', 'test:p0-oak-b'));
  perform pg_temp.ok('T7 ...but not twins that share no sport',
    not pg_temp.same('test:p0-fir-a', 'test:p0-fir-b'));
  begin
    perform public._pl_dedupe_venues('{}'::text[]);
    perform pg_temp.ok('T7 an empty sport set is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T7 an empty sport set is refused (pl:request.bad)', sqlstate = 'P0001', sqlerrm);
  end;
  perform public._pl_dedupe_venues(array['pickleball']);   -- back to the production set
exception when others then
  perform pg_temp.ok('T7 block crashed', false, sqlerrm);
end $$;


-- ════ T8 Purge of expired Google rows ════════════════════════════════════
do $$
declare
  v_res jsonb;
  v_n   bigint;
begin
  update public.venues
     set details_expires_at = now() - interval '1 day', address = '1 Test Way', website = 'https://example.test',
         phone = '555-0100', opening_hours = 'Mo-Su 08:00-20:00'
   where id in ('test:p0-gp-fav', 'test:p0-gp-admin', 'test:p0-gp-link', 'test:p0-gp-free');
  update public.venues set details_expires_at = now() + interval '10 days', address = '2 Test Way'
   where id = 'test:p0-gp-fresh';
  update public.venues set boundary_source = 'admin' where id = 'test:p0-gp-admin';
  insert into public.court_favorites (user_id, venue_id) values ('b0000000-0000-4000-8000-0000000000a1', 'test:p0-gp-fav');
  insert into public.venue_links (venue_id, canonical_id, note) values ('test:p0-gp-linker', 'test:p0-gp-link', 'test: purge');

  select count(*) into v_n from public.venues;
  v_res := public._pl_purge_expired_google_venues(true);
  perform pg_temp.ok('T8 a purge dry run writes nothing',
    (select count(*) from public.venues) = v_n
    and (select count(*) = 4 from public.venues
          where id in ('test:p0-gp-fav', 'test:p0-gp-admin', 'test:p0-gp-link', 'test:p0-gp-free')
            and address = '1 Test Way' and details_expires_at < now())
    and (v_res ->> 'dry_run')::boolean, v_res::text);
  perform pg_temp.ok('T8 the dry run counts referenced rows as kept and the lonely one as deleted',
    (v_res ->> 'cleared')::int >= 3 and (v_res ->> 'deleted')::int >= 1,
    format('cleared %s, deleted %s of %s expired', v_res ->> 'cleared', v_res ->> 'deleted', v_res ->> 'expired'));
  perform pg_temp.ok('T8 the purge helper is service_role only',
    has_function_privilege('service_role', 'public._pl_purge_expired_google_venues(boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_purge_expired_google_venues(boolean)', 'execute')
    and not has_function_privilege('anon', 'public._pl_purge_expired_google_venues(boolean)', 'execute'));

  v_res := public._pl_purge_expired_google_venues(false);
  perform pg_temp.ok('T8 a real purge keeps the starred, admin-outlined and hand-linked rows',
    (select count(*) = 3 from public.venues
      where id in ('test:p0-gp-fav', 'test:p0-gp-admin', 'test:p0-gp-link')), v_res::text);
  perform pg_temp.ok('T8 ...clearing their cached display fields, keeping name and pin',
    (select bool_and(address is null and website is null and phone is null and opening_hours is null
                     and details_expires_at is null and name like 'Purge %' and lat is not null)
       from public.venues where id in ('test:p0-gp-fav', 'test:p0-gp-admin', 'test:p0-gp-link')));
  perform pg_temp.ok('T8 ...and the star and the hand link survive',
    exists (select 1 from public.court_favorites where venue_id = 'test:p0-gp-fav')
    and exists (select 1 from public.venue_links where venue_id = 'test:p0-gp-linker' and canonical_id = 'test:p0-gp-link'));
  perform pg_temp.ok('T8 the unreferenced expired row is deleted; an unexpired one is untouched',
    not exists (select 1 from public.venues where id = 'test:p0-gp-free')
    and exists (select 1 from public.venues where id = 'test:p0-gp-fresh' and address = '2 Test Way'));
exception when others then
  perform pg_temp.ok('T8 block crashed', false, sqlerrm);
end $$;


-- ════ T9 Grants and RLS ══════════════════════════════════════════════════
select pg_temp.ok('T9 admin_save_venue_boundary / admin_list_venue_boundaries: authenticated yes, anon no (after the hardening re-run)',
  has_function_privilege('authenticated', 'public.admin_save_venue_boundary(text, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_list_venue_boundaries(text, text, int)', 'execute')
  and not has_function_privilege('anon', 'public.admin_save_venue_boundary(text, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.admin_list_venue_boundaries(text, text, int)', 'execute'));
select pg_temp.ok('T9 internal helpers are closed to clients',
  bool_and(not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')),
  string_agg(f, ', ') filter (where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')))
  from unnest(array['public._pl_dedupe_venues(text[])', 'public._pl_dedupe_venues(text)',
                    'public._pl_venue_name_key(text)', 'public._pl_venue_name_generic(text)',
                    'public._pl_venue_referenced(text)']) f;
select pg_temp.ok('T9 venue_links: RLS on, no client access',
  (select relrowsecurity from pg_class where oid = 'public.venue_links'::regclass)
  and not has_table_privilege('authenticated', 'public.venue_links', 'select')
  and not has_table_privilege('anon', 'public.venue_links', 'select'));
select pg_temp.ok('T9 venues.boundary_source exists with its check',
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'venues' and column_name = 'boundary_source'));


-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;
