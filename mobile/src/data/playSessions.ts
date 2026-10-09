// Live play sessions ("I'm playing right now"). Wrappers over the RPCs in
// supabase/migration_play_sessions.sql; both writes are idempotent (client id,
// end only closes an open row), so they may be retried or queued.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

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
}): Promise<PlaySessionRow> {
  return sbCall(
    () =>
      supabase.rpc('start_play_session', {
        p_id: p.id,
        p_kind: p.kind,
        p_source: p.sourceId ?? null,
        p_venue: p.venueId ?? null,
        p_at: p.at ?? null,
      }),
    BOUND,
  ) as Promise<PlaySessionRow>;
}

export async function endPlaySession(id: string, at?: string): Promise<number> {
  return sbCall(() => supabase.rpc('end_play_session', { p_id: id, p_at: at ?? null }), BOUND) as Promise<number>;
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
