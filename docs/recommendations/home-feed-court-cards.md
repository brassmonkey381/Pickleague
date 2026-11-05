# Home feed court cards

Which court cards the Pickleague Feed shows on Home, in what order, and the order of lines on each
card. Shown on Home (`mobile/src/components/feed/PickleagueFeedSection.tsx`). Behind
`HOME_FEED_ENABLED` (on, `mobile/src/lib/features.ts:229`).

This is mostly my own stuff, not discovery: it picks which of my courts make the cap, and which
friends' courts get the leftover room.

- **Current version:** `home-feed-court-cards-v2`
- **Defined by:** `mobile/src/lib/pickleagueFeed.ts:491` (card rank and cap), `:293`
  (`sortCourtLines`). Tests: `mobile/src/lib/__tests__/pickleagueFeed.test.ts`. Last commit on the
  file: `842a332`.

## Candidates

Per day band (Today, Tomorrow, Later this week), cards for (file header, lines 18-41):

- my starred courts (every star gets a Today and a Tomorrow card, even empty);
- my routine courts, and the courts of my one-off plans, on a day with something there;
- today: the court I'm checked in at, and courts my accepted friends are at;
- courts where a friend shared a plan.

Never a court that is only "frequent" or only a league's home court.

## Filters

Only my leagues, tournaments I signed up for, and accepted friends. A friend's plan is hidden when
they are already there and the plan starts within 30 minutes (`FRIEND_PLAN_HERE_MS`, line 88).

## Scoring

Card rank, compared in order (lines 491-495):

1. more lines that are live now (me here, friends here, a live league item) first;
2. a card with something of mine (check-in, routine stop, plan, league item) before one without;
3. more counted lines first.

## Tie-breaks

Court name (line 500). Lines on a card (`sortCourtLines`, line 293, order `LINE_ORDER`, line 288):
who came and went (by when they left), then who is here (me first, close friends first, then by
arrival), then what is coming in time order; undated votes last.

## What is shown

At most 6 cards a day (`MAX_FEED_COURTS = 6`, line 79), but a starred card or one with anything of
mine is never cut; friend-only cards share the room left (lines 505-512). 6 lines per card before
"See all" (`COURT_ROWS_CAP = 6`, line 75).

## Known weaknesses

- Friend-only cards are cut by rank, then name, so which friend court survives can be arbitrary.
- No tracking of card position or why a card is there; `home.tap` `feed` `court` has no position.
- Data that would help: card position and reason (star, mine, friend) on each tap.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-22 | First version: court cards as the top layer of each day band, live first, mine next, stars never cut, cap 6. | One Doggle-style feed on Home | `c1392f6` "Pickleague Feed on Home (P3)", `52a387f` "stars never cut", `1648ead` "court cards are the top layer", `d900f25` "my lines survive the cap" |
| v2 | 2026-10-24 | Friends' shared plans add lines, and a card of their own that gives way first under the cap. | Plan sharing | `09a504f` "Plan sharing, client: daily routine confirm, Shared / Only you, friends' plans" |
