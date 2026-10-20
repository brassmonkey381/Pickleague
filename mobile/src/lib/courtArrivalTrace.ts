// Court arrival debug trace: the last 200 things the arrival engine did on
// THIS phone (geofence Enter / Exit with the arrival flag, the queue's answer,
// prompts, notices, cancels, syncs, foreground monitor ticks), for the device
// tests and the godmode viewer in Settings.
//
// Device-only on purpose: it is never uploaded (Doggle's GPS debug session
// was, and Pickleague doesn't need that). It never holds coordinates either:
// court ids, flags and answers only. Cleared on a real sign-out, so the next
// account on the phone doesn't see the last one's courts.
//
// Headless-safe (the geofence task writes it): no React, no screens.
import AsyncStorage from '@react-native-async-storage/async-storage';

const TRACE_KEY = 'pickleague_court_arrival_trace_v1';
const MAX_EVENTS = 200;

export type ArrivalTraceKind =
  | 'enter'
  | 'exit'
  | 'decision'
  | 'queue'
  | 'notice'
  | 'prompt'
  | 'cancel'
  | 'departure'
  | 'local_checkin'
  | 'sync'
  | 'monitor_tick'
  | 'signout';

/** Flags, ids, counts and answers. Never a coordinate. */
export type ArrivalTraceDetail = Record<string, string | number | boolean | null | undefined>;

export type ArrivalTraceEvent = { at: number; kind: ArrivalTraceKind; detail?: ArrivalTraceDetail };

// One write at a time: two events from one wake (an Enter and its queue
// answer) must not overwrite each other's read-modify-write.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<R>(job: () => Promise<R>): Promise<R> {
  const run = chain.then(job);
  chain = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<ArrivalTraceEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(TRACE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ArrivalTraceEvent[]) : [];
  } catch {
    return [];
  }
}

/** Record one event. Fire and forget: never throws, never awaited by the engine. */
export function traceArrival(kind: ArrivalTraceKind, detail?: ArrivalTraceDetail): void {
  const event: ArrivalTraceEvent = { at: Date.now(), kind, ...(detail ? { detail } : {}) };
  void enqueue(async () => {
    const list = await readAll();
    list.push(event);
    await AsyncStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-MAX_EVENTS)));
  }).catch(() => undefined);
}

/** The trace, oldest first (the godmode viewer). */
export function readArrivalTrace(): Promise<ArrivalTraceEvent[]> {
  return enqueue(readAll).catch(() => []);
}

export function clearArrivalTrace(): Promise<void> {
  return enqueue(() => AsyncStorage.removeItem(TRACE_KEY)).catch(() => undefined);
}
