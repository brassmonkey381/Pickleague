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

module.exports = ({ config }) => {
  if (!GOOGLE_MAPS_ANDROID_KEY && process.env.EAS_BUILD_PLATFORM === 'android') {
    console.warn(
      '[app.config] EXPO_PUBLIC_GOOGLE_MAPS_KEY is not set — Android map tiles will render blank. ' +
        'Create a key with "Maps SDK for Android" enabled and add it to the EAS environment.',
    );
  }
  return {
    ...config,
    android: {
      ...config.android,
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
