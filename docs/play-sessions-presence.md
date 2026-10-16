# Play sessions + court presence (ported from Doggle)

**Status:** Phase 1 in progress (started 2026-10-15) · **Source:** a 13-agent study of Doggle's walks /
check-ins / plans / routines and of Pickleague's existing presence code, with a gap critic and a fact-checker.
Raw study output was kept in the session scratchpad; this doc is the durable record.

**Goal:** friends can see, without effort, when their friends are at pickleball courts: playing now,
planned for later, or there on a regular schedule.

## Decisions (made by the user, 2026-10-15)

| # | Question | Decision |
|---|----------|----------|
| 1 | Who sees your **name** at a court | **Friends + members of closed leagues you share.** Everyone else sees an anonymous "Player" in the crowd count; guests see counts only; blocked pairs never see each other. Plans and regular games: **friends only** by default. Open leagues never count (anyone can join one instantly). |
| 2 | Does starting a play session check you in | **Yes.** A session at a court creates a `source='session'` check-in that ends with the session. An existing check-in at that court is adopted, not duplicated. |
| 3 | Automatic check-in on arrival | **Build 1.0.5 in Phase 2.** Opt-in, default off, server-confirmed 10-min dwell, leaving cancels it. Needs new permission strings and App Store review. Phase 1 is prompt-only, as the shipped 1.0.4 permission text promises. |
| 4 | Who gets a push when a friend shows up | **Close friends only.** A ⭐ close-friend star on accepted friends (Doggle's model). Everyone else who can see you finds you in the in-app feed. |
| 5 | Rewards for showing up | **Kept plans + streaks:** +25 pickles per kept plan (max 1/day, made at least 1 h ahead); sessions of 20+ min count toward the play streak. **Only location-confirmed presence earns anything.** |
| 6 | **No manual check-ins** | A check-in needs a GPS fix inside the court's fence, verified on the server. No fix: no check-in (start an untracked session instead, or make a plan). Rewards therefore only ever pay on confirmed presence. Say "keep manual" to revisit. |
| 7 | Android background location | Deferred to the Phase 2 native build (the first Android release). Recommendation: ship Android without it. |

## Rules every change in this plan follows

1. **Location-confirmed only.** `checkin_venue` takes the device fix (`p_lat`, `p_lng`, `p_accuracy_m`, `p_fix_at`).
   The server accepts it when the fix is inside the venue boundary, or within
   `geofence_radius_m + least(p_accuracy_m, 75)` of the venue point, and the fix is at most 2 minutes old.
   It stores `location_confirmed`, the fix, and its distance. Calls from un-updated 1.0.4 clients (no fix)
   create a **private** unconfirmed row: shown to nobody, counted nowhere, earns nothing.
2. **Privacy is read-time.** Raw `venue_checkins` / `play_sessions` rows are owner-only. Everyone else reads through
   SECURITY DEFINER RPCs that apply `_pl_can_see_presence(viewer, owner, kind)`, blocks, pauses and hide-from.
3. **Allowlist.** Every new SECURITY DEFINER RPC is granted to `authenticated` **and** appended to the allowlist in
   `supabase/migration_rls_hardening_2026q3.sql` in the same commit. Helpers used inside RLS policies
   (`blocked_between`, `is_scope_admin`, `is_expired_guest`) are allowlisted too. Re-running that file must never
   take a live RPC offline.
4. **Time zones.** All user-facing times in SQL copy use `_pickleague_local_label` / a new `_pickleague_local_time`
   with `_pickleague_tz_for(recipient)`, built inside the per-recipient loop. Per-day caps are the recipient's local day.
5. **Every push has a pref key.** New categories go into `KNOWN_PREF_KEYS`, `PASS_KEYS` (send-push), `DEFAULT_PREFS`
   and the Settings rows. send-push is redeployed with `--no-verify-jwt`.
6. **Account deletion.** `delete_my_account` (a tombstone; FK cascades never fire) explicitly deletes every new
   per-user table plus `venue_checkins` and `play_sessions`. Every presence/friend RPC filters `deleted_at is null`.
7. **Real people only.** Friend requests, suggestions and search exclude `is_unclaimed` (472 of 524 profiles are
   unclaimed DUPR placeholders), `is_guest` and deleted profiles.
8. **Web works.** Background location doesn't exist on web; local notifications don't fire there. Every reminder has
   an in-app fallback (Home agenda row / inline card) and "Add to calendar".
9. **1.0.4 compatibility.** Existing RPC signatures are kept (or replaced in one transaction so named-argument calls
   from 1.0.4 still resolve). New screens are gated by `FRIENDS_AT_COURTS_ENABLED` in `lib/features.ts`.
10. **Hot files.** HomeScreen, homeData, agenda, inboxRequests, notificationActions and types/index change often.
    New code goes in new files, with one-line hooks in those files.

## Live facts the plan is built on (checked 2026-10-15)

- 0 venue check-ins, 5 play sessions (2 users), 1 push token, 50 real (claimed) profiles.
- `venue_checkins_read` and `play_sessions_read` are `using (true)`: any signed-in account, guests included, can read
  everyone's history. `venue_players_here` ignores blocks. **This is fixed in Phase 1 before anything new is shown.**
- 94 of 479 pickleball venues have another pickleball venue within 150 m (Google vs OSM duplicates, OSM per-court rows).
- There is no friend graph: only league members, drill pairs, match co-players and private one-way bookmarks.

## Phases

### Phase 1: friends see friends at the courts (SQL + OTA, no native build)

1. **Ship safety:** allowlist the 29 live client RPCs that are missing + policy helpers; `FRIENDS_AT_COURTS_ENABLED`.
2. **Presence lockdown (one transaction):** owner-only RLS; `venue_players_here` → SECURITY DEFINER, same signature,
   anonymous rows get a per-viewer md5 id; new `court_presence(p_venue)`; `presence_settings`
   (checkins_level default `leaguemates`, plans_level default `friends`, paused_until, consent_seen_at, auto_checkin);
   `presence_hidden_from`; `set_presence_settings`, `get_my_presence_settings`, `hide_presence_from`;
   persona tests (owner, friend, closed-league-mate, open-league-mate, stranger, blocked, guest, deleted) in
   rolled-back transactions.
3. **Location-confirmed check-ins** (rule 1) + checkout records the real leave time (`p_at`) + advisory lock +
   second check-in at the same court is quiet + `resolve_court` (sport-aware) + `leagues.home_venue_id` backfill
   written from the existing home-court pickers.
4. **Duplicate courts:** `venues.canonical_id` (non-destructive) so presence, crowd counts and friends group by facility.
5. **Mutual friends:** `friendships`, requests with lock-screen Accept, unfriend, block teardown, close-friend star column
   (used by Phase 2 pushes), suggestions from real co-play, an "Invite to Pickleague" link for an empty list.
6. **My courts:** `court_favorites` (max 5), a star on court surfaces; feeds YOUR COURTS and the geofence list.
7. **Session = presence:** start_play_session creates the session check-in when the fix confirms the court;
   PlayStartSheet ("Where are you playing?"); pending-End guard so a queued End never resurrects the island.
8. **Crowd line** ("6 playing now · mostly 3.5–4.0 · 2 friends", band only with 3+ rated anonymous players) and
   Home **Friends at the courts** (now / your courts).
9. **Hygiene + disclosure:** sign-out ends presence; account deletion clears it; 180-day check-in retention;
   privacy.html tells the truth about background region monitoring and who sees check-ins.
10. **Release:** apply SQL → merge to master (Vercel deploys web) → OTA → flip the flag by OTA after persona tests.

### Phase 2: tell close friends, make sessions pay off (native build 1.0.5 + OTA)

- Close-friend presence push ("Alex is playing at Lakeside · til 7:40 PM") with 90 min per friend+court throttle,
  3/day per author, 5/day per recipient (recipient's local day), quiet hours 22:00–07:00, mutes, kill switch,
  push expiry on check-out.
- Court screen (`court/<venueId>`), court check-in sheet, On my way + Need players, Play island presence actions.
- Session summary, Discard, MatchEntry "Players here" + `matches.play_session_id`, session history.
- Kit 1.45: symmetric geofence region state (Exit only after a recorded Enter), `weekdayMask` hoist,
  `registerBeforeSignOut`, VenuePicker row-meta prop, PrivacySettingsPanel level overrides.
- **Build 1.0.5:** opt-in auto check-in on arrival (server dwell 10 min, home/regular/favorite courts, default off),
  honest permission strings and review notes, first Android release (decision 7).

### Phase 3: plan the next game

`court_plans` (+ invites, join, I'll be there, need-N), friend notices (6 h throttle), overlap join ping, completion
under an advisory lock, missed-plan sweep, own reminders as local notifications with a web fallback, kept-plan
pickles (+25, location-confirmed check-in during the plan window only).

### Phase 4: regular games (routines)

`court_routines` (weekday mask, device zone stored on the row), a */15 materializer into plans, skip / move,
RegularsScreen, "Plays regularly" on profiles, plan- and routine-aware arrival prompts, one shared 20-fence order.

### Phase 5: polish once there is real usage

Badges and play-streak credit for 20+ min confirmed sessions, court conditions (3 h decay), long-lived court notes,
league "Where we play", busy times (5+ players, 20+ visits), regular-game suggestions, "Looking to play tonight"
status, field debug logger.

## Skipped on purpose

GPS route tracking / distance / pace (pickleball presence needs a court, not a route) · shareable session card ·
session league attribution · tagging other players on a session · hot/trending courts · passive 60 s foreground
proximity monitor · Live Activities, Realtime presence, DMs, vibes, multi-stop day plans, session kudos/photos.

## Doggle bugs not to copy

Its push path ignores privacy and blocks; its walk tables are `using(true)`; its here-now counts include closed rows;
its walks never expire; co-planners are matched on the exact same instant; join pings fire on insert only; it
auto-navigates on every foreground.
