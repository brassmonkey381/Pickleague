import { createNavigationContainerRef, ParamListBase } from '@react-navigation/native';

/**
 * Create a navigation ref plus a single pending-navigation queue, generic over
 * the app's param list. Lets non-component code (push-notification tap handlers,
 * deep-link / guest-join flows) navigate without prop-drilling the navigation
 * object.
 *
 * The queue survives navigates that must wait for the navigator to become ready
 * — a cold-start push tap (the container is gated behind an auth-loading splash)
 * or an auth flow that unmounts the current screen before it can navigate. It
 * retries briefly because the target screen only exists after the relevant
 * re-render commits.
 */
export function createNavigationRef<T extends ParamListBase>() {
  const navigationRef = createNavigationContainerRef<T>();

  type PendingNav = { name: keyof T; params?: object };
  let pendingNav: PendingNav | null = null;

  function setPendingNavigation(name: keyof T, params?: object): void {
    pendingNav = { name, params };
  }

  /**
   * Navigate now if the navigator is ready, otherwise queue and deliver once it
   * is (survives the auth-loading splash and the logged-out↔logged-in stack swap).
   */
  function navigateWhenReady(name: keyof T, params?: object): void {
    setPendingNavigation(name, params);
    flushPendingNavigation();
  }

  function flushPendingNavigation(attempt = 0): void {
    if (!pendingNav) return;
    if (!navigationRef.isReady()) {
      if (attempt < 20) setTimeout(() => flushPendingNavigation(attempt + 1), 100);
      return;
    }
    const p = pendingNav;
    pendingNav = null;
    try {
      // Dynamic (name, params) — the generic navigate overloads can't express this,
      // so erase to a plain (name, params) call via unknown.
      (navigationRef.navigate as unknown as (name: string, params?: object) => void)(p.name as string, p.params);
    } catch {
      // Target screen not registered yet (stack still swapping) — retry.
      pendingNav = p;
      if (attempt < 20) setTimeout(() => flushPendingNavigation(attempt + 1), 100);
    }
  }

  return { navigationRef, navigateWhenReady, flushPendingNavigation };
}
