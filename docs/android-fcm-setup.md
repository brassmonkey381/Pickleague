# Android push (FCM v1) — setup

The other half of the notification system. iOS push has been verified working
end to end since 2026-08-06; Android has never had credentials, so
`send-push` has nothing to deliver to.

The code side is done and on this branch. Everything below needs your Firebase
and Expo accounts, so it can't be run from here.

---

## What's already wired

`mobile/app.config.js` resolves `google-services.json` from two places, in order:

1. `GOOGLE_SERVICES_JSON` — an EAS environment variable of type **file**. EAS
   writes it onto the builder and sets this to its absolute path.
2. `mobile/google-services.json` — a local copy, for developer builds.

If neither exists the key is **omitted entirely** and an Android build prints a
warning. This is deliberate: `googleServicesFile` pointing at a missing path
fails the build outright, so "no file" has to mean "no Android push", not "no
Android build".

The file is gitignored. This repo is public, and while it holds no private key
it does carry the project and sender identifiers.

---

## 1. Firebase project

1. <https://console.firebase.google.com> → add project (or reuse one).
2. Add an **Android** app. Package name must be exactly `club.pickleague.app` —
   it must match `android.package` in `app.json` or FCM will not route.
3. Download the generated `google-services.json`.

The SHA-1 signing certificate is only needed for Google Sign-In, which this app
does not use. Skip it.

## 2. Give the file to EAS

```bash
cd mobile
npx eas env:create --scope project --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment production
```

Add `--environment preview` (and `development`) too if you want push in those
profiles. Keep the local copy at `mobile/google-services.json` for dev builds —
it is ignored by git.

## 3. Upload the FCM v1 service account to EAS

FCM v1 authenticates with a **service-account JSON**, which is NOT the same file
as `google-services.json`.

1. Firebase console → Project settings → **Service accounts** → Generate new
   private key. This downloads a JSON file.
2. Upload it:

```bash
npx eas credentials --platform android
# → production → Google Service Account → Manage your Google Service Account Key
#   for Push Notifications (FCM V1) → upload the JSON from step 1
```

**Treat that file as a secret.** It authenticates as your Firebase project.
Do not put it in the repo, and delete the download when you're done.

## 4. Build and verify

```bash
npx eas build --platform android --profile production
```

Install, allow notifications, then confirm a token was actually stored:

```sql
select platform, count(*)
from push_tokens
group by platform;
```

An Android row appearing is the real signal — registration silently no-ops
without credentials, which is exactly how iOS push stayed broken for 30 days
and 1,975 undelivered notifications.

Then insert a `notifications` row for that user and read `net._http_response`
newest-first. Expect `{"sent":N,"pruned":0}`.

> A 401 there means `send-push` got redeployed without `--no-verify-jwt`. That
> is a recurring trap, documented in `docs/app-store-golive.md`.

## 5. While you're in there

The same service-account JSON unblocks Play Store submits — add
`serviceAccountKeyPath` to `submit.production.android` in `eas.json`. Not needed
until you actually have a Play listing.
