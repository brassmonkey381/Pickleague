// Court check-in, app side: check in / extend / check out, the offline queue,
// the "5 minutes left" reminder and its lock-screen buttons.
//
// The current check-in is cached locally (per user) so a check-in made with no
// signal shows straight away and the reminder can be rescheduled. The server
// row is the truth once it lands; refreshCurrentCheckin() reconciles.
//
// Queued writes: a check-in is safe to apply late because it carries its real
// time (`at`) and a client id (replays land once). Extend is NOT queued: an
// extension that lands after the check-in lapsed would be refused anyway, so
// it fails loudly instead.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerMutationHandler, runOrQueue } from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { catalog, NeedsApp, registerActionHandler, requireUser } from './notificationActions';
import {
  checkinVenue,
  checkoutVenue,
  extendCheckin,
  getMyOpenCheckin,
  getVenueName,
  type CheckinSource,
} from '../data/venueCheckins';

export type CurrentCheckin = {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  expiresAt: string;
  source: CheckinSource;
  /** Saved offline; not on the server yet. */
  queued?: boolean;
};

const STORAGE_KEY = 'pickleague_current_checkin_v1';
const REMINDER_ID = 'checkin-extend';
const MUTATION_CHECKIN = 'venue:checkin';
const MUTATION_CHECKOUT = 'venue:checkout';
const HOUR_MS = 60 * 60_000;

/** Emits whenever the current check-in changes (null = not checked in). */
export const checkinChanged = createSignal<CurrentCheckin | null>();

type CheckinPayload = { id: string; venueId: string; minutes: number; source: CheckinSource; at: string };
type CheckoutPayload = { id: string | null; source?: CheckinSource };

registerMutationHandler(MUTATION_CHECKIN, {
  run: async (p) => {
    await checkinVenue(p as CheckinPayload);
  },
});
registerMutationHandler(MUTATION_CHECKOUT, {
  run: async (p) => {
    const { id, source } = p as CheckoutPayload;
    await checkoutVenue(id, source);
  },
});

async function readStored(): Promise<CurrentCheckin | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CurrentCheckin) : null;
  } catch {
    return null;
  }
}

async function setCurrent(c: CurrentCheckin | null): Promise<void> {
  try {
    if (c) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // cache only; the server row is the truth
  }
  if (c) void scheduleReminder(c);
  else void cancelLocalNotification(REMINDER_ID);
  checkinChanged.emit(c);
}

function scheduleReminder(c: CurrentCheckin): Promise<boolean> {
  return scheduleLocalNotification({
    id: REMINDER_ID,
    at: new Date(c.expiresAt).getTime() - 5 * 60_000,
    title: `Still at ${c.venueName}?`,
    body: 'Your check-in ends in 5 minutes.',
    categoryId: catalog.ids.checkin_extend.id,
    data: { checkin_id: c.id, expires_at: c.expiresAt, venue_id: c.venueId, venue_name: c.venueName },
  });
}

const live = (c: CurrentCheckin | null) => (c && new Date(c.expiresAt).getTime() > Date.now() ? c : null);

/** The signed-in player's current check-in from the local cache (no network). */
export async function peekCurrentCheckin(): Promise<CurrentCheckin | null> {
  const [c, uid] = await Promise.all([readStored(), currentUserId(supabase)]);
  return c && uid && c.userId === uid ? live(c) : null;
}

/**
 * Reconcile the cache with the server. Keeps a queued (not yet sent) check-in;
 * otherwise the server wins. Throws on a network failure so the caller can
 * keep showing the cached value.
 */
export async function refreshCurrentCheckin(): Promise<CurrentCheckin | null> {
  const uid = await currentUserId(supabase);
  if (!uid) return null;
  const cached = await peekCurrentCheckin();
  const row = await getMyOpenCheckin(uid);
  if (!row) {
    if (cached?.queued) return cached;
    if (cached) await setCurrent(null);
    return null;
  }
  const venueName =
    cached?.venueId === row.venue_id ? cached.venueName : (await getVenueName(row.venue_id)) ?? 'this court';
  const next: CurrentCheckin = {
    id: row.id,
    userId: uid,
    venueId: row.venue_id,
    venueName,
    expiresAt: row.expires_at,
    source: row.source,
  };
  if (!cached || cached.id !== next.id || cached.expiresAt !== next.expiresAt || cached.queued) await setCurrent(next);
  return next;
}

/** Check in now. Queues when offline (the result has `queued: true`). */
export async function checkInAt(
  venue: { id: string; name: string },
  opts: { source?: CheckinSource; minutes?: number } = {},
): Promise<CurrentCheckin> {
  const uid = await requireUser();
  const minutes = opts.minutes ?? 120;
  const payload: CheckinPayload = {
    id: uuidv4(),
    venueId: venue.id,
    minutes,
    source: opts.source ?? 'manual',
    at: new Date().toISOString(),
  };
  const { queued, result } = await runOrQueue(MUTATION_CHECKIN, payload, () => checkinVenue(payload));
  const c: CurrentCheckin = {
    id: payload.id,
    userId: uid,
    venueId: venue.id,
    venueName: venue.name,
    expiresAt: result?.expires_at ?? new Date(Date.now() + minutes * 60_000).toISOString(),
    source: payload.source,
    ...(queued ? { queued: true } : {}),
  };
  await setCurrent(c);
  return c;
}

/** Another hour from the current end (absolute, so a replay can't add two). */
export async function extendCheckinByHour(c: Pick<CurrentCheckin, 'id' | 'expiresAt'>): Promise<CurrentCheckin | null> {
  const until = new Date(Math.max(new Date(c.expiresAt).getTime(), Date.now()) + HOUR_MS).toISOString();
  const row = await extendCheckin(c.id, until);
  const cached = await readStored();
  if (cached?.id !== c.id) return null;
  const next = { ...cached, expiresAt: row.expires_at };
  await setCurrent(next);
  return next;
}

/** Check out (one check-in, or all of mine). Queues when offline. */
export async function checkOut(id: string | null, source?: CheckinSource): Promise<{ queued: boolean }> {
  const payload: CheckoutPayload = { id, source };
  const { queued } = await runOrQueue(MUTATION_CHECKOUT, payload, () => checkoutVenue(id, source));
  const cached = await readStored();
  if (cached && (id === null || cached.id === id) && (!source || cached.source === source)) await setCurrent(null);
  return { queued };
}

/** Sign-out: forget the local check-in and its reminder (the server row expires on its own). */
export async function clearCheckinForSignOut(): Promise<void> {
  await setCurrent(null);
}

// ── Lock-screen buttons on the "5 minutes left" reminder ────────────────────
registerActionHandler('checkin_extend', {
  success: { title: 'Extended', body: 'Checked in for another hour.' },
  run: async (d) => {
    await requireUser();
    if (!d.checkin_id || !d.expires_at) throw new NeedsApp('Open Pickleague to extend your check-in.');
    await extendCheckinByHour({ id: d.checkin_id, expiresAt: d.expires_at });
  },
});
registerActionHandler('checkin_out', {
  success: { title: 'Checked out', body: 'See you next time.' },
  queued: { title: 'Checked out', body: 'Saved. It syncs when you are back online.' },
  run: async (d) => {
    await requireUser();
    return checkOut(d.checkin_id ?? null);
  },
});
