// Discover's ONE search area (Doggle's "Search near" + "Within 5 mi"): every
// search on Discover (Leagues, Tournaments, Places, Players) and Find
// Drillers is limited to it. The "Mine" lists (my leagues, my tournaments,
// my friends, requests, people I've played with) are not.
//
//   centre  the device location while the player chose "Use my location" and
//           it is known; else the saved city: one they searched, or the
//           nearest city to where the device last was (the fallback while
//           location is off, denied or not read yet this run, e.g. every
//           fresh web visit); else the centre of my leagues' home courts;
//           else none
//   radius  5 / 10 / 25 / 50 mi (default 5, Places' old default)
//
// Kept per device (AsyncStorage, via the store below): the radius, the mode
// and the city (a city's own centre, from us_cities). Device coordinates are
// NEVER saved; they come only from a location grant this run
// (components/play/usePlayLocation).
//
// Only with none of those (no location ever, no city, in no league with a
// located court) is nothing limited (a first open must not be a dead end),
// and the control asks for an area.
//
// PURE: no React, no react-native, no Supabase. lib/useSearchArea wires it to
// AsyncStorage and the device location; the vitest suite pins every rule.

export type LatLng = { lat: number; lng: number };

export const SEARCH_RADIUS_MILES = [5, 10, 25, 50] as const;
export type SearchRadiusMiles = (typeof SEARCH_RADIUS_MILES)[number];
export const DEFAULT_SEARCH_RADIUS_MILES: SearchRadiusMiles = 5;

export const METERS_PER_MILE = 1609.344;

/** A city picked in "Search near" (us_cities). */
export type SearchCity = { label: string; lat: number; lng: number };

/** What is saved on this device. */
export type SearchAreaSaved = {
  radiusMi: SearchRadiusMiles;
  /** 'device': my location when known (the city is the fallback); 'city': the city. */
  mode: 'device' | 'city';
  city: SearchCity | null;
};

export const SEARCH_AREA_STORAGE_KEY = 'pickleague:search_area:v1';

export const DEFAULT_SEARCH_AREA: SearchAreaSaved = {
  radiusMi: DEFAULT_SEARCH_RADIUS_MILES,
  mode: 'device',
  city: null,
};

/** The area as it applies right now. */
export type SearchArea = {
  center: LatLng;
  radiusMi: number;
  radiusM: number;
  /** Where the centre came from ('courts': my leagues' home courts). */
  source: 'device' | 'city' | 'courts';
  /** The city's label; null for the device and the courts (the control looks one up). */
  label: string | null;
};

function finitePoint(lat: unknown, lng: unknown): LatLng | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // (0, 0) is a missing value written as zeros, not a court in the Atlantic.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** A radius as one of the choices; anything else reads as the default. */
export function asSearchRadius(v: unknown): SearchRadiusMiles {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return (SEARCH_RADIUS_MILES as readonly unknown[]).includes(n) ? (n as SearchRadiusMiles) : DEFAULT_SEARCH_RADIUS_MILES;
}

/** Whatever storage held (an older shape, junk, nothing) as a valid value. */
export function parseSearchAreaSaved(raw: unknown): SearchAreaSaved {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { ...DEFAULT_SEARCH_AREA };
    }
  }
  if (!v || typeof v !== 'object') return { ...DEFAULT_SEARCH_AREA };
  const o = v as Record<string, unknown>;
  const c = o.city as Record<string, unknown> | null | undefined;
  const p = c && typeof c === 'object' ? finitePoint(c.lat, c.lng) : null;
  const city = p && typeof c?.label === 'string' && c.label.trim() ? { label: c.label.trim(), ...p } : null;
  return {
    radiusMi: asSearchRadius(o.radiusMi),
    // A 'city' mode without a city has nothing to stand on.
    mode: o.mode === 'city' && city ? 'city' : 'device',
    city,
  };
}

/**
 * The area in effect: the city when the player chose it; else the device
 * location when known; else the saved city (location off, denied or not read
 * yet); else the centre of my leagues' home courts (`courts`); else null
 * (nothing is limited).
 */
export function resolveSearchArea(
  saved: SearchAreaSaved,
  device: LatLng | null,
  courts: LatLng | null = null,
): SearchArea | null {
  const radiusMi = asSearchRadius(saved.radiusMi);
  const radiusM = Math.round(radiusMi * METERS_PER_MILE);
  const dev = device ? finitePoint(device.lat, device.lng) : null;
  if (saved.mode === 'city' && saved.city) {
    return { center: { lat: saved.city.lat, lng: saved.city.lng }, radiusMi, radiusM, source: 'city', label: saved.city.label };
  }
  if (dev) return { center: dev, radiusMi, radiusM, source: 'device', label: null };
  if (saved.city) {
    return { center: { lat: saved.city.lat, lng: saved.city.lng }, radiusMi, radiusM, source: 'city', label: saved.city.label };
  }
  const home = courts ? finitePoint(courts.lat, courts.lng) : null;
  if (home) return { center: home, radiusMi, radiusM, source: 'courts', label: null };
  return null;
}

/** How close two of my courts must be to count as one place I play. */
const HOME_CLUSTER_MILES = 25;

/**
 * Where I play, from my leagues' home courts: the court with the most of my
 * other courts within 25 mi (the first on a tie), averaged with those. A plain
 * average of a Bay Area league and a New York one would land in Kansas; this
 * lands in the Bay Area. Null with no located court.
 */
export function homeCourtsCenter(points: ReadonlyArray<LatLng | null | undefined>): LatLng | null {
  const pts = points.flatMap((p) => {
    const q = p ? finitePoint(p.lat, p.lng) : null;
    return q ? [q] : [];
  });
  if (pts.length === 0) return null;
  let best: LatLng[] = [];
  for (const p of pts) {
    const near = pts.filter((q) => milesBetween(p, q) <= HOME_CLUSTER_MILES);
    if (near.length > best.length) best = near;
  }
  return {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lng: best.reduce((s, p) => s + p.lng, 0) / best.length,
  };
}

/** A stable key for caches and "start over at page 1" (centre to ~100 m). */
export function searchAreaKey(area: SearchArea | null): string {
  if (!area) return 'anywhere';
  return `${area.center.lat.toFixed(3)},${area.center.lng.toFixed(3)}:${area.radiusMi}`;
}

/** "Near Alameda, CA · 5 mi" (the control's spoken label). */
export function searchAreaLabel(area: SearchArea | null, placeLabel: string | null): string {
  if (!area) return 'Choose an area';
  const where = area.label ?? placeLabel
    ?? (area.source === 'device' ? 'your location' : area.source === 'courts' ? 'your courts' : 'here');
  return `Near ${where} · ${area.radiusMi} mi`;
}

// ── Distance ─────────────────────────────────────────────────────────────────

/** Great-circle distance in miles (haversine). */
export function milesBetween(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A row's point, or null when it has none (null, NaN, or 0/0). */
export function pointOf(lat: number | null | undefined, lng: number | null | undefined): LatLng | null {
  return finitePoint(lat, lng);
}

/**
 * Whether a point is inside the area. No area: everything is (nothing is
 * limited yet). A row with no point is never inside an area: it can't be
 * placed, so a search near somewhere leaves it out.
 */
export function withinSearchArea(point: LatLng | null, area: SearchArea | null): boolean {
  if (!area) return true;
  if (!point) return false;
  return milesBetween(area.center, point) <= area.radiusMi;
}

/** The rows inside the area, in their order. `pointFor` may return several
 *  points (a player's courts): any one inside counts. */
export function filterBySearchArea<T>(
  rows: readonly T[],
  area: SearchArea | null,
  pointFor: (row: T) => LatLng | null | ReadonlyArray<LatLng | null>,
): T[] {
  if (!area) return [...rows];
  return rows.filter((r) => {
    const p = pointFor(r);
    const pts = Array.isArray(p) ? (p as ReadonlyArray<LatLng | null>) : [p as LatLng | null];
    return pts.some((x) => withinSearchArea(x, area));
  });
}

/** The next wider radius ("Widen to 10 mi"), or null at the widest. */
export function widerSearchRadius(radiusMi: number): SearchRadiusMiles | null {
  return SEARCH_RADIUS_MILES.find((r) => r > radiusMi) ?? null;
}

/** "0.4 mi", "3 mi", "12 mi". */
export function formatMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return '';
  if (miles < 0.95) return `${Math.max(0.1, Math.round(miles * 10) / 10)} mi`;
  return `${Math.round(miles)} mi`;
}

// ── The shared store ─────────────────────────────────────────────────────────

/** The bits of AsyncStorage the store uses (a fake in tests). */
export type SearchAreaStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export type SearchAreaStore = {
  /** The saved value (defaults until `load` finishes). */
  get: () => SearchAreaSaved;
  /** True once storage was read (or failed: the defaults stand). */
  ready: () => boolean;
  /** Read storage once; later calls return the same promise. */
  load: () => Promise<void>;
  subscribe: (fn: (v: SearchAreaSaved) => void) => () => void;
  setRadius: (radiusMi: number) => void;
  /** "Use my location": the device location wins again (the city stays as the fallback). */
  preferDevice: () => void;
  /** "Search near <city>". */
  pickCity: (city: SearchCity) => void;
  /**
   * The nearest city to the device, kept as the fallback for a run without
   * a location (a fresh web visit, location turned off). Only while the
   * device is the centre: a city the player chose stays. After `load`, so it
   * never hides what storage held.
   */
  rememberCity: (city: SearchCity) => Promise<void>;
};

/**
 * One process-wide value every tab reads, so a change on Places is the area
 * on Leagues at once. Writes are best effort: a storage failure (a private
 * window) keeps the value for this run.
 */
export function createSearchAreaStore(storage: SearchAreaStorage | null, key = SEARCH_AREA_STORAGE_KEY): SearchAreaStore {
  let value: SearchAreaSaved = { ...DEFAULT_SEARCH_AREA };
  let isReady = !storage;
  let loading: Promise<void> | null = null;
  // A change made before the read finished wins over what storage held.
  let touched = false;
  const listeners = new Set<(v: SearchAreaSaved) => void>();

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(value);
      } catch {
        // One bad listener must not break the others.
      }
    }
  };
  const save = () => {
    if (!storage) return;
    try {
      void storage.setItem(key, JSON.stringify(value)).catch(() => {});
    } catch {
      // Storage unavailable: the value holds for this run.
    }
  };
  const set = (next: SearchAreaSaved) => {
    touched = true;
    const same = next.radiusMi === value.radiusMi && next.mode === value.mode
      && (next.city === value.city || (!!next.city && !!value.city && next.city.label === value.city.label
        && next.city.lat === value.city.lat && next.city.lng === value.city.lng));
    value = next;
    if (same) return;
    save();
    emit();
  };

  const load = (): Promise<void> => {
    if (loading) return loading;
    if (!storage) {
      isReady = true;
      return (loading = Promise.resolve());
    }
    loading = (async () => {
      try {
        const raw = await storage.getItem(key);
        if (!touched && raw != null) value = parseSearchAreaSaved(raw);
      } catch {
        // Unreadable: the defaults stand.
      }
      isReady = true;
      emit();
    })();
    return loading;
  };

  return {
    get: () => value,
    ready: () => isReady,
    load,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setRadius(radiusMi) {
      set({ ...value, radiusMi: asSearchRadius(radiusMi) });
    },
    preferDevice() {
      set({ ...value, mode: 'device' });
    },
    pickCity(city) {
      const p = finitePoint(city.lat, city.lng);
      if (!p || !city.label?.trim()) return;
      set({ ...value, mode: 'city', city: { label: city.label.trim(), ...p } });
    },
    async rememberCity(city) {
      await load();
      const p = finitePoint(city.lat, city.lng);
      if (!p || !city.label?.trim() || value.mode !== 'device') return;
      set({ ...value, city: { label: city.label.trim(), ...p } });
    },
  };
}
