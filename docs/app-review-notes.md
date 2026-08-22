# App Review Notes

Paste the block in §1 into App Store Connect → your build → **App Review
Information → Notes**. Everything after §1 is our own working context, not for
Apple.

The demo account is a purpose-built durable fixture — see §3. Do **not** point
the notes at a `sim_player_*@pickleague.test` account: those live in a
`[SIM]`-prefixed league that our own simulation scripts delete on every run.

---

## 1. Paste-ready notes

```text
1. SCREEN RECORDING
A screen recording is attached to this reply. It was captured on the physical
device listed in section 2, begins at app launch, and covers registration,
sign-in, the core league/match/tournament flows, the in-app reporting and
blocking controls, the account deletion flow, and every system permission prompt
the app can present.

2. DEVICES AND OS VERSIONS TESTED
iPhone 13 mini (iOS 26.5.2).

THIS APP DOES NOT SUPPORT IPAD. It is an iPhone-only app: the build sets
supportsTablet = false, so it is not offered on the iPad App Store and its
layouts are not designed for that screen. Please review it on an iPhone rather
than on an iPad or an iPad simulator.

3. WHAT THE APP DOES, AND FOR WHOM
Pickleague is a recreational pickleball league manager. Players create or join a
league, schedule sessions, record match results, and track a skill rating
(PLUPR) that updates automatically from those results. It also runs tournaments
in several formats (round robin, single/double elimination, pool play, MLP).

Target audience: adult recreational pickleball players and the volunteer
organizers who run their local leagues, clubs, and ladders.

Problem it solves: these groups currently coordinate over group texts and
spreadsheets. Scores get lost, standings are computed by hand and argued over,
and matching players of similar ability is guesswork. Pickleague keeps the
roster, schedule, results, standings, and ratings in one place, and computes
ratings and tournament brackets automatically so the organizer does not have to.

4. SETUP AND ACCESS - DEMO ACCOUNT
Email:    qa_player_1@pickleague.club
Password: PickleReview!2026

This account ("Ben Ortiz") is the ADMIN of a populated league, so it reaches both
the player and the organizer features. No special configuration, hardware,
sample files, or second device is needed. The demo account is already confirmed,
so it signs in directly.

Anyone can also self-register with an email address. Registration requires
confirming that address: after signing up, Supabase sends a confirmation email,
and the confirmation link opens pickleague.club in the browser and confirms the
account. The user then returns to the app and signs in. If you register a test
account of your own during review, please complete that email step first —
sign-in is intentionally blocked until the address is confirmed. The demo
account above avoids this entirely.

League membership is by invite or join code.

SUGGESTED WALKTHROUGH
1. Sign in with the demo account above.
2. Leagues -> "Alameda Evening League" (24 members, 100 recorded matches).
   - Members: the full roster with ratings and profiles.
   - Standings: six locked scoring periods showing how ranks moved over time.
   - Match History: singles and doubles results, filterable.
3. Tournaments -> "Summer Smash MLP", an in-progress tournament with a live
   bracket and standings.
4. Events -> two scheduled sessions, each created from a completed time-slot
   vote, with the per-slot vote counts still visible.
5. Profile -> the PLUPR rating (3.48), 23 matches in this league, badges, and
   the earned "pickles" balance.
6. Any other player's profile -> the "..." button offers Report and Block
   (see REPORTING AND BLOCKING below).
7. Settings -> Blocked players, and Delete account, are both available in-app.

5. EXTERNAL SERVICES USED
- Supabase (hosted PostgreSQL, Auth, Storage) - user accounts, all league and
  match data, and profile photo storage. This is our backend.
- Expo Application Services (EAS) - app builds and over-the-air JavaScript
  updates.
- Expo Push Notification Service, forwarding to Apple APNs - delivery of the
  optional push notifications described below.
- Google Places API - court and venue name/address autocomplete when a user adds
  a playing location.
- OpenStreetMap / Overpass API - seeds our public court catalogue. This runs on
  our servers ahead of time; the app itself never calls it.
- Apple MapKit - map display on iOS.
- Vercel - hosting for the web version of the product and the privacy policy.
- Optional, and only if a league organiser sets it up: an outgoing webhook to
  that league's own group chat (for example Discord or Slack), so that session
  reminders can post there. The organiser supplies the webhook URL, only the
  organiser can see or change it, and nothing is sent anywhere unless they do.
  No such integration is configured on the demo account.

There is NO advertising SDK, NO third-party analytics SDK, NO payment processor
or in-app purchase, and NO AI service in this app. Usage analytics are
first-party and stored in our own database.

6. REGIONAL DIFFERENCES
There are none. The app offers identical features and content in every region.
It is English-only, has no region-locked or region-varying content, no
geographic restrictions, and no regional pricing (the app and all features are
free). The only practical difference is that our pre-seeded public court
catalogue is currently densest in the United States; court search works
worldwide, and in any region a user can add a venue manually or via Google
Places autocomplete.

7. REGULATED INDUSTRY / THIRD-PARTY MATERIAL
Pickleague does not operate in a regulated industry. There is no real-money
gambling, no financial service, no health or medical function, and no
telecommunications function. Please see the note below on our in-app currency,
which we want to be fully transparent about.

Regarding third-party material: the app displays public court/venue data. That
data is sourced from OpenStreetMap, used under the ODbL with attribution, and
from the Google Places API, used under the Places API terms, with display data
cached no longer than the permitted 30 days and attributed per record. The app
contains no licensed sports content and no professional league or team marks.

USER-GENERATED CONTENT
User-generated content is deliberately minimal and is not a social feed. It
consists of: a display name and short tagline, an optional profile photo, the
names of leagues, events, and venues created by organizers, and one private
messaging surface - when a player asks another player to practise ("drill")
together, the two of them get a private message thread attached to that
request. There is no public feed, no group chat, no comments, and no photo
sharing beyond a single profile picture. All of it is visible only to other
members of leagues the user has joined - or, for a drill thread, only to the
two players in it - and league membership is by invite or join code rather than
open to the public.

REPORTING AND BLOCKING
Both are in the app, on the "..." button that appears on any other player -
their profile, a drill request, and inside a drill message thread:

- Report opens a list of reasons (harassment, hate speech, sexual content,
  violence, impersonation, spam, cheating, other) plus an optional note. What
  the reporter was looking at is captured with the report, so the content can
  still be acted on if the author edits or deletes it afterwards.
- Block is immediate and mutual: the two players can no longer send each other
  drill requests or messages, existing threads disappear for both, and they
  stop appearing in each other's partner search. It is enforced on our server,
  not just hidden in the app. Blocks are listed and reversible in
  Settings -> Blocked players. A blocked user is not told they were blocked.

Reports go to a queue we review within 24 hours. We can remove a profile photo,
remove a display name or tagline, and delete the offending account outright -
after which they cannot sign back in. Anything can also be reported to
support@pickleague.club, which is published in the app and on our website.

ABOUT "PICKLES" (IN-APP CURRENCY) - PLEASE NOTE
"Pickles" are a free scorekeeping currency, similar to points in a fantasy
league. Specifically:
- They CANNOT be purchased. There is no in-app purchase, no payment method, and
  no payment SDK anywhere in the app.
- They have NO cash value and cannot be withdrawn, transferred off-platform, or
  exchanged for anything of real-world value.
- They are earned only by playing and recording matches.
- They can be spent ONLY on cosmetic items: avatars, profile name styles, and
  decorative badges.
- They CANNOT be staked, wagered, or bet on anything. There is no prediction,
  wagering, or contest-of-chance feature in this build.

In short: pickles are a points total that can buy a nicer avatar. There is no
purchase, no cash-out, no staking, and no real money anywhere in the app.

PERMISSIONS AND WHY THEY ARE REQUESTED
- Location (when in use): to show pickleball courts near the player when they
  search for a venue. Not used in the background; coordinates are not stored.
- Contacts: only when the player opens the contact picker to invite someone to
  an event. The address book is read on-device and is never uploaded; only the
  name and phone number of contacts the player explicitly selects are sent, in
  order to create that invite.
- Photo library: only to select a profile picture.
- Notifications: optional, off by default. Used for match results, event
  reminders, and tournament updates.
Every permission is optional and the app remains usable if declined.

ACCOUNT DELETION
Account deletion is available in-app at Settings -> Delete account. It removes
the profile, personal data, and credentials.

PRIVACY POLICY
https://pickleague.club/privacy

OTHER NOTES
- iPhone only. The app does not support iPad and is not submitted for it.
- No third-party advertising, no ad tracking, and no App Tracking Transparency
  prompt (we do not track across other companies' apps or sites).
- The same product is available on the web at https://pickleague.club.
- Support contact: support@pickleague.club
```

---

## 2. Why the pickles paragraph is in there

Guideline 5.3 (gambling) turns on consideration + chance + a **prize of value**.
Two of those three legs have now been removed from the shipping build, in order:

1. The real-world redemption catalogue — physical goods labelled "Worth $X.XX
   online", shipped to an address — was the *prize of value*. Removed
   2026-08-05 (`migration_retire_real_world_redemptions.sql`; see
   [`app-store-golive.md`](app-store-golive.md) §1.5).
2. The wagering feature — staking pickles on a match result or a final standing
   — was the *consideration on a contest outcome*. Gated off 2026-08-20 behind
   `WAGERS_ENABLED` in `mobile/src/lib/features.ts`, which unregisters the wager
   routes entirely, so there is no reachable staking UI at all.

So the paragraph no longer argues a defensible position; it states a plain fact.
Everything in it is verifiable in the build: no payment SDK is bundled,
`shop_items` are cosmetics only, the redemption RPCs are revoked at the database
level, and the wager screens are not registered in the navigator.

Do not soften it into vagueness, and do not claim more than is true. **If
`WAGERS_ENABLED` is ever flipped back on, or redemptions are reinstated, this
paragraph becomes false and must change before the next submission.**

## 3. Demo-account durability — RESOLVED 2026-08-06

The original plan was to point Apple at `sim_player_1@pickleague.test`. That was
unsafe: the only populated league was `[SIM] Toolbox League`, and `cleanup()` in
both `simulations/simulate-flows.ts` and `scripts/seed-fake-players.mjs --delete`
deletes every league matching `like '[SIM]%'`, on entry *and* exit of every run.
A single sim run during the review window would have emptied the reviewer's app —
a rejection that would be near-impossible to reproduce afterwards.

Replaced with a dedicated fixture, seeded by `--qa` mode on the same script:

```bash
node scripts/seed-fake-players.mjs --qa --count 8 \
     --league "Alameda Evening League" --matches 40 --doubles-pct 45 \
     --days 45 --dupr-min 3.0 --dupr-max 4.6
```

`--qa` inverts every sim convention so nothing it creates is reachable by sim
cleanup: emails are `qa_player_<n>@pickleague.club` (not `sim_*`, not
`@pickleague.test`), the league-name guard is inverted to *refuse* a `[SIM]`
prefix, and `--qa --delete` matches the exact league name rather than a pattern.

**Verified isolated** by running both teardowns in `--dry-run`:

| cleanup | accounts | matches | leagues |
| --- | --- | --- | --- |
| SIM mode | 62 sim | 180 | 1 `[SIM]` |
| QA mode  | 8 QA   | 40  | 1 QA |

Neither sees the other's data. Login verified against the live auth endpoint.

What the fixture contained when first seeded: 8 players, `Alameda Evening
League` (8 members, 40 matches over 45 days through the real ELO triggers), 2
seasons with 48 standings snapshots across 6 locked periods, and 2 upcoming
events. It has since been re-seeded larger — **24 members, 100 matches, and one
in-progress tournament** as of 2026-08-21. The review account is league admin
with 23 matches of its own — so unlike the old sim account, "My Matches" is not
empty.

**Closed:** the league now has an in-progress tournament, "Summer Smash MLP",
so the §1 walkthrough demos one. The fixture has also grown since it was first
seeded — 24 members and 100 matches, not the original 8 and 40, and both events
are now scheduled rather than one still open for voting. §1 reflects the
current state; re-check these numbers before each submission, since they move
whenever the fixture is re-seeded.

To rebuild or tear down:

```bash
node scripts/seed-fake-players.mjs --qa --delete --league "Alameda Evening League" --dry-run
```

## 4. Still to fill in elsewhere in App Store Connect

- Age rating questionnaire — answer the contests/gambling questions consistently
  with §1. No real-money gambling, no simulated gambling with purchasable
  currency.
- App Privacy questionnaire — declare email, precise location, contacts, photos,
  push token, and user content. Keep the contacts answer aligned with the
  privacy policy's precise wording.
- Support URL (required) and Marketing URL (optional).

## 5. Screen recording shot list — 2.1 rejection, 2026-08-12

Apple rejected 1.0.2 (7) on 2026-08-12 under **Guideline 2.1 — Information
Needed**. Nothing is wrong with the binary; they could not tell what the app
does because App Review Information → Notes was empty. Reply in App Store
Connect with the §1 block plus a recording. A new build is not required.

Record on a **physical device on the latest iOS** (not the simulator — Apple
asks for a device capture and can usually tell). iPhone: Settings → Control
Centre → add Screen Recording, then swipe down and tap the record button. Aim
for 3–5 minutes; unhurried, no narration needed.

Apple named four things they specifically want to see. Two of them are the easy
ones to forget, so shoot in this order:

1. **Cold launch.** Start recording on the home screen, then tap the icon. They
   asked for it to "begin with launching the app."
2. **Registration, including the email confirmation.** Sign up as a brand-new
   user with a throwaway email. Do not skip straight to the demo account —
   registration is on their list.

   Shoot the whole loop, not just the form: fill in the fields → tap Create
   Account → the "check your email to confirm" message → switch to Mail on the
   same device → open the confirmation email → tap the link → the browser
   confirms → back to the app → sign in successfully.

   This is not optional padding. Email confirmation is **enforced**: as of
   2026-08-14, zero non-anonymous accounts have ever signed in without a
   confirmed address. A recording that stops at "check your email" shows the
   reviewer a dead end and reads as a broken signup. Note the link opens
   pickleague.club in the browser rather than deep-linking back into the app —
   expected, and called out in §1 so it does not look like a bug.

   Use a throwaway address you can actually receive mail at on the device.
3. **Permission prompts.** Trigger each one on camera: add a venue (location),
   invite to an event (contacts), set a profile picture (photo library), and
   accept the notifications prompt. This is their "sensitive data or device
   capabilities" bullet.
4. **Core loop, signed in as `qa_player_1`.** League → Members → Standings →
   Match History, record a match, then open "Summer Smash MLP" and show the
   bracket.
5. **Pickles.** Show the balance and the cosmetic-only shop. There is no staking
   to film any more — wagering is gated off (§2). If you see a wager control
   anywhere, stop: the build is wrong, not the shot list.
6. **Report and block.** Open another player's profile → "..." → Report, pick a
   reason, send. Then "..." → Block, and show Settings → Blocked players with
   the entry in it. Apple asked about reporting and blocking by name, so film it
   deliberately rather than mentioning it.
7. **Account deletion.** Settings → Delete account, all the way through
   confirmation. Their list explicitly includes deletion flows, and this is the
   single most common cause of a follow-up rejection.

Nothing to record for paid content: there is no purchase or subscription flow
anywhere in the app.

Use a fresh throwaway account for step 2 and delete it in step 7, so the
recording covers both flows without touching the `qa_player_1` fixture. For
step 6, report and block that same throwaway account from `qa_player_1` (or the
reverse) — never a real player.

### Closed 2026-08-21: report, block, and a moderation queue

This was the open Guideline 1.2 gap, and the likeliest cause of the next
rejection — Apple named "content reporting and blocking mechanisms" in the 2.1
request. It is now built (`migration_moderation_report_block.sql`):

- **Report** — `PlayerModerationMenu` ("..." on any other player) on the
  profile, on a drill request card, and inside a drill message thread. Reasons
  plus an optional note, with a snapshot of what the reporter saw, into
  `content_reports`.
- **Block** — enforced in RLS, not the client. Verified live in a rolled-back
  transaction: after a block neither side can open a drill request or post a
  message (both refused with 42501), existing threads vanish for both, and the
  blocked user cannot read `user_blocks` to discover they were blocked.
  Reversible at Settings → Blocked players.
- **Act within 24h** — Settings → Godmode → Reported Content lists open reports,
  flags any past 24 hours, and offers Dismiss / Remove photo / Remove account.
  Ejection reuses the same purge as self-deletion: auth user gone, profile left
  as `[deleted account]`, other players' matches intact.

Writing the drill message thread into §1 is part of the same correction. The
previous notes said "no chat or direct messaging", which was **wrong** —
`drill_requests.message` and `drill_request_messages` are exactly that. Never
restore that sentence.
