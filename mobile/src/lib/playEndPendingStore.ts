// Storage for the pending-End guard (rules in ./playEndPending). Shared by
// lib/playSession (End writes it, the island's resume check reads it) and
// lib/courtCheckin (a session check-in whose End is still queued is not shown
// as current either). Writes are chained so a mark and a clear can't
// interleave; the in-memory map is the one the last write stored.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PLAY_END_PENDING_KEY, addPendingEnd, prunePendingEnds, removePendingEnd, type PendingEnds } from './playEndPending';

let pendingEnds: PendingEnds | null = null; // null until first read
let chain: Promise<unknown> = Promise.resolve();

async function load(): Promise<PendingEnds> {
  try {
    return prunePendingEnds(await AsyncStorage.getItem(PLAY_END_PENDING_KEY), Date.now());
  } catch {
    return {};
  }
}

function update(fn: (m: PendingEnds) => PendingEnds): Promise<void> {
  const run = chain.then(async () => {
    pendingEnds = fn(pendingEnds ?? (await load()));
    await AsyncStorage.setItem(PLAY_END_PENDING_KEY, JSON.stringify(pendingEnds)).catch(() => {});
  });
  chain = run.catch(() => {});
  return run;
}

/** End was tapped for this session (call before the End write goes out). */
export function markEndPending(sessionId: string, tapMs: number): Promise<void> {
  return update((m) => addPendingEnd(m, sessionId, tapMs));
}

/** The End landed, or failed for a reason a retry won't fix. */
export function clearEndPending(sessionId: string): Promise<void> {
  return update((m) => removePendingEnd(m, sessionId));
}

/** The current map, after any write already started. */
export async function readPendingEnds(): Promise<PendingEnds> {
  await chain;
  return pendingEnds ?? (pendingEnds = await load());
}
