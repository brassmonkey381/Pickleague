// "Continue in the app" — our answer to deferred deep linking, without an SDK.
//
// The gap: tap a pickleague.club link with the app installed and the universal
// link opens it on the right screen. Tap it WITHOUT the app and you land in the
// browser; install from there and the app opens cold on Home, having lost the
// league or event you were trying to reach. iOS has no built-in fix — and since
// iOS 16 removed silent clipboard reads, closing it properly means a
// third-party attribution SDK (Branch, AppsFlyer), which would add a data
// processor to our privacy policy and likely flip our App Store answer to
// "data used to track you". Not worth it for one lost tap.
//
// So we close it from the web side instead. When a visitor on a real content
// URL taps "get the app", we remember where they were. Next time they open the
// site, we offer that destination back as a link — and if they installed in the
// meantime, the universal-link association hands it straight to the app on the
// correct screen.
//
// Web-only and localStorage-only by design: nothing is sent anywhere, no
// identifier is minted, and it is per-browser, which is exactly the scope of
// the problem being solved.
import { Platform } from 'react-native';

const KEY = 'pickleague:pendingDeepLink';

/** Long enough to cover "install now, come back this evening"; short enough
 *  that a months-old link never ambushes someone. */
const MAX_AGE_MS = 7 * 86_400_000;

/** Paths with nothing to return to — the root, and the two static pages. */
const NOT_WORTH_REMEMBERING = ['/', '/privacy', '/landing', '/login', '/register'];

type Pending = { path: string; at: number };

function storage(): Storage | null {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    // Private mode / blocked storage. The feature is a nicety; it may vanish.
    return null;
  }
}

/**
 * Remember the visitor's current location as somewhere worth returning to.
 * Call this when they act on an install prompt — not on every page view, so
 * what comes back is a place they chose, not the last thing they scrolled past.
 */
export function rememberDestination(): void {
  try {
    const s = storage();
    if (!s) return;
    const path = window.location.pathname + window.location.search;
    if (NOT_WORTH_REMEMBERING.includes(window.location.pathname)) return;
    s.setItem(KEY, JSON.stringify({ path, at: Date.now() } satisfies Pending));
  } catch {
    /* never break a click handler over bookkeeping */
  }
}

/**
 * The remembered destination, if there is a fresh one and we are not already
 * standing on it. Read-only — call `clearDestination` once it has been acted on
 * or dismissed.
 */
export function peekDestination(): string | null {
  try {
    const s = storage();
    if (!s) return null;
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Pending>;
    if (typeof parsed?.path !== 'string' || typeof parsed?.at !== 'number') return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) {
      s.removeItem(KEY);
      return null;
    }
    // Already here — offering to "continue" to the current page is noise.
    if (parsed.path === window.location.pathname + window.location.search) return null;
    return parsed.path;
  } catch {
    return null;
  }
}

export function clearDestination(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
