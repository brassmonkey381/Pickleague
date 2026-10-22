// The bell's badge (Home's top bar; the bottom bar has no Alerts slot, the
// user's decision 1): its NUMBER is what needs me (lib/agenda needsYouCount),
// and plain unread notices only light a dot. Home's load sets it; anything
// can read it, and it survives Home remounting.
import { useSyncExternalStore } from 'react';
import type { TopBarBadge } from '@just-messin-around/expo-foundation/ui';

export type AlertCounts = { needYou: number; unread: number };

/** The badge for these counts: the needs-you number, else a dot for unread, else none. */
export function alertBadgeFor(c: AlertCounts | null): TopBarBadge | null {
  if (!c) return null;
  if (c.needYou > 0) return c.needYou;
  return c.unread > 0 ? 'dot' : null;
}

let counts: AlertCounts | null = null;
const listeners = new Set<() => void>();

export function setAlertBadge(next: AlertCounts): void {
  if (counts && counts.needYou === next.needYou && counts.unread === next.unread) return;
  counts = { ...next };
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const get = () => counts;

/** The bell's badge, or null for none. */
export function useAlertBadge(): TopBarBadge | null {
  return alertBadgeFor(useSyncExternalStore(subscribe, get, get));
}
