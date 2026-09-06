// Notification action buttons — answering a push without opening the app.
//
// Shape of the thing, end to end:
//   1. A `notifications` row is inserted (by a trigger or a generator).
//   2. `send-push` resolves an ACTION CATEGORY for it and puts `categoryId` on
//      the Expo message, plus whatever context the buttons will need in `data`.
//   3. This module has registered that category id with the OS, so iOS/Android
//      know which buttons to draw.
//   4. Pressing one delivers a response carrying `actionIdentifier`, which
//      `handleNotificationAction` below turns into a write.
//
// All four steps must agree on the identifier strings, so they live here and
// send-push mirrors them (there is no shared module across the DB/app boundary
// — if you rename one, grep for it in supabase/functions/send-push).
//
// This is entirely JS: categories are registered at runtime, so the whole
// feature ships over the air with no native rebuild.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

// ── Identifiers ────────────────────────────────────────────────────────────
export const CATEGORY_EVENT_VOTE = 'event_vote';
export const CATEGORY_EVENT_CONFIRMED = 'event_confirmed';
export const CATEGORY_MATCH_CONFIRM = 'match_confirm';

export const ACTION_EVENT_ACCEPT = 'event_accept';
export const ACTION_EVENT_DECLINE = 'event_decline';
export const ACTION_MATCH_CONFIRM = 'match_confirm';

/**
 * Register every action category with the OS.
 *
 * Safe and cheap to call on every launch — it overwrites by identifier rather
 * than accumulating. Must run BEFORE a push arrives, which is why it is fired
 * at startup rather than lazily: a notification naming an unregistered category
 * simply renders with no buttons, silently.
 */
export async function registerNotificationCategories(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.setNotificationCategoryAsync(CATEGORY_EVENT_VOTE, [
      {
        identifier: ACTION_EVENT_DECLINE,
        buttonTitle: "Can't make it",
        // Handled in the background — the entire point is not to open the app.
        options: { opensAppToForeground: false },
      },
    ]);

    // A confirmed event has exactly one time (league_events.confirmed_slot_id),
    // so "I'm in" is unambiguous here. During VOTING it is not — there are
    // several proposed slots and no way to say which one a single tap means —
    // which is why the voting category offers only the decline. Picking a time
    // needs the screen, and the plain tap already goes there.
    await Notifications.setNotificationCategoryAsync(CATEGORY_EVENT_CONFIRMED, [
      {
        identifier: ACTION_EVENT_ACCEPT,
        buttonTitle: "I'm in",
        options: { opensAppToForeground: false },
      },
      {
        identifier: ACTION_EVENT_DECLINE,
        buttonTitle: "Can't make it",
        options: { opensAppToForeground: false },
      },
    ]);
    // Confirm only. There is no reject RPC — the decline path is simply
    // letting it lapse, after which expire_pending_matches() deletes the row.
    // A "Dispute" button would have nothing to call.
    await Notifications.setNotificationCategoryAsync(CATEGORY_MATCH_CONFIRM, [
      {
        identifier: ACTION_MATCH_CONFIRM,
        buttonTitle: 'Confirm',
        options: { opensAppToForeground: false },
      },
    ]);
  } catch {
    // Worst case the notifications arrive with no buttons. Never worth a crash.
  }
}

// ── Handling ───────────────────────────────────────────────────────────────

export type ActionPushData = {
  entity_type?: string | null;
  entity_id?: string | null;
  /** Sent by send-push for event pushes so "I'm in" knows which slot to vote for. */
  confirmed_slot_id?: string | null;
  title?: string;
};

/** How long a background action gets before we give up and tell the user. */
const ACTION_TIMEOUT_MS = 10_000;

/**
 * Tell the user, on the notification shade, that their tap did NOT take effect.
 *
 * This matters more than it looks. A background action has no UI, so a failed
 * write is invisible — the user believes they declined an event they are still
 * on the roster for. Silence is the dangerous outcome here, not noise.
 */
async function reportFailure(body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: "That didn't save", body, sound: 'default' },
      trigger: null,
    });
  } catch {
    /* if even this fails there is nothing left to try */
  }
}

/**
 * Plain INSERT, treating a duplicate as success.
 *
 * NOT an upsert, deliberately — and this was verified against production, not
 * assumed. Neither event_slot_votes nor event_declines has an UPDATE policy
 * (only INSERT / SELECT / DELETE), so `ON CONFLICT DO UPDATE` fails with 42501
 * "new row violates row-level security policy" the moment the row already
 * exists. That is the COMMON case here: pressing the same button twice, or
 * responding again to a repeated reminder.
 *
 * A plain insert returns 23505 instead, which from the user's point of view is
 * not a failure at all — their answer is already recorded. Same reasoning, and
 * the same shape, as submitReport() in lib/moderation.
 */
async function insertIgnoringDuplicate(
  run: () => PromiseLike<{ data: unknown; error: { code?: string } | null }>,
): Promise<void> {
  try {
    await sbCall(run, { retries: 1, timeoutMs: ACTION_TIMEOUT_MS });
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') return;
    throw e;
  }
}

async function acceptEvent(data: ActionPushData, userId: string): Promise<void> {
  const slotId = data.confirmed_slot_id;
  if (!slotId) {
    await reportFailure('Open Pickleague to pick a time for this event.');
    return;
  }
  // Voting is all that is needed to undo a previous decline: a DB trigger
  // clears the opposite side either way.
  await insertIgnoringDuplicate(() =>
    supabase.from('event_slot_votes').insert({ slot_id: slotId, user_id: userId }),
  );
}

/**
 * Confirm a pending match.
 *
 * Unlike the event writes this is an RPC, and it raises rather than returning
 * an error code — 'Match is no longer pending', 'Confirmation window has
 * expired', 'Match not found'. Those are all REACHABLE from a notification that
 * has been sitting in the shade: the confirm window is an hour, and
 * expire_pending_matches() deletes lapsed rows every minute. So the message is
 * surfaced verbatim rather than swallowed — "that match expired" is genuinely
 * what the user needs to know, and inventing a friendlier lie would leave them
 * thinking a match got recorded when it did not.
 */
async function confirmMatch(data: ActionPushData, _userId: string): Promise<void> {
  const matchId = data.entity_id;
  if (!matchId) {
    await reportFailure('Open Pickleague to confirm this match.');
    return;
  }
  try {
    await sbCall(() => supabase.rpc('confirm_match', { p_match_id: matchId }), {
      retries: 1,
      timeoutMs: ACTION_TIMEOUT_MS,
    });
  } catch (e) {
    const raw = (e as { message?: string })?.message ?? '';
    if (/no longer pending|expired|not found/i.test(raw)) {
      await reportFailure('That match is no longer waiting on you.');
      return;
    }
    throw e;
  }
}

async function declineEvent(data: ActionPushData, userId: string): Promise<void> {
  const eventId = data.entity_id;
  if (!eventId) {
    await reportFailure('Open Pickleague to respond to this event.');
    return;
  }
  await insertIgnoringDuplicate(() =>
    supabase.from('event_declines').insert({ event_id: eventId, user_id: userId }),
  );
}

/**
 * Perform the write behind a pressed button.
 *
 * Returns true when the response was an action we handled, so the caller knows
 * NOT to also deep-link — a plain tap opens the screen, a button press must not.
 *
 * Runs in a background launch, where nothing is mounted and there is no
 * navigator, no theme and no toast. It must therefore depend on nothing but
 * Supabase, and it must never throw: an uncaught rejection here happens with no
 * one watching.
 */
export async function handleNotificationAction(
  actionIdentifier: string,
  data: ActionPushData,
): Promise<boolean> {
  if (
    actionIdentifier !== ACTION_EVENT_ACCEPT &&
    actionIdentifier !== ACTION_EVENT_DECLINE &&
    actionIdentifier !== ACTION_MATCH_CONFIRM
  ) {
    return false;
  }

  try {
    // LOCAL session read. getUser() is a network round trip and this may be
    // running on a cold background launch with a slow connection.
    const userId = await currentUserId(supabase);
    if (!userId) {
      await reportFailure('Sign in to Pickleague to respond.');
      return true;
    }

    if (actionIdentifier === ACTION_EVENT_ACCEPT) await acceptEvent(data, userId);
    else if (actionIdentifier === ACTION_MATCH_CONFIRM) await confirmMatch(data, userId);
    else await declineEvent(data, userId);
  } catch {
    await reportFailure('Tap to open Pickleague and try again.');
  }
  return true;
}
