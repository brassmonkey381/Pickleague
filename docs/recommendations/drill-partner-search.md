# Drill partner search

Drill partners ranked against me by shared free time, shared shot preferences, or level. Shown in
Drills > Find drillers (`mobile/src/screens/DrillSearchScreen.tsx`).

- **Current version:** `drill-partner-search-v4`
- **Defined by:** `mobile/src/screens/DrillSearchScreen.tsx:76` (`toCandidate`), `:129` (`load`),
  `:207` (`filtered`, the sort). Last commit on the file: `dc3ed01` (copy only; last rule change
  `c55a5c0`).
- **Depends on:** [players-near](players-near.md) with `p_drilling_only`, `discover_players` with
  `p_near_rating`, and the foundation's `scheduling/drillTime.ts` (`rollingDates`,
  `expandWeeklyToDates`, `overlapSlots`).

## Candidates

- **With a search area:** drillers who play in the area (league courts only), up to 200 (line 155).
- **No area at all:** `discover_players` with drilling on, the 100 nearest my rating (line 157).

My rating: `profiles.rating`, else 3.25 (line 145).

## Filters

Drilling on, not me. The server leaves out deleted and hidden test accounts (and, in the area query,
blocks both ways). The screen also drops players I blocked (`useBlockedIds`, line 183) and filters by
typed name or username.

## Scoring

Per candidate (lines 76-101):

- `overlap`: half-hour slots free for both of us over the next 7 days (`DAYS_VISIBLE = 7`,
  foundation `drillTime.ts:21`). Both weekly drill templates are expanded to dates, then intersected.
- `sharedShots`: count of their shot preferences that are also mine (line 81).
- `sharedPartner`: count of shared partner preferences (line 82). Computed but not used in any sort.

Three sorts, picked by pill (lines 216-224). Default `'overlap'` (line 118):

| Sort | Order |
| --- | --- |
| Overlap (default) | `overlap.length desc`, then `sharedShots desc` |
| Shared shots | `sharedShots desc`, then `overlap.length desc` |
| Skill match | `abs(rating - myRating) asc` (a missing rating counts as 3.25) |

## Tie-breaks

None past the two keys. Equal rows keep the candidate order: distance (area) or level then name (no
area).

## What is shown

The whole list (up to 200 or 100), cached per area for 60 s (line 168). Each row shows the
"Plays at" line when the area placed them.

## Known weaknesses

- `sharedPartner` is computed and never used.
- Distance only builds the pool; it never orders the list.
- Skill match has no tie-break and does not prefer overlap.
- Data that would help: drill requests sent and accepted per sort and rank, and completed drills
  between pairs.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-05-09 | First version: 100 drillers, three sorts (overlap, shared shots, skill), overlap default. | Find drillers | `88330b5` "Bundle in-progress features" |
| v2 | 2026-06-03 | Availability is a recurring weekly template, expanded over the rolling 7 days before the overlap is counted. | Drill availability as a weekly template | `13a16e2` "drill: make availability a recurring weekly template" |
| v3 | 2026-10-21 | The 100-row pool is the 100 nearest my level (`p_near_rating`), not the first 100 by name; hidden test accounts left out. | "the pool scored below is never just the first 100 names alphabetically" | `352bf1f`, `4cdf954` |
| v4 | 2026-10-24 | With a search area, the pool is drillers who play in it (league courts only), up to 200. | "Discover: one search area limits every search", then "league courts only" | `1c0e0ed`, `7a3e7f1`, `c55a5c0` (same day; the first placement draft was not applied on a server) |
