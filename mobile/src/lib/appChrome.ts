// The bottom chrome's shared numbers (PLAY_NAV_ENABLED): the bar's height
// (navigation/AppNavBar reports it) and whether an island shows (PlayIsland,
// components/play/CheckinHost). AppNavigator keeps `useNavReserve()` clear
// under every screen, so nothing sits under the bar or the island's pill; the
// island sits in that room, just above the bar.
//
// Screens with a StickyActionBar pass `useNavReserve()` as its bottomOffset
// (the foundation's bottom edge is measured from the window bottom) and pad
// their lists by `useScreenBottomInset()` instead of useBottomChromeInset()
// (which would count the bar the navigator already keeps clear).
import { useContext, useSyncExternalStore } from 'react';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useBottomChromeEdge } from '@just-messin-around/expo-foundation/navigation';
import { navReserve, screenBottomInset } from './navBarRules';
import { PLAY_NAV_ENABLED } from './features';

type State = { barPx: number; islands: ReadonlySet<string> };
let state: State = { barPx: 0, islands: new Set() };
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The bar's covered height (0 while hidden). */
export function setNavBarHeight(px: number): void {
  const barPx = Math.max(0, Math.round(px));
  if (barPx !== state.barPx) set({ ...state, barPx });
}

/** An island (`owner`) shows or hides. */
export function setIslandShown(owner: string, shown: boolean): void {
  if (state.islands.has(owner) === shown) return;
  const islands = new Set(state.islands);
  if (shown) islands.add(owner);
  else islands.delete(owner);
  set({ ...state, islands });
}

const getBar = () => state.barPx;
const getIsland = () => state.islands.size > 0;

export function useNavBarHeight(): number {
  return useSyncExternalStore(subscribe, getBar, getBar);
}

export function useIslandShown(): boolean {
  return useSyncExternalStore(subscribe, getIsland, getIsland);
}

/** The room the navigator keeps clear at the bottom (0 with the bar flagged off). */
export function useNavReserve(): number {
  const barPx = useNavBarHeight();
  const islandShown = useIslandShown();
  const insets = useContext(SafeAreaInsetsContext);
  if (!PLAY_NAV_ENABLED) return 0;
  return navReserve({ barPx, islandShown, safeBottom: insets?.bottom ?? 0 });
}

/** useBottomChromeInset for a screen inside the navigator: only what reaches above the kept-clear room. */
export function useScreenBottomInset(base = 0): number {
  const edge = useBottomChromeEdge();
  const reserve = useNavReserve();
  return screenBottomInset(base, edge, reserve);
}
