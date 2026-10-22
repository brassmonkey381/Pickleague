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
// End closes only a check-in the session opened, and is its check-out: it
// sends a fresh fix when one comes back within 3 s (the stay proof, Phase
// 1.5), taken in the background so the island still clears at once. A queued
// End must never bring the island back, so End records a pending-End entry
// first, keeps it after the End lands, and the resume check skips it
// (./playEndPending).
// When a Start at a court does not check me in (the fix didn't confirm the
// court at the tap, or the Start synced over 12 hours late), or its check-in
// was already over when it synced, the island stops naming the court and says
// why once (playStartUntracked; a card for a replay, lib/playStartRules).
// Every refusal reaches the player (rule 11): a Start or End the server
// refused, live or replayed from the queue, is said (lib/refusalNotices);
// signed out, it waits in the queue like an offline one; a session the
// server ended without this device (the 6-hour expiry, another device) is
// explained on the next resume (playLost).
//
// Starting goes through one sheet, "Where are you playing?"
// (components/play/PlayStartSheet): openPlayStart() opens it, or expands the
// island when a session already runs. Ending emits playEnded, and the end
// sheet (components/play/PlayEndSheet) asks for the match or drill that makes
// the session count (Phase 1.5), unless this device or the server already
// knows something counts.
//
// Also schedules a local "starting now" notice (with a Start session button)
// for my upcoming drill sessions and scheduled matches.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  enqueueMutation,
  flushMutationQueue,
  registerMutationHandler,
  runOrQueue,
} from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { isProbablyOffline, TimeoutError, withTimeout } from '@just-messin-around/expo-foundation/platform';
import { createLiveSession } from '@just-messin-around/expo-foundation/session';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { catalog, registerActionHandler, requireUser } from './notificationActions';
import {
  forgetCheckin,
  peekCurrentCheckin,
  refreshCurrentCheckin,
  takeFixIfAllowed,
  type CurrentCheckin,
} from './courtCheckin';
import { cancelAllScheduledArrivalNotices } from './courtArrivalNotice';
import {
  CHECKOUT_FIX_WAIT_MS,
  checkinEndMs,
  fixWithin,
  isValidFix,
  waitUntilSent,
  type DeviceFix,
} from './courtCheckinRules';
import { endNeedsResend, isEndPending } from './playEndPending';
import { clearEndPending, markEndPending, readPendingEnds } from './playEndPendingStore';
import { checkedInBySession, untrackedStartNotice } from './playStartRules';
import { isRetryLater, noteRefusalNotice } from './refusalNotices';
import { queuedRefusalNotice, untrackedStartNote, type UntrackedStartReason } from './refusals';
import {
  drillMadeItCount,
  drillReviewNote,
  type EndedPlay,
  type RecordedForSession,
  type LostPlayReason,
} from './sessionValidity';
import {
  endPlaySession,
  getMyActivePlaySession,
  getMyPlaySession,
  getMySessionValidity,
  getMyUpcomingPlay,
  startPlaySession,
  type PlayKind,
  type PlaySessionRow,
} from '../data/playSessions';
import { getMyCheckin, getVenueName, type VenueCheckin } from '../data/venueCheckins';
import { PLAY_NAV_ENABLED } from './features';

export type PlayMeta = {
  kind: PlayKind;
  /** "Open play", "Drill session", … */
  label: string;
  sourceId: string | null;
  venueId: string | null;
  venueName: string | null;
  /**
   * Something already makes this session count (see noteMatchRecorded); kept
   * across restarts. 'match' from a build before 2026-10-16 meant a match of
   * either kind, so it reads as 'match_pending' (lib/sessionValidity).
   */
  recorded?: 'match' | 'match_pending' | 'match_confirmed' | 'drill';
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
  /**
   * The start sheet skipped the fix because I looked checked in at this
   * court (the server adopts that check-in). If it wasn't adopted, the reason
   * is the check-in, not a missing location.
   */
  viaCheckin?: true;
};
/** `fix`: taken at the tap when one came back in time, the session check-in's stay proof. */
type EndPayload = { id: string; at: string; fix?: DeviceFix };

// A Start waits at most a day for a signal; past that it is dropped, and said
// so. (The queue's own age-out never reaches the handler, so it would be silent:
// the handler sees every entry for a week instead.)
const START_MAX_WAIT_MS = 24 * 3600_000;

registerMutationHandler(MUTATION_START, {
  maxAgeMs: 7 * 24 * 3600_000,
  run: async (p, meta) => {
    const payload = p as StartPayload;
    if (Date.now() - Date.parse(meta.queuedAt) > START_MAX_WAIT_MS) {
      await noteStartRefused(
        payload,
        null,
        'It waited more than a day for a signal, too long to save it. Start a new one when you play.',
      );
      throw new Error('Queued Start is over a day old');
    }
    let row: PlaySessionRow;
    try {
      row = await startPlaySession(payload);
    } catch (e) {
      // No signal / signed out: stays queued. Refused: the player hears why.
      if (isRetryLater(e)) throw asRetry(e);
      await noteStartRefused(payload, e);
      throw e;
    }
    await unmarkQueuedStart(payload.id);
    // As for a live Start (startPlay).
    void cancelAllScheduledArrivalNotices();
    // The session may have checked me in (or adopted my check-in), checked me
    // in only for a time already over, or not (the server judges the fix at
    // the tap, up to 12 hours back). The player wasn't watching: a card.
    if (payload.venueId) void noteUntrackedStart(payload, row, { queued: true });
  },
});

/** The queue keeps only "network" failures: a signed-out one waits too. */
function asRetry(e: unknown): unknown {
  return e instanceof TimeoutError ? e : new TimeoutError('Waiting to send again');
}

// ── Starts still in the offline queue ───────────────────────────────────────
// While a Start waits in the queue the server has no session, and that is
// not "none": the island stays (getActivePlay), however long the wait.
const QUEUED_STARTS_KEY = 'pickleague_play_start_queued_v1';

async function readQueuedStarts(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUED_STARTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Is this session's Start still waiting in the offline queue? */
export async function isPlayStartQueued(id: string): Promise<boolean> {
  return (await readQueuedStarts()).includes(id);
}

async function markQueuedStart(id: string): Promise<void> {
  const list = await readQueuedStarts();
  if (list.includes(id)) return;
  await AsyncStorage.setItem(QUEUED_STARTS_KEY, JSON.stringify([...list, id].slice(-20))).catch(() => {});
}

/**
 * Before an End: if its Start still waits in the offline queue and there is a
 * signal, ask the queue to send it and wait (at most CHECKOUT_FIX_WAIT_MS)
 * until it has gone. Offline there is nothing to wait for: the End queues
 * behind it. Never throws.
 */
async function sendQueuedStartFirst(id: string): Promise<boolean> {
  if (!(await isPlayStartQueued(id)) || isProbablyOffline()) return true;
  return waitUntilSent({
    kick: () => void flushMutationQueue().catch(() => {}),
    stillQueued: () => isPlayStartQueued(id),
    ms: CHECKOUT_FIX_WAIT_MS,
  });
}

async function unmarkQueuedStart(id: string): Promise<void> {
  const list = await readQueuedStarts();
  if (!list.includes(id)) return;
  await AsyncStorage.setItem(QUEUED_STARTS_KEY, JSON.stringify(list.filter((x) => x !== id))).catch(() => {});
}

/**
 * The server refused a Start (live or replayed): nothing recorded for this
 * session can count, and nobody sees it. Stop the island and say why.
 */
async function noteStartRefused(payload: StartPayload, error: unknown, reason?: string): Promise<void> {
  await unmarkQueuedStart(payload.id);
  const s = playSession.get();
  if (s.id === payload.id && s.status !== 'idle') playSession.clear();
  await noteRefusalNotice({
    key: `start:${payload.id}`,
    title: 'Play session not saved',
    body: queuedRefusalNotice({ what: 'start', tapMs: Date.parse(payload.at), error, reason }),
  });
}

/** The server refused an End: the session is still open there, and the island comes back. */
async function noteEndRefused(payload: EndPayload, error: unknown): Promise<void> {
  await clearEndPending(payload.id);
  await noteRefusalNotice({
    key: `end:${payload.id}`,
    title: 'Session still running',
    body: queuedRefusalNotice({ what: 'end', tapMs: Date.parse(payload.at), error }),
  });
}

/**
 * Emits when a Start at a court did not check me in there (the island says so
 * once, and why). `endedAtMs`: for 'synced_late', when its check-in ended.
 */
export const playStartUntracked = createSignal<{
  venueName: string | null;
  reason: UntrackedStartReason;
  endedAtMs?: number | null;
}>();

// A check that couldn't be made (offline): tried again on the next resume.
let untrackedCheckPending: {
  payload: StartPayload;
  row: PlaySessionRow | null | undefined;
  queued?: boolean;
} | null = null;

/**
 * After a Start at a court lands: if it did not check me in (the fix didn't
 * confirm the court at the tap, or the tap was over 12 hours ago: the server
 * starts it untracked, no error), or checked me in only for a time already
 * over (synced late, or closed at an End that reached Pickleague first), stop
 * naming the court on the island and say why, instead of implying friends see
 * me there. A live Start the island still shows says it on the island; a
 * replay from the offline queue, or a session already over here (the usual
 * offline case: Start and End both queued, End cleared the island), on a card
 * (lib/playStartRules.untrackedStartNotice). When a read fails (offline) the
 * check is tried again on the next resume: a failed read is never "none".
 */
async function noteUntrackedStart(
  payload: StartPayload,
  row: PlaySessionRow | null | undefined,
  opts: { queued?: boolean } = {},
): Promise<void> {
  const sessionId = payload.id;
  const retryLater = () => {
    untrackedCheckPending = { payload, row, queued: opts.queued };
  };
  let cur: CurrentCheckin | null;
  try {
    cur = await refreshCurrentCheckin();
  } catch {
    retryLater();
    return;
  }
  const s = playSession.get();
  const showing = s.id === sessionId && s.status !== 'idle' && !!s.meta?.venueId;
  const venueIds = [row?.venue_id, payload.venueId];
  if (checkedInBySession(cur, sessionId, venueIds)) {
    if (untrackedCheckPending?.payload.id === sessionId) untrackedCheckPending = null;
    return;
  }
  // The session's own check-in, when the server stored one: it may count
  // (the island is idle, so the current check-in hides it while its End is
  // pending), or it was stored only after it had ended.
  let sessionCheckin: VenueCheckin | null = null;
  if (isValidFix(payload.fix)) {
    try {
      sessionCheckin = await getMyCheckin(sessionId);
    } catch {
      retryLater();
      return;
    }
  }
  if (untrackedCheckPending?.payload.id === sessionId) untrackedCheckPending = null;
  const notice = untrackedStartNotice({
    payload,
    row,
    cur,
    sessionCheckin,
    nowMs: Date.now(),
    sessionId,
    showing,
    queued: !!opts.queued,
  });
  if (!notice) return;
  const { reason } = notice;
  const endedAtMs = reason === 'synced_late' && sessionCheckin ? checkinEndMs(sessionCheckin) : null;
  const venueId = row?.venue_id ?? payload.venueId;
  const venueName = showing
    ? (s.meta?.venueName ?? null)
    : venueId
      ? await getVenueName(venueId).catch(() => null)
      : null;
  if (showing) playSession.patchMeta({ venueName: null });
  if (!notice.onIsland) {
    await noteRefusalNotice({
      key: `start-untracked:${sessionId}`,
      title: reason === 'synced_late' ? 'Check-in saved late' : 'Not checked in',
      body: untrackedStartNote(venueName, reason, { endedAtMs, over: !showing }),
      link: 'home/-',
    });
    return;
  }
  playStartUntracked.emit({ venueName, reason, endedAtMs });
}

registerMutationHandler(MUTATION_END, {
  run: async (p) => {
    const payload = p as EndPayload;
    const { id, at, fix } = payload;
    try {
      // An End queued by an older build has no fix: the Phase 1 call.
      await endPlaySession(id, at, isValidFix(fix) ? fix : null);
    } catch (e) {
      // No signal / signed out: still queued, so still pending. Refused: the
      // session is still open on the server; the player hears why.
      if (isRetryLater(e)) throw asRetry(e);
      await noteEndRefused(payload, e);
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
/**
 * A Start reached the server live (not a queued replay): the session row
 * exists, and with a court that confirmed, so does its check-in.
 */
export const playStartLanded = createSignal<{ id: string; venueId: string | null; at: string }>();

export function startPlay(
  meta: Omit<PlayMeta, 'label'> & { label?: string; fix?: DeviceFix | null; viaCheckin?: boolean },
): string {
  const id = uuidv4();
  const at = new Date().toISOString();
  const { fix, viaCheckin, ...rest } = meta;
  playSession.start(id, { ...rest, label: meta.label ?? PLAY_LABEL[meta.kind] }, Date.parse(at));
  const payload: StartPayload = {
    id,
    kind: meta.kind,
    sourceId: meta.sourceId,
    venueId: meta.venueId,
    at,
    ...(meta.venueId && fix ? { fix } : {}),
    ...(meta.venueId && viaCheckin ? { viaCheckin: true as const } : {}),
  };
  void runOrQueue(MUTATION_START, payload, () => startPlaySession(payload))
    .then(({ queued, result }) => {
      if (queued) return markQueuedStart(id);
      // The server now skips an arrival still waiting out its minute (a play
      // session of mine is open), and a session adopts or closes one that
      // landed: the phone's own "Checked in" / "Still at" (D3) would be wrong.
      void cancelAllScheduledArrivalNotices();
      // The court card shows the session's check-in once it exists; a court
      // that didn't check me in stops being named (the queued replay checks
      // the same way when it lands).
      if (meta.venueId) void noteUntrackedStart(payload, result);
      // The ▶ Play sheet's plan waits for this (lib/playStartPlan).
      playStartLanded.emit({ id, venueId: meta.venueId, at });
    })
    .catch(async (e: unknown) => {
      // Signed out right now: wait in the queue like an offline Start.
      if (isRetryLater(e)) {
        try {
          await enqueueMutation(MUTATION_START, payload);
        } catch (queueError: unknown) {
          // Not saved to send later either (kit 1.47+ throws rather than erase the queue).
          await noteStartRefused(payload, queueError, "You're signed out, and Pickleague couldn't save it on this phone to send later.");
          return;
        }
        await markQueuedStart(id);
        return;
      }
      // Refused: nothing recorded for it could count. Say why, stop the island.
      await noteStartRefused(payload, e);
    });
  return id;
}

/** An End refused live (not a network failure: those queue). Signed out: it waits; else the player hears why. */
async function onEndFailed(payload: EndPayload, e: unknown): Promise<void> {
  if (isRetryLater(e)) {
    // Not saved to send later either: the island comes back and the player hears why.
    await enqueueMutation(MUTATION_END, payload).catch((queueError: unknown) => noteEndRefused(payload, queueError));
    return;
  }
  await noteEndRefused(payload, e);
}

/**
 * End the session. Resolves without the network: the island clears now, the
 * server write (with the real end time) is sent or queued in the background.
 * The pending-End entry is written BEFORE that write and kept after it lands
 * (a tombstone that ages out), so neither a resume check that runs while it is
 * queued nor one already in flight when End was tapped can bring the island
 * back. At a court, End is the check-out of the session's check-in: alongside
 * that entry it takes a fresh fix (never a prompt, at most 3 s, as Check out
 * does) and sends it with the End, so the server can confirm the stay.
 */
export function endPlay(): EndedPlay | null {
  const s = playSession.get();
  if (!s.id) return null;
  const payload: EndPayload = { id: s.id, at: new Date().toISOString() };
  const atCourt = !!s.meta?.venueId;
  playSession.clear();
  // The server closes the session's own check-in; an adopted one stays.
  void forgetCheckin(payload.id);
  void Promise.all([
    markEndPending(payload.id, Date.parse(payload.at)).catch(() => {}), // best-effort; the End goes out regardless
    atCourt ? fixWithin(() => takeFixIfAllowed(CHECKOUT_FIX_WAIT_MS), CHECKOUT_FIX_WAIT_MS) : Promise.resolve(null),
    // Its Start still in the offline queue (the signal just came back): let
    // it land first, so this End closes its check-in with the stay fix. If
    // the End still lands first, the server stores the Start ended with its
    // check-in closed at the End (migration_checkin_tap_time.sql).
    atCourt ? sendQueuedStartFirst(payload.id) : Promise.resolve(true),
  ])
    .then(async ([, fix]) => {
      const sent: EndPayload = fix ? { ...payload, fix } : payload;
      try {
        await runOrQueue(MUTATION_END, sent, () => endPlaySession(sent.id, sent.at, sent.fix ?? null));
      } catch (e) {
        // Not a network failure (those queue): signed out waits, else say why.
        await onEndFailed(sent, e);
      }
    })
    .catch(() => clearEndPending(payload.id));
  if (!s.meta || s.startedAtMs == null) return null;
  const recorded: RecordedForSession = recordedFor.get(s.id) ?? s.meta.recorded ?? null;
  recordedFor.delete(s.id);
  const ended: EndedPlay = {
    id: s.id,
    kind: s.meta.kind,
    sourceId: s.meta.sourceId,
    startedAtMs: s.startedAtMs,
    endedAtMs: Date.parse(payload.at),
    recorded,
    venueName: s.meta.venueName,
  };
  lastEnded = ended;
  playEnded.emit(ended);
  return ended;
}

// The session ended last on this device: a drill reviewed in its 2 hours
// after End can still make it count (noteDrillReviewed asks about it too).
let lastEnded: EndedPlay | null = null;

// ── Ending: "Record a match or drill?" ──────────────────────────────────────
// A session counts once a match or drill is recorded for it (Phase 1.5,
// lib/sessionValidity). End emits the session that just ended; the end sheet
// (components/play/PlayEndSheet) decides what to show.

/** Emits the session the player just ended. */
export const playEnded = createSignal<EndedPlay>();

// Sessions this device already knows count, so End doesn't ask again (asking
// would invite a duplicate match). Also kept on the running session's meta,
// which is persisted per user, so a restart between recording and End
// remembers it. Anything else (a match a partner recorded, one from before
// this build) End asks the server about.
type Recorded = NonNullable<RecordedForSession>;
const recordedFor = new Map<string, Recorded>();
// What wins when two things count: a confirmed match, then a pending one, then a drill.
const RANK: Record<Recorded, number> = { match_confirmed: 3, match: 2, match_pending: 2, drill: 1 };

function noteSessionCounts(sessionId: string, what: Recorded): void {
  const had = recordedFor.get(sessionId);
  if (had && RANK[had] >= RANK[what]) return;
  recordedFor.set(sessionId, what);
  const s = playSession.get();
  const meta = s.meta?.recorded;
  if (s.id === sessionId && s.status !== 'idle' && (!meta || RANK[meta] < RANK[what])) playSession.patchMeta({ recorded: what });
}

/**
 * MatchEntry recorded a match I played in, for this session (linked to it, or
 * recorded while it runs). MatchEntry decides (lib/sessionValidity
 * shouldNoteRecorded): the server counts a match only when I played in it.
 * `confirmed`: stored confirmed (godmode); every other match is pending until
 * the other team confirms, and stops counting if nobody does within the hour.
 */
export function noteMatchRecorded(sessionId: string, opts: { confirmed?: boolean } = {}): void {
  noteSessionCounts(sessionId, opts.confirmed ? 'match_confirmed' : 'match_pending');
}

/**
 * I just reviewed a drill. Asks the server about my running session, or the
 * one I ended under 2 hours ago (the end sheet's Review drill), and returns
 * the line to show: it counts now, or why the drill doesn't count for it.
 * When the running session now needs nothing more, End won't ask again.
 * Best-effort, bounded at 5 s; never throws (null: nothing to say).
 */
export async function noteDrillReviewed(): Promise<string | null> {
  const s = playSession.get();
  const running = !!s.id && s.status !== 'idle';
  const recent = lastEnded && Date.now() - lastEnded.endedAtMs < 2 * 3600_000 ? lastEnded : null;
  const id = running ? s.id : recent?.id;
  if (!id) return null;
  try {
    const v = await withTimeout(getMySessionValidity(id), 5_000);
    // Only when the drill is what counts: if a match a partner recorded made
    // it count, End must not credit the drill (it asks the server instead).
    if (running && v && v.reason === 'open' && drillMadeItCount(v) === true) noteSessionCounts(id, 'drill');
    return drillReviewNote(v, { running, nowMs: Date.now() });
  } catch {
    // End asks the server again anyway.
    return null;
  }
}

// Ends sent again this run (once each; a repeat End is a no-op server side).
const resentEnds = new Set<string>();

/** The app died between End and its write: send it again, with the tap time
 *  and no fix (that fix is gone, so this stay goes unconfirmed). */
function resendLostEnd(id: string, tapMs: number): void {
  if (resentEnds.has(id)) return;
  resentEnds.add(id);
  const payload: EndPayload = { id, at: new Date(tapMs).toISOString() };
  void runOrQueue(MUTATION_END, payload, () => endPlaySession(payload.id, payload.at, null)).catch((e: unknown) =>
    onEndFailed(payload, e),
  );
}

// ── A session that ended without this device's End ─────────────────────────
/** A session the island was showing that the server ended (or never had), and why. */
export type LostPlay = {
  id: string;
  kind: PlayKind;
  sourceId: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  reason: LostPlayReason;
  recorded: RecordedForSession;
};

/** Emits when the island's session turns out to be over on the server (PlayIsland says why). */
export const playLost = createSignal<LostPlay>();
/** The server ends a session left open this long (expire_play_sessions: ended_at = start + 6 h). */
const AUTO_END_MS = 6 * 3600_000;
const explainedLost = new Set<string>();

/** Find out why the island's session is gone on the server, and say so once. Never throws. */
async function explainLostPlay(local: { id: string; startedAtMs: number; meta: PlayMeta }): Promise<void> {
  if (explainedLost.has(local.id)) return;
  explainedLost.add(local.id);
  try {
    const row = await getMyPlaySession(local.id);
    const startedAtMs = row ? Date.parse(row.started_at) : local.startedAtMs;
    let endedAtMs = row?.ended_at ? Date.parse(row.ended_at) : null;
    if (row && !row.ended_at) {
      // Still open there: past the 6-hour read window, before the hourly
      // expiry (expire_play_sessions, at :25) closes it. The island is
      // cleared now and no later resume would ask again, so treat it as
      // auto-ended now, with the end the expiry will store (start + 6 h).
      if (startedAtMs + AUTO_END_MS > Date.now()) {
        // Younger than 6 hours (can't reach here today): ask again next resume.
        explainedLost.delete(local.id);
        return;
      }
      endedAtMs = startedAtMs + AUTO_END_MS;
    }
    const reason: LostPlayReason = !row
      ? 'never_saved'
      : endedAtMs != null && endedAtMs - startedAtMs >= AUTO_END_MS - 60_000
        ? 'auto_ended'
        : 'ended_elsewhere';
    playLost.emit({
      id: local.id,
      kind: local.meta.kind,
      sourceId: local.meta.sourceId,
      startedAtMs,
      endedAtMs,
      reason,
      recorded: recordedFor.get(local.id) ?? local.meta.recorded ?? null,
    });
  } catch {
    explainedLost.delete(local.id); // offline: try again on the next resume
  }
}

/** For useResumeLiveSession: the server's view of my active session. */
export async function getActivePlay() {
  const uid = await currentUserId(supabase);
  if (!uid) return null;
  const found = await getMyActivePlaySession(uid);
  // An End still on its way to the server: that session is over.
  const pending = await readPendingEnds();
  const row = found && !isEndPending(pending, found.id, Date.now()) ? found : null;
  if (found && endNeedsResend(pending, found.id, Date.now())) resendLostEnd(found.id, pending[found.id]);
  // A Start at a court whose check-in read failed (offline): check again now.
  if (untrackedCheckPending) {
    const { payload, row, queued } = untrackedCheckPending;
    void noteUntrackedStart(payload, row, { queued });
  }
  const shown = playSession.get();
  const shownMeta = shown.id && shown.status !== 'idle' && shown.meta && shown.startedAtMs != null
    ? { id: shown.id, startedAtMs: shown.startedAtMs, meta: shown.meta as PlayMeta }
    : null;
  if (!row) {
    if (shownMeta) {
      // A Start still sitting in the offline queue is not "none", however
      // long it waits; nor is one this young (its write may be in flight).
      if ((await readQueuedStarts()).includes(shownMeta.id) || Date.now() - shownMeta.startedAtMs < 10 * 60_000) {
        return shownMeta;
      }
      // Gone on the server, and not ended here: say why (auto-ended after 6
      // hours, ended elsewhere, or never saved).
      if (!isEndPending(pending, shownMeta.id, Date.now())) void explainLostPlay(shownMeta);
    }
    return null;
  }
  if (shownMeta && shownMeta.id !== row.id && !isEndPending(pending, shownMeta.id, Date.now())) {
    // My newer Start is still queued: it ends that older session when it
    // lands, so keep showing mine.
    if ((await readQueuedStarts()).includes(shownMeta.id)) return shownMeta;
    // Another session runs on the server (a newer Start elsewhere): this one ended.
    void explainLostPlay(shownMeta);
  }
  const local = playSession.get();
  const startedAtMs = Date.parse(row.started_at);
  if (local.id === row.id && local.meta) return { id: row.id, startedAtMs, meta: local.meta };
  // Rebuilt from the server: name the court only when the session checked me
  // in there (an untracked session at a court shows no court, as at Start).
  const checkedIn =
    !!row.venue_id &&
    checkedInBySession(await refreshCurrentCheckin().catch(() => peekCurrentCheckin()), row.id, [row.venue_id]);
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
export type PlayStartRequest = {
  kind?: PlayKind;
  sourceId?: string | null;
  /** "▶ Play here": this court, picked (the plan's C3). */
  venue?: { id: string; name: string };
};

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
  success: PLAY_NAV_ENABLED
    ? { title: '▶ Play', body: 'Open Pickleague and tap Start.' }
    : { title: 'Where are you playing?', body: 'Pick your court in Pickleague, then tap Start.' },
  run: async (d) => {
    await requireUser();
    const raw = d as Record<string, unknown>;
    const kind = raw.play_kind === 'match' ? 'match' : raw.play_kind === 'drill' ? 'drill' : 'open_play';
    openPlayStart({ kind, sourceId: typeof raw.source_id === 'string' ? raw.source_id : null });
  },
});
