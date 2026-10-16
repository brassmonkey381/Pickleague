// Sign-out ends presence (docs/play-sessions-presence.md, Phase 1 item 9).
// Without this the server row keeps showing me "here" for up to 4 hours after
// I sign out, because the SIGNED_OUT handler (navigation/AppNavigator) only
// clears local state, and by then the session that could close it is gone.
//
// So callers run this BEFORE signOutSafely, under the account that is signing
// out: close every open check-in (any source) and end the open play session,
// at the real time. Best-effort: each call is bounded to 3 s, they run in
// parallel, nothing is queued (the queue is cleared on account change), and it
// never throws, so it can never block or fail a sign-out. When a close this
// device knows was needed doesn't land, the player is told what stays open
// and until when (rule 11: no silent failure; lib/refusalNotices shows it on
// the sign-in screen, or as a notification).
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { playSession } from './playSession';
import { peekCurrentCheckin } from './courtCheckin';
import { noteRefusalNotice } from './refusalNotices';
import { whenLabel } from './refusals';
import { checkoutVenue } from '../data/venueCheckins';
import { endPlaySession, getMyActivePlaySession } from '../data/playSessions';

const BOUND_MS = 3_000;

async function endOpenSession(at: string): Promise<void> {
  // The island's session, else one this account left open elsewhere.
  let id = playSession.get().id;
  if (!id) {
    const uid = await currentUserId(supabase);
    id = uid ? ((await getMyActivePlaySession(uid))?.id ?? null) : null;
  }
  if (id) await endPlaySession(id, at);
}

export async function endPresenceForSignOut(): Promise<void> {
  const at = new Date().toISOString();
  // What this device knows is open, for the notice if a close doesn't land.
  const checkin = await peekCurrentCheckin().catch(() => null);
  const session = playSession.get();
  const sessionStartMs = session.id && session.status !== 'idle' ? session.startedAtMs : null;
  const [outOk, endOk] = await Promise.all([
    // p_id null closes all of my open check-ins; p_source null: whatever opened them.
    withTimeout(checkoutVenue(null, null, at), BOUND_MS).then(
      () => true,
      () => false,
    ),
    withTimeout(endOpenSession(at), BOUND_MS).then(
      () => true,
      () => false,
    ),
  ]);
  const lines: string[] = [];
  if (!outOk && checkin && !checkin.queued) {
    lines.push(
      `Pickleague couldn't check you out of ${checkin.venueName}, so you may still show there until ${whenLabel(new Date(checkin.expiresAt))}.`,
    );
  }
  if (!endOk && sessionStartMs != null) {
    lines.push(
      `Your play session couldn't be ended, so it ends on its own at ${whenLabel(new Date(sessionStartMs + 6 * 3_600_000))}.`,
    );
  }
  if (lines.length === 0) return;
  await noteRefusalNotice({
    key: `signout:${at}`,
    title: 'Signed out',
    body: `Signed out. ${lines.join(' ')} Sign in again and check out to end it sooner.`,
  }).catch(() => {});
}
