// Guest vote links (g/<token>) need an account to vote
// (supabase/migration_guest_votes_need_account.sql). Signed out, the link page
// shows the event and its times and keeps the token here; after sign-up and
// the first sign-in (often after confirming the email), deliverGuestVote joins
// the invite's league and opens the vote.
import { createReferralStash } from '@just-messin-around/expo-foundation/referrals';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { WEEK_MS } from '@just-messin-around/expo-foundation/cache';
import { supabase } from './supabase';
import { navigateWhenReady } from './navigationRef';

/** The pending invite token on this device, from link open to the first sign-in. A link lasts 7 days. */
export const guestVoteStash = createReferralStash({ key: 'pickleague:pendingGuestVote', maxAgeMs: WEEK_MS });

export type GuestSlot = { starts_at: string; ends_at: string };

export type JoinedInvite = { event_id: string; event_title: string | null };

/** The event's times, signed out. Empty on any miss (the page still offers the sign-up). */
export async function getGuestInviteSlots(token: string): Promise<GuestSlot[]> {
  try {
    const data = await sbCall(() => supabase.rpc('get_guest_invite_slots', { p_token: token }));
    return Array.isArray(data) ? (data as GuestSlot[]) : [];
  } catch {
    return [];
  }
}

/** Join the invite's league as the signed-in account, so its event can be voted on. Throws the server's refusal. */
export async function joinGuestInvite(token: string): Promise<JoinedInvite | null> {
  const data = await sbCall(() => supabase.rpc('join_guest_invite', { p_token: token }), { retries: 2 });
  const row = (Array.isArray(data) ? data[0] : data) as JoinedInvite | undefined;
  return row?.event_id ? row : null;
}

/**
 * After sign-in: a link opened signed out lands on its vote. A guest
 * (anonymous) session leaves the token for the account it upgrades to.
 * Never throws; an expired or refused link is dropped.
 */
export async function deliverGuestVote(isAnonymous: boolean): Promise<void> {
  if (isAnonymous) return;
  const token = await guestVoteStash.take();
  if (!token) return;
  try {
    const row = await joinGuestInvite(token);
    if (row) navigateWhenReady('EventDetail', { eventId: row.event_id, title: row.event_title ?? 'Event' });
  } catch {
    // The link expired or was turned off; nothing to open.
  }
}
