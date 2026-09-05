// Dynamic layer over app.json. Expo reads app.json first and hands it in as
// `config`; everything here is merged on top.
//
// It exists for one reason: react-native-maps needs a Google Maps SDK key baked
// into the Android manifest, and app.json is static JSON with no way to read an
// env var. iOS needs nothing here — it renders through Apple Maps.
//
// Deliberately no fallback to EXPO_PUBLIC_GOOGLE_PLACES_KEY: that value is not a
// Google Maps Platform key (those are 39 chars, prefixed "AIza"), and the venue
// picker no longer uses it at all (externalSearch="none" — see CourtPicker).
// Baking it in would ship an Android manifest with a key Google rejects.
//
// The key ships inside the APK by design; Google's expectation is that it is
// restricted by package name + signing certificate in the Cloud console rather
// than kept secret. Set it in mobile/.env locally and as an EAS environment
// variable for builds.
const GOOGLE_MAPS_ANDROID_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY;

// ── Android push (FCM v1) ──────────────────────────────────────────────────
// google-services.json is what lets FCM address this app. It is NOT committed:
// this repo is public, and while the file holds no private key, it does carry
// the project/sender identifiers, and a public copy invites nuisance traffic
// against them.
//
// Two supply routes, in priority order:
//   1. GOOGLE_SERVICES_JSON — an EAS environment variable of type "file". EAS
//      materialises it on the builder and sets this to its absolute path.
//   2. mobile/google-services.json — a local copy for developer builds.
//
// Resolved to null when neither exists, and the key is then omitted entirely.
// That matters: pointing googleServicesFile at a missing path fails the Android
// build outright, so an absent file has to mean "no Android push" rather than
// "no Android build". See docs/android-fcm-setup.md.
const fs = require('fs');
const path = require('path');

function resolveGoogleServices() {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.resolve(__dirname, 'google-services.json');
  if (fs.existsSync(local)) return './google-services.json';
  return null;
}

module.exports = ({ config }) => {
  const googleServicesFile = resolveGoogleServices();
  if (!GOOGLE_MAPS_ANDROID_KEY && process.env.EAS_BUILD_PLATFORM === 'android') {
    console.warn(
      '[app.config] EXPO_PUBLIC_GOOGLE_MAPS_KEY is not set — Android map tiles will render blank. ' +
        'Create a key with "Maps SDK for Android" enabled and add it to the EAS environment.',
    );
  }
  if (!googleServicesFile && process.env.EAS_BUILD_PLATFORM === 'android') {
    console.warn(
      '[app.config] google-services.json not found — this Android build CANNOT receive push ' +
        'notifications. Supply it as the EAS file variable GOOGLE_SERVICES_JSON. ' +
        'See docs/android-fcm-setup.md.',
    );
  }
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
      ...(GOOGLE_MAPS_ANDROID_KEY
        ? {
            config: {
              ...config.android?.config,
              googleMaps: { apiKey: GOOGLE_MAPS_ANDROID_KEY },
            },
          }
        : {}),
    },
  };
};
