// The device location Play filters and sorts by ("Nearest", "Within 25 mi").
//
// The app asks for location in exactly ONE place: the "Use my location" button
// in the Filters sheet (DistanceFilterGroup). Opening Play never prompts. What
// this hook does on its own is only the no-prompt path: if permission was
// ALREADY granted (from that button on an earlier visit, or the court check-in
// flow), read the remembered / OS-cached fix and then a fresh one.
//
// Shared by both Play lists through a module-level value + signal, so granting
// on the Leagues tab also gives the Tournaments tab its "Nearest".
import { useEffect, useState } from 'react';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import {
  getCurrentCoords,
  getForegroundLocationStatus,
  getLastKnownCoords,
} from '@just-messin-around/expo-foundation/platform/location';
import type { LatLng } from '../../lib/playFilters';

let current: LatLng | null = null;
let probed = false;
const changed = createSignal<LatLng | null>();

/** Set the shared location (after "Use my location" succeeds). */
export function setPlayCoords(coords: LatLng | null): void {
  current = coords;
  changed.emit(coords);
}

/** One no-prompt probe per app run: status first, then cached, then fresh. */
async function probeExistingGrant(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    // getForegroundLocationStatus never prompts (Permissions API on web).
    if ((await getForegroundLocationStatus()) !== 'granted') return;
    const cached = await getLastKnownCoords();
    if (cached && !current) setPlayCoords({ lat: cached.lat, lng: cached.lng });
    // Already granted, so this reads a fix without a dialog.
    const fresh = await getCurrentCoords({ fallbackToLastKnown: true, timeoutMs: 8000 });
    if (fresh) setPlayCoords({ lat: fresh.lat, lng: fresh.lng });
  } catch {
    // Location is a nice-to-have here: the lists work without it.
  }
}

export function usePlayLocation(): { coords: LatLng | null; setCoords: (c: LatLng | null) => void } {
  const [coords, setCoordsState] = useState<LatLng | null>(current);
  useEffect(() => {
    const unsubscribe = changed.subscribe(setCoordsState);
    // Another list may have set it between render and subscribe.
    if (current !== coords) setCoordsState(current);
    void probeExistingGrant();
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { coords, setCoords: setPlayCoords };
}
