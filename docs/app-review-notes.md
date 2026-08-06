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
ABOUT PICKLEAGUE
Pickleague is a recreational pickleball league manager. Players create or join a
league, schedule sessions, record match results, and track a skill rating
(PLUPR) that updates automatically from those results. It also runs tournaments
in several formats (round robin, single/double elimination, pool play, MLP).

DEMO ACCOUNT
Email:    qa_player_1@pickleague.club
Password: PickleReview!2026

This account ("Ben Ortiz") is the ADMIN of a populated league, so it reaches both
the player and the organizer features. No special configuration, hardware, or
second device is needed.

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
