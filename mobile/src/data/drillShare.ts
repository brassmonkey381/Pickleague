// What a drill share card needs (PKL-013, lib/shareCards drillCardModel):
// the drill (my partner, when), its timer (the play session of kind drill:
// how long, where), my review of it, the shots I'm working on, and my
// drilling lately (play sessions of kind drill, the last DRILL_WEEKS weeks).
// Reached from a drill session in Play history (a play session id) or right
// after reviewing a drill (a drill session id). Every part is optional: a part
// that fails to load leaves its line off the card.
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { cardPlayer } from '../lib/finishShare';
import { DRILL_WEEKS, drillStats, minutesBetween, type DrillShareData } from '../lib/shareCards';
import { playHistoryDay } from '../lib/playHistory';
import { findShotPref } from './drillOptions';

const BOUND = { timeoutMs: 9_000 };

type PlayRow = { id: string; kind: string; source_id: string | null; venue_id: string | null; started_at: string; ended_at: string | null };

const FACETS = [
  ['consistency', 'Consistency'],
  ['effort', 'Effort'],
  ['organization', 'Organization'],
  ['intentionality', 'Intentionality'],
  ['fun', 'Fun'],
] as const;

async function quiet<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

/**
 * The drill card's facts. `playSessionId`: a drill session from Play history;
 * `drillSessionId`: a scheduled drill (after its review). Throws only when I'm
 * signed out.
 */
export async function loadDrillShare(
  target: { playSessionId?: string | null; drillSessionId?: string | null },
  blocked: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<DrillShareData> {
  const me = await currentUserId(supabase);
  if (!me) throw new Error('Sign in to share your drill.');

  // The timer: the play session itself, or the drill's own one.
  let play: PlayRow | null = null;
  if (target.playSessionId) {
    play = await quiet(async () => (await sbCall(
      () => supabase.from('play_sessions').select('id, kind, source_id, venue_id, started_at, ended_at')
        .eq('id', target.playSessionId!).maybeSingle(),
      BOUND,
    )) as PlayRow | null, null);
  }
  const drillId = target.drillSessionId ?? (play?.kind === 'drill' ? play.source_id : null);

  type DrillRow = { id: string; player1_id: string; player2_id: string; starts_at: string | null };
  const drill = drillId
    ? await quiet(async () => (await sbCall(
        () => supabase.from('drill_sessions').select('id, player1_id, player2_id, starts_at').eq('id', drillId).maybeSingle(),
        BOUND,
      )) as DrillRow | null, null)
    : null;

  if (!play && drill) {
    // Its timer: linked to it, else a drill timer of mine started near its start.
    play = await quiet(async () => {
      const linked = (await sbCall(
        () => supabase.from('play_sessions').select('id, kind, source_id, venue_id, started_at, ended_at')
          .eq('user_id', me).eq('kind', 'drill').eq('source_id', drill.id).not('ended_at', 'is', null)
          .is('discarded_at', null).order('started_at', { ascending: false }).limit(1),
        BOUND,
      )) as PlayRow[] | null;
      if (linked?.[0]) return linked[0];
      if (!drill.starts_at) return null;
      const t = Date.parse(drill.starts_at);
      const near = (await sbCall(
        () => supabase.from('play_sessions').select('id, kind, source_id, venue_id, started_at, ended_at')
          .eq('user_id', me).eq('kind', 'drill').not('ended_at', 'is', null).is('discarded_at', null)
          .gte('started_at', new Date(t - 2 * 3600_000).toISOString())
          .lte('started_at', new Date(t + 4 * 3600_000).toISOString())
          .order('started_at').limit(1),
        BOUND,
      )) as PlayRow[] | null;
      return near?.[0] ?? null;
    }, null);
  }

  const partnerId = drill ? (drill.player1_id === me ? drill.player2_id : drill.player1_id) : null;
  const since = new Date(now.getTime() - (DRILL_WEEKS * 7 + 7) * 86_400_000).toISOString();

  type ReviewRow = { rating: number | null; notes: string | null } & Partial<Record<(typeof FACETS)[number][0], number | null>>;
  const [partner, venueName, review, prefs, recent] = await Promise.all([
    partnerId
      ? quiet(async () => {
          const p = (await sbCall(
            () => supabase.from('profiles').select('id, full_name, deleted_at').eq('id', partnerId).maybeSingle(),
            BOUND,
          )) as { id: string; full_name: string | null; deleted_at?: string | null } | null;
          return cardPlayer({ id: partnerId, fullName: p?.full_name ?? null, deleted: !!p?.deleted_at }, blocked);
        }, cardPlayer({ id: partnerId, fullName: null }, blocked))
      : Promise.resolve(null),
    play?.venue_id
      ? quiet(async () => ((await sbCall(
          () => supabase.from('venues').select('name').eq('id', play!.venue_id!).maybeSingle(),
          BOUND,
        )) as { name: string | null } | null)?.name ?? null, null)
      : Promise.resolve(null),
    drill
      ? quiet(async () => (await sbCall(
          () => supabase.from('drill_session_reviews')
            .select('rating, notes, consistency, effort, organization, intentionality, fun')
            .eq('session_id', drill.id).eq('user_id', me).maybeSingle(),
          BOUND,
        )) as ReviewRow | null, null)
      : Promise.resolve(null),
    quiet(async () => ((await sbCall(
      () => supabase.from('profiles').select('drill_shot_prefs').eq('id', me).maybeSingle(),
      BOUND,
    )) as { drill_shot_prefs: string[] | null } | null)?.drill_shot_prefs ?? [], [] as string[]),
    quiet(async () => ((await sbCall(
      () => supabase.from('play_sessions').select('started_at, ended_at')
        .eq('user_id', me).eq('kind', 'drill').not('ended_at', 'is', null).is('discarded_at', null)
        .gte('started_at', since).limit(500),
      BOUND,
    )) as { started_at: string; ended_at: string }[] | null) ?? [], [] as { started_at: string; ended_at: string }[]),
  ]);

  const when = play?.started_at ?? drill?.starts_at ?? null;
  const minutes = play?.ended_at ? minutesBetween(play.started_at, play.ended_at) : null;
  return {
    partner,
    court: venueName,
    date: when ? playHistoryDay(new Date(when), now) : playHistoryDay(now, now),
    minutes: minutes && minutes >= 1 ? minutes : null,
    focus: (prefs ?? []).map((slug) => findShotPref(slug)?.label).filter((x): x is string => !!x),
    review: review
      ? {
          rating: review.rating ?? null,
          facets: FACETS.map(([k, label]) => ({ label, stars: review[k] ?? 0 })),
          notes: review.notes ?? null,
        }
      : null,
    stats: drillStats(recent.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at })), now),
  };
}
