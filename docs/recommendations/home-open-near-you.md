# Home open near you

Up to 3 open tournaments or joinable leagues, for a player already in a league. Shown on Home as
"Open near you" (or "Open leagues") (`mobile/src/components/home/OpenNearYouSection.tsx`).

- **Current version:** `home-open-near-you-v2`
- **Defined by:** `mobile/src/screens/HomeScreen.tsx:519` (`openItems`). Candidates from
  `mobile/src/components/home/homeData.ts`. Last rule change `7a3e7f1`.

## Candidates

- Tournaments in registration, soonest start first, at most 25 (`OPEN_TOURNAMENT_LIMIT = 25`,
  `homeData.ts:185`, query at line 492), minus ones I'm in.
- The same 40 newest active leagues as [Join a league](home-join-a-league.md), minus mine.

## Filters

Inside Discover's search area (`HomeScreen.tsx:489-498`). A tournament with no venue is placed at its
league's court; a row with no location is left out. Shown only to members, after the first load
(`HomeScreen.tsx:817`).

## Scoring

With location already granted: distance from the device, nearest first (`HomeScreen.tsx:530`).
Without: no sort.

## Tie-breaks

Without location the order is tournaments first (soonest start), then leagues (newest created). With
location, rows with no distance go last; equal distances keep that order.

## What is shown

The first 3 (`OPEN_ROWS = 3`, `HomeScreen.tsx:129`). "See all (N)" when more were found, or "See all"
with no number when a fetch hit its row limit. Title "Open near you" when location or a search area
exists, else "Open leagues".

## Known weaknesses

- Without location, tournaments always crowd out leagues.
- Same pool and device-distance limits as Join a league.
- Data that would help: impressions and taps per position (taps are logged as `home.tap`
  `open_near_you` with position).

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-13 | First version: open tournaments then joinable leagues, nearest first with location, top 3, "See all (N)". | Home layout B | `7717f13` |
| v2 | 2026-10-24 | Limited to Discover's search area; tournaments with no venue placed at their league's court. | "Search area review fixes: ... Home limited" | `7a3e7f1` |
