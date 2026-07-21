# Location pipeline — getting off Google Places

**Status:** schema + scraper built (P0–P2); migration not yet applied to the DB · **Related:** [basketball-vertical.md](./basketball-vertical.md)

**Scope:** the pipeline covers **10 sports** — basketball, pickleball, tennis, soccer, volleyball
(incl. beach), baseball, softball, skateboarding, disc golf, and bocce. Adding another is a one-line
change (a row in `SPORT_ALIASES` in `scripts/load-osm-venues.mjs` + the tag in the osmium filter);
the DB needs no change because `venues.sport` is `text[]` and the search/radius RPCs are sport-generic.

## Why

Today every venue in Pickleague is free text picked from **Google Places autocomplete**
(`react-native-google-places-autocomplete`, keyed by `EXPO_PUBLIC_GOOGLE_PLACES_KEY`). That means:
per-keystroke API cost, a hard runtime dependency on a Google key in every client + CI, no offline
search, unstable identity (a match's `location_name` is a copied string, not a stable id), and no way
to curate or enrich the courts our users actually play at.

We want the opposite: **our own cached, versioned database of known playing locations** (pickleball
*and* basketball), scraped from OpenStreetMap + other open sources, served through our own text/radius
search, and cached on-device so it works offline. Google Places becomes optional (a fallback for
long-tail gaps), not the backbone.

The good news: **Doggle already built exactly this pipeline** for dog parks. We clone it. Almost
nothing here is novel — it's a port with a different OSM tag filter and a de-dog-ified schema.

## What we're building

1. A **`venues`** table (courts / gyms / sports complexes) with stable OSM-derived ids.
2. **Scrapers** that populate it from OSM (bulk PBF + live Overpass), reusing Doggle's scripts.
3. **Geo + text search RPCs** (`search_venues`, `list_venues_in_radius`) — our in-house autocomplete.
4. A **`localSearch`** implementation wired into the foundation `VenuePicker`, with the external
   provider switched **off** (requires one small foundation change — see [Foundation change](#foundation-change-required)).
5. A **"suggest a court"** flow so users can add venues we missed (unconfirmed → admin-confirm),
   mirroring Doggle's `unconfirmed_google_places`.

## Reuse map — clone these Doggle files

All paths under `C:\Users\Brian\source\repos\doggle`. See that repo's pipeline; here's the mapping.

| Doggle (source) | Pickleague (target) | Change needed |
| --- | --- | --- |
| `scripts/load-osm-parks.mjs` (streaming osmium geojsonseq → upsert) | `scripts/load-osm-venues.mjs` | `SPORT_ALIASES` registry → sport detection; `kindFor` for court/field/skatepark/etc; no CA bbox guard |
| `scripts/ingest-osm-parks.sh` (osmium bulk orchestration) | `scripts/ingest-osm-venues.sh` | `osmium tags-filter` → pitches + sports centres + skateparks + disc-golf courses + our `sport=` values |
| `scripts/load-osm-businesses.mjs` (Overpass live, retry/backoff, area vs bbox) | reuse pattern for gap-fill / per-metro | Swap `FILTERS` to court tags |
| `db/migrations/0014_dog_places.sql` + `0184_dog_place_osm_enrichment.sql` (schema spine, PostGIS boundary trigger) | `supabase/migration_add_venues.sql` | Drop leash/fenced; add court attributes (§ schema) |
| `db/migrations/0066_search_dog_places.sql` (`search_dog_places`) | `search_venues` | Rename table; add `sport` filter |
| `db/migrations/0074/0295_*_in_radius.sql` (`list_dog_places_in_radius`, haversine) | `list_venues_in_radius` | Rename table; add `sport` filter |
| `db/migrations/0027_google_place_mappings.sql` (`resolve_google_place`, 250 m haversine) | `resolve_venue` | Rename; reuse the 250 m proximity test verbatim |
| `db/migrations/0202_merge_dog_place.sql` (`merge_dog_place`) | `merge_venue` | Rename; repoint match/rating references |
| `db/migrations/0161_us_cities_geocode.sql` (offline geocoder) | reuse as-is | none — domain-neutral |
| `app/src/data/dogPlaces.ts` (catalog-vs-dynamics cache split) | `mobile/src/data/venues.ts` | Model on it; cache keys `venues:*` |

**Runtime:** all Node ESM `.mjs`, no build step, Node 18+. The bulk path needs the `osmium` CLI
(osmium-tool) and a Geofabrik `.osm.pbf` extract. Scrapers need `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` (service-role, server-side only — never ship it to a client).

## OSM query design for courts

OSM has strong US court coverage under `leisure=pitch` + `sport=*`. The tagging is messy, so query
broad and refine in JS.

**Bulk (osmium tags-filter on a PBF):** keep it wide, filter precisely in the loader.
```bash
osmium tags-filter "$PBF" \
  nwr/leisure=pitch \
  nwr/leisure=sports_centre \
  -o "$FILTERED"
```

**Live (Overpass QL, for gap-fill / a single metro):**
```overpassql
[out:json][timeout:300];
area["ISO3166-2"="US-CA"]->.a;
(
  nwr["leisure"="pitch"]["sport"~"basketball"](area.a);
  nwr["leisure"="pitch"]["sport"~"pickleball"](area.a);
  nwr["leisure"="pitch"]["sport"="tennis"]["pickleball"="yes"](area.a);
  nwr["leisure"="sports_centre"]["sport"~"basketball|pickleball"](area.a);
  nwr["sport"~"pickleball"](area.a);
);
out center tags;
```

**Tagging gotchas the loader must handle:**
- `sport` is often **multi-value**, semicolon-separated (`sport=basketball;volleyball`). Split on `;`
  and match membership, not equality. (Overpass `~"basketball"` already matches substrings; the JS
  refine must do the same.)
- **Pickleball is under-tagged.** It's frequently `sport=tennis` + `pickleball=yes`, or a multi-value
  `sport=tennis;pickleball`, and only sometimes `sport=pickleball`. Treat any of those as pickleball.
- A single venue can host **both** sports (a rec complex). Model `sport` as an array (§ schema), not a
  scalar — don't force a court into one vertical.
- Use `out center` so ways/relations collapse to one lat/lng (same as Doggle).

**Court attributes worth capturing from OSM tags** (all optional, present when tagged):
`surface`, `lit` (huge for outdoor courts), `covered`/`indoor`, `hoops` (basketball), `access`
(public/private/customers), `fee`, `operator`, `website`, `opening_hours`, and court count
(`pitches`/multiple mapped pitches). Basketball especially benefits from `hoops` + `lit` + `indoor`.

## `venues` schema (proposed)

Mirrors `dog_places`' spine (stable text PK, source/provenance, PostGIS-ready) minus dog fields.

```sql
create table public.venues (
  id            text primary key,              -- 'osm:way/123' | 'g:<place_id>' | 'user:<uuid>' | curated slug
  sport         text[] not null default '{}',  -- e.g. '{basketball}', '{pickleball}', '{basketball,pickleball}'
  name          text not null,
  kind          text not null,                 -- 'court' | 'gym' | 'sports_centre' | 'park'
  lat           double precision not null,
  lng           double precision not null,
  address       text,
  city          text,
  region_slug   text references venue_regions(slug),
  -- attributes (from OSM tags; nullable)
  surface       text,                           -- asphalt | concrete | acrylic | wood | ...
  indoor        boolean,
  lit           boolean,
  covered       boolean,
  hoops         int,                            -- basketball
  court_count   int,
  access        text,                           -- public | private | customers
  fee           boolean,
  operator      text,
  website       text,
  phone         text,
  opening_hours text,
  -- provenance / dedup
  source        text not null,                  -- 'osm' | 'google' | 'curated' | 'user'
  external_id   text,
  source_url    text,
  attribution   text,                           -- ODbL / OSM contributors when source='osm'
  confirmation_status text not null default 'confirmed', -- 'confirmed' | 'unconfirmed'
  created_by    uuid references profiles(id),   -- set for user-suggested venues
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index venues_sport_idx on public.venues using gin (sport);
create index venues_region_idx on public.venues (region_slug);
-- RLS: world-readable to authenticated; writes service-role only, except user-suggested
--      inserts (source='user', confirmation_status='unconfirmed', created_by = auth.uid()).
```

`venue_regions` (slug, name, center_lat/lng) mirrors `dog_place_regions` for nearest-center region
assignment. Add PostGIS `boundary`/`boundary_geom` only if we later want polygon geofencing — not
needed for v1 (points are enough for courts).

## Dedup & identity

Same three mechanisms Doggle proved:
1. **Primary-key upsert** on `osm:<type>/<id>` — re-ingesting an element is an idempotent update.
   In-memory `Map` dedup before the write batch (also collapses osmium's LineString+area double-emit).
2. **Coordinate resolution** — `resolve_venue(lat, lng)` returns whether a pick is within **250 m** of
   an existing venue (`confirmed | unconfirmed | suggest | unknown`). This is exactly the "is this
   Google/user result already one of ours" test.
3. **Manual merge** — `merge_venue(from, to)` repoints match `location`/rating references and unions
   fields. OSM rows are the canonical target.

## Geo + text search (our autocomplete backend)

- **Radius:** `list_venues_in_radius(lat, lng, radius_m, limit, sports text[])` — haversine (plain
  lat/lng math, no PostGIS needed for points), sport-filtered before the nearest-N cap. Client cache
  key `venues:radius:{lat},{lng}:{radius}:{sports}`.
- **Text:** `search_venues(query, lat?, lng?, region?, sports text[], limit)` — score by name/address
  `ILIKE` + distance decay (`50/(1+d/3000)`), sport-filtered, UNION unconfirmed user venues below
  confirmed. This *is* the autocomplete.
- **Catalog-vs-dynamics split** (from `dogPlaces.ts`): persist the immutable catalog for days
  (`venues:*`, `persistMs` ~ 1 week) via the foundation `cache` module; keep any volatile overlay
  (recent-play counts, etc.) on a short TTL. Result: instant, offline-capable search.

## Foundation change — DONE (kit v1.2.0)

`VenuePicker` used to *always* render an external autocomplete (Google on native, Nominatim on web),
with `localSearch` only *augmenting* it. **Shipped in `@just-messin-around/expo-foundation@1.2.0`**
(kit `0799d3a`): a new prop

```ts
externalSearch?: 'google' | 'nominatim' | 'none'   // default undefined = today's behavior
```

With **`externalSearch="none"`** the picker uses only `localSearch` (our catalog) + GPS / pasted
coordinates — native renders a plain controlled `TextInput` instead of `<GooglePlacesAutocomplete>` (no
`EXPO_PUBLIC_GOOGLE_PLACES_KEY`, no Google calls) and web skips the Nominatim fetch. Everything else is
unchanged: `VenueResult` (`catalogId`/`localBadge`), coord-paste (`parseLatLngInput`), the "📍 Use my
location" GPS button, `LocationUseConfirmModal`, distance ranking. Additive + backward-compatible.

To adopt: bump `mobile/` to `^1.2.0`, then pass `externalSearch="none"` through `CourtPicker` once our
`venues` DB + `localSearch` are ready (the P6 flip below).

> **Follow-up (not blocking):** the native `react-native-google-places-autocomplete` import is still
> static (optional peer), so a consumer must have the package installed even when using `'none'`.
> Pickleague already has it (kept during the dual-run), so this doesn't block us. Fully dropping the
> install requirement for a brand-new never-Google app is a separate change (lazy require / injected
> provider component).

## App migration path (low-risk, reversible)

1. **Dual-run.** Implement `mobile/src/data/venues.ts` `searchVenues()` and pass it as `localSearch` to
   `CourtPicker` (the 19-line shim over `VenuePicker`). Our results render **above** Google. Zero risk —
   Google still covers gaps. Ship this first; watch how often local results are chosen.
2. **Flip the switch.** Once coverage is good in our launch metros, bump the kit and set
   `externalSearch="none"` on `CourtPicker`. Google key becomes unnecessary; drop
   `EXPO_PUBLIC_GOOGLE_PLACES_KEY` from `.env.example` + CI.
3. **Long tail.** Keep a `externalSearch="google"` escape hatch behind an admin/debug flag, or rely on
   the "suggest a court" flow (user adds an unconfirmed venue by dropping a pin / pasting coords →
   admin confirms → it enters the catalog for everyone).

## Coverage & ops

- **Seed regions** (`venue_regions`) for launch metros; assign each venue to its nearest region center
  (haversine ≤ threshold, else NULL), same as Doggle.
- **Refresh cadence:** OSM is append-mostly; a monthly bulk re-run + on-demand per-metro Overpass
  gap-fill is plenty. All idempotent (PK upsert), so re-runs are safe.
- **Attribution:** OSM data is ODbL — store `attribution` and show "© OpenStreetMap contributors" on
  any venue detail/map (Doggle does this). Non-negotiable for the license.
- **Rate limits:** Overpass has no key but rate-limits hard — reuse Doggle's real `User-Agent` +
  429/5xx retry-with-backoff. Prefer the PBF bulk path for full-region loads; Overpass only for
  gap-fill.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY` is server/CLI-only. Scrapers run from a dev machine or a
  scheduled job, never the app.

## Phased checklist

- [x] **P0 — Schema.** `supabase/migration_add_venues.sql` — `venues` + `venue_regions` + RLS
      (world-read; users may only suggest their own unconfirmed rows; service role writes canonical)
      + gin/trgm indexes + `touch_venue` trigger + `haversine_meters`. *(Deferred: `resolve_venue`,
      `merge_venue`, `us_cities` geocoder — add when we wire the "suggest a court" dedup flow.)*
- [x] **P1 — Search RPCs.** `search_venues` (name/city/address + distance rank) and
      `list_venues_in_radius` (nearest-N), both sport-filtered via `venues.sport && p_sports`. In
      `migration_add_venues.sql`.
- [x] **P2 — Scrapers.** `scripts/load-osm-venues.mjs` + `scripts/ingest-osm-venues.sh` (ported from
      Doggle's parks pipeline). Multi-sport via a `SPORT_ALIASES` registry (10 sports); handles
      multi-value `sport`, `pickleball=yes` on tennis courts, `leisure=skatepark`/`disc_golf_course`
      with no `sport=` tag, and osmium area-id decoding; idempotent `osm:<type>/<id>` upsert; PostgREST
      **or** `SQL_OUT` chunk mode. Functionally tested offline (per-sport detection + SQL emit verified).
      *(Still to do: run a real extract against the DB and spot-check counts.)*
- [ ] **P3 — Data module.** `mobile/src/data/venues.ts` (catalog/dynamics cache split, `venues:*` keys).
- [ ] **P4 — Dual-run in app.** Wire `searchVenues` as `localSearch` on `CourtPicker`; ship; observe.
- [x] **P5 — Foundation.** `externalSearch` prop added to `VenuePicker`, published as kit **v1.2.0** (`0799d3a`). Bump `mobile/` to `^1.2.0` when adopting.
- [ ] **P6 — Flip.** `externalSearch="none"`; drop the Google key; keep "suggest a court" for gaps.
- [ ] **P7 — Ops.** Region seeds, refresh job, attribution on venue UI.
