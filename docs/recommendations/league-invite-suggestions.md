# League invite suggestions

Players to invite to a league: near the league's court, close to its level, ranked by how much their
weekly schedule overlaps mine. Shown in League members > Suggest
(`mobile/src/screens/LeagueMembersScreen.tsx`, the Suggest modal around line 628).

- **Current version:** `league-invite-suggestions-v4`
- **Defined by:** `mobile/src/screens/LeagueMembersScreen.tsx:244` (`loadSuggestionsInner`). Last
  commit on the file: `1ea3db8` (layout only; last rule change `c55a5c0`).
- **Depends on:** [players-near](players-near.md) (`discover_players_near`),
  `mobile/src/lib/inviteSuggestions.ts` (`suggestionSteps`, `firstWithAnyone`, `withinLevel`), and
  `discover_players` with `p_near_rating` (`supabase/migration_hide_test_accounts.sql:346`).

## Candidates

The league's average PLUPR: the mean of the members' `rating`, a missing rating counted as 3.25
(line 255); with no members, my own rating, else 3.25 (line 251).

Steps, first one that leaves anyone wins (`lib/inviteSuggestions.ts:50`, `:73`):

1. **Place:** the real people who play within the search area's radius of the league's home court
   (`data/inviteSuggestions.ts:42`, `nearForInvite`), the 100 nearest (line 268).
2. **Area:** the same around the shared search area, skipped when it is the same circle as step 1
   (`lib/inviteSuggestions.ts:57`).
3. **Anywhere:** `discover_players` with rating between average minus and plus 1.75, the 50 nearest
   the average (`p_near_rating`), excluding members (lines 285-292).

Steps 1 and 2 keep a row only if its rating is within 1.75 of the average (`withinLevel`,
`lib/inviteSuggestions.ts:86`; band `SUGGEST_LEVEL_BAND = 1.75`, line 87). A row with no rating is
dropped there.

## Filters

Members are excluded (`memberIds`). Steps 1 and 2: real people only (no unclaimed placeholders or
guest passes), deleted, blocked both ways and hidden test accounts left out by the server. Step 3:
deleted and hidden test accounts left out; blocks are not applied by `discover_players`.

## Scoring

For each candidate (lines 297-316):

- `overlapHours = availabilityOverlap(myAvailability, theirs) * 0.5`, rounded to 0.1 (line 314).
  Availability is the weekly grid of 336 half-hour cells (`TOTAL_CELLS`, foundation
  `scheduling/availability.ts:17`); overlap counts cells both have on. If my grid is not a full 336
  cells, overlap is 0 for everyone.
- `eloDiff = |rating - leagueAverage|` (line 313).

## Tie-breaks

`overlapHours desc`, then `eloDiff asc` (lines 318-320). No further tie-break: equal rows keep the
candidate order (distance for steps 1 and 2, level then name for step 3).

## What is shown

The top 20 (line 322). Heading: "Players near <place>, N mi, similar PLUPR, sorted by schedule
overlap", or "Similar PLUPR to <league>, sorted by schedule overlap" for step 3 (lines 628-630). Each
row shows rank, PLUPR versus the average, and "Nh overlap" or "no overlap".

## Known weaknesses

- Distance only picks the pool; it plays no part in the order. A player 0.2 mi away with no overlap
  ranks below one 20 mi away with 1 hour.
- Players who never filled in availability all score 0 and fall to level order.
- The 100-row pool in steps 1 and 2 is cut by distance before the level band, so in a busy area
  good-level players past the 100th can be missed.
- Step 3 applies no blocks.
- Data that would help: invites sent and accepted per suggestion rank and step, and recent activity.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-05-09 | Anywhere, rating within 350 ELO of the league average, 50 rows, sorted by schedule overlap then ELO distance, top 20. | First Suggest | `88330b5` "Bundle in-progress features" |
| v2 | 2026-05-10 | Band changed to plus or minus 1.75 PLUPR. | ELO replaced by PLUPR | `a3ea576` "Replace ELO with PLUPR v1" |
| v3 | 2026-10-21 | The 50-row pool is the 50 nearest the league's level (`p_near_rating`), not the first 50 by name; test accounts hidden while God mode hides them. | "keep the players nearest their level when the limit cuts, not the first names alphabetically" | `352bf1f`, `4cdf954` "Hide test accounts: review fixes", `migration_hide_test_accounts.sql` |
| v4 | 2026-10-24 | Nearby first: players near the league's court, else the search area (league courts only), within the band; the old list only when both are empty. | The user: "Suggest nearby, search all" | `c55a5c0` "Players near: league courts only; invites suggest nearby, search all", `f564c4a` "Suggest waits for the area" |
