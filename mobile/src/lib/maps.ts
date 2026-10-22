// Map settings for court Discover (state/court-discovery-plan.md, Phase 2),
// mirroring Doggle's lib/maps.ts: the same foundation maps, interactive on
// every platform and all free (no metered API):
//   web     = OpenStreetMap tiles (Leaflet)
//   iOS     = Apple Maps (react-native-maps, already in the binary)
//   Android = Google Maps SDK, which needs a Maps key baked into the manifest
//             by app.config.js. It arrives with a native build only.
//
// One difference from Doggle, on purpose: the key is EXPO_PUBLIC_GOOGLE_MAPS_KEY,
// never EXPO_PUBLIC_GOOGLE_PLACES_KEY (app.config.js explains why: that value
// isn't a Maps Platform key here). RadiusPlacesMap uses the key only to pick
// the Google provider on Android; without it Android still draws the default
// provider, which shows blank tiles until a build carries the key.
import { Platform } from 'react-native';

export const googleMapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY ?? '';
export const hasGoogleMaps = Boolean(googleMapsKey);

// How place maps render, per platform. 'static' is a Google Static Maps image
// and needs `googleMapsKey`; flip a platform to it only if its interactive map
// misbehaves.
export type PlaceMapMode = 'interactive' | 'static';

export const PLACE_MAP_MODE: Record<'web' | 'ios' | 'android', PlaceMapMode> = {
  web: 'interactive',
  ios: 'interactive',
  android: 'interactive',
};

/** Place-map mode for the platform we're running on. */
export function placeMapMode(): PlaceMapMode {
  if (Platform.OS === 'ios') return PLACE_MAP_MODE.ios;
  if (Platform.OS === 'android') return PLACE_MAP_MODE.android;
  return PLACE_MAP_MODE.web;
}
