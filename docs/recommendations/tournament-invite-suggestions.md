# Tournament invite suggestions

Players to invite to a tournament: near its venue, close to its level, closest level first. Shown in
Tournament > Invite players (`mobile/src/screens/TournamentInvitePlayersScreen.tsx`), above the
search-everyone list.

- **Current version:** `tournament-invite-suggestions-v3`
- **Defined by:** `mobile/src/screens/TournamentInvitePlayersScreen.tsx:153` (`loadInner`). Last
  commit on the file: `dc3ed01` (copy only; last rule change `c55a5c0`).
- **Depends on:** [players-near](players-near.md), `mobile/src/lib/inviteSuggestions.ts`,
  `mobile/src/data/inviteSuggestions.ts`, and `discover_players` with `p_near_rating`.

## Candidates

The tournament average: mean `rating` of approved registrants with a rating; none, 3.25 (lines
163-168).

The place: the tournament's venue, else its league's home court (`data/inviteSuggestions.ts:178`).

Steps, first that leaves anyone wins:

1. **Place:** real people who play within the search area's radius of that place, up to 200
   (`nearForInvite` default, `data/inviteSuggestions.ts:42`).
2. **Area:** the same around the shared search area (skipped when it is the same circle).
3. **Anywhere:** `discover_players` with rating within 1.5 of the average, the 500 nearest the
   average (line 194).

Steps 1 and 2 keep rows within 1.5 of the average (`withinLevel`; `LEVEL_BAND = 1.5`, line 76).

## Filters

Anyone with a registration of any status is excluded (lines 155-159). Steps 1 and 2: real people
only, blocks both ways, deleted and hidden test accounts left out by the server. Step 3: deleted and
hidden test accounts left out; no block filter.

## Scoring

`ratingDiff = |rating - average|` (line 90); a missing rating counts as the average (line 80).

## Tie-breaks

`ratingDiff asc` (line 200). JavaScript sort is stable, so equal rows keep the step's order:
distance for steps 1 and 2, level then name for step 3.

## What is shown

All suggestions (up to 200 or 500), then everyone else by name for search. Heading "Players near
<place>, N mi" for steps 1 and 2 (`lib/inviteSuggestions.ts:95`), with a "Plays at" line per row; each
row shows "+0.25 vs avg".

## Known weaknesses

- Distance picks the pool but the order is level only, so a nearby player can sit below a far one.
- No schedule fit, although the tournament has a start time and players have availability grids.
- Step 3 applies no blocks.
- Data that would help: invite sent and accepted per rank and step; the tournament start time against
  each player's availability.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-05-10 | First version: everyone within 1.5 PLUPR of the approved registrants' average, up to 500, closest level first. | Admin Invite Players screen | `1c5972b` "Add admin Invite Players button + screen for tournaments" |
| v2 | 2026-10-21 | The 500-row pool is the 500 nearest the average (`p_near_rating`), not the first 500 by name; hidden test accounts left out. | Keep the players nearest the level when the limit cuts | `352bf1f`, `4cdf954` "Hide test accounts: review fixes" |
| v3 | 2026-10-24 | Nearby first: players near the venue (else its league's court), else the search area, within the band; the old list only when both are empty. | The user: "Suggest nearby, search all" | `c55a5c0`, `f564c4a` "Invite review fixes" |
