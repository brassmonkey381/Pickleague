// The bottom bar's rules (navigation/AppNavBar), pure so vitest covers them:
// where it shows, which slot is lit, and how much room the navigator keeps
// clear under the screens for the bar and the island above it.
//
// PURE: no react-native, no expo.

/** The bar's slots, left to right (the user's order, 2026-10-22). */
export type NavSlot = 'home' | 'play' | 'checkin' | 'discover' | 'me';

/**
 * Routes with no bar: the signed-out stack (Login, Register, GuestJoin,
 * InviteLanding), claiming or saving an account (onboarding), recording a
 * match (a full-screen form with its own Save), and the routes that only
 * redirect (PlayStart, and the Discover aliases that replace themselves).
 */
export const NAV_HIDDEN_ROUTES: ReadonlySet<string> = new Set([
  'Login',
  'Register',
  'GuestJoin',
  'InviteLanding',
  'Claim',
  'UpgradeAccount',
  'MatchEntry',
  'PlayStart',
]);

/** Does the bar show? Never signed out, never before the navigator knows the route, never over the keyboard. */
export function navBarVisible(p: { enabled: boolean; signedIn: boolean; route: string | null | undefined; keyboardOpen?: boolean }): boolean {
  if (!p.enabled || !p.signedIn || !p.route) return false;
  if (NAV_HIDDEN_ROUTES.has(p.route)) return false;
  return !p.keyboardOpen;
}

/**
 * The lit side slot for the focused route. Me is my own profile only (a
 * Profile with another player's id is someone else's page). Play and Check in
 * are actions, lit by their own state instead (a session, a check-in).
 */
export function activeNavSlot(route: string | null | undefined, params?: Record<string, unknown> | null, myId?: string | null): NavSlot | null {
  switch (route) {
    case 'Home':
      return 'home';
    case 'Discover':
      return 'discover';
    case 'Profile': {
      const id = params && typeof params.userId === 'string' ? params.userId : null;
      return !id || (myId != null && id === myId) ? 'me' : null;
    }
    default:
      return null;
  }
}

/** The island's pill and its gap above the bar: the room screens keep clear for it. */
export const ISLAND_ZONE_PX = 52;

/**
 * How much room the navigator keeps clear at the bottom, so no screen's
 * content sits under the bar or the island's pill: the bar's height (its
 * safe-area padding included) when it shows, plus the island's zone when an
 * island shows (over the safe area when the bar is hidden). 0 when neither.
 */
export function navReserve(p: { barPx: number; islandShown: boolean; safeBottom: number }): number {
  const bar = Math.max(0, p.barPx);
  if (!p.islandShown) return bar;
  return (bar > 0 ? bar : Math.max(0, p.safeBottom)) + ISLAND_ZONE_PX;
}

/** Where the island's bottom edge goes: just above the bar, else above the safe area. */
export function islandBottom(p: { barPx: number; safeBottom: number; gap: number }): number {
  return (p.barPx > 0 ? p.barPx : Math.max(0, p.safeBottom)) + p.gap;
}

/**
 * Padding a list needs at its end so its last row scrolls clear of a sticky
 * action bar, when the navigator already keeps `reserve` clear: only what
 * reaches above that (the foundation's bottom chrome edge is measured from
 * the window bottom, and the bar publishes into it too).
 */
export function screenBottomInset(base: number, chromeEdge: number, reserve: number): number {
  return base + Math.max(0, chromeEdge - reserve);
}
