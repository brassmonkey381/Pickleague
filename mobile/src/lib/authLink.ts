// The link in a Supabase auth email (PKL-020). Supabase checks the link, then
// redirects to the site with the result in the URL hash:
//   success: #access_token=...&refresh_token=...&type=signup
//   failure: #error=access_denied&error_code=otp_expired&error_description=...
// On the web supabase-js reads a success itself (detectSessionInUrl). On a phone
// with the app installed, iOS opens pickleague.club links in the app, which
// never read the hash: the player landed on a bare Sign In (Brian, 2026-11-10).
// This parses either result so the app can sign in, or say what happened.
//
// PURE (no React Native), so vitest reads it.

export type AuthLinkResult =
  | { kind: 'session'; accessToken: string; refreshToken: string; type: string | null }
  | { kind: 'error'; code: string | null; description: string | null };

/** The auth result in a URL's hash (or query, for older links), or null for an ordinary link. */
export function parseAuthLink(url: string | null | undefined): AuthLinkResult | null {
  if (!url) return null;
  const hashAt = url.indexOf('#');
  const queryAt = url.indexOf('?');
  const parts: string[] = [];
  if (hashAt >= 0) parts.push(url.slice(hashAt + 1));
  if (queryAt >= 0) parts.push(url.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined));
  for (const part of parts) {
    const p = new URLSearchParams(part);
    const access = p.get('access_token');
    const refresh = p.get('refresh_token');
    if (access && refresh) return { kind: 'session', accessToken: access, refreshToken: refresh, type: p.get('type') };
    if (p.get('error') || p.get('error_code')) {
      return { kind: 'error', code: p.get('error_code'), description: p.get('error_description') };
    }
  }
  return null;
}

/** What Sign In says after a link that didn't sign the player in. */
export function authLinkNotice(r: AuthLinkResult): string | null {
  if (r.kind === 'session') return null;
  if (r.code === 'otp_expired') {
    return "That link was already used or is too old. If you've confirmed your email, sign in below. If not, sign in and we'll send a new code.";
  }
  return "That link didn't work. Sign in below, or ask for a new code from Check your email.";
}

// One pending notice for Sign In, set by the link handler before Sign In mounts.
let pending: string | null = null;
const listeners = new Set<() => void>();

export function setAuthLinkNotice(text: string | null): void {
  pending = text;
  listeners.forEach((l) => l());
}

export function getAuthLinkNotice(): string | null {
  return pending;
}

export function subscribeAuthLinkNotice(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
