// The shared search area as a hook (lib/searchArea has the rules). One store
// for the whole app, kept on this device; the device location is the one
// Play and Places already share (usePlayLocation: read only when location is
// ALREADY allowed, so opening Discover never prompts).
//
// Two fallbacks keep a run without a location limited too:
//   - whenever the device is the centre, its nearest city (us_cities, the
//     city's own centre, never the device's coordinates) is saved as the
//     fallback city, so the next run without a location (every fresh web
//     visit, location turned off) still searches near where you were;
//   - with no location and no city at all, the centre of my leagues' home
//     courts (read once per signed-in user per run).
// `ready` stays false until the saved value is read and, when it is needed,
// the courts lookup has answered, so a list never shows unlimited first and
// limited a moment later.
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { usePlayLocation } from '../components/play/usePlayLocation';
import { supabase } from './supabase';
import { getMyLeagueCourts } from '../data/venueCheckins';
import { nearestCity } from '../data/courtDiscovery';
import {
  createSearchAreaStore,
  homeCourtsCenter,
  pointOf,
  resolveSearchArea,
  type LatLng,
  type SearchArea,
  type SearchAreaSaved,
  type SearchCity,
} from './searchArea';

export const searchAreaStore = createSearchAreaStore({
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
});

// ── Fallback: my leagues' home courts ───────────────────────────────────────

type Courts = { uid: string | null; center: LatLng | null; settled: boolean };
let courts: Courts = { uid: null, center: null, settled: false };
let courtsLoading: Promise<void> | null = null;
const courtsChanged = createSignal<Courts>();

/** Read (once per signed-in user per run) where my leagues play. */
function loadCourtsCenter(): Promise<void> {
  if (courtsLoading) return courtsLoading;
  courtsLoading = (async () => {
    try {
      const uid = await currentUserId(supabase);
      if (courts.settled && courts.uid === uid) return;
      const rows = uid ? await getMyLeagueCourts(uid) : [];
      courts = { uid, center: homeCourtsCenter(rows.map((r) => pointOf(r.home_court_lat, r.home_court_lng))), settled: true };
    } catch {
      // Offline or refused: no courts fallback this time (a later mount tries again).
      courts = { ...courts, settled: true };
    } finally {
      courtsLoading = null;
      courtsChanged.emit(courts);
    }
  })();
  return courtsLoading;
}

// ── Fallback: the device's nearest city ─────────────────────────────────────

let rememberedKey: string | null = null;

/** Save the nearest city to the device as the fallback city (once per ~1 km). */
function rememberDeviceCity(p: LatLng): void {
  const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
  if (rememberedKey === key) return;
  rememberedKey = key;
  void nearestCity(p)
    .then((city) => (city ? searchAreaStore.rememberCity(city) : undefined))
    .catch(() => {
      // Try again on the next fix.
      if (rememberedKey === key) rememberedKey = null;
    });
}

export type UseSearchArea = {
  /** The area in effect, or null (no location, no city, no located league court: nothing is limited). */
  area: SearchArea | null;
  saved: SearchAreaSaved;
  /** The area is known: until then a list waits rather than showing everything first. */
  ready: boolean;
  /** The device location, when known this run. */
  coords: LatLng | null;
  setRadius: (radiusMi: number) => void;
  /** "Use my location" after a fix: shares it and makes it the centre. */
  centerOnDevice: (p: LatLng) => void;
  pickCity: (c: SearchCity) => void;
};

export function useSearchArea(): UseSearchArea {
  const { coords, setCoords } = usePlayLocation();
  const [saved, setSaved] = useState<SearchAreaSaved>(searchAreaStore.get());
  const [storeReady, setStoreReady] = useState(searchAreaStore.ready());
  const [home, setHome] = useState<Courts>(courts);
  useEffect(() => {
    const off = searchAreaStore.subscribe((v) => {
      setSaved(v);
      setStoreReady(searchAreaStore.ready());
    });
    const offCourts = courtsChanged.subscribe(setHome);
    // Another screen may have changed them between render and subscribe.
    setSaved(searchAreaStore.get());
    setHome(courts);
    void searchAreaStore.load().then(() => {
      setSaved(searchAreaStore.get());
      setStoreReady(true);
    });
    return () => {
      off();
      offCourts();
    };
  }, []);

  // Neither the device nor a city: my leagues' courts are the last fallback.
  const needCourts = storeReady && !coords && !saved.city;
  useEffect(() => {
    if (needCourts) void loadCourtsCenter();
  }, [needCourts]);

  // The device is the centre: keep its nearest city for a run without it.
  useEffect(() => {
    if (storeReady && coords && saved.mode === 'device') rememberDeviceCity(coords);
  }, [storeReady, coords, saved.mode]);

  const area = useMemo(
    () => resolveSearchArea(saved, coords, needCourts ? home.center : null),
    [saved, coords, needCourts, home.center],
  );
  const ready = storeReady && (area != null || home.settled);

  return {
    area,
    saved,
    ready,
    coords,
    setRadius: searchAreaStore.setRadius,
    centerOnDevice: (p) => {
      setCoords({ lat: p.lat, lng: p.lng });
      searchAreaStore.preferDevice();
    },
    pickCity: searchAreaStore.pickCity,
  };
}
