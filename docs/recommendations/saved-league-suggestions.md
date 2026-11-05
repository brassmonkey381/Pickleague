# Saved league suggestions

Leagues I play in but have not saved, offered with a Save star. Shown in Saved > Your leagues
(`mobile/src/screens/BookmarksScreen.tsx:249`). A suggestion is never saved without a tap.

- **Current version:** `saved-league-suggestions-v1`
- **Defined by:** `mobile/src/lib/savedStandings.ts:269` (`leagueSuggestions`). Caller
  `BookmarksScreen.tsx:102`. Last commit on the file: `dc3ed01` (copy only; rule from `0fd7714`).

## Candidates

My leagues from `listMyLeagues`, in the order given (newest joined first, per the code comment;
unverified against the query).

## Filters

Left out: inactive leagues (`is_active === false`), leagues already saved, duplicates
(`savedStandings.ts:277`).

## Scoring

None. Input order.

## Tie-breaks

Input order.

## What is shown

At most 5 (`max = 5`, `savedStandings.ts:272`), each with my standing line when it loads. With no saved
league yet, the block leads the page.

## Known weaknesses

- No signal for which league I care about (matches played, open votes). The spotlight's rule in
  `agenda.ts` would be a better order.
- Data that would help: impressions; saves per position (`saved_suggestion_save` has no position).

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-22 | First version: my active unsaved leagues, newest joined first, up to 5. | "Saved is the fast path to standings" | `0fd7714` "Saved is the fast path to standings: your rank inline, one tap to the table" |
