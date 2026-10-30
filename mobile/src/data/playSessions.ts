// Live play sessions ("I'm playing right now"). Wrappers over the RPCs in
// supabase/migration_play_sessions.sql and the presence migration
// (docs/play-sessions-presence-api.md); both writes are idempotent (client id,
// end only closes an open row), so they may be retried or queued.
//
// A session at a court is presence: with a fix that confirms the court, the
// server also checks me in there (a 'session' check-in with the session's id,
// or it adopts the check-in I already had), and End closes only the one it
// opened. Without a fix it is just my timer. End is the check-out of that
// check-in, so it may carry the fix taken at the tap (the stay proof, Phase 1.5).
import { classifySbError, sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { checkoutFixArgs, fixArgs, type DeviceFix } from '../lib/courtCheckinRules';
import type { SessionValidity } from '../lib/sessionValidity';
import { parsePlayHistory, PLAY_HISTORY_PAGE, type PlayHistoryRow } from '../lib/playHistory';
import { parseAbsoluteWindows, type AbsoluteTimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { PLAY_MODES, type PlayMode } from '../lib/courtRoutineRules';
import { parseGroupSession, type GroupKind, type GroupSession } from '../lib/groupSessionRules';

export { PLAY_HISTORY_PAGE };

/** 'event' and 'tournament': a group session, source_id the league event or
 *  tournament (supabase/migration_group_sessions.sql). */
export type PlayKind = 'open_play' | 'drill' | 'match' | 'event' | 'tournament';

export type PlaySessionRow = {
  id: string;
  user_id: string;
  kind: PlayKind;
  source_id: string | null;
  venue_id: string | null;
  started_at: string;
  ended_at: string | null;
};

const BOUND = { timeoutMs: 9_000 };

export async function startPlaySession(p: {
  id: string;
  kind: PlayKind;
  sourceId?: string | null;
  venueId?: string | null;
  at?: string;
  /** The fix taken at Start; it decides whether the session checks me in at `venueId`. */
  fix?: DeviceFix | null;
}): Promise<PlaySessionRow> {
  return sbCall(
    () =>
      supabase.rpc('start_play_session', {
        p_id: p.id,
        p_kind: p.kind,
        p_source: p.sourceId ?? null,
        p_venue: p.venueId ?? null,
        p_at: p.at ?? null,
        ...fixArgs(p.venueId ? p.fix : null, Date.now()),
      }),
    BOUND,
  ) as Promise<PlaySessionRow>;
}

/**
 * End my session (and the check-in it opened). `fix`, taken at the tap, is
 * that check-in's stay proof: the same optional arguments as checkout_venue,
 * its age measured at each send. Without a fix: the Phase 1 call shape
 * ({p_id, p_at}). A server without the Phase 1.5 SQL doesn't know the fix
 * arguments (PGRST202): the End then goes again without them, so it never
 * fails for the sake of the fix.
 */
export async function endPlaySession(id: string, at?: string, fix?: DeviceFix | null): Promise<number> {
  const base = { p_id: id, p_at: at ?? null };
  const call = (withFix: boolean) =>
    sbCall(
      () => supabase.rpc('end_play_session', withFix ? { ...base, ...checkoutFixArgs(fix, Date.now()) } : base),
      BOUND,
    ) as Promise<number>;
  if (!fix) return call(false);
  try {
    return await call(true);
  } catch (e) {
    if (classifySbError(e) === 'missingFunction') return call(false);
    throw e;
  }
}

/**
 * Whether my session counts (Phase 1.5, supabase/migration_validity_rules.sql)
 * and what it still needs. Null when it isn't mine or isn't on the server yet
 * (its Start still queued). lib/sessionValidity words it.
 */
export async function getMySessionValidity(id: string): Promise<SessionValidity | null> {
  return ((await sbCall(() => supabase.rpc('my_session_validity', { p_session: id }), BOUND)) ??
    null) as SessionValidity | null;
}

/** One of my sessions by id (owner-only read), open or ended; null when the server has none. */
export async function getMyPlaySession(id: string): Promise<PlaySessionRow | null> {
  return ((await sbCall(
    () =>
      supabase
        .from('play_sessions')
        .select('id, user_id, kind, source_id, venue_id, started_at, ended_at')
        .eq('id', id)
        .maybeSingle(),
    BOUND,
  )) ?? null) as PlaySessionRow | null;
}

/**
 * The check-in one of my sessions belongs to (play_sessions.checkin_id,
 * supabase/migration_checkin_starts_session.sql), or null: none, or a server
 * without that column yet (the read is refused, and there is nothing to tell
 * then). No signal throws, so the caller can ask again later.
 */
export async function getMyPlaySessionCheckinId(id: string): Promise<string | null> {
  try {
    const row = (await sbCall(
      () => supabase.from('play_sessions').select('checkin_id').eq('id', id).maybeSingle(),
      BOUND,
    )) as { checkin_id?: string | null } | null;
    return row?.checkin_id ?? null;
  } catch (e) {
    if (classifySbError(e) === 'network') throw e;
    return null;
  }
}

/** My open session started in the last 6 hours, or null. */
export async function getMyActivePlaySession(userId: string): Promise<PlaySessionRow | null> {
  const rows = (await sbCall(
    () =>
      supabase
        .from('play_sessions')
        .select('id, user_id, kind, source_id, venue_id, started_at, ended_at')
        .eq('user_id', userId)
        .is('ended_at', null)
        .gt('started_at', new Date(Date.now() - 6 * 3600_000).toISOString())
        .order('started_at', { ascending: false })
        .limit(1),
    BOUND,
  )) as PlaySessionRow[] | null;
  return rows?.[0] ?? null;
}

export type UpcomingPlay = { kind: 'drill' | 'match'; id: string; startsAt: string; title: string };

/** My drill sessions and scheduled matches starting in the next 7 days (max 10). */
export async function getMyUpcomingPlay(userId: string): Promise<UpcomingPlay[]> {
  const now = new Date();
  const until = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const [drills, matches] = await Promise.all([
    sbCall(
      () =>
        supabase
          .from('drill_sessions')
          .select('id, starts_at')
          .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
          .gt('starts_at', now.toISOString())
          .lt('starts_at', until)
          .order('starts_at')
          .limit(10),
      BOUND,
    ) as Promise<{ id: string; starts_at: string }[] | null>,
    sbCall(
      () =>
        supabase
          .from('matches')
          .select('id, scheduled_at')
          .eq('status', 'scheduled')
          .or(`player1_id.eq.${userId},player2_id.eq.${userId},partner1_id.eq.${userId},partner2_id.eq.${userId}`)
          .gt('scheduled_at', now.toISOString())
          .lt('scheduled_at', until)
          .order('scheduled_at')
          .limit(10),
      BOUND,
    ) as Promise<{ id: string; scheduled_at: string }[] | null>,
  ]);
  return [
    ...(drills ?? []).map((d) => ({ kind: 'drill' as const, id: d.id, startsAt: d.starts_at, title: 'Drill session' })),
    ...(matches ?? []).map((m) => ({ kind: 'match' as const, id: m.id, startsAt: m.scheduled_at, title: 'Scheduled match' })),
  ]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 10);
}

// ── Session history and Discard (supabase/migration_play_session_history.sql) ──

export type { PlayHistoryRow } from '../lib/playHistory';

/**
 * My ended sessions, newest first: a page of PLAY_HISTORY_PAGE, the next one
 * started before `before` (the last row's startedAt). Throws as sbCall does;
 * a server without the history SQL throws 'missingFunction' (the screen says
 * it isn't ready yet).
 */
export async function listMyPlaySessions(before?: string | null): Promise<PlayHistoryRow[]> {
  return parsePlayHistory(
    await sbCall(
      () => supabase.rpc('list_my_play_sessions', { p_before: before ?? null, p_limit: PLAY_HISTORY_PAGE }),
      BOUND,
    ),
  );
}

/**
 * Discard one of my ENDED sessions: it leaves the history and never counts.
 * 1, or 0 when it was discarded already (a retry). Refusals (lib/refusals):
 * session.gone, session.open, session.not_yours.
 */
export async function discardPlaySession(id: string): Promise<number> {
  return ((await sbCall(() => supabase.rpc('discard_play_session', { p_id: id }), BOUND)) ?? 0) as number;
}

/**
 * The closed group / open play / drill windows one of my sessions ran under:
 * its check-in's play_windows (absolute). Empty when it had no check-in, the
 * check-in said no windows, or the read fails: the card then says the
 * session's own kind.
 */
export async function getSessionPlayWindows(sessionId: string): Promise<AbsoluteTimeWindow<PlayMode>[]> {
  try {
    const checkinId = await getMyPlaySessionCheckinId(sessionId);
    if (!checkinId) return [];
    const row = (await sbCall(
      () => supabase.from('venue_checkins').select('play_windows').eq('id', checkinId).maybeSingle(),
      BOUND,
    )) as { play_windows?: unknown } | null;
    return parseAbsoluteWindows(row?.play_windows ?? null, PLAY_MODES);
  } catch {
    return [];
  }
}

/** A match row for a play session's share card (lib/shareCards sessionTally), with the players' names. */
export type SessionShareMatch = import('../lib/shareCards').SessionMatchIn & {
  player1: { id: string; full_name: string | null; deleted_at?: string | null } | null;
  partner1: { id: string; full_name: string | null; deleted_at?: string | null } | null;
  player2: { id: string; full_name: string | null; deleted_at?: string | null } | null;
  partner2: { id: string; full_name: string | null; deleted_at?: string | null } | null;
};

/**
 * Completed matches that may belong to one of my ended sessions: linked to it,
 * or recorded between its start and two hours after its end. sessionTally
 * picks mine and the ones that count.
 */
export async function listSessionShareMatches(row: { id: string; startedAt: string; endedAt: string }): Promise<SessionShareMatch[]> {
  const end = new Date(Date.parse(row.endedAt) + 2 * 60 * 60 * 1000).toISOString();
  const data = await sbCall(
    () => supabase
      .from('matches')
      .select(`status, winner_team, player1_id, partner1_id, player2_id, partner2_id, play_session_id, created_at,
        player1:profiles!matches_player1_id_fkey(id, full_name, deleted_at),
        partner1:profiles!matches_partner1_id_fkey(id, full_name, deleted_at),
        player2:profiles!matches_player2_id_fkey(id, full_name, deleted_at),
        partner2:profiles!matches_partner2_id_fkey(id, full_name, deleted_at)`)
      .eq('status', 'completed')
      .or(`play_session_id.eq.${row.id},and(created_at.gte."${row.startedAt}",created_at.lte."${end}")`)
      .limit(50),
    BOUND,
  );
  return (data ?? []) as unknown as SessionShareMatch[];
}

// ── Group sessions (supabase/migration_group_sessions.sql) ──────────────────

/**
 * Who played in an event's or tournament's group session today, one row per
 * player, playing now first; can_view false for anyone not in it. Blocks are
 * hidden by the server. Throws as sbCall does (missingFunction before the SQL).
 */
export async function listGroupSession(kind: GroupKind, id: string): Promise<GroupSession> {
  return parseGroupSession(
    await sbCall(() => supabase.rpc('list_group_session', { p_kind: kind, p_id: id }), BOUND),
  );
}

/**
 * "Let everyone know": tell the people going that my group session started.
 * Only for my own open event or tournament session; the server skips anyone
 * told in the last 2 hours. Returns how many were told. No retry: a second
 * call would tell nobody new anyway.
 */
export async function notifyGroupSession(sessionId: string): Promise<number> {
  return Number(
    (await sbCall(() => supabase.rpc('notify_group_session', { p_session_id: sessionId }), { ...BOUND, retries: 0 })) ?? 0,
  );
}
