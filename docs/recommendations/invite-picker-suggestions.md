# Invite picker suggestions

The players listed first in the invite picker: those who play near the league's court or the
tournament's venue. Shown in an invite code's "Send in app" picker
(`mobile/src/components/MultiUserPickerModal.tsx`, opened from
`mobile/src/components/InviteCodeManager.tsx:440` with `nearScope`).

- **Current version:** `invite-picker-suggestions-v1`
- **Defined by:** `mobile/src/components/MultiUserPickerModal.tsx:87` (the `suggested` block) and
  `mobile/src/lib/inviteSuggestions.ts:106` (`suggestedFirst`). Last commit on the modal: `dc3ed01`
  (copy only; rules from `c55a5c0`).
- **Depends on:** [players-near](players-near.md), `lib/inviteSuggestions.ts`.

## Candidates

Same steps as the league and tournament suggestions, without a level band:

1. real people who play within the search area's radius of the place (league home court, or
   tournament venue, else its league's court), up to 200 (`data/inviteSuggestions.ts:42`);
2. else the same around the shared search area;
3. else no suggestions (just everyone by name).

## Filters

`excludeUserIds` from the caller. Real people only; blocks both ways, deleted and hidden test accounts
left out by the server.

## Scoring

Distance only (the server's order, nearest first).

## Tie-breaks

Server order (distance, name, id). Then everyone else by name, then id
(`lib/inviteSuggestions.ts:117-119`). Each player once.

## What is shown

All suggested rows first, each with "Plays at <court>, N mi", then everyone else. Typing filters the
whole list. A failed suggestions read drops only the suggestions (line 104).

## Known weaknesses

- No level and no schedule, unlike the league and tournament suggestions.
- The suggested block has no heading or count of its own (unverified in the rendered UI).
- Data that would help: whether a picked player came from the suggested block.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-24 | First version: nearby players first, then everyone by name. Before this the picker listed everyone by name with no suggestions. | The user: "Suggest nearby, search all" | `c55a5c0`, `f564c4a` "Invite review fixes: pickers search everyone" |
