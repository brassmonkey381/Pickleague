// Sign-out ends presence (docs/play-sessions-presence.md, Phase 1 item 9).
// Without this the server row keeps showing me "here" for up to 4 hours after
// I sign out, because the SIGNED_OUT handler (navigation/AppNavigator) only
// clears local state, and by then the session that could close it is gone.
//
// So callers run this BEFORE signOutSafely, under the account that is signing
// out: close every open check-in (any source) and end the open play session,
// at the real time. Best-effort: each call is bounded to 3 s, they run in
// parallel, nothing is queued (the queue is cleared on account change), and it
// never throws, so it can never block or fail a sign-out.
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { playSession } from './playSession';
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
  await Promise.all([
    // p_id null closes all of my open check-ins; p_source null: whatever opened them.
    withTimeout(checkoutVenue(null, null, at), BOUND_MS).catch(() => {}),
    withTimeout(endOpenSession(at), BOUND_MS).catch(() => {}),
  ]);
}
