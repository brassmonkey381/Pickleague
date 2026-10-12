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
//      handleNotificationAction below. Link buttons (catalog `link: true`)
//      never get here: they navigate like a tap (lib/pushLinks.ts).
//
// Each write runs through the foundation's runNotificationAction: bounded at
// 10 s and ending in exactly one local notice, because on the lock screen the
// notification is the whole UI and silence reads as "nothing happened". Every
// notice links to what it is about: a tap on "Drill accepted" opens the chat,
// a tap on "That didn't save" opens the item that needs fixing.
//
// Delivery is at-least-once, so every write is idempotent: plain inserts that
// treat a duplicate as success, or RPCs that return 'already' on a replay. A
// replay reads as "already done", never as a failure.
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
import { linkOf } from './pushLinks';
import { redeemLeagueInvite } from '../data/leagueInvites';

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

type DateSlot = { date: string; slot: number };

/** Fields send-push (or a local notice) puts on the push for the buttons. */
export type ActionPushData = {
  entity_type?: string | null;
  entity_id?: string | null;
  confirmed_slot_id?: string | null;
  registration_id?: string | null;
  venue_id?: string | null;
  venue_name?: string | null;
  checkin_id?: string | null;
  expires_at?: string | null;
  title?: string;
  kind?: string;
  league_id?: string | null;
  invite_code?: string | null;
  partner_id?: string | null;
  /** Drill request slots in time order (the order the push body numbers them). */
  slots?: DateSlot[];
  deepLink?: string;
};

/** A precondition the lock screen can't satisfy; the message is the notice body.
 *  `link` is where a tap on that notice goes (default: the push's own link). */
export class NeedsApp extends Error {
  constructor(message: string, readonly link?: string) {
    super(message);
  }
}

const TIMED_OUT: NoticeCopy = { title: 'May not have saved', body: 'Tap to open Pickleague and check.' };
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

const message = (e: unknown): string => (e as { message?: string })?.message ?? '';

/** Known server rejections become specific copy; everything else is FAILED. */
export function mapError(e: unknown): NoticeCopy | null {
  if (e instanceof NeedsApp) {
    return { title: "That didn't save", body: e.message, ...(e.link ? { data: { deepLink: e.link } } : {}) };
  }
  const raw = message(e);
  // The entry fee: "User <id> has only N 🥒, ante is M (after S🥒 subsidy)".
  if (/has only \d+/i.test(raw)) {
    return { title: 'Not enough pickles', body: "You don't have enough 🥒 for the entry fee. Tap to open the tournament." };
  }
  if (/Code creator can.t cover/i.test(raw)) {
    return { title: "Couldn't join", body: "The invite's pickle subsidy can't be covered right now. Tap to open the tournament." };
  }
  if (/Tournament is full/i.test(raw)) return { title: 'Tournament is full', body: 'Tap to open it and join the waitlist.' };
  if (/time has passed/i.test(raw)) return { title: 'That time has passed', body: 'Tap to open Pickleague and pick another.' };
  if (/another time/i.test(raw)) return { title: 'Already accepted', body: 'You accepted a different time for this drill.' };
  if (/no longer pending|expired|not found|Invite already/i.test(raw)) {
    return { title: 'Nothing to answer', body: 'That is no longer waiting on you.' };
  }
  if (/Pick a time|times changed/i.test(raw)) return { title: 'Pick a time', body: 'Tap to open Pickleague and choose a time.' };
  return null;
}

const rpc = (fn: string, args: Record<string, unknown>) =>
  sbCall(() => supabase.rpc(fn, args), { retries: 1, timeoutMs: 9_000 });

const BOUND = { retries: 1, timeoutMs: 9_000 };

export type ActionHandler = {
  run: (d: ActionPushData, idempotencyKey: string, r: ParsedNotificationResponse) => Promise<unknown>;
  success: NoticeCopy | ((result: unknown, d: ActionPushData) => NoticeCopy);
  queued?: NoticeCopy;
  /** Where a tap on the success notice goes. Default: the pressed push's own link. */
  link?: (d: ActionPushData, result: unknown) => string | null | undefined;
};

// ── Drill slot picks ────────────────────────────────────────────────────────
/** Accept the n-th proposed time (0-based, time order). The slot from the push
 *  rides along, so the server can refuse if the times changed since. */
function acceptSlot(index: number): ActionHandler {
  return {
    success: (res) =>
      res === 'already'
        ? { title: 'Already accepted', body: 'This drill is on. Tap to open the chat.' }
        : { title: 'Drill accepted', body: 'Tap to chat about where to play.' },
    link: (d) => (d.entity_id ? `drill_chat/${d.entity_id}` : null),
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer this request.');
      await requireUser();
      const slot = Array.isArray(d.slots) ? d.slots[index] : undefined;
      if (index > 0 && !slot) throw new NeedsApp('Open Pickleague to pick a time.');
      return rpc('accept_drill_slot', { p_request: id, p_slot_index: index, p_slot: slot ?? null });
    },
  };
}

// ── Tournaments ─────────────────────────────────────────────────────────────
type RegStatus = 'pending' | 'approved' | 'rejected' | 'waitlisted' | string;

/** "Request to join": a plain self-registration (RLS 'Users can register themselves'). */
async function requestToJoin(tournamentId: string): Promise<RegStatus> {
  const uid = await requireUser();
  try {
    const row = (await sbCall(
      () =>
        supabase
          .from('tournament_registrations')
          .insert({ tournament_id: tournamentId, user_id: uid })
          .select('status')
          .single(),
      // No retry: a retried insert that landed comes back as 23505 below anyway.
      { retries: 0, timeoutMs: 9_000 },
    )) as { status: RegStatus } | null;
    return row?.status ?? 'pending';
  } catch (e) {
    // unique(tournament_id, user_id): a replay, or an older row (e.g. a
    // rejected request). Report the row's real status, not "Request sent".
    if ((e as { code?: string })?.code !== '23505' && !/duplicate key/i.test(message(e))) throw e;
    const mine = (await sbCall(
      () =>
        supabase
          .from('tournament_registrations')
          .select('status')
          .eq('tournament_id', tournamentId)
          .eq('user_id', uid)
          .maybeSingle(),
      BOUND,
    )) as { status: RegStatus } | null;
    return `already:${mine?.status ?? 'pending'}`;
  }
}

function requestNotice(res: unknown): NoticeCopy {
  const s = String(res);
  if (s === 'waitlisted' || s === 'already:waitlisted') {
    return { title: "You're on the waitlist", body: 'The tournament is full. The admin reviews the waitlist.' };
  }
  if (s === 'already:approved' || s === 'approved') return { title: "You're in", body: 'You are already registered.' };
  if (s === 'already:rejected') return { title: 'Not this time', body: 'The admin already turned this request down.' };
  if (s.startsWith('already:')) return { title: 'Already requested', body: 'The admin will review your request.' };
  return { title: 'Request sent', body: 'The admin will review it. The entry fee is charged only if you are approved.' };
}

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
    success: (res) =>
      res === 'already'
        ? { title: 'Already confirmed', body: 'This match is recorded.' }
        : { title: 'Match confirmed', body: 'Ratings update shortly.' },
    // Raises (not an error code) for a match that lapsed or was already
    // settled. A replay after the first press completed it is "already", not
    // "Nothing to answer"; a lapsed match stays "no longer waiting on you".
    run: async (d) => {
      const matchId = needs(d.entity_id, 'Open Pickleague to confirm this match.');
      const uid = await requireUser();
      try {
        await rpc('confirm_match', { p_match_id: matchId });
        return 'confirmed';
      } catch (e) {
        if (!/no longer pending/i.test(message(e))) throw e;
        const m = (await sbCall(
          () =>
            supabase
              .from('matches')
              .select('status, player1_id, partner1_id, player2_id, partner2_id, team1_confirmed_by, team2_confirmed_by')
              .eq('id', matchId)
              .maybeSingle(),
          BOUND,
        )) as Record<string, string | null> | null;
        const onTeam1 = !!m && (m.player1_id === uid || m.partner1_id === uid);
        const mine = onTeam1 ? m?.team1_confirmed_by : m?.team2_confirmed_by;
        if (m?.status === 'completed' && mine) return 'already';
        throw e;
      }
    },
  },
  drill_accept: acceptSlot(0),
  drill_slot_1: acceptSlot(0),
  drill_slot_2: acceptSlot(1),
  drill_slot_3: acceptSlot(2),
  drill_decline: {
    success: (res) =>
      res === 'already' ? { title: 'Already declined', body: 'We let them know.' } : { title: 'Declined', body: 'We let them know.' },
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to answer this request.');
      await requireUser();
      return rpc('respond_drill_request', { p_request: id, p_accept: false });
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
  // Reply from the lock screen. The idempotency key goes in client_key
  // (unique), so a replayed press lands once.
  drill_reply: {
    success: (res) => ({ title: 'Sent', body: typeof res === 'string' && res ? res : 'Your reply is in the chat.' }),
    link: (d) => (d.entity_id ? `drill_chat/${d.entity_id}` : null),
    run: async (d, key, r) => {
      const requestId = needs(d.entity_id, 'Open Pickleague to reply.');
      const body = (r.text ?? '').trim();
      if (!body) throw new NeedsApp('Type a message to reply.', `drill_chat/${requestId}`);
      const uid = await requireUser();
      await insertIgnoringDuplicate(
        supabase
          .from('drill_request_messages')
          .insert({ request_id: requestId, sender_id: uid, body: body.slice(0, 1000), client_key: key }),
      );
      return body.length > 80 ? `${body.slice(0, 77)}...` : body;
    },
  },
  tournament_accept: {
    success: (res) =>
      res === 'already'
        ? { title: "You're in", body: 'You already accepted this invite.' }
        : { title: "You're in", body: 'Invite accepted.' },
    run: async (d) => {
      const id = needs(d.registration_id, 'Open Pickleague to answer this invite.');
      await requireUser();
      try {
        await rpc('tournament_respond_to_invite', { p_registration_id: id, p_accept: true });
        return 'accepted';
      } catch (e) {
        // A replay after the first tap worked: the invite is already approved.
        if (/Invite already approved/i.test(message(e))) return 'already';
        throw e;
      }
    },
  },
  tournament_decline: {
    success: (res) =>
      res === 'already'
        ? { title: 'Declined', body: 'You already declined this invite.' }
        : { title: 'Declined', body: 'We let the organizer know.' },
    run: async (d) => {
      const id = needs(d.registration_id, 'Open Pickleague to answer this invite.');
      await requireUser();
      try {
        await rpc('tournament_respond_to_invite', { p_registration_id: id, p_accept: false });
        return 'declined';
      } catch (e) {
        // Caught before mapError, whose /Invite already/ would say "Nothing to answer".
        const raw = message(e);
        if (/Invite already rejected/i.test(raw)) return 'already';
        if (/Invite already approved/i.test(raw)) throw new NeedsApp('You already accepted. Open the tournament to withdraw.');
        throw e;
      }
    },
  },
  tournament_request_join: {
    success: (res) => requestNotice(res),
    run: async (d) => {
      const id = needs(d.entity_id, 'Open Pickleague to request a spot.');
      return requestToJoin(id);
    },
  },
  league_join: {
    success: (res) => {
      const r = res as { already?: boolean; leagueName?: string | null };
      const name = r?.leagueName ? ` ${r.leagueName}` : ' the league';
      return r?.already ? { title: 'Already a member', body: `You're in${name}.` } : { title: 'Joined', body: `Welcome to${name}!` };
    },
    link: (_d, res) => {
      const id = (res as { leagueId?: string } | null)?.leagueId;
      return id ? `league/${id}` : null;
    },
    run: async (d) => {
      const code = needs(d.invite_code, 'Open Pickleague to join with the code.');
      await requireUser();
      const res = await redeemLeagueInvite(code);
      if (!res.joined) throw new NeedsApp(res.message, `invite_code/${code}`);
      return res;
    },
  },
};

/** Feature modules (court check-in, play session) add their buttons here. */
export function registerActionHandler(actionId: string, h: ActionHandler): void {
  HANDLERS[actionId] = h;
}

/** True when the app has a handler for this button (tests: every catalog write button). */
export function hasActionHandler(actionId: string): boolean {
  return actionId in HANDLERS;
}

/** Perform the write behind a pressed button. Never throws. */
export async function handleNotificationAction(r: ParsedNotificationResponse): Promise<void> {
  const h = r.action ? HANDLERS[r.action] : undefined;
  if (!h) return;
  const d = r.data as ActionPushData;
  const pushLink = linkOf(r.data);
  await runNotificationAction((key) => h.run(d, key, r), {
    idempotencyKey: r.idempotencyKey,
    // Every notice opens what the push was about (overridden per notice below).
    noticeData: pushLink ? { deepLink: pushLink } : undefined,
    success: (result) => {
      const copy = typeof h.success === 'function' ? h.success(result, d) : h.success;
      let link: string | null | undefined;
      try {
        link = h.link?.(d, result);
      } catch {
        link = null;
      }
      return link ? { ...copy, data: { ...(copy.data ?? {}), deepLink: link } } : copy;
    },
    queued: h.queued,
    timedOut: TIMED_OUT,
    failure: FAILED,
    mapError,
  });
}
