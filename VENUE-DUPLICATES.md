# Venue duplicates — work order for `scripts/`

**Produced by:** the analytics studio (`../analytics-studio`), 2026-08-09, from a full read of
`venues` (4,072 rows with coordinates) on the Pickleague project.
**Audience:** an agent session rooted at this repo.
**Scope:** `scripts/ingest-google-venues.mjs`, `scripts/load-osm-venues.mjs`, and a one-off
reconciliation script. **No product code, no migration required.**

The studio never writes to this database — everything below is a finding plus a proposed
change for you to make here.

---

## The headline

**118 venue records (2.9% of 4,072) are duplicate records of a place that already exists**,
under a deliberately conservative test. They form 77 real places currently stored as 195 rows.

That number is small on purpose. A looser proximity test flags 1,979 more pairs, and
**spot-checking shows those are mostly wrong** — they are sibling facilities inside one
complex, which a "where can I play" app should probably keep separate:

```
  67 m   George Wolfman Baseball Fields  <->  Baseball Diamond 1
   0 m   Upper East Field                <->  East Field
  26 m   minor League #2                 <->  Minor League
 193 m   Robb Field 2                    <->  Robb Field 1
```

Do not dedup on proximity alone. Distance does not separate "the same place recorded twice"
from "two courts in one park", and at these scales it never will.

---

## What counts as a duplicate here

Only two predicates, both requiring a shared sport and ≤ 200 m separation:

| Class | Edges | Sources | What it is |
|---|---|---|---|
| Identical name | 247 | 230 osm+osm, 12 google, 5 cross | The same facility stored as several rows |
| Google child-POI beside its parent | 8 | google+google | `Pickleball Courts \| Lincoln Park` **and** `Lincoln Park` |

Digits and direction words (`1`, `#2`, `Upper`, `North`) are **not** normalised away — they are
exactly what distinguishes siblings from duplicates. Median separation of a confirmed
duplicate pair is 42 m; 206 of 255 sit under 100 m.

---

## Root cause 1 — the Google dedup radius is a hair too small

`scripts/ingest-google-venues.mjs` skips a candidate within **100 m** of any existing venue:

```js
// Physical dedup: skip within 100 m of any existing venue.
if (existing.some((x) => x.lat != null && kmMeters(lat, lng, x.lat, x.lng) < 100)) { skipped++; continue; }
```

Every one of the 55 google-vs-google duplicate candidates sits at **101–199 m**. Not one is
under 100 m. The filter is not broken — it is working exactly as written, and Google's court
POIs land just past its edge:

```
 101 m   Tennis courts | Braly Park            <->  Braly Park
 108 m   Pickleball Courts | Lincoln Park      <->  Lincoln Park
 154 m   Pickleball Courts | Leydecker Park    <->  Leydecker Park
```

Google pins a child court POI **at the court**, not at the park centroid, so a park of any
size puts the two pins 100–160 m apart by construction.

**Do not simply raise the radius to 200 m.** That would also merge the sibling facilities
above, which are 0–77 m apart — a bigger radius makes the *worse* error more likely, not less.

**Proposed change:** keep 100 m as a pure-distance skip, and add a second, name-aware rule out
to ~250 m:

- If the candidate name matches `^(.*) \| (?<parent>.+)$` and a venue named `parent` already
  exists within 250 m → skip (or attach as a child, see below).
- If the normalised candidate name equals an existing venue's normalised name within 250 m →
  skip.

Normalise by lowercasing and collapsing punctuation only. **Preserve digits and direction
words.**

## Root cause 2 — the OSM loader has no physical dedup at all

`scripts/load-osm-venues.mjs` upserts by deterministic OSM id (`way/559623274`), which makes
re-runs idempotent but never asks whether the place is already present under a different id.
OSM frequently maps one facility as several ways — 230 of the 247 identical-name duplicate
edges are osm+osm:

```
   2 m   Pioneer Stadium                        <->  Pioneer Stadium
   5 m   High Country Sports Arena              <->  High Country Sports Arena
  33 m   Municipal Tennis and Pickleball Center <->  Municipal Tennis and Pickleball Center
```

**Proposed change:** at load time, when a row's normalised name exactly matches an existing
venue within 250 m **and** shares a sport, merge rather than insert — union the sport arrays,
sum `court_count`, keep the record that has a `boundary`, and keep both external ids so a
re-run stays idempotent.

## Root cause 3 — 5 cross-source pairs that the radius does not explain

Five OSM/Google pairs sit **under 30 m** and still both exist, which the 100 m filter should
have caught:

```
   5 m   [google] Haas Pavilion       <->  [osm] Haas Pavilion
   6 m   [google] Tice Creek Fitness Center at Rossmoor <->  [osm] Tice Creek Fitness Center
  20 m   [google] Tennis Courts       <->  [osm] Tennis Courts
  25 m   [google] City Sports Club    <->  [osm] City Sports Club
  25 m   [google] CenterLine 33       <->  [osm] Centerline 33
```

The `existing` prefetch looks correct (`limit=20000`, any source, bbox-scoped), so this is
**not** the PostgREST 1,000-row default biting. Most likely the two loaders ran against
different bboxes, or OSM data landed in a region after the Google pass covered it. **This one
is a hypothesis, not a finding** — worth ten minutes with the run logs before changing code.

---

## Reconciliation of the rows already stored

A fix to the loaders stops new duplicates; it does not remove the 118 already present. A
one-off script should:

1. Emit the 77 clusters as a **review file**, not a delete. Every cluster gets its member
   names, sources, distances and ids.
2. Merge on approval: union `sport`, keep the row with a `boundary` (or the OSM row, which
   carries real geometry — Google rows have none), sum `court_count`, retain every
   `external_id` so both loaders stay idempotent.
3. Never hard-delete. Mark superseded rows so a bad merge is reversible.

**Do not run a blind delete pass.** 2.9% is small enough that a wrong merge costs more than
the duplicates do.

---

## What is NOT a duplicate

The studio's geo report has a sport filter. A panel reading *"Alameda — 10 of 43 venues here
list pickleball"* means the other 33 are basketball, tennis, soccer and baseball venues that
the filter is hiding. They are correct records. (The studio's label used to read
"10 of 43 venues", which invited exactly this misreading; that wording is fixed.)

---

## How to re-check after the fix

The studio's queries live in this document's source data, but the cheapest verification is:

```sql
-- identical-name duplicate edges within 200 m sharing a sport.
-- The whitespace collapse and the 200 m cap both matter: without them this
-- reports 249, because two pairs differ only in spacing or sit further apart.
select count(*) from venues a join venues b on a.id < b.id
  and abs(a.lat-b.lat) < 0.002 and abs(a.lng-b.lng) < 0.002 and a.sport && b.sport
  and 111320 * sqrt((a.lat-b.lat)^2 + ((a.lng-b.lng)*cos(radians(a.lat)))^2) <= 200
  and btrim(regexp_replace(lower(regexp_replace(a.name,'[^a-zA-Z0-9 ]',' ','g')),'\s+',' ','g'))
    = btrim(regexp_replace(lower(regexp_replace(b.name,'[^a-zA-Z0-9 ]',' ','g')),'\s+',' ','g'));
```

Baseline on 2026-08-09: **247** (verified against this exact query).
