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
A screen recording is attached to this reply. It was captured on a physical
device running the latest iOS, begins at app launch, and covers registration,
sign-in, the core league/match/tournament flows, the account deletion flow, and
every system permission prompt the app can present.

2. DEVICES AND OS VERSIONS TESTED
<<FILL IN before sending - e.g. iPhone 15 Pro (iOS 18.6), iPhone 12 (iOS 18.5),
iPad Air 11-inch M2 (iPadOS 18.6). List only what you actually tested on.>>

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
2. Leagues -> "Alameda Evening League" (8 members, 40 recorded matches).
   - Members: the full roster with ratings and profiles.
   - Standings: six locked scoring periods showing how ranks moved over time.
   - Match History: singles and doubles results, filterable.
3. Events -> two upcoming sessions: one open for time-slot voting, one already
   scheduled from a completed vote.
4. Profile -> the PLUPR rating (3.48), 23 matches in this league, badges, and
   the earned "pickles" balance.
5. Settings -> Delete account is available in-app (see below).

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
consists of: a display name, an optional profile photo, and the names of
leagues, events, and venues created by organizers. There is no public feed, no
chat or direct messaging, no comments, and no photo sharing beyond a single
profile picture. Content is visible only to other members of leagues the user
has joined, and league membership is by invite or join code rather than open to
the public. Objectionable content or a problem user can be reported to
support@pickleague.club, and we remove content and disable accounts on report.

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

The app includes a friendly prediction feature where players can stake pickles
on the outcome of a match or a final standing within their own league. Because
pickles cannot be bought and cannot be cashed out or redeemed for anything of
value, this is a leaderboard/bragging-rights mechanic rather than gambling. No
real money is involved at any point.

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
- No third-party advertising, no ad tracking, and no App Tracking Transparency
  prompt (we do not track across other companies' apps or sites).
- The same product is available on the web at https://pickleague.club.
- Support contact: support@pickleague.club
```

---

## 2. Why the pickles paragraph is in there

Guideline 5.3 (gambling) turns on consideration + chance + a **prize of value**.
The app stakes a currency on contest outcomes, which reads as the first two legs.
The real-world redemption catalogue — physical goods labelled "Worth $X.XX
online", shipped to an address — supplied the third, and was removed on
2026-08-05 (`migration_retire_real_world_redemptions.sql`; see
[`app-store-golive.md`](app-store-golive.md) §1.5).

With redemptions gone, every claim in that paragraph is literally true and
verifiable in the build: no payment SDK is bundled, `shop_items` are cosmetics
only, and the redemption RPCs are revoked at the database level. State it up
front rather than waiting to be asked — a reviewer who finds the staking feature
unprompted will assume the worst reading.

Do not soften it into vagueness, and do not claim more than is true. If
redemptions are ever reinstated, this paragraph becomes false and must change.

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

What the fixture contains: 8 players, `Alameda Evening League` (8 members, 40
matches over 45 days through the real ELO triggers), 2 seasons with 48 standings
snapshots across 6 locked periods, and 2 upcoming events. The review account is
league admin with 23 matches of its own — so unlike the old sim account, "My
Matches" is not empty.

**Gap: there is no tournament in the QA league.** The walkthrough in §1 does not
mention one, deliberately — do not add a tournament step to the notes without
seeding one first. Tournaments are a headline feature and worth demoing, so
consider seeding a completed round-robin before submitting.

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
   Match History, record a match, then open a tournament bracket.
5. **Pickles.** Show the balance, the cosmetic-only shop, and a prediction being
   staked. Do not hide this — a reviewer who finds staking unprompted after
   watching a recording that skipped it will assume the worst. §2 explains why.
6. **Account deletion.** Settings → Delete account, all the way through
   confirmation. Their list explicitly includes deletion flows, and this is the
   single most common cause of a follow-up rejection.

Nothing to record for paid content: there is no purchase or subscription flow
anywhere in the app.

Use a fresh throwaway account for step 2 and delete it in step 6, so the
recording covers both flows without touching the `qa_player_1` fixture.

### Known gap: no in-app report/block

The app has no reporting or blocking mechanism. Guideline 1.2 requires one for
apps with user-generated content, and Apple listed "content reporting and
blocking mechanisms" in this rejection. Our UGC is genuinely thin — a display
name, one profile photo, and organizer-authored league/event names, visible only
inside leagues you were invited to — and §1 says so plainly rather than
overclaiming. That is a defensible answer, but it is the likeliest cause of the
next rejection.

If they push back, the fix is a report action on `PlayerProfileScreen` plus a
block that hides a blocked user's name and photo, backed by a `user_blocks`
table. Profile photos land in the public `avatars` bucket
(`AvatarPickerModal.tsx`), so a report path needs a way to take one down.
