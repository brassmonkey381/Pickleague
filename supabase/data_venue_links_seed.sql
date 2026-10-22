-- ============================================================
-- Court discovery, Phase 0 data: hand links for the duplicate pairs named in
-- VENUE-DUPLICATES.md (2026-08-09), then the v2 dedupe for pickleball (the
-- plan's decision 2: pickleball only).
--
-- The doc names pairs by name, source and separation, not by id, so each pair
-- is looked up by those three: both normalised names (_pl_venue_name_key),
-- both sources, and a separation within 5 m of the doc's figure. Every lookup
-- must match exactly one pair; if any matches none or several, NOTHING is
-- inserted and the error lists every failed pair (fix the spec below, re-run).
--
-- Each link points the row that would lose under the dedupe's own order (an
-- outline first, then a Google row, then the lowest id) at the one that wins,
-- except a Google child POI ('X | Parent'), which always points at its parent.
-- Existing links are left alone (on conflict do nothing), so a later hand
-- edit survives a re-run. Re-runnable.
--
-- Left out on purpose: '[google] Tennis Courts <-> [osm] Tennis Courts'
-- (20 m). The name is generic, so a name + distance lookup can't pin one pair;
-- if it is pickleball, the v1 50 m rule already merges it.
-- Also left out: '[osm] Municipal Tennis and Pickleball Center' x2 (33 m).
-- Live has 22 rows of that name (one per court, Santa Barbara), so the
-- lookup matched 24 pairs (2026-10-21).
--
-- Needs migration_venue_data_guards.sql.
--   supabase db query --linked -f supabase/data_venue_links_seed.sql -o csv
-- ============================================================

do $$
declare
  r        record;
  v_hits   int;
  v_a      text;
  v_b      text;
  v_win    text;
  v_errors text[] := '{}';
  v_links  text[][] := '{}';
  v_i      int;
begin
  for r in
    select * from (values
      -- name_a,                                   source_a, name_b,                              source_b, metres, a_is_child_of_b
      ('Pickleball Courts | Lincoln Park',          'google', 'Lincoln Park',                      'google', 108, true),
      ('Tennis courts | Braly Park',                'google', 'Braly Park',                        'google', 101, true),
      ('Pickleball Courts | Leydecker Park',        'google', 'Leydecker Park',                    'google', 154, true),
      ('Pioneer Stadium',                           'osm',    'Pioneer Stadium',                   'osm',      2, false),
      ('High Country Sports Arena',                 'osm',    'High Country Sports Arena',         'osm',      5, false),
      ('Haas Pavilion',                             'google', 'Haas Pavilion',                     'osm',      5, false),
      ('Tice Creek Fitness Center at Rossmoor',     'google', 'Tice Creek Fitness Center',         'osm',      6, false),
      ('City Sports Club',                          'google', 'City Sports Club',                  'osm',     25, false),
      ('CenterLine 33',                             'google', 'Centerline 33',                     'osm',     25, false)
    ) s (name_a, source_a, name_b, source_b, metres, a_is_child)
  loop
    -- Unordered pairs: two rows with the same name would otherwise match twice.
    select count(*), min(x.a), min(x.b)
      into v_hits, v_a, v_b
      from (
        select distinct
               case when r.name_a = r.name_b and r.source_a = r.source_b then least(a.id, b.id) else a.id end as a,
               case when r.name_a = r.name_b and r.source_a = r.source_b then greatest(a.id, b.id) else b.id end as b
          from public.venues a
          join public.venues b
            on b.id <> a.id
           and abs(a.lat - b.lat) < 0.003 and abs(a.lng - b.lng) < 0.005
         where public._pl_venue_name_key(a.name) = public._pl_venue_name_key(r.name_a)
           and public._pl_venue_name_key(b.name) = public._pl_venue_name_key(r.name_b)
           and a.source = r.source_a and b.source = r.source_b
           and abs(public.haversine_meters(a.lat, a.lng, b.lat, b.lng) - r.metres) <= 5
      ) x;

    if v_hits <> 1 then
      v_errors := v_errors || format('%s [%s] <-> %s [%s] ~%s m: %s matches',
                                     r.name_a, r.source_a, r.name_b, r.source_b, r.metres, v_hits);
      continue;
    end if;

    if r.a_is_child then
      v_links := v_links || array[[v_a, v_b, r.name_a || ' -> ' || r.name_b]];
    else
      -- The loser points at the winner, in the dedupe's own order.
      select w.id into v_win
        from public.venues w
       where w.id in (v_a, v_b)
       order by (w.boundary is not null) desc, (w.source = 'google') desc, w.id
       limit 1;
      v_links := v_links || array[[case when v_win = v_a then v_b else v_a end, v_win,
                                   r.name_a || ' = ' || r.name_b]];
    end if;
  end loop;

  if cardinality(v_errors) > 0 then
    raise exception using
      message = 'venue_links seed: ' || cardinality(v_errors) || ' pair lookup(s) failed, nothing inserted: '
                || array_to_string(v_errors, '; '),
      hint = 'pl:seed.lookup';
  end if;

  for v_i in 1 .. coalesce(array_length(v_links, 1), 0) loop
    insert into public.venue_links (venue_id, canonical_id, note)
    values (v_links[v_i][1], v_links[v_i][2], 'VENUE-DUPLICATES.md 2026-08-09: ' || v_links[v_i][3])
    on conflict (venue_id) do nothing;
  end loop;
  raise notice 'venue_links seed: % pair(s) resolved', coalesce(array_length(v_links, 1), 0);
end $$;

-- Recompute canonical ids for pickleball, hand links first.
select public._pl_dedupe_venues(array['pickleball']) as venues_changed;

-- The VENUE-DUPLICATES.md check query (baseline 247 on 2026-08-09, every
-- sport), plus how many of those edges still sit on two canonical rows.
-- Pickleball only is deduped, so the second number stays high for other sports.
select count(*) as identical_name_edges_200m,
       count(*) filter (where coalesce(a.canonical_id, a.id) <> coalesce(b.canonical_id, b.id)) as still_separate,
       count(*) filter (where coalesce(a.canonical_id, a.id) <> coalesce(b.canonical_id, b.id)
                          and a.sport @> array['pickleball'] and b.sport @> array['pickleball']) as still_separate_pickleball
  from public.venues a join public.venues b on a.id < b.id
   and abs(a.lat-b.lat) < 0.002 and abs(a.lng-b.lng) < 0.002 and a.sport && b.sport
   and 111320 * sqrt((a.lat-b.lat)^2 + ((a.lng-b.lng)*cos(radians(a.lat)))^2) <= 200
   and btrim(regexp_replace(lower(regexp_replace(a.name,'[^a-zA-Z0-9 ]',' ','g')),'\s+',' ','g'))
     = btrim(regexp_replace(lower(regexp_replace(b.name,'[^a-zA-Z0-9 ]',' ','g')),'\s+',' ','g'));
