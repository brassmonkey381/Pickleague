// The live play session ("I'm playing right now") behind the play island.
//
// State lives in a foundation live session (user-scoped, persisted), so the
// island shows at once on a cold start, before the network answers. The server
// row is written through the offline queue; neither Start nor End ever waits
// on the network to update what the user sees.
//
// Also schedules a local "starting now" notice (with a Start session button)
// for my upcoming drill sessions and scheduled matches.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerMutationHandler, runOrQueue } from '@just-messin-around/expo-foundation/cache';
import { createLiveSession } from '@just-messin-around/expo-foundation/session';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { catalog, registerActionHandler, requireUser } from './notificationActions';
import {
  endPlaySession,
  getMyActivePlaySession,
  getMyUpcomingPlay,
  startPlaySession,
  type PlayKind,
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
type StartPayload = { id: string; kind: PlayKind; sourceId: string | null; venueId: string | null; at: string };
type EndPayload = { id: string; at: string };

registerMutationHandler(MUTATION_START, {
  run: async (p) => {
    await startPlaySession(p as StartPayload);
  },
});
registerMutationHandler(MUTATION_END, {
  run: async (p) => {
    const { id, at } = p as EndPayload;
    await endPlaySession(id, at);
  },
});

/** Start a session. Shows immediately; the server write queues when offline. */
export function startPlay(meta: Omit<PlayMeta, 'label'> & { label?: string }): string {
  const id = uuidv4();
  const at = new Date().toISOString();
  playSession.start(id, { ...meta, label: meta.label ?? PLAY_LABEL[meta.kind] }, Date.parse(at));
  const payload: StartPayload = { id, kind: meta.kind, sourceId: meta.sourceId, venueId: meta.venueId, at };
  void runOrQueue(MUTATION_START, payload, () => startPlaySession(payload)).catch(() => {
    // A rejected start (not a network failure) has nothing to retry; the
    // session still runs locally and End is a no-op server side.
  });
  return id;
}

/**
 * End the session. Resolves without the network: the island clears now, the
 * server write (with the real end time) is sent or queued in the background.
 */
export function endPlay(): void {
  const s = playSession.get();
  if (!s.id) return;
  const payload: EndPayload = { id: s.id, at: new Date().toISOString() };
  playSession.clear();
  void runOrQueue(MUTATION_END, payload, () => endPlaySession(payload.id, payload.at)).catch(() => {});
}

/** For useResumeLiveSession: the server's view of my active session. */
export async function getActivePlay() {
  const uid = await currentUserId(supabase);
  if (!uid) return null;
  const row = await getMyActivePlaySession(uid);
  if (!row) {
    // A start still sitting in the offline queue is not "none".
    const local = playSession.get();
    if (local.id && local.startedAtMs && Date.now() - local.startedAtMs < 10 * 60_000) {
      return { id: local.id, startedAtMs: local.startedAtMs, meta: local.meta as PlayMeta };
    }
    return null;
  }
  const local = playSession.get();
  const meta: PlayMeta =
    local.id === row.id && local.meta
      ? local.meta
      : {
          kind: row.kind,
          label: PLAY_LABEL[row.kind],
          sourceId: row.source_id,
          venueId: row.venue_id,
          venueName: row.venue_id ? await getVenueName(row.venue_id).catch(() => null) : null,
        };
  return { id: row.id, startedAtMs: Date.parse(row.started_at), meta };
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
        data: { play_kind: u.kind, source_id: u.id, title: u.title },
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

// "Start session" on the starting-now notice (opens the app).
registerActionHandler('play_start', {
  success: { title: 'Session started', body: 'It is on your screen. Tap End when you finish.' },
  run: async (d) => {
    await requireUser();
    const raw = d as Record<string, unknown>;
    const kind = raw.play_kind === 'match' ? 'match' : raw.play_kind === 'drill' ? 'drill' : 'open_play';
    if (playSession.get().status !== 'idle') return;
    startPlay({ kind, sourceId: typeof raw.source_id === 'string' ? raw.source_id : null, venueId: null, venueName: null });
  },
});
