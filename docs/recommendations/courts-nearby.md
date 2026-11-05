# Courts nearby

Pickleball courts near me, nearest first. Shown in Discover > Courts (`mobile/src/screens/CourtsScreen.tsx`),
as a list or a map. Behind `COURT_DISCOVERY_ENABLED` (on, `mobile/src/lib/features.ts:97`).

- **Current version:** `courts-nearby-v1`
- **Defined by:** `supabase/migration_court_discovery_p1.sql:128`, `public.list_courts_nearby` (the
  only definition), and the client sort `mobile/src/lib/courtDiscovery.ts:310` (`sortCourts`). Last
  commits: `8fb5fd1` (SQL), `f16c671` (`courtDiscovery.ts`).
- **App read:** `mobile/src/data/courtDiscovery.ts:54` (`listCourtsNearby`).

## Candidates

Canonical courts (not an alias, not rejected) within the radius of the centre (lines 163-173). The
centre: the route's point, else a searched city, else the device location if already allowed. A court
matches the sport if it or one of its aliases lists the app's court sport (lines 174-178).

## Filters

- Radius clamped 100 m to 80,467 m (50 mi), default 8,047 m (line 145). The app default is 5 mi
  (`DEFAULT_COURT_RADIUS_MILES = 5`, `courtDiscovery.ts:61`).
- Client chips: My courts (starred) and With leagues (`league_count > 0`), and a name filter
  (`courtDiscovery.ts:295`).

## Scoring

Haversine distance from the centre, rounded to the millimetre (line 163).

## Tie-breaks

Server: distance, then court id (line 183). Client sorts (`courtDiscovery.ts:310-320`), default
Nearest (`CourtsScreen.tsx:154`):

| Sort | Order |
| --- | --- |
| Nearest (default) | distance, then name |
| Name A-Z | name (case-insensitive), then nearest |
| Most leagues | league count desc, then nearest |

## What is shown

Pages of 50 (`COURTS_PAGE = 50`, `courtDiscovery.ts:56`; server cap 100, line 146), "Load more" for
the next page by cursor.

## Known weaknesses

- The client sorts only the pages already loaded, so Most leagues is not global past page 1.
- No signal for crowd, my history or friends' courts in the order.
- Data that would help: row taps with position and sort (today `courts.view` has no position),
  stars and check-ins that follow a list visit.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-20 | First version: canonical courts within the radius, nearest first, paged. Two days later distances were rounded to the millimetre so the paging cursor never repeats a row (no order change). | Court discovery P1 | `33c5f1f` "Court discovery P1", `8fb5fd1` "Court list paging: round distances to the mm", `migration_court_discovery_p1.sql` |
