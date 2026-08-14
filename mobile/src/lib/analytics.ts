/**
 * First-party in-app analytics emitter (pickleague).
 *
 * Ported from the michi-maker/tcgscan emitter pair (each app's src/lib/analytics.ts) with ONE
 * structural difference: a pickleague.club visitor is signed out until they log in, register, or
 * redeem a guest invite (signInAnonymously is used ONLY for guest passes, never minted for
 * browsing) — so this emitter records identity-less sessions through the `anon` role (user_id
 * null, see supabase/migration_add_analytics_events.sql) instead of requiring an auth.uid().
 * When a signed-out session gains an identity mid-visit (sign-in, sign-up, or a guest-pass
 * redeem), the live session row is CLAIMED: user_id set, upgraded_at stamped. That transition
 * is what makes a printed QR campaign attributable to a signup.
 *
 * Everything here is best-effort and swallows its own errors: analytics must NEVER block the UI
 * or throw into the app. When Supabase isn't configured, events are skipped gracefully.
 *
 * The database contract (supabase/migration_add_analytics_events.sql):
 *   - `analytics_sessions` — one row per app-open. RLS: anon inserts identity-less rows and can
 *     never set a user_id; authenticated inserts/selects/updates its own and may claim a
 *     null-user row.
 *   - `analytics_events`   — append-only. Events recorded signed-out keep user_id null forever
 *     and join their person through session_id once the session is claimed. Recorded identity is
 *     NEVER rewritten.
 *
 * NO PII: only ids and counts belong in props — never emails, tokens, names, or locations.
 */
import Constants from 'expo-constants';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { supabase } from './supabase';

/** lib/supabase asserts its env with `!`; mirror the check here so a missing .env means silent
 *  no-op analytics rather than requests at a placeholder. */
const hasSupabaseConfig = Boolean(
  process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

/** This app always reports as 'pickleague' (its own project — nothing shares these tables). */
const APP = 'pickleague' as const;

/** Throttle window for opportunistic session `last_seen_at` touches. */
const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Web-only: where the active session is persisted across full page loads, so a browser reload
 * reuses the same session instead of minting a new row (native keeps the in-memory session, which
 * already survives because the RN process persists).
 */
const SESSION_STORAGE_KEY = 'pickleague_analytics_session';
/** Reuse a persisted web session only if its last activity was within this idle window. */
const IDLE_MS = 30 * 60 * 1000;

/** StoredSession.userId value for an identity-less (signed-out) session. */
const ANON = 'anon';

/** Shape of the persisted web session entry. `userId` is the auth uid or the ANON sentinel;
 *  `code` carries the landing campaign code across a reload so a signup after a refresh still
 *  attributes (see CAMPAIGN_PARAMS below). */
type StoredSession = { id: string; userId: string; lastSeen: number; code?: string };

/**
 * Durable device id (see tcgscan repo root: ANALYTICS-GUEST-DEVICE-ID.md — same design). A
 * RANDOM, OPAQUE UUID minted once on first use and never regenerated — deliberately derived from
 * nothing about the device (no hardware, IP, or UA), so it is a coincidence key, not a
 * fingerprint. It survives reloads, sign-outs and session claims; it dies only with the storage
 * that holds it (cleared site data / reinstall), which is exactly the churn it exists to
 * measure. Web: localStorage — NOT sessionStorage, which dies with the tab. Native:
 * AsyncStorage. Never expires, never scoped to a userId, never cleared on sign-out.
 */
const DEVICE_STORAGE_KEY = 'pickleague_analytics_device';

/** Resolved device id: undefined = not yet resolved, null = storage unavailable. */
let deviceId: string | null | undefined;

/** A v4 UUID. crypto.randomUUID is absent on Hermes; fall back to getRandomValues, then
 *  Math.random — this is a coincidence key, not a security boundary. */
function uuidv4(): string {
  const c = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array }
    | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h
    .slice(8, 10)
    .join('')}-${h.slice(10, 16).join('')}`;
}

/** Read-or-mint the device id. Returns null when storage is unavailable — a storage failure must
 *  never cost the session row. Never throws. */
async function getDeviceId(): Promise<string | null> {
  if (deviceId !== undefined) return deviceId;
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || typeof localStorage === 'undefined') return (deviceId = null);
      const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
      if (existing) return (deviceId = existing);
      const minted = uuidv4();
      localStorage.setItem(DEVICE_STORAGE_KEY, minted);
      return (deviceId = minted);
    }
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const existing = await AsyncStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing) return (deviceId = existing);
    const minted = uuidv4();
    await AsyncStorage.setItem(DEVICE_STORAGE_KEY, minted);
    return (deviceId = minted);
  } catch {
    return (deviceId = null);
  }
}

/**
 * Print/QR campaign attribution (the analytics studio's
 * requests/2026-08-14-print-campaign-attribution.md). STRICT allowlist: only these self-chosen
 * params ever reach the database, so an arbitrary third-party parameter can never ride in.
 * General referrer capture is deliberately NOT implemented — this is the narrow campaign-code
 * carve-out only.
 */
const CAMPAIGN_PARAMS = ['code', 'utm_source', 'utm_medium', 'utm_campaign'] as const;

/**
 * Parsed ONCE at module load (web only): the only moment the URL is guaranteed to still be the
 * printed URL — by the first recorded screen the SPA may already have navigated. `suffix` is the
 * sanitized query for landing_route; `code` rides on account.created.
 */
const landingCampaign = (() => {
  try {
    if (typeof window === 'undefined' || !window.location?.search) return null;
    const q = new URLSearchParams(window.location.search);
    const kept = new URLSearchParams();
    for (const k of CAMPAIGN_PARAMS) {
      const v = q.get(k);
      if (v && v.length <= 64) kept.append(k, v); // printed codes are short; anything huge is not ours
    }
    const s = kept.toString();
    return s ? { suffix: `?${s}`, code: kept.get('code') } : null;
  } catch {
    return null; // never throw at module load
  }
})();

/** The campaign code a signup attributes to: this page load's landing code, or one persisted with
 *  the reused web session (a reload loses the query string but must not lose the attribution). */
let campaignCode: string | null = landingCampaign?.code ?? null;

/**
 * The current auth identity, mirrored from onAuthStateChange via resetSessionUser().
 *   null            — auth bootstrap has not settled yet; events buffer.
 *   { id: null }    — settled, signed out: a real anonymous visitor, recorded through `anon` RLS.
 *   { id: uid }     — settled, signed in.
 */
let cachedUser: { id: string | null } | null = null;

/**
 * Events that arrived before the auth bootstrap settled. supabase-js restores a persisted
 * session asynchronously, and the first screens render before INITIAL_SESSION fires — dropping
 * those events silently is how the michi emitter once lost a real trial.start. Buffer instead,
 * then flush in resetSessionUser() with each event's original time. Bounded; oldest dropped on
 * overflow.
 */
const PENDING_MAX = 20;
let pending: { name: string; props?: Record<string, unknown>; at: string }[] = [];
/** Events dropped on overflow since the last flush — surfaced once in dev so the loss isn't silent. */
let droppedPending = 0;

/** The active app-open session row id, created lazily on first use. */
let sessionId: string | null = null;
/** In-flight session creation, so concurrent tracks share one insert. */
let starting: Promise<string | null> | null = null;
/** Timestamp (ms) of the last `last_seen_at` write, for throttling. */
let lastSeenAt = 0;
/** Have we already recorded this session's landing_route (its first screen)? Once per session. */
let landingRouteRecorded = false;
/** Cached access token for the web `pagehide` keepalive PATCH. Refreshed on every auth change;
 *  null when signed out — the beacon then runs as `anon`, which RLS permits on unclaimed rows. */
let accessToken: string | null = null;
/** Whether the app-lifecycle listeners (visibility/pagehide on web, AppState on native) are bound. */
let listenersBound = false;
/** Teardown for the web listeners; null when unbound or off web. */
let webUnbind: (() => void) | null = null;
/** Native AppState subscription; null when unbound or off native. */
let appStateSub: { remove: () => void } | null = null;

/** Web sessionStorage, or null when unavailable (native, SSR prerender, or a privacy mode that
 *  throws on access). All persistence helpers below no-op when this returns null. Never throws. */
function webStore(): Storage | null {
  try {
    if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch {
    // access itself can throw under strict privacy settings — treat as unavailable
  }
  return null;
}

/** Read the persisted web session, or null if absent/unavailable/malformed. Never throws. */
function readStoredSession(): StoredSession | null {
  const store = webStore();
  if (!store) return null;
  try {
    const raw = store.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.userId === 'string' &&
      typeof parsed.lastSeen === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignore malformed / unreadable entries
  }
  return null;
}

/** Persist the web session entry. No-op off web. Never throws. */
function writeStoredSession(entry: StoredSession): void {
  const store = webStore();
  if (!store) return;
  try {
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // swallow — never throw out of analytics
  }
}

/** Forget the persisted web session (sign-out, or a different user in the same tab). Never throws. */
function clearStoredSession(): void {
  const store = webStore();
  if (!store) return;
  try {
    store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // swallow
  }
}

/** Bump `lastSeen` on the persisted web session so the reload-reuse window tracks real activity. */
function touchStoredSession(): void {
  const entry = readStoredSession();
  if (!entry) return;
  writeStoredSession({ ...entry, lastSeen: Date.now() });
}

/**
 * Create the session row for the current identity (once). Returns its id, or null if it can't be
 * made (no backend, bootstrap unsettled, or the insert failed). Never throws.
 */
async function ensureSession(): Promise<string | null> {
  if (!hasSupabaseConfig || !cachedUser) return null;
  if (sessionId) return sessionId;
  if (starting) return starting;

  const user = cachedUser;
  starting = (async () => {
    try {
      // Web reload-reuse: adopt a persisted session that belongs to this same identity and was
      // active within the idle window, rather than minting a new row. A page refresh keeps ONE
      // session (and does NOT re-emit session.start). Native never has a stored entry.
      // One extra case michi doesn't have: a stored ANON session + a now signed-in user is the
      // visitor who converted across a reload — adopt it AND claim it, so the QR-scan session
      // and the signup stay one row.
      const stored = readStoredSession();
      const identity = user.id ?? ANON;
      if (stored && Date.now() - stored.lastSeen < IDLE_MS && (stored.userId === identity || (stored.userId === ANON && user.id))) {
        sessionId = stored.id;
        // A fresh landing code wins; else inherit the one persisted with the session.
        campaignCode = landingCampaign?.code ?? stored.code ?? null;
        if (stored.userId === ANON && user.id) claimSession(stored.id);
        writeStoredSession({
          ...stored,
          userId: identity,
          lastSeen: Date.now(),
          ...(campaignCode ? { code: campaignCode } : {}),
        });
        bindLifecycleListeners(); // flush last_seen_at when this reused session's app goes away
        return sessionId;
      }

      // app_version is a nice-to-have; omit the key entirely when Constants doesn't expose it.
      const appVersion = Constants.expoConfig?.version;
      // user_id is deliberately NOT sent: it defaults to auth.uid() server-side, which is the
      // uid when signed in and null when anon — and the anon RLS forbids sending one anyway.
      // The row id is minted CLIENT-side, not returned by the insert. `.select('id')` would need
      // a SELECT policy, and the anon role deliberately has none — an anon `.insert().select()`
      // comes back 401 and the session row is lost (found live on doggle's first end-to-end test).
      const sid = uuidv4();
      const { error } = await supabase.from('analytics_sessions').insert({
        id: sid,
        app: APP,
        is_guest: !user.id, // immutable: "this session STARTED without an account"
        platform: Platform.OS,
        // Session-level, set on insert only (never on the reuse path — the row already has it).
        device_id: await getDeviceId(),
        ...(appVersion ? { app_version: appVersion } : {}),
      });
      if (error) return null;
      sessionId = sid;
      landingRouteRecorded = false; // a brand-new session captures its own first screen
      // Persist so a web reload reuses this session (no-op on native), carrying the campaign code.
      writeStoredSession({
        id: sessionId,
        userId: identity,
        lastSeen: Date.now(),
        ...(campaignCode ? { code: campaignCode } : {}),
      });
      bindLifecycleListeners(); // flush last_seen_at when this session's app goes away
      // The emitter owns session.start: emit it EXACTLY ONCE, here, when a brand-new session row
      // is created (never on reuse). Insert directly rather than via track(), which would recurse
      // back through ensureSession.
      try {
        await supabase
          .from('analytics_events')
          .insert({ app: APP, name: 'session.start', props: { is_guest: !user.id }, session_id: sessionId });
      } catch {
        // swallow — a missed session.start must never surface
      }
      return sessionId;
    } catch {
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/**
 * Claim an identity-less session for the current auth identity: the signed-out visitor signed
 * in or signed up mid-visit. The RPC sets user_id from the caller's JWT and stamps upgraded_at;
 * its `user_id is null` filter makes it idempotent — a claimed row is never re-claimed.
 * is_guest is IMMUTABLE and stays true — it records that the session started without an
 * account. Fire-and-forget; never throws.
 */
function claimSession(id: string): void {
  void (async () => {
    try {
      // A SECURITY DEFINER RPC, not a plain update: the claim targets a row the caller cannot
      // SELECT, and an RLS UPDATE whose WHERE references columns silently matches nothing on
      // such rows (see the analytics_rpc migration). auth.uid() is read server-side from the
      // JWT — never a parameter. MUST be awaited: a lazy thenable never issues its request.
      await supabase.rpc('analytics_claim', { p_session: id });
    } catch {
      // swallow — a missed claim loses attribution, never function
    }
  })();
}

/** Best-effort, throttled `last_seen_at` bump so a session's tail reflects real activity. */
async function touchSession(id: string): Promise<void> {
  if (!hasSupabaseConfig) return;
  const now = Date.now();
  if (now - lastSeenAt < LAST_SEEN_THROTTLE_MS) return;
  lastSeenAt = now;
  touchStoredSession(); // keep the web reload-reuse window fresh (no-op on native)
  try {
    // RPC rather than a plain update: an anon session row is not SELECT-visible, and an RLS
    // update on an invisible row silently matches nothing (see the analytics_rpc migration).
    await supabase.rpc('analytics_touch', { p_session: id });
  } catch {
    // swallow — a missed heartbeat is harmless
  }
}

/**
 * Cache the current access token for the `pagehide` keepalive PATCH. Refreshed on every auth
 * change (resetSessionUser). Fire-and-forget; never throws.
 */
function refreshAccessToken(): void {
  try {
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        accessToken = data.session?.access_token ?? null;
      })
      .catch(() => {
        // swallow — a stale/absent token just means the beacon runs as anon
      });
  } catch {
    // swallow
  }
}

/**
 * Force `last_seen_at = now` for the live session, bypassing LAST_SEEN_THROTTLE_MS. No-op when
 * there's no session or backend. Fire-and-forget; never throws.
 */
export function flushLastSeen(): void {
  try {
    const id = sessionId;
    if (!hasSupabaseConfig || !id) return;
    lastSeenAt = Date.now(); // count as a heartbeat so a following throttled touch doesn't double-write
    touchStoredSession();
    // MUST be awaited (lazy thenable — see claimSession). RPC for the same reason as
    // touchSession: an anon row is invisible to a plain RLS update.
    void (async () => {
      try {
        await supabase.rpc('analytics_touch', { p_session: id });
      } catch {
        // swallow — a missed flush is harmless
      }
    })();
  } catch {
    // swallow — a missed flush is harmless
  }
}

/**
 * `pagehide`-only flush. A normal supabase-js call is usually cancelled as the page unloads, so
 * prefer a keepalive fetch straight at PostgREST — with the user's access token when signed in,
 * or the publishable key as `anon` (RLS permits anon updates on unclaimed rows). Never throws.
 */
function flushLastSeenBeacon(): void {
  try {
    const id = sessionId;
    if (!id) return;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (typeof fetch === 'function' && url && anonKey) {
      // The RPC endpoint, for the same RLS reason as touchSession.
      void fetch(`${url}/rest/v1/rpc/analytics_touch`, {
        method: 'POST',
        keepalive: true,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken ?? anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ p_session: id }),
      }).catch(() => {
        // swallow — best effort on unload
      });
      return;
    }
    // No fetch/config: the client call may still be cancelled, but it's the best we have.
    flushLastSeen();
  } catch {
    // swallow — never throw out of an unload handler
  }
}

/**
 * Record this session's landing_route from its FIRST tracked screen, exactly once. The
 * `.is(null)` filter makes it idempotent across a web reload (which reuses the row) so it never
 * overwrites the real entry point. The landing URL's allowlisted campaign query (if any) rides
 * in, so a printed QR scan is distinguishable from someone typing the URL. Fire-and-forget;
 * never throws.
 *
 * The update MUST be awaited even though nothing reads the result (lazy thenable — see
 * claimSession). The flag is set BEFORE the await deliberately, so two screens racing on the
 * same tick cannot both fire; a lost write is preferable to overwriting a real entry point.
 */
function recordLandingRoute(id: string, route: unknown): void {
  if (landingRouteRecorded) return;
  if (typeof route !== 'string' || !route) return;
  landingRouteRecorded = true;
  const landing = landingCampaign ? `${route}${landingCampaign.suffix}` : route;
  void (async () => {
    try {
      // analytics_touch writes landing_route only while it is still null (the first-touch
      // idempotence lives server-side now) — and doubles as the session's first heartbeat.
      await supabase.rpc('analytics_touch', { p_session: id, p_landing: landing });
    } catch {
      // swallow — a missed landing route is harmless
    }
  })();
}

/**
 * Bind the app-lifecycle listeners that flush `last_seen_at` when the app goes away. Web gets
 * `visibilitychange` (the reliable one mobile browsers fire before freezing a tab) plus
 * `pagehide` (best-effort on real navigation away); native gets AppState background/inactive.
 * Bound once when the session is created, torn down in endSession(). Guarded and never throws.
 */
function bindLifecycleListeners(): void {
  if (listenersBound) return;
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const onVisibility = () => {
        try {
          if (document.visibilityState === 'hidden') flushLastSeen();
        } catch {
          // swallow — a listener must never throw
        }
      };
      const onPageHide = () => {
        try {
          flushLastSeenBeacon();
        } catch {
          // swallow
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      webUnbind = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      };
      listenersBound = true;
    } else {
      appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
        try {
          if (state === 'background' || state === 'inactive') flushLastSeen();
        } catch {
          // swallow — a listener must never throw
        }
      });
      listenersBound = true;
    }
  } catch {
    // swallow — a failed bind must never surface
  }
}

/** Remove the lifecycle listeners bound by bindLifecycleListeners(). Never throws. */
function unbindLifecycleListeners(): void {
  try {
    webUnbind?.();
  } catch {
    // swallow
  }
  try {
    appStateSub?.remove();
  } catch {
    // swallow
  }
  webUnbind = null;
  appStateSub = null;
  listenersBound = false;
}

/**
 * Record an event. Fire-and-forget: returns immediately, does the work on a floating promise,
 * and swallows every error. Buffers until the auth bootstrap settles (INITIAL_SESSION); a
 * signed-out visitor is a valid identity here, not a reason to skip.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  try {
    if (!hasSupabaseConfig) return;
    if (!cachedUser) {
      // Bootstrap not settled yet. Buffer rather than drop, keeping the real time so a later
      // flush can't reorder a funnel by stamping everything now().
      pending.push({ name, props, at: new Date().toISOString() });
      if (pending.length > PENDING_MAX) {
        pending.shift();
        droppedPending += 1;
        if (__DEV__) console.warn(`[analytics] event buffer full, dropped oldest (${droppedPending} since last flush)`);
      }
      return;
    }
    emit(name, props);
  } catch {
    // swallow — even the synchronous setup must not throw
  }
}

/** The last screen recorded, to de-dupe genuine back-to-back repeats (react-navigation fires
 *  state changes more often than the active route actually changes). */
let lastScreen: string | null = null;

/**
 * Screen-change hook for react-navigation: call from the NavigationContainer's onReady and
 * onStateChange with the current route name. De-dupes repeats and emits `page.view` with the
 * screen name as `route` (pickleague navigates by screen name, not URL path — landing_route holds
 * the same names).
 */
export function trackScreen(name: string | undefined): void {
  try {
    if (!name || name === lastScreen) return;
    lastScreen = name;
    track('page.view', { route: name });
  } catch {
    // swallow
  }
}

/**
 * Insert one event now. `ts` overrides the server `now()` default so a buffered event keeps the
 * time it actually happened. Assumes the bootstrap has settled. Fire-and-forget; never throws.
 */
function emit(name: string, props?: Record<string, unknown>, ts?: string): void {
  // A signup carries its campaign attribution. Merged HERE, centrally, so every account.created
  // call site attributes without repeating it — and an explicit `code` prop still wins.
  if (name === 'account.created' && campaignCode && !(props && 'code' in props)) {
    props = { ...props, code: campaignCode };
  }
  void (async () => {
    try {
      const sid = await ensureSession();
      // `ts` is undefined for live events (supabase-js omits it, so the server default now()
      // wins) and set only for a buffered event being flushed. user_id is never sent: it
      // defaults to auth.uid() server-side (null when anon, which RLS requires).
      await supabase
        .from('analytics_events')
        .insert({ app: APP, name, props: props ?? {}, session_id: sid, ts });
      if (sid) {
        // The first page.view of the session backfills landing_route (once, cheaply).
        if (name === 'page.view') recordLandingRoute(sid, props?.route);
        void touchSession(sid);
      }
    } catch {
      // swallow — analytics failures must never surface
    }
  })();
}

/**
 * Point the emitter at the settled auth identity. Call from onAuthStateChange with the session
 * user, or null for a settled signed-out state (INITIAL_SESSION with no session, SIGNED_OUT).
 * The first call flushes the pre-bootstrap event buffer. A different uid drops the old session;
 * a null→uid transition on a live session is the CLAIM (see claimSession).
 */
export function resetSessionUser(user: { id: string } | null): void {
  const prev = cachedUser;
  cachedUser = { id: user?.id ?? null };
  refreshAccessToken(); // keep the pagehide-beacon token in step with the current identity

  // Drain events that arrived before the bootstrap settled (see track()'s buffer), keeping each
  // event's captured time so funnel order is preserved.
  if (pending.length) {
    const drained = pending;
    pending = [];
    droppedPending = 0;
    for (const e of drained) emit(e.name, e.props, e.at);
  }

  if (prev?.id && user && prev.id !== user.id) {
    // A genuinely different account — drop the old session (in-memory AND the persisted web
    // entry) so the next event mints a new session row and a fresh session.start.
    sessionId = null;
    starting = null;
    lastSeenAt = 0;
    landingRouteRecorded = false;
    clearStoredSession();
  } else if (prev && prev.id === null && user && sessionId) {
    // The signed-out visitor gained an identity mid-session: claim the live row. is_guest stays
    // true (immutable — the session STARTED without an account); upgraded_at records the moment.
    claimSession(sessionId);
    const stored = readStoredSession();
    if (stored && stored.id === sessionId) writeStoredSession({ ...stored, userId: user.id });
  }
  // uid → null (sign-out) is handled by endSession() from the auth wiring, not here.
}

/** Forget the current session and identity (sign-out). The next event starts a fresh anonymous
 *  session once resetSessionUser(null) settles the new state. The device id survives — the
 *  device is still the same device. */
export function endSession(): void {
  sessionId = null;
  starting = null;
  cachedUser = null;
  pending = [];
  droppedPending = 0;
  lastSeenAt = 0;
  landingRouteRecorded = false;
  lastScreen = null;
  accessToken = null;
  unbindLifecycleListeners();
  clearStoredSession();
}
