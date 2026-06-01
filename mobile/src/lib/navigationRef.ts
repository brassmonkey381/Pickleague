import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from '../types';

// Shared ref so non-component code (e.g. push-notification tap handlers in
// lib/push.ts) can navigate without prop-drilling the navigation object.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Single pending-navigation queue for any navigate that must wait for the
// navigator to become ready — a cold-start push tap (the container is gated
// behind the auth-loading splash) or the guest-join flow (anonymous sign-in
// unmounts the logged-out screen before it can navigate). Callers resolve their
// target to a concrete (name, params) and hand it here; we navigate when ready,
// retrying briefly because the target screen only exists after the relevant
// re-render commits.
type PendingNav = { name: keyof RootStackParamList; params?: object };
let pendingNav: PendingNav | null = null;

function setPendingNavigation(name: keyof RootStackParamList, params?: object): void {
  pendingNav = { name, params };
}

/**
 * Navigate now if the navigator is ready, otherwise queue and deliver once it
 * is (survives the auth-loading splash and the logged-out↔logged-in stack swap).
 */
export function navigateWhenReady(name: keyof RootStackParamList, params?: object): void {
  setPendingNavigation(name, params);
  flushPendingNavigation();
}

export function flushPendingNavigation(attempt = 0): void {
  if (!pendingNav) return;
  if (!navigationRef.isReady()) {
    if (attempt < 20) setTimeout(() => flushPendingNavigation(attempt + 1), 100);
    return;
  }
  const p = pendingNav;
  pendingNav = null;
  try {
    // Dynamic (name, params) — the generic navigate overloads can't express this.
    (navigationRef.navigate as (name: string, params?: object) => void)(p.name, p.params);
  } catch {
    // Target screen not registered yet (stack still swapping) — retry.
    pendingNav = p;
    if (attempt < 20) setTimeout(() => flushPendingNavigation(attempt + 1), 100);
  }
}
