# Discover league order

The default order of leagues I'm not in, on Discover > Leagues. The player can pick another sort; this
page is about the default ("auto") and the distance sorts.

- **Current version:** `discover-league-order-v2`
- **Defined by:** `mobile/src/lib/playFilters.ts:286` (`resolveLeagueSort`), `:317` (`sortLeagues`),
  `:272` (`myCourtsCenter`), `:426` (`splitLeagues`). Caller `mobile/src/screens/LeaguesScreen.tsx:419`.
  Last commit on `playFilters.ts`: `7a3e7f1`.

## Candidates

Every league not Mine (Mine: I'm a member, or I asked to join a private league). Pages of 25
(`PAGE_SIZE = 25`, `playFilters.ts:34`).

## Filters

With a search area: leagues outside it, and leagues with no court coordinates, are left out; the
sheet's Distance is ignored (`playFilters.ts:396-404`). Then search, chips and the sheet (private
shown by default).

## Scoring

The default sort falls back in a chain (`playFilters.ts:290`):

1. **Nearest**, when there is an origin point. With a search area the origin is the area's centre
   (`areaContext`, line 403), so this is the default whenever an area exists.
2. **Near my courts**: the average of my leagues' court coordinates (`myCourtsCenter`).
3. **Most active**: matches in the last 30 days desc (`RECENT_MS`, `LeaguesScreen.tsx:126`), then
   member count desc, then name.

Distance sorts use miles to the league's court; leagues with no court go last (lines 325-338).

## Tie-breaks

Equal distance: the Most active order (line 337).

## What is shown

The sorted Discover list, 25 per page. Mine is a separate block above, in role order, never sorted by
this.

## Known weaknesses

- No level, schedule or friends signal. A league my friends are in looks like any other.
- "Most active" counts matches only, not events or new members.
- Sort and row taps are not logged (`trackPlayFilter` exists but has no caller).
- Data that would help: joins from Discover by position and sort, friends per league.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-13 | First version: Nearest, else Near my courts, else Most active. | Play > Leagues rules (plan section 4) | `7717f13` |
| v2 | 2026-10-24 | Discover's search area limits the list, and Nearest measures from its centre. | "Discover: one search area (place + radius) limits every search" | `1c0e0ed`, `7a3e7f1` |
