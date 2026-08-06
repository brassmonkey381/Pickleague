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

### 1.4 `eas.json` `submit.production` — STILL OPEN

The one item that can't be closed from here. Needs three values from App Store
Connect, which requires interactive Apple auth:

```json
"submit": {
  "production": {
    "ios": {
      "appleId": "<your Apple ID email>",
      "ascAppId": "<numeric App Store Connect app ID — not the bundle ID>",
      "appleTeamId": "<10-char team ID>"
    }
  }
}
```

Android submissions additionally need `android.serviceAccountKeyPath` pointing at
a Play service-account JSON. Until this is filled in, `--auto-submit` prompts
instead of running unattended. EAS itself is already authenticated
(`eas whoami` → `brassmonkey381`).

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

1. **Make `support@pickleague.club` receive mail** (§1.1) — the policy is live and
   names it; a dead contact address is a rejection risk.
2. **Push credentials** (§3) — longest lead time, needs both developer accounts.
3. **Fill in `eas.json` submit block** (§1.4) — needs the App Store Connect record
   to exist first.
4. **Production build; confirm the maps crash is gone** (§4) — still unvalidated.
5. **Listing assets, demo account, privacy questionnaires** (§3).
6. **Write the App Review note** about pickles (§1.5).
