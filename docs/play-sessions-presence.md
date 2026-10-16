# Play sessions + court presence (ported from Doggle)

**Status:** Phase 1 live 2026-10-16 (SQL applied, master `8a42a1f`, OTA `55a4e858`, flag still off) ·
Phase 1.5 (validity rules) built on `feat/validity` 2026-10-16, hardened after an anti-gaming review the same day,
persona-tested against live in a rolled-back transaction (440/440), not applied or shipped yet · **Source:** a 13-agent study of Doggle's walks /
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
| 5 | Rewards for showing up | **Kept plans + streaks:** +25 pickles per kept plan (max 1/day, made at least 1 h ahead); valid sessions count toward the play streak (Phase 1.5 replaced the original 20+ min rule). **Only location-confirmed presence earns anything.** |
| 6 | **No manual check-ins** | A check-in needs a GPS fix inside the court's fence, verified on the server. No fix: no check-in (start an untracked session instead, or make a plan). Rewards therefore only ever pay on confirmed presence. Say "keep manual" to revisit. |
| 7 | Android background location | Deferred to the Phase 2 native build (the first Android release). Recommendation: ship Android without it. |

How Phase 1 applies decision 1 (from the 2026-10-16 privacy review; the decision itself is unchanged):

- **"Members of closed leagues you share"** counts a membership only if it was made while the league was closed
  (`league_members.admitted_closed`, set by the server). Closing an open league later names nobody who joined it
  instantly; and no one can be moved into a league they never joined (clients may change only a member's role).
- **"Blocked pairs never see each other"** (confirmed by the user 2026-10-16): no row and no count, either way.
  Accepted trade-off: someone with a second account could notice the count differs by one.
- **"Guests see counts only"** (confirmed 2026-10-16): guests get `venue_crowd` numbers and their own row, never
  anyone else's row, in `court_presence` and in the 1.0.4 `venue_players_here`.
- Anonymous rows carry only what a count needs (random per-call id, hour-rounded times, no session), so a pause or
  a hide-from can't be undone by matching rows later. Residual, by design: someone watching at the very moment of
  a pause sees one named row become one more "Player" with the count unchanged.
- The crowd's skill band is built only from players the viewer sees anonymously, and only with 3+ of them.

## Rules every change in this plan follows

1. **Location-confirmed only.** `checkin_venue` takes the device fix (`p_lat`, `p_lng`, `p_accuracy_m`, `p_fix_at`,
   and `p_fix_age_ms`, the fix's age measured on the device when it is sent). The server accepts it when the fix
   is inside the venue boundary, or within `geofence_radius_m + least(p_accuracy_m, 75)` of the venue point, the
   fix is at most 2 minutes old (by its age, so a wrong phone clock doesn't matter; by `p_fix_at` against the
   server clock when no age is sent), and its accuracy is reported and at most 150 m (an approximate location,
   e.g. Precise Location off, can't confirm a court). It stores `location_confirmed`, the fix, and its distance.
   Calls from un-updated 1.0.4 clients (no fix) create a **private** unconfirmed row: shown to nobody, counted
   nowhere, earns nothing. A confirmed check-in stays confirmed: extending it needs a confirming fix, or stops 4
   hours after its last one.
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
   from 1.0.4 still resolve). New social screens are gated by `FRIENDS_AT_COURTS_ENABLED` in `lib/features.ts`:
   the Friends screen and requests, FriendButton / FriendsLink, Home "Friends at the courts", the crowd line, the
   court star and friend push routes. NOT gated, because they ship with the check-ins they control: the consent
   sheet, Settings › Privacy "Who sees me at the courts" / "Hidden from", Pause sharing and "Hide my presence".
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
   anonymous rows get a random per-call id and hour-rounded times; new `court_presence(p_venue)`; `presence_settings`
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
6. **My courts:** `court_favorites` (max 5), a star on court surfaces; feeds YOUR COURTS (every star shows) and the
   geofence list (starred courts first; starring re-syncs the fences).
7. **Session = presence:** start_play_session creates the session check-in when the fix confirms the court;
   PlayStartSheet ("Where are you playing?"); pending-End guard so a queued End never resurrects the island; an
   End or check-out that reaches the server before its Start or check-in makes that one land closed.
8. **Crowd line** ("6 playing now · mostly 3.5–4.0 · 2 friends", band only with 3+ rated anonymous players) and
   Home **Friends at the courts** (now / your courts).
9. **Hygiene + disclosure:** sign-out ends presence; account deletion clears it; 180-day check-in retention;
   privacy.html tells the truth about background region monitoring and who sees check-ins.
10. **Release:** apply SQL (incl. `migration_league_members_lock_identity.sql`, which can also go first on its own)
    → merge to master (Vercel deploys web, privacy.html goes live) → re-answer the App Store App Privacy
    questionnaire (Precise Location: collected, linked to the user, App Functionality) and update the Play Data
    Safety draft → OTA (this starts storing fixes) → flip the flag by OTA after persona tests. Re-answer the label
    before or with the OTA, not with the next binary.

### Phase 1.5: validity rules (decided by the user 2026-10-16; SQL + OTA)

Anti-gaming: presence is about being there, rewards are about having played. These rules gate rewards and streaks,
never presence (an invalid session still shows you at the court).

1. **Stay proof:** check-out sends a fresh fix when one comes back within 3 s (never blocks check-out; extend already
   needs one). The server records whether the player was confirmed at the court at arrival AND at check-out/extend,
   at least 5 minutes apart (`stay_confirmed`). Future presence rewards pay only on a confirmed stay.
2. **Valid session = 5+ minutes AND a recorded match or drill.** A match counts when it is linked to the session
   (`matches.play_session_id`) or recorded by the player during the session or within 2 h after it ends; a drill
   counts when the player's drill session in that window is completed. Recorded is enough to count; pickles for a
   session wait until its match is confirmed. This replaces decision 5's "sessions of 20+ min count toward the play
   streak": the streak credit (Phase 5) goes to valid sessions.
3. **End flow:** ending a session asks "Record a match or drill?" (opens MatchEntry linked to the session); without
   one, the summary says sessions count once a match or drill is recorded within 2 h.

**Built (`feat/validity`, 2026-10-16; contract: [API, Phase 1.5](./play-sessions-presence-api.md#phase-15-validity-rules)):**

- [x] 1. Stay proof: `venue_checkins.stay_confirmed` + `arrival_fix_at` + check-out fix columns; `checkout_venue`
  and `end_play_session` gain optional fix arguments (1.0.4 and current calls still resolve); the app sends a fix
  from Check out and from End (at a court) only when one comes back within 3 s.
- [x] 2. Valid session: `play_sessions.valid` / `valid_reason` / `validated_at` / `rewards_pending_confirmation` /
  `at_court`, `matches.play_session_id`, recomputed by triggers on Start, End, matches and drill reviews;
  `my_session_validity`. A matches insert guard (server time, server-side confirmations), no overlapping sessions,
  one session per match or drill, drill schedules locked to the server.
- [x] 3. End flow: `components/play/PlayEndSheet` (Record match / Review drill / Not now), shown only when neither
  the device nor the server (`my_session_validity`, 2 s) already counts the session; MatchEntry links the match.
- [ ] Apply `supabase/migration_validity_rules.sql`, then merge and OTA.

How the build reads the rules (say so to change any):

- **Stay proof** also accepts any later confirming fix stored on the check-in (extend, a repeat check-in or a
  session start at the same court), not only check-out and extend: each of those already proves the court. End
  sends the same fix for the session's own check-in (an adopted one stays open and gets none).
- **The 5 minutes of a stay run from the arrival fix**, not from the check-in time the app sends (`p_at`, which may
  be backdated for an offline check-in): `arrival_fix_at` is when the arrival fix was taken, on the server clock.
- **"Recorded" is the server's clock:** every signed-in match insert gets `created_at = now()`, and the 2 h window
  reads only that (never `played_at`, which the app still sets for display).
- **Confirmations are the server's:** a client insert of a played match is stored pending, due within the hour,
  with only the recorder's own team confirmed (never both teams by one caller); godmode keeps its confirmed insert.
  So `rewards_pending_confirmation` can be trusted.
- **Recorded counts until the confirm deadline:** a pending match counts at once, but the existing 1-hour expiry
  (`expire_pending_matches`) deletes a match nobody confirms, and the session then stops counting. In practice a
  session keeps counting through a match only when the other team confirms within the hour. A drill needs no
  confirmation.
- **"Recorded by the player" is read as "with the player in it":** a match counts toward the sessions of all four
  of its players, whoever recorded it (partner, opponent, or a league member who didn't play). Only linking checks
  the recorder.
- **A drill is completed** when the player submits their drill review (drills have no status); it counts when
  that review lands in the session's window AND the drill was held during the session (scheduled to overlap it,
  give or take 30 minutes). A review of an older drill never counts, and clients can no longer move a drill's time.
- **A match can be linked** only to the recorder's own session, open or ended under 2 h ago, with the recorder
  among the players; anything else is stored unlinked (never refused).
- **One match or drill counts for one session** of each player (this closes the old "Open" item): a match for the
  session it is linked to, else the one it was recorded during, else the latest one that ended before it; a drill
  for the session started from it, else the one that started closest to it. A session under 5 minutes never takes
  one. A player's sessions never overlap: a Start dated before the end of an earlier session starts when it ended.
- **Valid means played; rewards need presence too.** `valid` says the player played (it drives the End copy, so
  an untracked session can be valid). `at_court` says a location-confirmed check-in at the session's court
  overlapped it. Decisions 5 and 6 ("only location-confirmed presence earns anything") are kept by paying rewards
  and streak credit only on **valid AND at_court**. Say "valid is enough" to drop the location requirement instead.
- **Still open (your call):** the 5-minute floor is measured on the session's own start and end, which the app
  sends (a Start may be backdated up to 12 h for offline use). Each such session still needs its own match or
  drill now, so the damage is bounded. To close it fully, count duration from server time and accept an earlier
  start only with a confirmed stay; the cost is that a fully offline session (Start and End both queued) would
  never count.

Doggle counterpart (same day, built in the Doggle repo): GPS required to check in (no-fix calls from old builds are
stored but earn nothing), and a valid walk is 5+ min and 100+ m measured on the server from `walk_points`;
duration-only walks save but never count.

### Phase 2: tell close friends, make sessions pay off (native build 1.0.5 + OTA)

- Close-friend presence push ("Alex is playing at Lakeside · til 7:40 PM") with 90 min per friend+court throttle,
  3/day per author, 5/day per recipient (recipient's local day), quiet hours 22:00–07:00, mutes, kill switch,
  push expiry on check-out. **Decide the direction first and write it here.** Under Doggle's model (decision 4)
  the recipient is `close_friends.user_id` (the person who starred) and the author is `friend_id`: "you hear when
  a close friend is at a court". The Instagram direction ("your close friends hear about you") reads
  `user_id = author` and would need the Phase 1 "listed first" reads rethought. Change the ⭐ explainer
  (`CLOSE_FRIEND_EXPLAINER`, today "listed first, only you see your stars") in the same commit as the push.
- Fan-out code that judges two other people under a user's session uses `_pl_blocked_pair`, not
  `blocked_between` (which answers a signed-in caller only about their own pairs).
- Kit: a High-accuracy option for `getCurrentCoords` (check-ins need fixes under 150 m; Balanced often returns
  cell-level fixes on Android) and iOS `accuracyAuthorization`, so "Precise Location off" isn't guessed from the
  accuracy number.
- Court screen (`court/<venueId>`), court check-in sheet, On my way + Need players, Play island presence actions.
- Session summary (builds on the Phase 1.5 end sheet `PlayEndSheet`), Discard, MatchEntry "Players here"
  (`matches.play_session_id` already exists from Phase 1.5), session history.
- Kit 1.45: symmetric geofence region state (Exit only after a recorded Enter), `weekdayMask` hoist,
  `registerBeforeSignOut`, VenuePicker row-meta prop, PrivacySettingsPanel level overrides.
- **Build 1.0.5:** opt-in auto check-in on arrival (server dwell 10 min, home/regular/favorite courts, default off),
  honest permission strings and review notes, first Android release (decision 7).

### Phase 3: plan the next game

`court_plans` (+ invites, join, I'll be there, need-N), friend notices (6 h throttle), overlap join ping, completion
under an advisory lock, missed-plan sweep, own reminders as local notifications with a web fallback, kept-plan
pickles (+25, location-confirmed check-in during the plan window only). Restore Settings › Privacy "Who sees my
planned games" (`plans_level`, stored since Phase 1) and the privacy.html planned-games sentence with it.

### Phase 4: regular games (routines)

`court_routines` (weekday mask, device zone stored on the row), a */15 materializer into plans, skip / move,
RegularsScreen, "Plays regularly" on profiles, plan- and routine-aware arrival prompts, one shared 20-fence order.

### Phase 5: polish once there is real usage

Badges and play-streak credit for valid, at-the-court sessions only (Phase 1.5: `play_sessions.valid` AND
`at_court`; pickles wait while `rewards_pending_confirmation`), court conditions (3 h decay), long-lived court notes,
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
