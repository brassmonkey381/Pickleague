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

export type PlayKind = 'open_play' | 'drill' | 'match' | 'event';

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
