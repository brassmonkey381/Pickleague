// Play and check-in, merged (the user, 2026-10-24: "go merge play and
// check-in"): every check-in this device makes starts the play session timer,
// a check-out ends it (and the end sheet asks "Record a match or drill?"), and
// a taken-back arrival drops its session. The rules are in
// ./checkinPlayRules; this file wires them to lib/courtCheckin's signals.
// Imported once for its side effects (components/PlayIsland).
//
// The server does the same on its own once
// supabase/migration_checkin_starts_session.sql is live (an arrival's session
// included, which this device learns on its next resume). Before that, this
// is what starts and ends the session: Start goes out with the check-in's own
// id, which the migrated server answers as a replay of its session.
import { arrivalTakenBack, checkedInHere, checkedOutHere, checkOut, peekCurrentCheckin } from './courtCheckin';
import { endPlay, playSession, startPlay, type PlayMeta } from './playSession';
import { setCheckoutInFlight } from './checkinHost';
import {
  checkinToCloseWithEnd,
  checkoutEndsPlay,
  onCheckedIn,
  takeBackClearsPlay,
  type RunningPlay,
} from './checkinPlayRules';

function running(): RunningPlay {
  const s = playSession.get();
  if (!s.id || s.status === 'idle') return null;
  const meta = s.meta as PlayMeta | undefined;
  return { id: s.id, venueId: meta?.venueId ?? null, startedAtMs: s.startedAtMs ?? null };
}

checkedInHere.subscribe((c) => {
  const next = onCheckedIn({ play: running(), checkin: { id: c.id, venueId: c.venueId, source: c.source } });
  if (!next) return;
  if (next.kind === 'adopt') {
    // The timer gains the court (the server links it to this check-in).
    playSession.patchMeta({ venueId: c.venueId, venueName: c.venueName });
    return;
  }
  // Checked in at another court while a session ran: the server ended that
  // one (this check-in closed its court's), or ends it when the Start below
  // lands. No end sheet for it: the player moved on, and its end is the
  // server's. The island drops it and shows this court's.
  if (next.kind === 'switch') playSession.clear();
  startPlay({
    id: next.id,
    kind: 'open_play',
    sourceId: null,
    venueId: c.venueId,
    venueName: c.venueName,
    // Checked in at this court just now: the server adopts that check-in.
    viaCheckin: true,
    startedAtMs: c.checkedInAt ? Date.parse(c.checkedInAt) : undefined,
  });
});

checkedOutHere.subscribe((out) => {
  if (checkoutEndsPlay({ play: running(), checkout: out })) endPlay();
});

arrivalTakenBack.subscribe(({ venueId }) => {
  if (takeBackClearsPlay({ play: running(), venueId, nowMs: Date.now() })) playSession.clear();
});

/**
 * The island's Check out (= End): ends the session now (the end sheet takes
 * it from there) and checks out of my check-in, unless End closes it itself
 * (a Start's own check-in). The check-out runs behind it, bounded by
 * lib/courtCheckin (a queued one goes when the signal comes back); while it
 * runs, the check-in island and the bar leave that check-in out (lib/checkinHost
 * checkoutInFlight). `error`: the check-out was refused (still checked in, so
 * the check-in shows again), for the island to say why.
 */
export async function checkOutAndEnd(): Promise<{
  ended: boolean;
  checkedOut: boolean;
  venueName: string | null;
  error?: unknown;
}> {
  const s = playSession.get();
  const sessionId = s.id;
  const cur = await peekCurrentCheckin();
  // A check-in still queued is checked out behind it (lib/courtCheckin checkOut).
  const closeId = sessionId && cur ? checkinToCloseWithEnd({ sessionId, checkin: cur }) : null;
  const venueName = cur?.venueName ?? null;
  // Hidden before the session clears, so the check-in island never flashes in.
  if (closeId) setCheckoutInFlight(closeId);
  const ended = !!endPlay();
  if (!closeId) return { ended, checkedOut: false, venueName };
  try {
    await checkOut(closeId);
    return { ended, checkedOut: true, venueName };
  } catch (error) {
    return { ended, checkedOut: false, venueName, error };
  } finally {
    setCheckoutInFlight(null);
  }
}
