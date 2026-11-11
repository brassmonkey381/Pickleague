# Suggested courts

Courts to star, ranked by how much pickleball actually happens there, not distance alone. Shown in
the first run's "Your courts" step (PKL-020 change 3). Modeled on Doggle's Your parks ranking
(`suggested_favorite_parks`, parks-v5, Doggle `db/migrations/0516`-`0517`).

- **Current version:** `suggested-courts-v1`
- **Defined by:** `supabase/migration_suggested_courts.sql`, `public.suggested_courts` (the only
  definition). The RPC returns `algo_version`; it must equal the version here and
  `mobile/src/lib/recsVersions.ts`.

## Candidates

Canonical courts, not rejected, that list pickleball themselves or through an alias, within
15 km (line 46) of the point, the 60 nearest (line 83). Courts already in my starred courts are left
out. The point is the phone's location when allowed, else my home location
(`profile_home_locations`); with neither, the list is empty and `located` is false.

## Scoring

Counts only real people (no test accounts, no deleted profiles). Every count includes the court's
duplicates (venues whose `canonical_id` is it). Lines 147-156:

| Signal | Points |
| --- | --- |
| Distinct players with a confirmed check-in in 30 days | +12 each, up to 5 |
| Confirmed check-ins in 30 days | +8 x ln(1 + n) |
| Active open leagues with it as home court (real play in 120 days, or created in 60) | +10 each, up to 3 |
| Weekly sessions listed (`court_sessions`, not hidden, current) | +6 each, up to 4 |
| Matches recorded there in 30 days (open leagues) | +6 x ln(1 + n) |
| Other players who starred it | +8 each, up to 5 |
| Courts | +2 each, up to 6 courts |
| Lit | +5 |
| Private or customers only | -15 |
| Distance | -6 per km |

Closed leagues are not counted: their home court is for members only
(`migration_closed_league_privacy.sql`). Only counts leave the database, never who.

## Tie-breaks

Score, then distance. The top 3 come back `recommended` (line 185).

## What is shown

Up to `p_limit` rows (default 6, at most 10), each with the counts behind its score so the row can
say why ("9 players this month, 2 leagues").

## Known weaknesses

- New areas with no check-ins fall back to court count, lights and distance.
- One very regular player counts once in players, and only by ln in check-ins, by design.
- No friends signal yet (friends' courts would help once a new player has friends).

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-11-11 | First version. | Brian: courts ranked by check-ins, active leagues and more, not distance alone (PKL-020 change 3) | `migration_suggested_courts.sql` |
