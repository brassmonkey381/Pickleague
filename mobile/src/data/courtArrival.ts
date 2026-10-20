// Court arrival, server side: check-in automation settings, my starred courts'
// circles, the arrival queue (Enter, Exit / Not here, Check in now), the
// "Check in nearby?" push and the app-open scan. Thin wrappers over the RPCs in
// supabase/migration_court_arrival_settings.sql, migration_court_arrival_queue.sql
// and migration_court_checkin_prompt.sql; those files are the contract for
// every argument and answer here.
//
// Headless-safe: the geofence task and the lock-screen buttons call these with
// no React tree, so this file imports no React, screens or components (the
// Settings panel reads the caches with useCachedQuery and the keys below).
//
// Every call is bounded. The arrival calls run inside a geofence wake or a
// notification button, which the OS gives about 30 seconds, so their budgets
// come from the plan (lib/courtArrivalRules).
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import {
  cachedFetch,
  peekQuery,
  registerMutationHandler,
  runOrQueue,
  setQueryData,
} from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { supabase } from '../lib/supabase';
import {
  ARRIVAL_CANCEL_MAX_AGE_MS,
  ARRIVAL_PENDING_TIMEOUT_MS,
  CONFIRM_ARRIVAL_TIMEOUT_MS,
  normalizeCourtArrivalSettings,
  QUEUE_ARRIVAL_TIMEOUT_MS,
  type CancelCourtArrivalResult,
  type CourtArrivalSettings,
  type NearbyPromptReason,
  type QueueCourtArrivalAnswer,
  type StarredCourtGeofence,
} from '../lib/courtArrivalRules';

export type { CancelCourtArrivalResult, CourtArrivalSettings, QueueCourtArrivalAnswer, StarredCourtGeofence };

/** Bumped with the answer's shape (Doggle's me:notifPrefs:vN rule): an older
 *  persisted copy is then never read as the new one. */
export const COURT_ARRIVAL_SETTINGS_KEY = 'me:courtArrivalSettings:v1';
export const STARRED_COURT_GEOFENCES_KEY = 'me:starredCourtGeofences';

/** Settings change only from this account, and every change writes the cache. */
export const COURT_ARRIVAL_SETTINGS_TTL_MS = 60 * 60_000;
/** A star made on another device shows within 30 s; every sync reads it fresh. */
export const STARRED_COURT_GEOFENCES_TTL_MS = 30_000;
/** A week of stale-if-error: a wake with no signal still knows my courts. */
export const COURT_ARRIVAL_PERSIST_MS = 7 * 24 * 60 * 60_000;

const BOUND = { timeoutMs: 9_000 };

/**
 * Something changed which courts the phone should watch: a star, a QR wallet
 * code, a Settings choice. CourtArrivalHost resyncs the geofences on it. (The
 * per-court switch doesn't: it patches the saved region info instead.)
 */
export const courtArrivalResync = createSignal<void>();

// ── Settings ────────────────────────────────────────────────────────────────
export async function getCourtArrivalSettings(): Promise<CourtArrivalSettings> {
  return normalizeCourtArrivalSettings(await sbCall(() => supabase.rpc('get_court_arrival_settings'), BOUND));
}

/** Cached read (1 h, a week stale-if-error); `force` reads the server now. */
export function loadCourtArrivalSettings(force = false): Promise<CourtArrivalSettings> {
  return cachedFetch(COURT_ARRIVAL_SETTINGS_KEY, getCourtArrivalSettings, {
    ttlMs: force ? 0 : COURT_ARRIVAL_SETTINGS_TTL_MS,
    persistMs: COURT_ARRIVAL_PERSIST_MS,
  });
}

/**
 * Change one or more settings; fields left out stay as they are. A radius
 * other than 0 / 100 / 250 / 1000 is refused (pl:request.bad). The returned
 * settings replace the cached ones.
 */
export async function setCourtArrivalSettings(p: {
  radiusM?: number;
  otherRadiusM?: number;
  auto?: boolean;
  departure?: boolean;
}): Promise<CourtArrivalSettings> {
  const s = normalizeCourtArrivalSettings(
    await sbCall(
      () =>
        supabase.rpc('set_court_arrival_settings', {
          p_radius_m: p.radiusM ?? null,
          p_other_radius_m: p.otherRadiusM ?? null,
          p_auto: p.auto ?? null,
          p_departure: p.departure ?? null,
        }),
      BOUND,
    ),
  );
  setQueryData(COURT_ARRIVAL_SETTINGS_KEY, s);
  return s;
}

// ── My starred courts' circles ──────────────────────────────────────────────
export async function listStarredCourtGeofences(): Promise<StarredCourtGeofence[]> {
  return ((await sbCall(() => supabase.rpc('list_starred_court_geofences'), BOUND)) ?? []) as StarredCourtGeofence[];
}

/** Cached read (30 s, a week stale-if-error); `force` reads the server now. */
export function loadStarredCourtGeofences(force = false): Promise<StarredCourtGeofence[]> {
  return cachedFetch(STARRED_COURT_GEOFENCES_KEY, listStarredCourtGeofences, {
    ttlMs: force ? 0 : STARRED_COURT_GEOFENCES_TTL_MS,
    persistMs: COURT_ARRIVAL_PERSIST_MS,
  });
}

/**
 * The per-court "Check me in when I arrive" switch. False when that court
 * isn't starred (any more). Patches the cached list, so Settings shows it at
 * once; the caller also patches the saved region info (lib/courtGeofence).
 */
export async function setStarredCourtAutoCheckin(venueId: string, on: boolean): Promise<boolean> {
  const ok = (await sbCall(
    () => supabase.rpc('set_starred_court_auto_checkin', { p_venue: venueId, p_on: on }),
    BOUND,
  )) as boolean;
  const list = peekQuery<StarredCourtGeofence[]>(STARRED_COURT_GEOFENCES_KEY);
  if (list) {
    setQueryData(
      STARRED_COURT_GEOFENCES_KEY,
      ok ? list.map((c) => (c.venue_id === venueId ? { ...c, auto_checkin: on } : c)) : list.filter((c) => c.venue_id !== venueId),
    );
  }
  return ok;
}

// ── The arrival queue ───────────────────────────────────────────────────────
/**
 * The geofence Enter (a real arrival at a starred court): check me in here if
 * I'm still here in a minute. `checkinId` is the id the check-in will get, so
 * the phone's own "Checked in" notice (D3) names the right row.
 */
export async function queueCourtArrival(
  venueId: string,
  arrivedAt: string,
  checkinId: string,
): Promise<QueueCourtArrivalAnswer> {
  return (await sbCall(
    () => supabase.rpc('queue_court_arrival', { p_venue: venueId, p_arrived_at: arrivedAt, p_checkin_id: checkinId }),
    { timeoutMs: QUEUE_ARRIVAL_TIMEOUT_MS },
  )) as QueueCourtArrivalAnswer;
}

/**
 * Don't check me in here: the Exit at `leftAt` (null: now), or Not here
 * (`notHere`, the press time). `venueId` null cancels every arrival of mine
 * still waiting (sign-out). The server acts on `leftAt` only within 2 hours.
 */
export async function cancelCourtArrival(
  venueId: string | null,
  leftAt?: string | null,
  notHere = false,
): Promise<CancelCourtArrivalResult> {
  const r = (await sbCall(
    () =>
      supabase.rpc('cancel_court_arrival', {
        p_venue: venueId,
        p_left_at: leftAt ?? null,
        p_not_here: notHere,
      }),
    BOUND,
  )) as Partial<CancelCourtArrivalResult> | null;
  return { dropped: r?.dropped === true, closed: r?.closed === true, removed: r?.removed === true };
}

/** Queued "I left" / "Not here". The replay sends the queue time as
 *  p_left_at; kept 2 hours, because the server acts on nothing older. */
export const ARRIVAL_CANCEL_MUTATION = 'venue:arrival-cancel';

export type ArrivalCancelPayload = {
  venueId: string;
  notHere?: boolean;
  venueName?: string;
  /** A Not here: its entry in the pending list (the press time). */
  notHereId?: string;
};

// The base replay, so a queued Exit is sent wherever this file is loaded (a
// geofence wake included). lib/courtCheckin imports this file and registers
// over it with the same payload, adding what a queued Not here tells the
// player; a module always runs after the files it imports, so that one wins.
registerMutationHandler(ARRIVAL_CANCEL_MUTATION, {
  run: async (payload, meta) => {
    const p = payload as Partial<ArrivalCancelPayload> | null;
    if (!p || typeof p.venueId !== 'string') return;
    await cancelCourtArrival(p.venueId, meta.queuedAt, p.notHere === true);
  },
  maxAgeMs: ARRIVAL_CANCEL_MAX_AGE_MS,
});

/**
 * Cancel an arrival now, or queue the cancel with this time when there's no
 * signal, so leaving through a dead zone still doesn't check anyone in.
 * A refusal (not a network failure) throws.
 */
export async function cancelCourtArrivalOrQueue(
  venueId: string,
  opts: { notHere?: boolean; venueName?: string; notHereId?: string } = {},
): Promise<{ queued: boolean; result?: CancelCourtArrivalResult }> {
  const leftAt = new Date().toISOString();
  const notHere = opts.notHere === true;
  const payload: ArrivalCancelPayload = {
    venueId,
    notHere,
    ...(opts.venueName ? { venueName: opts.venueName } : {}),
    ...(opts.notHereId ? { notHereId: opts.notHereId } : {}),
  };
  const res = await runOrQueue(ARRIVAL_CANCEL_MUTATION, payload, () => cancelCourtArrival(venueId, leftAt, notHere));
  return res.queued ? { queued: true } : { queued: false, result: res.result };
}

/** Check in now, pressed after the arrival check-in landed: it's a real visit,
 *  so an Exit no longer takes it back. True when there was one to confirm. */
export async function confirmCourtArrival(venueId: string): Promise<boolean> {
  return ((await sbCall(() => supabase.rpc('confirm_court_arrival', { p_venue: venueId }), {
    timeoutMs: CONFIRM_ARRIVAL_TIMEOUT_MS,
  })) ?? false) as boolean;
}

/** An arrival here is still waiting out its minute ("you'll be checked in in a minute" stays true). */
export async function courtArrivalPending(venueId: string): Promise<boolean> {
  return ((await sbCall(() => supabase.rpc('court_arrival_pending', { p_venue: venueId }), {
    timeoutMs: ARRIVAL_PENDING_TIMEOUT_MS,
  })) ?? false) as boolean;
}

// ── "Check in nearby?" and the app-open scan ────────────────────────────────
export type EnqueueCourtPromptAnswer = {
  enqueued: boolean;
  /** 'already_checked_in' or 'cooldown' when held back. */
  reason?: string;
  /** The server can push it to me; false: the phone posts its own copy. */
  pushable: boolean;
};

/** The server's "Check in nearby?" push (held back on an open check-in there, or 30 minutes). */
export async function enqueueCourtCheckinPrompt(
  venueId: string,
  venueName?: string | null,
  reason?: NearbyPromptReason | null,
): Promise<EnqueueCourtPromptAnswer> {
  const r = (await sbCall(
    () =>
      supabase.rpc('enqueue_court_checkin_prompt', {
        p_venue: venueId,
        p_venue_name: venueName ?? null,
        p_reason: reason ?? null,
      }),
    { timeoutMs: QUEUE_ARRIVAL_TIMEOUT_MS },
  )) as Partial<EnqueueCourtPromptAnswer> | null;
  return {
    enqueued: r?.enqueued === true,
    pushable: r?.pushable === true,
    ...(typeof r?.reason === 'string' ? { reason: r.reason } : {}),
  };
}

export type CourtPromptScan = {
  /** The smallest court outline I'm inside, at any distance. */
  inside: { venue_id: string; name: string } | null;
  /** Up to 8 courts within the scan (clamped to 10-500 m), nearest first. */
  nearby: { venue_id: string; name: string; distance_m: number; starred: boolean; has_outline: boolean }[];
};

/**
 * The foreground monitor's read, once a minute while the app is open. The
 * coordinates go to this one call only: never stored or logged, here or on
 * the server.
 */
export async function courtPromptScan(lat: number, lng: number, scanM: number): Promise<CourtPromptScan> {
  const r = (await sbCall(
    () => supabase.rpc('court_prompt_scan', { p_lat: lat, p_lng: lng, p_scan_m: Math.round(scanM) }),
    BOUND,
  )) as Partial<CourtPromptScan> | null;
  return {
    inside: r?.inside && typeof r.inside.venue_id === 'string' ? r.inside : null,
    nearby: Array.isArray(r?.nearby) ? r.nearby : [],
  };
}
