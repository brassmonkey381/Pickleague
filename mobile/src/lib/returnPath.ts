// Signed-out deep links on the web come back after sign-in (TRI-007).
//
// Open pickleague.club/leagues/<id> signed out and the app shows Sign In (the
// league screens only exist in the signed-in stack); before this, signing in
// then dropped the player on Home and the league they followed was gone. The
// path is read ONCE at module load, before React Navigation rewrites the
// address bar to /login, and is opened after the first sign-in of this page
// load. A browser that already holds a session at load needs nothing: the
// linking table opens the link directly.
//
// shouldReturnTo is PURE (no React Native), so vitest reads it.

/** Paths with nothing to come back to, or with their own signed-out flow. */
const SKIP = /^\/(?:|home|login|register|check-email|claim|app\.html|(?:g|invite)(?:\/.*)?)$/;

/** The path to reopen after sign-in, or null. */
export function shouldReturnTo(pathname: string, search: string, hash: string, hasStoredSession: boolean): string | null {
  if (hasStoredSession) return null;
  const path = pathname.replace(/\/+$/, '') || '/';
  if (SKIP.test(path)) return null;
  // An auth return carries its own result; it never has a page to come back to.
  if (/(^#|&)(access_token|refresh_token|error|error_code|type)=/.test(hash)) return null;
  return path + search;
}

let pending: string | null = (() => {
  try {
    if (typeof window === 'undefined' || !window.location || typeof document === 'undefined') return null;
    let stored = false;
    try {
      for (let i = 0; !stored && i < window.localStorage.length; i++) stored = /^sb-.+-auth-token$/.test(window.localStorage.key(i) || '');
    } catch { /* storage blocked: treat as signed out */ }
    return shouldReturnTo(window.location.pathname, window.location.search, window.location.hash, stored);
  } catch {
    return null; // never throw at module load
  }
})();

/** The remembered path, once; null after the first call. */
export function takeReturnPath(): string | null {
  const p = pending;
  pending = null;
  return p;
}
