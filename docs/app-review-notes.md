# App Review Notes

Paste the block in §1 into App Store Connect → your build → **App Review
Information → Notes**. Everything after §1 is our own working context, not for
Apple.

⚠️ **Before pasting, confirm the demo account is durable.** See §3 — the current
seeded data lives in a `[SIM]`-prefixed league that our own simulation scripts
delete on every run.

---

## 1. Paste-ready notes

```text
ABOUT PICKLEAGUE
Pickleague is a recreational pickleball league manager. Players create or join a
league, schedule sessions, record match results, and track a skill rating
(PLUPR) that updates automatically from those results. It also runs tournaments
in several formats (round robin, single/double elimination, pool play, MLP).

DEMO ACCOUNT
Email:    sim_player_1@pickleague.test
Password: pickle123

This account is an ADMIN of a populated league, so it can reach both the player
and the organizer features. No special configuration or hardware is needed.

SUGGESTED WALKTHROUGH
1. Sign in with the demo account above.
2. Leagues -> open the league -> Members, Standings, and Match History are all
   populated with real recorded results.
3. Tournaments -> open the tournament to see bracket generation, seeding, and
   advancement.
4. Profile -> shows the PLUPR rating, badges, and earned "pickles" balance.
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

## 3. Demo-account durability — UNRESOLVED

The credentials above are verified working (checked 2026-08-06 against the live
auth endpoint), but the data behind them is not safe yet:

- The only populated league in the database is **`[SIM] Toolbox League`** — 62
  members, 180 matches, 1 tournament. Every other league is effectively empty.
- `cleanup()` in `simulations/simulate-flows.ts` deletes every league matching
  `like '[SIM]%'` through `godmode_delete_league`, and it runs at both the start
  and the end of every simulation run.

So any sim run during the review window empties the reviewer's account. Fix one
of these before submitting:

1. **Rename the league** to something without the `[SIM]` prefix. It drops out of
   the cleanup matcher immediately, and sims still clean up the timestamped
   leagues they create themselves. Cheapest option.
2. **Build a dedicated demo account** with its own durable league, and don't
   point the notes at the sim fleet at all. Cleanest option.

Also worth fixing either way: `sim_player_1` has **0 matches of its own**, so
"My Matches" is empty on the very account the notes send the reviewer to. Pick or
seed an account that has both admin rights and personal match history.

## 4. Still to fill in elsewhere in App Store Connect

- Age rating questionnaire — answer the contests/gambling questions consistently
  with §1. No real-money gambling, no simulated gambling with purchasable
  currency.
- App Privacy questionnaire — declare email, precise location, contacts, photos,
  push token, and user content. Keep the contacts answer aligned with the
  privacy policy's precise wording.
- Support URL (required) and Marketing URL (optional).
