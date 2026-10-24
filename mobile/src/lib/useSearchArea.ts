// The shared search area as a hook (lib/searchArea has the rules). One store
// for the whole app, kept on this device; the device location is the one
// Play and Places already share (usePlayLocation: read only when location is
// ALREADY allowed, so opening Discover never prompts).
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePlayLocation } from '../components/play/usePlayLocation';
import {
  createSearchAreaStore,
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

export type UseSearchArea = {
  /** The area in effect, or null (no location and no city yet: nothing is limited). */
  area: SearchArea | null;
  saved: SearchAreaSaved;
  /** Storage was read (until then `area` may still change once). */
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
  const [ready, setReady] = useState(searchAreaStore.ready());
  useEffect(() => {
    const off = searchAreaStore.subscribe((v) => {
      setSaved(v);
      setReady(searchAreaStore.ready());
    });
    // Another screen may have changed it between render and subscribe.
    setSaved(searchAreaStore.get());
    void searchAreaStore.load().then(() => {
      setSaved(searchAreaStore.get());
      setReady(true);
    });
    return off;
  }, []);

  const area = useMemo(() => resolveSearchArea(saved, coords), [saved, coords]);

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
