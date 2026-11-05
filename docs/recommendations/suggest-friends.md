# Suggest friends

People I have really played with, offered as friends. Shown in Discover > Players > Played with
(`mobile/src/components/discover/PlayersPanel.tsx:670`, `playedWithView`), each row with an Add
button.

- **Current version:** `suggest-friends-v2`
- **Defined by:** `supabase/migration_hide_test_accounts.sql:429`, `public.suggest_friends(p_limit)`
  (newest definition; the first was `supabase/migration_presence_p1_friends.sql:385`). Last commit on
  that file: `4cdf954`.
- **App:** `mobile/src/data/friends.ts:82` (`suggestFriends(limit = 10)`), cached by
  `mobile/src/lib/useFriends.ts:63`, filtered again by `visibleSuggestions`
  (`mobile/src/lib/friendship.ts:248`).

## Candidates

Three sources, counted per other person (`migration_hide_test_accounts.sql:441-470`):

1. **Matches:** completed matches in the last 180 days where both of us are in any of the four player
   columns (line 447).
2. **Drills:** drill sessions with `session_date` in the last 180 days (lines 452-459).
3. **Closed leagues:** closed leagues (`not l.is_open`) we are both in, both admitted while it was
   closed (`admitted_closed`), membership not expired (lines 460-470).

The viewer must be signed in and not a guest (`_pl_presence_viewer_is_guest`).

## Filters

Left out (lines 488-496): guests, unclaimed placeholders, deleted accounts, test accounts while God
mode hides them, blocked pairs (`blocked_between`), and anyone with a pending or accepted friendship
with me, or a request answered in the last 30 days (line 496).

The app removes again anyone already a friend, in a request either way, or me
(`friendship.ts:248`), so a cached list never shows a stale row.

## Scoring

One packed integer, so matches always outrank drills, and drills outrank leagues (line 484):

```
score = least(matches, 99) * 10000 + least(drills, 99) * 100 + least(closed_leagues, 99)
```

The reason line shows the strongest source: "N matches together", else "Drilled Nx", else
"Both in <league>" (the alphabetically first shared league, `min(l.name)`).

## Tie-breaks

`order by score desc, lower(full_name)` (line 497).

## What is shown

The app asks for 10 (`friends.ts:82`); the server caps at 1 to 50 (line 498). All returned rows are
shown, minus the client filter. Empty: "No one yet" with a Search players button.

## Known weaknesses

- Recency is ignored inside the 180 days: 3 matches last week and 3 matches 5 months ago score the
  same.
- One match always beats any number of drills, by design of the packing. Unverified that this is the
  intended weight.
- Open leagues never count, so a player in only open leagues gets no league-based suggestions.
- No friends-of-friends, no location, no level. Data that would help: mutual friend counts,
  co-presence at the same court (privacy rules permitting), and tap or Add rates per source.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-16 | First version: matches and drills in 180 days, shared closed leagues, packed score, 30-day decline cooldown. Same day, league overlap limited to `admitted_closed` members. | Presence Phase 1, friends | `03eee77` "presence: Phase 1 SQL", `e3dcf2a` "close the privacy and fix-rule gaps the review found", `migration_presence_p1_friends.sql` |
| v2 | 2026-10-21 | Test accounts left out while God mode hides them. | Hide test accounts from discovery | `352bf1f`, `4cdf954` "Hide test accounts: review fixes", `migration_hide_test_accounts.sql` |
