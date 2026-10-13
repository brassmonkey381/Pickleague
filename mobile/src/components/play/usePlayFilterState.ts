// One Play list's filter state: quick chips, filter-sheet values and sort,
// saved per user under `play:<list>:<userId>` (foundation usePersistedState,
// version 1), plus the route-param chips that apply to this visit only.
//
// What is NOT here: search. It is never saved (plan section 4), so it stays
// plain screen state.
//
// Every user change also emits `play.filter` (chip toggles, sheet Apply per
// changed group, chip removal, sort, Clear filters). Programmatic changes (a
// tour start clearing chips, a route param) do not: they aren't the user's.
// Nor does a list mounted with `track: false` (LeagueDetail's league-scoped
// Tournaments list is not a Play list).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersistedState } from '@just-messin-around/expo-foundation/hooks';
import { removeFilterValue, type FilterValues } from '@just-messin-around/expo-foundation/ui';
import { trackPlayFilter } from '../../lib/analytics';
import {
  PLAY_PERSIST_VERSION,
  changedChip,
  countSheetFilters,
  effectiveChips,
  toggleChip,
  type PlayListKind,
  type PlayPersisted,
  type SheetValues,
} from '../../lib/playFilters';

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Stored data from any older build is checked field by field; anything of the
 *  wrong shape falls back to that field's default (never a crash, never a
 *  half-valid filter). */
function mergePlayPersisted(defaults: PlayPersisted) {
  return (stored: Partial<PlayPersisted>, _d: PlayPersisted): PlayPersisted => {
    const chips = Array.isArray(stored.chips) ? stored.chips.filter((x): x is string => typeof x === 'string') : defaults.chips;
    const sheet: SheetValues = { ...defaults.sheet };
    if (isPlainObject(stored.sheet)) {
      for (const k of Object.keys(defaults.sheet)) {
        const v = (stored.sheet as Record<string, unknown>)[k];
        const d = defaults.sheet[k];
        if (Array.isArray(d)) sheet[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
        else if (typeof v === 'string' || v === null) sheet[k] = v;
      }
    }
    const sort = typeof stored.sort === 'string' ? stored.sort : defaults.sort;
    return { chips, sheet, sort };
  };
}

function valueForEvent(v: SheetValues[string] | undefined): string | null {
  if (v == null) return null;
  return Array.isArray(v) ? v.join(',') : v;
}

export type PlayFilterState = {
  /** Chips in effect (saved + route-param). */
  chips: string[];
  /** Sheet values, every default key present. */
  sheet: SheetValues;
  sheetDefaults: SheetValues;
  /** Requested sort key ('auto' for the fallback chain). */
  sort: string;
  /** Sheet groups that differ from their defaults. */
  sheetCount: number;
  /** The saved value has loaded (or there was nothing to load). */
  ready: boolean;
  /** FilterChipRow onChangeValues. */
  setChips: (next: string[]) => void;
  /** FilterSheet onApply. */
  applySheet: (next: FilterValues) => void;
  /** ActiveFilterChips onRemove. */
  removeSheetValue: (key: string, value?: string) => void;
  /** One sheet value from outside the sheet ("Widen to 50 mi"). */
  setSheetValue: (key: string, value: string | string[] | null) => void;
  setSort: (sort: string) => void;
  /** "Clear filters": chips (saved and route) and the sheet back to defaults. */
  clearFilters: () => void;
  /** Tour start: drop the chips that could hide the first joinable row. */
  clearChipsQuietly: () => void;
};

// Every mounted list on the same storageKey, so they share one value. The
// Play tab's Leagues body and the standalone 'Leagues' route (an invite_code
// push on top of Play) are both `play:leagues:<uid>`, and usePersistedState
// keeps a separate in-memory copy per instance: without this, a chip set on
// the pushed route was overwritten by Play's stale copy at its next toggle.
// FOUNDATION-TODO: usePersistedState cross-instance sync (instances on the
// same key share one value; setValue notifies peers without re-persisting).
const peers = new Map<string, Set<(v: PlayPersisted) => void>>();

export function usePlayFilterState(opts: {
  list: PlayListKind;
  /** `play:<list>:<userId>`; null = in memory only (no user yet, or a scoped list). */
  storageKey: string | null;
  defaults: PlayPersisted;
  /** Each new value turns the Mine chip on for this visit (Home "All yours"). 0 = none. */
  routeMineToken?: number;
  /** false = do not emit play.filter (a league-scoped list is not a Play list). Default true. */
  track?: boolean;
}): PlayFilterState {
  const { list, defaults, storageKey } = opts;
  const track = opts.track !== false;
  const merge = useMemo(() => mergePlayPersisted(defaults), [defaults]);
  const [saved, setSaved, meta] = usePersistedState<PlayPersisted>(storageKey, {
    version: PLAY_PERSIST_VERSION,
    defaults,
    merge,
  });

  // Route-param chips live only in memory, so they can never be written.
  const [routeChips, setRouteChips] = useState<string[]>([]);
  useEffect(() => {
    if (opts.routeMineToken) setRouteChips((r) => (r.includes('mine') ? r : [...r, 'mine']));
  }, [opts.routeMineToken]);

  // A tour start hides the saved chips for this visit WITHOUT writing them.
  // It can fire before the uid key resolves or before the stored value has
  // loaded: a write then would either be replaced by the late load (the
  // chips come back and hide the [Join] row) or, as a write-before-load, win
  // over it and persist defaults (wiping the saved sheet and sort too). The
  // user's next chip toggle writes their new set and ends the override.
  const [tourCleared, setTourCleared] = useState(false);

  const chips = useMemo(
    () => effectiveChips(tourCleared ? [] : saved.chips, routeChips),
    [tourCleared, saved.chips, routeChips],
  );
  const sheet = useMemo<SheetValues>(() => ({ ...defaults.sheet, ...saved.sheet }), [defaults.sheet, saved.sheet]);

  // Latest values for the callbacks below, so they stay stable.
  const latest = useRef({ saved, routeChips, chips, sheet, tourCleared });
  latest.current = { saved, routeChips, chips, sheet, tourCleared };

  // This instance's peer listener (see `peers`). A value from a peer is the
  // user's newest choice, so it also ends a tour-clear override here.
  const selfRef = useRef<((v: PlayPersisted) => void) | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    const fn = (v: PlayPersisted) => { setTourCleared(false); setSaved(v); };
    selfRef.current = fn;
    let set = peers.get(storageKey);
    if (!set) { set = new Set(); peers.set(storageKey, set); }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) peers.delete(storageKey);
      if (selfRef.current === fn) selfRef.current = null;
    };
  }, [storageKey, setSaved]);

  /** Every write goes through here: apply it, then hand the result to the
   *  other mounted instances on this key. The foundation setter runs a
   *  functional update synchronously, so `next` is the value it stored, built
   *  on its latest value (two commits in one handler compose). */
  const commit = useCallback((fn: (p: PlayPersisted) => PlayPersisted) => {
    // A holder, not two `let`s: TS can't see assignments made inside the updater.
    const out: { prev?: PlayPersisted; next?: PlayPersisted } = {};
    setSaved((p) => { out.prev = p; out.next = fn(p); return out.next; });
    const value = out.next;
    if (!value || value === out.prev || !storageKey) return;
    peers.get(storageKey)?.forEach((f) => { if (f !== selfRef.current) f(value); });
  }, [setSaved, storageKey]);

  const setChips = useCallback((next: string[]) => {
    const cur = latest.current;
    const chip = changedChip(cur.chips, next);
    if (!chip) return;
    // Under a tour-clear override the visible chips start from none.
    const r = toggleChip({ saved: cur.tourCleared ? [] : cur.saved.chips, route: cur.routeChips }, chip);
    commit((p) => ({ ...p, chips: r.saved }));
    setTourCleared(false);
    setRouteChips(r.route);
    if (track) trackPlayFilter({ list, key: chip, on: r.on });
  }, [list, track, commit]);

  const writeSheet = useCallback((next: SheetValues) => {
    const cur = latest.current.sheet;
    const clean: SheetValues = {};
    for (const k of Object.keys(defaults.sheet)) {
      clean[k] = next[k] === undefined ? defaults.sheet[k] : next[k];
      const before = valueForEvent(cur[k]);
      const after = valueForEvent(clean[k]);
      if (track && before !== after) {
        trackPlayFilter({
          list,
          key: k,
          value: after,
          on: countSheetFilters({ [k]: clean[k] }, { [k]: defaults.sheet[k] }) > 0,
        });
      }
    }
    commit((p) => ({ ...p, sheet: clean }));
  }, [defaults.sheet, list, track, commit]);

  const applySheet = useCallback((next: FilterValues) => writeSheet(next), [writeSheet]);

  const removeSheetValue = useCallback((key: string, value?: string) => {
    writeSheet(removeFilterValue(latest.current.sheet, defaults.sheet, key, value));
  }, [defaults.sheet, writeSheet]);

  const setSheetValue = useCallback((key: string, value: string | string[] | null) => {
    writeSheet({ ...latest.current.sheet, [key]: value });
  }, [writeSheet]);

  const setSort = useCallback((sort: string) => {
    commit((p) => ({ ...p, sort }));
    if (track) trackPlayFilter({ list, key: 'sort', value: sort, on: true });
  }, [list, track, commit]);

  const clearFilters = useCallback(() => {
    commit((p) => ({ ...p, chips: [], sheet: { ...defaults.sheet } }));
    setTourCleared(false);
    setRouteChips([]);
    if (track) trackPlayFilter({ list, key: 'clear', on: false });
  }, [defaults.sheet, list, track, commit]);

  // Writes nothing (see tourCleared), so it is safe at any point of the load.
  const clearChipsQuietly = useCallback(() => {
    setTourCleared(true);
    setRouteChips([]);
  }, []);

  return {
    chips,
    sheet,
    sheetDefaults: defaults.sheet,
    sort: saved.sort,
    sheetCount: countSheetFilters(sheet, defaults.sheet),
    ready: meta.ready,
    setChips,
    applySheet,
    removeSheetValue,
    setSheetValue,
    setSort,
    clearFilters,
    clearChipsQuietly,
  };
}
