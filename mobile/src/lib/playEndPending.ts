// The pending-End guard for play sessions (pure; ./playEndPendingStore keeps
// the map). End clears the island at once and sends end_play_session through
// the offline queue. Until that write lands, the server still has the session
// open, and the resume check (getActivePlay) would bring the island straight
// back. So End records { sessionId: tapMs } BEFORE the queued write and the
// resume check skips those sessions. A successful End KEEPS its entry, as a
// tombstone: a resume read that was already in flight when End was tapped can
// answer "open" after the End landed, and must still be ignored. Only a
// non-network failure clears it (that End will never land). Entries age out
// after 3 days: the server's own expiry has closed that session long before,
// and session ids are fresh uuids, so a tombstone never hides a live session.
// An End that never left the phone (the app was killed before the write went
// out) would leave the session open on the server behind its tombstone, so a
// resume check that still finds the session open well after the tap sends
// that End again (end_play_session ignores a repeat).

export const PLAY_END_PENDING_KEY = 'pickleague_play_end_pending';
export const PLAY_END_PENDING_MAX_AGE_MS = 3 * 86_400_000;
/** How long after the tap an End that should have landed counts as lost. */
export const PLAY_END_RESEND_AFTER_MS = 2 * 60_000;

/** sessionId -> when End was tapped (epoch ms). */
export type PendingEnds = Record<string, number>;

const live = (tapMs: unknown, nowMs: number): tapMs is number =>
  typeof tapMs === 'number' && Number.isFinite(tapMs) && nowMs - tapMs < PLAY_END_PENDING_MAX_AGE_MS;

/** The stored map without expired or malformed entries (anything unreadable is an empty map). */
export function prunePendingEnds(raw: unknown, nowMs: number): PendingEnds {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: PendingEnds = {};
  for (const [id, tapMs] of Object.entries(v as Record<string, unknown>)) {
    if (id && live(tapMs, nowMs)) out[id] = tapMs;
  }
  return out;
}

export function addPendingEnd(map: PendingEnds, sessionId: string, tapMs: number): PendingEnds {
  return { ...map, [sessionId]: tapMs };
}

export function removePendingEnd(map: PendingEnds, sessionId: string): PendingEnds {
  if (!(sessionId in map)) return map;
  const { [sessionId]: _gone, ...rest } = map;
  return rest;
}

/** True while an End for this session is waiting to reach the server. */
export function isEndPending(map: PendingEnds, sessionId: string, nowMs: number): boolean {
  return live(map[sessionId], nowMs);
}

/** True when the server still has this session open long after its End was
 *  tapped: that End was lost, so send it again. */
export function endNeedsResend(map: PendingEnds, sessionId: string, nowMs: number): boolean {
  return isEndPending(map, sessionId, nowMs) && nowMs - map[sessionId] >= PLAY_END_RESEND_AFTER_MS;
}
