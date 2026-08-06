# App Store Go-Live Checklist

Status as of 2026-08-05. Everything under §1/§2 was checked against the current
tree; everything under "Needs your accounts" cannot be checked from here (Apple
Developer / Play Console credentials are interactive).

Bundle / application ID: `club.pickleague.app` on both platforms. EAS project
`a6b4311e-5bd8-4fab-bc6d-51ad44bfbe7c`, owner `brassmonkey381`. Web is already
live at pickleague.club (Vercel, auto-deploy on push to `master`).

---

## 1. Repo blockers — resolved 2026-08-05

### 1.1 Privacy policy — DONE

`mobile/public/privacy.html`, served at `pickleague.club/privacy` via an explicit
rewrite ahead of the SPA catch-all in `vercel.json`, and linked from
**Settings → Privacy Policy**. Verified that `expo export` copies `public/` into
`dist/` byte-for-byte.

It documents email, precise location, contacts, photos, push tokens, match data,
and the four processors (Supabase, Expo, Vercel, Google Places).

Two things to know about the content:

- **The contacts wording is deliberately precise.** The address book is read
  on-device and never uploaded, but when you select people and send an invite,
  `create_guest_invite` sends *those* names and phone numbers to the server.
  The policy says exactly that. Keep the Play Data Safety answers consistent
  with it, or the declaration is inaccurate.
- **`support@pickleague.club` is the stated contact.** That mailbox must
  actually receive mail before you submit — reviewers do use it.

Terms of service still doesn't exist. Not required by Apple, and less pressing
now that §1.5 is resolved, but worth having.

### 1.2 Android `package` — DONE

`"package": "club.pickleague.app"` added to the `android` block, matching iOS.
Permanent once published.

### 1.3 `WRITE_CONTACTS` — DONE

Removed. `READ_CONTACTS` retained. Confirmed nothing in the app writes contacts.

### 1.4 `eas.json` `submit.production` — DONE (iOS)

```json
"submit": {
  "production": {
    "ios": { "ascAppId": "6796130870", "appleTeamId": "WJ7Y8W9WKC" }
  }
}
```

**`appleId` is deliberately absent.** This repo is public and git history is
permanent, so the account email stays out of it — EAS reads `EXPO_APPLE_ID` from
the environment when the field is missing. Export it before submitting:

```bash
export EXPO_APPLE_ID=brassmonkey381@msn.com   # or set it in your shell profile
```

The two values that *are* committed aren't secrets: the team ID ships inside
every signed binary and the ASC app ID is in the App Store URL.

Better still, long term: an App Store Connect **API key** (`ascApiKeyPath`)
removes the Apple ID and its 2FA prompt from the flow entirely, which matters if
submits ever run from CI.

Android still has no `serviceAccountKeyPath`, so a Play submit will prompt. That
needs the Firebase/Play service-account JSON from §2 of the push setup.

### 1.5 Wagering + real-world redemption — RESOLVED by removing redemptions

The concern was the combination: `mobile/src/lib/wager.ts` stakes pickles on
match/score/rank outcomes, and the Shop redeemed pickles for physical goods
labelled "Worth $X.XX online" with a shipping address. Guideline 5.3 gambling
needs consideration + chance + a **prize of value**; the redemptions supplied
that last leg even though pickles are earn-only.

Redemptions are now gone, both halves:

- **Client** — the `real_world` tab, the shipping-address forms, the daily
  discount carousel, and the `redeem_real_world_item` / `gift_real_world_item`
  call sites are removed from `ShopScreen`. The Shop is cosmetics only.
- **Server** — `migration_retire_real_world_redemptions.sql` sets every
  `real_world` item inactive and revokes EXECUTE on all three RPCs from
  `authenticated`. Applied and verified in prod: 0 active items, all three
  revoked. This matters because a web client can hold a stale JS bundle — the
  UI removal alone is not a kill switch.

`redemption_orders` and its six pending rows were **deliberately not dropped**.
All six belong to the owner's own account, but the table is the only record of
them; retiring is reversible, dropping isn't. Fulfil or cancel-and-refund them by
hand.

What's left of the loop — earn pickles by playing, stake them on outcomes, spend
them on avatars and name styles — is a leaderboard mechanic. Still worth a line
in App Review Notes: currency cannot be purchased, has no cash value, and buys
only cosmetics.

### 1.6 Version string drift — DONE

`AboutScreen` and `SettingsScreen` both hardcoded `1.0.0` while `app.json` said
`1.0.1`. Both now read `Constants.expoConfig?.version`.

---

## 2. Already in good shape

Verified, no action needed:

- **In-app account deletion** — `SettingsScreen` → `delete_my_account` RPC. Apple
  requires this for any app with account creation (Guideline 5.1.1(v)). Present.
- **`ITSAppUsesNonExemptEncryption: false`** — set in `app.json`, so you skip the
  export-compliance prompt on every build.
- **All four iOS usage strings** — location, contacts, photo library. Each is
  specific about why, which is what Apple actually checks.
- **`runtimeVersion.policy: appVersion` + EAS Update** — OTA channel is wired.
- **`autoIncrement: true`** on the production profile, with
  `appVersionSource: remote` — build numbers won't collide.

---

## 3. Needs your Apple / Google accounts

I can't do any of these headlessly.

- [ ] **EAS push credentials** — APNs key (iOS) and FCM v1 service account
      (Android) via `eas credentials`. **Push does not work in a store build
      without these.** The whole notification system (trigger → `send-push` Edge
      Function → Expo Push API) is live and verified server-side, so this is the
      one remaining gap between "works in Expo Go" and "works for real users."
- [ ] **App Store Connect app record** — create it, grab the numeric `ascAppId`
      for §1.4.
- [ ] **Privacy questionnaire / Play Data Safety form** — declare: email,
      approximate + precise location, contacts (read), photos, push token,
      user-generated content. Must match the privacy policy from §1.1.
- [ ] **Screenshots** — 6.7" and 6.5" iPhone required; iPad too, since
      `supportsTablet: true` (turn that off if you don't want to produce them and
      don't want iPad reviewers).
- [ ] **App Review demo account** — a seeded login with a league, a season, and a
      finished tournament. Reviewers reject apps whose content is empty on
      first launch. `scripts/seed-fake-players.mjs` can build the data.
- [ ] **Support URL** — required field; can be a simple page.
- [ ] **Age rating** — answer the gambling/contests questions consistently with §1.5.
- [ ] **Supabase SMTP** — confirm production email sending is off the shared
      Supabase sender, or confirmation emails will throttle at real signup volume.
- [ ] **`https://pickleague.club/claim`** — add to Supabase auth redirect allowlist.

---

## 4. Pre-flight, run before every submission

```bash
cd mobile
npx tsc --noEmit          # expect 0
npm test                  # expect all green
npm run build:web         # web is a first-class target; must export

cd ../simulations
npm run brackets          # if tournament or rating logic changed
```

Then smoke-test the built web bundle in a browser — a successful export does not
mean it renders (RNW `RefreshControl` and native-only Expo APIs have both broken
the page while the bundle built fine).

Build and submit:

```bash
cd mobile
eas build --platform ios --profile production --auto-submit
```

**Still unvalidated:** the react-native-maps fix from the earlier TestFlight crash
work has not been confirmed against a production build. That should be the first
build you run, and the map screens are the first thing to open on the device.

---

## 5. What's left, in order

Closed on 2026-08-06: privacy policy live, `support@pickleague.club` routing,
iOS push working end to end, `eas.json` submit target, and all the `app.json`
fixes.

1. **Production build; confirm the maps crash is gone** (§4). Every existing
   build (v1.0.1 build 6, 2026-07-31 and earlier) predates today's changes, so a
   fresh one is required regardless. Open the map screens first.
2. **Android FCM v1** — the other half of push. Firebase project → app registered
   as `club.pickleague.app` → `google-services.json` in `mobile/` →
   `googleServicesFile` wired into `app.json` → service-account JSON uploaded via
   `eas credentials -p android`. Same JSON also unblocks Play submits (§1.4).
3. **Listing assets, demo account, privacy questionnaires** (§3). Keep the Data
   Safety contacts answer consistent with §1.1.
4. **Write the App Review note** about pickles (§1.5).

### iOS push — verified working 2026-08-06

Token registered, APNs key good, delivery confirmed on device. Getting there
turned up a bug that had silenced push since it shipped: `send-push` was deployed
with the platform-default `verify_jwt: true`, so the gateway 401'd the DB
trigger before the function body ran. The trigger authenticates with
`x-push-secret` and swallows errors by design, so nothing surfaced — 1,975
notifications over 30 days, zero delivered. Redeployed identical code as v4 with
`verify_jwt: false`.

**This regresses the moment anyone runs `supabase functions deploy send-push`
without `--no-verify-jwt`.** To verify after any redeploy: insert a
`notifications` row, then read `net._http_response` newest-first. Expect
`{"sent":N,"pruned":0}`; a 401 means the flag is back on.
