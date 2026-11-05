# Home join a league

Three leagues to join, for a player in no league. Shown on Home > Join a league
(`mobile/src/components/home/JoinLeagueSection.tsx`), with inline Join or Request.

- **Current version:** `home-join-a-league-v2`
- **Defined by:** `mobile/src/screens/HomeScreen.tsx:502` (`joinLeagues`). Candidates from
  `mobile/src/components/home/homeData.ts` (`loadHome`). Last commit on `HomeScreen.tsx`: `842a332`
  (layout; last rule change `7a3e7f1`).

## Candidates

Active leagues, newest created first, at most 40 (`LEAGUE_FETCH_LIMIT = 40`, `homeData.ts:183`,
query at line 501). Leagues I'm in are removed (`homeData.ts:604`).

## Filters

Inside Discover's search area: a league with no court coordinates is left out
(`HomeScreen.tsx:489-492`, `filterBySearchArea`). Nothing shows until the area is known. Shown only
when I'm in no league (`HomeScreen.tsx:612`).

## Scoring

Two modes (`HomeScreen.tsx:502-511`):

- **Location already granted:** distance from the device to the league's court, nearest first. Home
  never asks for location to fill this.
- **Otherwise:** open leagues before private ones, then member count desc.

## Tie-breaks

Distance mode: none past distance (a league with no distance sorts last). Otherwise: none past
member count; equal rows keep fetch order (newest created).

## What is shown

The top 3 (`JOIN_ROWS = 3`, `HomeScreen.tsx:128`), each with distance ("2.1 mi") when known, plus
Enter code and Browse all.

## Known weaknesses

- The pool is the 40 newest leagues app-wide, cut before the area filter, so an older league nearby
  can be missed.
- Distance uses the device, not the search area centre, so a player who searched a city but denied
  location gets the open-then-busiest order.
- No level or schedule fit.
- Data that would help: impressions (which 3 were shown), and joins per position.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-13 | First version: 40 newest active leagues, nearest first with location, else open then busiest, top 3. | Home layout B | `7717f13` "ui: compact layout across Home, Play, league, tournament and personal screens" |
| v2 | 2026-10-24 | Limited to Discover's search area; a league with no location is left out. | "Search area review fixes: ... Home limited" | `7a3e7f1` |
