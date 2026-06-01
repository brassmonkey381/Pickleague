import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from '../types';

// Shared ref so non-component code (e.g. push-notification tap handlers in
// lib/push.ts) can navigate without prop-drilling the navigation object.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Pending navigation that must survive an auth-stack swap. The guest-join flow
// signs the user in (anonymously), which unmounts the logged-out screen before
// it can navigate — so we stash the target here and flush once the logged-in
// navigator is mounted. Retries briefly because the target screen only exists
// after the post-sign-in re-render commits.
type PendingNav = { name: keyof RootStackParamList; params?: object };
let pendingNav: PendingNav | null = null;

export function setPendingNavigation(name: keyof RootStackParamList, params?: object): void {
  pendingNav = { name, params };
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
