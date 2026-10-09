// Notification action buttons: answering a push without opening the app.
//
// End to end:
//   1. A `notifications` row is inserted (by a trigger or a generator).
//   2. send-push resolves an ACTION CATEGORY for it at send time and puts
//      `categoryId` on the Expo message, plus whatever the buttons need in `data`.
//   3. This module registers every category from notificationCatalog.data.ts
//      with the OS, so iOS/Android know which buttons to draw.
//   4. A press arrives through the foundation's wireNotificationResponses (in
//      lib/push.ts), which dedupes replays and hands it to
//      handleNotificationAction below.
//
// Each write runs through the foundation's runNotificationAction: bounded at
// 10 s and ending in exactly one local notice, because on the lock screen the
// notification is the whole UI and silence reads as "nothing happened".
//
// Delivery is at-least-once, so every write is idempotent: plain inserts that
// treat a duplicate as success, or RPCs that return 'already' on a replay.
//
// Runs on a background launch where nothing is mounted: no navigator, theme or
// toast. It depends on Supabase and the LOCAL session only, and never throws.
import { Platform } from 'react-native';
import {
  defineNotificationCatalog,
  registerNotificationCategories as registerCategories,
  runNotificationAction,
  type NoticeCopy,
  type ParsedNotificationResponse,
} from '@just-messin-around/expo-foundation/platform/push';
import { sbCall, currentUserId, insertIgnoringDuplicate } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { CATALOG } from './notificationCatalog.data';

export const catalog = defineNotificationCatalog(CATALOG);
const ACTION_IDS = new Set<string>(Object.values(CATALOG).flatMap((c) => Object.keys(c.actions)));

/** True for a button this app handles (anything else is treated as a plain tap). */
export function isAppAction(actionId: string): boolean {
  return ACTION_IDS.has(actionId);
}

/**
 * Register every category with the OS. Cheap and idempotent; must run at
 * startup, before a push arrives, or the push renders with no buttons.
 */
export async function registerNotificationCategories(): Promise<void> {
  if (Platform.OS === 'web') return;
  await registerCategories(catalog.registrationMap);
}

/** Fields send-push (or a local notice) puts on the push for the buttons. */
export type ActionPushData = {
  entity_type?: string | null;
  entity_id?: string | null;
  confirmed_slot_id?: string | null;
  registration_id?: string | null;
  venue_id?: string | null;
  title?: string;
};

/** A precondition the lock screen can't satisfy; the message is the notice body. */
export class NeedsApp extends Error {}

const TIMED_OUT: NoticeCopy = { title: 'May not have saved', body: 'Open Pickleague to check.' };
const FAILED: NoticeCopy = { title: "That didn't save", body: 'Tap to open Pickleague and try again.' };

export async function requireUser(): Promise<string> {
  // LOCAL session read: getUser() is a network round trip, and this may be a
  // cold background launch on a slow connection.
  const uid = await currentUserId(supabase);
  if (!uid) throw new NeedsApp('Sign in to Pickleague to respond.');
  return uid;
}

function needs(id: string | null | undefined, msg: string): string {
  if (!id) throw new NeedsApp(msg);
  return id;
}

/** Known server rejections become specific copy; everything else is FAILED. */
function mapError(e: unknown): NoticeCopy | null {
  if (e instanceof NeedsApp) return { title: "That didn't save", body: e.message };
  const raw = (e as { message?: string })?.message ?? '';
  if (/no longer pending|expired|not found|Invite already/i.test(raw)) {
    return { title: 'Nothing to answer', body: 'That is no longer waiting on you.' };
  }
  if (/Pick a time/i.test(raw)) return { title: 'Pick a time', body: 'Open Pickleague to choose a time.' };
  return null;
}

const rpc = (fn: string, args: Record<string, unknown>) =>
  sbCall(() => supabase.rpc(fn, args), { retries: 1, timeoutMs: 9_000 });

export type ActionHandler = {
  run: (d: ActionPushData, idempotencyKey: string) => Promise<unknown>;
  success: NoticeCopy;
  queued?: NoticeCopy;
};

const HANDLERS: Record<string, ActionHandler> = {
  event_accept: {
    success: { title: "You're in", body: 'See you there.' },
    run: async (d) => {
      const slotId = needs(d.confirmed_slot_id, 'Open Pickleague to pick a time for this event.');
      const uid = await requireUser();
      // Plain insert, not upsert: event_slot_votes has no UPDATE policy, so
      // ON CONFLICT DO UPDATE fails with 42501 when the row exists. A duplicate
      // (23505) means the answer is already recorded. A DB trigger clears an
      // earlier decline.
      await insertIgnoringDuplicate(supabase.from('event_slot_votes').insert({ slot_id: slotId, user_id: uid }));
    },
  },
  event_decline: {
    success: { title: 'Got it', body: "Marked you as can't make it." },
    run: async (d) => {
      const eventId = needs(d.entity_id, 'Open Pickleague to respond to this event.');
      const uid = await requireUser();
      await insertIgnoringDuplicate(supabase.from('event_declines').insert({ event_id: eventId, user_id: uid }));
    },
  },
  match_confirm: {
    success: { title: 'Match confirmed', body: 'Ratings update shortly.' },
    // Raises (not an error code) for a match that lapsed or was already
    // settled; mapError turns that into "no longer waiting on you" rather than
    // pretending the match got recorded.
    run: async (d) => {
      const matchId = needs(d.entity_id, 'Open Pickleague to confirm this match.');
      await requireUser();
      await rpc('confirm_match', { p_match_id: matchId });
    },
  },
  drill_accept: {
    success: { title: 'Drill accepted', body: 'Open Pickleague to chat about where to play.' },
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer this request.');
      await requireUser();
      await rpc('respond_drill_request', { p_request: id, p_accept: true });
    },
  },
  drill_decline: {
    success: { title: 'Declined', body: 'We let them know.' },
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer this request.');
      await requireUser();
      await rpc('respond_drill_request', { p_request: id, p_accept: false });
    },
  },
  drill_on_my_way: {
    success: { title: 'Sent', body: 'Your partner knows you are on the way.' },
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer.');
      await requireUser();
      await rpc('rsvp_drill_session', { p_session: id, p_status: 'on_my_way' });
    },
  },
  drill_cant_make_it: {
    success: { title: 'Sent', body: "Your partner knows you can't make it." },
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer.');
      await requireUser();
      await rpc('rsvp_drill_session', { p_session: id, p_status: 'cant_make_it' });
    },
  },
  tournament_accept: {
    success: { title: "You're in", body: 'Invite accepted.' },
    run: async (d) => {
      const id = needs(d.registration_id, 'Open Pickleague to answer this invite.');
      await requireUser();
      try {
        await rpc('tournament_respond_to_invite', { p_registration_id: id, p_accept: true });
      } catch (e) {
        // A replay after the first tap worked: the invite is already approved.
        if (/Invite already approved/i.test((e as { message?: string })?.message ?? '')) return;
        throw e;
      }
    },
  },
};

/** Feature modules (court check-in, play session) add their buttons here. */
export function registerActionHandler(actionId: string, h: ActionHandler): void {
  HANDLERS[actionId] = h;
}

/** Perform the write behind a pressed button. Never throws. */
export async function handleNotificationAction(r: ParsedNotificationResponse): Promise<void> {
  const h = r.action ? HANDLERS[r.action] : undefined;
  if (!h) return;
  await runNotificationAction((key) => h.run(r.data as ActionPushData, key), {
    idempotencyKey: r.idempotencyKey,
    success: h.success,
    queued: h.queued,
    timedOut: TIMED_OUT,
    failure: FAILED,
    mapError,
  });
}
