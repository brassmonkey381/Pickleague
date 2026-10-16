// The live play session ("I'm playing right now") behind the play island.
//
// State lives in a foundation live session (user-scoped, persisted), so the
// island shows at once on a cold start, before the network answers. The server
// row is written through the offline queue; neither Start nor End ever waits
// on the network to update what the user sees.
//
// A session at a court is presence: Start sends the fix taken at Start, and
// when it confirms the court the server checks me in there too (a 'session'
// check-in with the session's id, or it adopts the check-in I already had).
// End closes only a check-in the session opened. A queued End must never
// bring the island back, so End records a pending-End entry first, keeps it
// after the End lands, and the resume check skips it (./playEndPending).
// When a Start at a court does not check me in (the fix didn't confirm it),
// the island stops naming the court and says so once (playStartUntracked).
//
// Starting goes through one sheet, "Where are you playing?"
// (components/play/PlayStartSheet): openPlayStart() opens it, or expands the
// island when a session already runs. Ending emits playEnded, and the end
// sheet (components/play/PlayEndSheet) asks for the match or drill that makes
// the session count (Phase 1.5).
//
// Also schedules a local "starting now" notice (with a Start session button)
// for my upcoming drill sessions and scheduled matches.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerMutationHandler, runOrQueue } from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { createLiveSession } from '@just-messin-around/expo-foundation/session';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { catalog, registerActionHandler, requireUser } from './notificationActions';
import { forgetCheckin, peekCurrentCheckin, refreshCurrentCheckin, type CurrentCheckin } from './courtCheckin';
import type { DeviceFix } from './courtCheckinRules';
import { isEndPending } from './playEndPending';
import { clearEndPending, markEndPending, readPendingEnds } from './playEndPendingStore';
import type { EndedPlay } from './sessionValidity';
import {
  endPlaySession,
  getMyActivePlaySession,
  getMyUpcomingPlay,
  startPlaySession,
  type PlayKind,
  type PlaySessionRow,
} from '../data/playSessions';
import { getVenueName } from '../data/venueCheckins';

export type PlayMeta = {
  kind: PlayKind;
  /** "Open play", "Drill session", … */
  label: string;
  sourceId: string | null;
  venueId: string | null;
  venueName: string | null;
};

export const playSession = createLiveSession<PlayMeta>({
  storageKey: 'pickleague_play_session',
  getUserId: () => currentUserId(supabase),
});

export const PLAY_LABEL: Record<PlayKind, string> = {
  open_play: 'Open play',
  drill: 'Drill session',
  match: 'Match',
  event: 'Event',
};

const MUTATION_START = 'play:start';
const MUTATION_END = 'play:end';
type StartPayload = {
  id: string;
  kind: PlayKind;
  sourceId: string | null;
  venueId: string | null;
  at: string;
  /** Taken at Start, so a late replay is judged by where I was then. */
  fix?: DeviceFix | null;
};
type EndPayload = { id: string; at: string };

registerMutationHandler(MUTATION_START, {
  run: async (p) => {
    const payload = p as StartPayload;
    const row = await startPlaySession(payload);
    // The session may have checked me in (or adopted my check-in), or, with
    // a fix that no longer confirms the court, not.
    if (payload.venueId) void noteUntrackedStart(payload.id, payload.venueId, row);
  },
});

/** Emits when a Start at a court did not check me in there (the island says so once). */
export const playStartUntracked = createSignal<{ venueName: string | null }>();

/** Is `cur` the check-in a session at `venueId` gave me (its own, or the one it adopted)? */
function sessionCheckedIn(cur: CurrentCheckin | null, sessionId: string, venueIds: (string | null | undefined)[]): boolean {
  return !!cur && (cur.id === sessionId || venueIds.some((v) => !!v && cur.venueId === v));
}

/**
 * After a Start at a court lands: if it did not check me in (the fix didn't
 * confirm the court: the server starts it untracked, no error), stop naming
 * the court on the island and say so, instead of implying friends see me
 * there. Quiet when the check can't be made (offline) or the session is over.
 */
async function noteUntrackedStart(sessionId: string, venueId: string, row: PlaySessionRow | null | undefined): Promise<void> {
  let cur: CurrentCheckin | null;
  try {
    cur = await refreshCurrentCheckin();
  } catch {
    return;
  }
  const s = playSession.get();
  if (s.id !== sessionId || s.status === 'idle' || !s.meta?.venueId) return;
  if (sessionCheckedIn(cur, sessionId, [row?.venue_id, venueId])) return;
  const venueName = s.meta.venueName;
  playSession.patchMeta({ venueName: null });
  playStartUntracked.emit({ venueName });
}

registerMutationHandler(MUTATION_END, {
  run: async (p) => {
    const { id, at } = p as EndPayload;
    try {
      await endPlaySession(id, at);
    } catch (e) {
      // Network: still queued, so still pending. Anything else won't succeed.
      if (!isNetworkError(e)) await clearEndPending(id);
      throw e;
    }
    // Landed: the entry stays as a tombstone (./playEndPending) until it ages out.
  },
});

// ── Start / End ─────────────────────────────────────────────────────────────
/**
 * Start a session. Shows immediately; the server write queues when offline.
 * With a court, pass the fix taken at Start: it is what checks me in there.
 */
export function startPlay(meta: Omit<PlayMeta, 'label'> & { label?: string; fix?: DeviceFix | null }): string {
  const id = uuidv4();
  const at = new Date().toISOString();
  const { fix, ...rest } = meta;
  playSession.start(id, { ...rest, label: meta.label ?? PLAY_LABEL[meta.kind] }, Date.parse(at));
  const payload: StartPayload = {
    id,
    kind: meta.kind,
    sourceId: meta.sourceId,
    venueId: meta.venueId,
    at,
    ...(meta.venueId && fix ? { fix } : {}),
  };
  void runOrQueue(MUTATION_START, payload, () => startPlaySession(payload))
    .then(({ queued, result }) => {
      // The court card shows the session's check-in once it exists; a court
      // that didn't check me in stops being named (the queued replay checks
      // the same way when it lands).
      if (!queued && meta.venueId) void noteUntrackedStart(id, meta.venueId, result);
    })
    .catch(() => {
      // A rejected start (not a network failure) has nothing to retry; the
      // session still runs locally and End is a no-op server side.
    });
  return id;
}

/**
 * End the session. Resolves without the network: the island clears now, the
 * server write (with the real end time) is sent or queued in the background.
 * The pending-End entry is written BEFORE that write and kept after it lands
 * (a tombstone that ages out), so neither a resume check that runs while it is
 * queued nor one already in flight when End was tapped can bring the island
 * back.
 */
export function endPlay(): EndedPlay | null {
  const s = playSession.get();
  if (!s.id) return null;
  const payload: EndPayload = { id: s.id, at: new Date().toISOString() };
  playSession.clear();
  // The server closes the session's own check-in; an adopted one stays.
  void forgetCheckin(payload.id);
  void markEndPending(payload.id, Date.parse(payload.at))
    .catch(() => {}) // the guard is best-effort; the End goes out regardless
    .then(() => runOrQueue(MUTATION_END, payload, () => endPlaySession(payload.id, payload.at)))
    // Not a network failure (those queue): retrying won't help, nothing is pending.
    .catch(() => clearEndPending(payload.id));
  if (!s.meta || s.startedAtMs == null) return null;
  const recorded = recordedFor.has(s.id);
  recordedFor.delete(s.id);
  const ended: EndedPlay = {
    id: s.id,
    kind: s.meta.kind,
    sourceId: s.meta.sourceId,
    startedAtMs: s.startedAtMs,
    endedAtMs: Date.parse(payload.at),
    recorded,
  };
  playEnded.emit(ended);
  return ended;
}

// ── Ending: "Record a match or drill?" ──────────────────────────────────────
// A session counts once a match or drill is recorded for it (Phase 1.5,
// lib/sessionValidity). End emits the session that just ended; the end sheet
// (components/play/PlayEndSheet) decides what to show.

/** Emits the session the player just ended. */
export const playEnded = createSignal<EndedPlay>();

// Sessions a match was already recorded from (the island's Enter score), so
// End doesn't ask again. Memory only: after a restart it may ask, harmlessly.
const recordedFor = new Set<string>();

/** MatchEntry recorded a match linked to this session. */
export function noteMatchRecorded(sessionId: string): void {
  recordedFor.add(sessionId);
}

/** For useResumeLiveSession: the server's view of my active session. */
export async function getActivePlay() {
  const uid = await currentUserId(supabase);
  if (!uid) return null;
  const found = await getMyActivePlaySession(uid);
  // An End still on its way to the server: that session is over.
  const row = found && !isEndPending(await readPendingEnds(), found.id, Date.now()) ? found : null;
  if (!row) {
    // A start still sitting in the offline queue is not "none".
    const local = playSession.get();
    if (local.id && local.startedAtMs && Date.now() - local.startedAtMs < 10 * 60_000) {
      return { id: local.id, startedAtMs: local.startedAtMs, meta: local.meta as PlayMeta };
    }
    return null;
  }
  const local = playSession.get();
  const startedAtMs = Date.parse(row.started_at);
  if (local.id === row.id && local.meta) return { id: row.id, startedAtMs, meta: local.meta };
  // Rebuilt from the server: name the court only when the session checked me
  // in there (an untracked session at a court shows no court, as at Start).
  const checkedIn =
    !!row.venue_id &&
    sessionCheckedIn(await refreshCurrentCheckin().catch(() => peekCurrentCheckin()), row.id, [row.venue_id]);
  const meta: PlayMeta = {
    kind: row.kind,
    label: PLAY_LABEL[row.kind],
    sourceId: row.source_id,
    venueId: row.venue_id,
    venueName: row.venue_id && checkedIn ? await getVenueName(row.venue_id).catch(() => null) : null,
  };
  return { id: row.id, startedAtMs, meta };
}

// ── "Where are you playing?" and the island ─────────────────────────────────
/** What the start sheet opens with (all optional: it fills in the rest). */
export type PlayStartRequest = { kind?: PlayKind; sourceId?: string | null };

/** Emits when the start sheet should open (its host takes the request). */
export const playStartRequested = createSignal<void>();
/** Emits when the island should expand (a session already runs). */
export const playIslandExpand = createSignal<void>();
// Held until the host takes it: a cold start from the "starting now" notice
// asks before the host is mounted.
let pendingStart: PlayStartRequest | null = null;

/** Open the start sheet, or expand the island when a session already runs. */
export function openPlayStart(req: PlayStartRequest = {}): void {
  if (playSession.get().status !== 'idle') {
    playIslandExpand.emit();
    return;
  }
  pendingStart = req;
  playStartRequested.emit();
}

/** For the sheet's host: the request waiting to be shown (cleared on read). */
export function takePlayStartRequest(): PlayStartRequest | null {
  const r = pendingStart;
  pendingStart = null;
  return r;
}

// ── "Starting now" notices for my upcoming drills and matches ───────────────
const SCHEDULED_KEY = 'pickleague_play_start_ids_v1';

async function readScheduled(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Re-sync the local notices with the server. Best-effort; never throws. */
export async function syncPlayStartReminders(): Promise<void> {
  try {
    const uid = await currentUserId(supabase);
    if (!uid) return;
    const upcoming = await getMyUpcomingPlay(uid);
    const ids: string[] = [];
    for (const u of upcoming) {
      const id = `play-start:${u.kind}:${u.id}`;
      ids.push(id);
      await scheduleLocalNotification({
        id,
        at: Date.parse(u.startsAt),
        title: `${u.title} starting now`,
        body: 'Tap Start session to time it and show it on your screen.',
        categoryId: catalog.ids.play_start.id,
        // A tap opens the drill session or the match itself.
        data: { play_kind: u.kind, source_id: u.id, title: u.title, deepLink: `${u.kind === 'match' ? 'match' : 'drill'}/${u.id}` },
      });
    }
    for (const old of await readScheduled()) if (!ids.includes(old)) await cancelLocalNotification(old);
    await AsyncStorage.setItem(SCHEDULED_KEY, JSON.stringify(ids)).catch(() => {});
  } catch {
    // reminders are a nicety
  }
}

/** Sign-out: no ghost island for the next account, no reminders for the old one. */
export async function clearPlayForSignOut(): Promise<void> {
  await playSession.clearForSignOut();
  for (const id of await readScheduled()) await cancelLocalNotification(id);
  await AsyncStorage.removeItem(SCHEDULED_KEY).catch(() => {});
}

// "Start session" on the starting-now notice (opens the app): the start sheet,
// with the drill or match as the session's source.
registerActionHandler('play_start', {
  success: { title: 'Where are you playing?', body: 'Pick your court in Pickleague, then tap Start.' },
  run: async (d) => {
    await requireUser();
    const raw = d as Record<string, unknown>;
    const kind = raw.play_kind === 'match' ? 'match' : raw.play_kind === 'drill' ? 'drill' : 'open_play';
    openPlayStart({ kind, sourceId: typeof raw.source_id === 'string' ? raw.source_id : null });
  },
});
