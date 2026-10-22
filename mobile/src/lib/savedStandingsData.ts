// The loads behind Saved's standing lines (the pure half: lib/savedStandings).
//
// At most three sequential stages however many leagues are on Saved (seasons +
// members, then snapshots + finals, then the live windows' matches). Within a
// stage the reads are split PER LEAGUE / PER SEASON and run in parallel, never
// one `.in(...)` over every league: PostgREST caps a response at 1,000 rows,
// and a batched read that hits the cap drops arbitrary rows, which silently
// corrupts the locked-period set and the rank. A per-key read that still comes
// back at the cap marks that league's standing unknown (kind 'none', no rank)
// rather than print a wrong one. Each read is one SeasonStandings /
// LeagueDetail already makes, against tables everyone can read. Results go
// through the foundation query cache (60 s), so Saved's reload-on-every-focus
// doesn't re-read standings you saw a moment ago.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { cachedFetch } from '@just-messin-around/expo-foundation/cache';
import { supabase } from './supabase';
import { STANDINGS_MATCH_COLUMNS, addDaysIso, localIsoDate, type StandingsMatch } from './seasonSummary';
import {
  liveMatchWindow, pickLeagueSeasons, savedLeagueStanding, standingsSeasonFor, tournamentFinishes, unknownStanding,
  type SavedFinal, type SavedSeason, type SavedSnapshot, type SavedStanding, type TournamentFinish,
} from './savedStandings';

const TTL_MS = 60_000;
/** PostgREST's default max rows per response; a read this long may be truncated. */
export const ROW_CAP = 1000;

type MatchRow = StandingsMatch & { league_id: string };

async function readSavedStandings(
  leagueIds: ReadonlyArray<string>,
  myUserId: string | null,
  now: Date,
): Promise<Record<string, SavedStanding>> {
  if (leagueIds.length === 0) return {};
  const ids = [...leagueIds];
  const today = localIsoDate(now);
  // Leagues whose rank can't be trusted (a read came back at the row cap).
  const capped = new Set<string>();
  const rowsOf = <T,>(rows: unknown, leagueId: string): T[] => {
    const list = (rows ?? []) as T[];
    if (list.length >= ROW_CAP) capped.add(leagueId);
    return list;
  };

  const [seasonRows, memberLists] = await Promise.all([
    sbCall(() => supabase.from('league_seasons').select('*').in('league_id', ids)),
    Promise.all(ids.map(async (leagueId) => rowsOf<{ user_id: string }>(
      await sbCall(() => supabase.from('league_members').select('user_id').eq('league_id', leagueId)),
      leagueId,
    ).map((m) => m.user_id))),
  ]);
  const seasons = ((seasonRows ?? []) as unknown as SavedSeason[]);
  const picked = pickLeagueSeasons(seasons);
  const current: Array<{ leagueId: string; seasonId: string }> = [];
  const completed: Array<{ leagueId: string; seasonId: string }> = [];
  for (const [leagueId, slot] of picked) {
    if (slot.current) current.push({ leagueId, seasonId: slot.current.id });
    else if (slot.completed) completed.push({ leagueId, seasonId: slot.completed.id });
  }

  const [snapLists, finalLists] = await Promise.all([
    Promise.all(current.map(async ({ leagueId, seasonId }) => rowsOf<SavedSnapshot>(
      await sbCall(() => supabase.from('season_snapshots')
        .select('season_id, period_number, user_id, rank_at_snapshot')
        .eq('season_id', seasonId)),
      leagueId,
    ))),
    Promise.all(completed.map(async ({ leagueId, seasonId }) => rowsOf<SavedFinal>(
      await sbCall(() => supabase.from('season_final_standings')
        .select('season_id, user_id, final_rank')
        .eq('season_id', seasonId)),
      leagueId,
    ))),
  ]);
  const snaps = snapLists.flat();
  const finals = finalLists.flat();

  // One match read per league whose live period needs computing, each over its
  // own window (a day of slack each side: the ranking filters by local day, so
  // the server bound only has to be wide enough).
  const matchReads: Array<Promise<MatchRow[]>> = [];
  for (const [leagueId, slot] of picked) {
    if (!slot.current || capped.has(leagueId)) continue;
    const w = liveMatchWindow(slot.current, snaps, today);
    if (!w) continue;
    const lo = addDaysIso(w.start.slice(0, 10), -1);
    const hi = addDaysIso(w.end.slice(0, 10), 2);
    matchReads.push((async () => rowsOf<MatchRow>(
      await sbCall(() => supabase.from('matches')
        .select(`league_id, ${STANDINGS_MATCH_COLUMNS}`)
        .eq('league_id', leagueId)
        .eq('status', 'completed')
        .gte('played_at', lo)
        .lte('played_at', hi)),
      leagueId,
    ))());
  }
  const matches = (await Promise.all(matchReads)).flat();

  const membersBy = new Map<string, string[]>();
  ids.forEach((leagueId, i) => membersBy.set(leagueId, memberLists[i]));
  const out: Record<string, SavedStanding> = {};
  for (const leagueId of ids) {
    const slot = picked.get(leagueId) ?? { current: null, completed: null };
    const st = savedLeagueStanding({
      leagueId,
      current: slot.current,
      completed: slot.completed,
      memberIds: membersBy.get(leagueId) ?? [],
      snaps,
      finals,
      matches: matches.filter((m) => m.league_id === leagueId),
      myUserId,
      today,
    });
    // Truncated read: no line rather than a wrong rank. The tap still opens
    // the season's standings (default tab), which reads per period.
    out[leagueId] = capped.has(leagueId) ? unknownStanding(st) : st;
  }
  return out;
}

/** Each league's standing for me, keyed by league id. Cached per (user, league set). */
export function loadSavedStandings(
  leagueIds: ReadonlyArray<string>,
  myUserId: string | null,
  opts: { force?: boolean } = {},
): Promise<Record<string, SavedStanding>> {
  const key = `saved:standings:${myUserId ?? '-'}:${[...leagueIds].sort().join(',')}`;
  return cachedFetch(key, () => readSavedStandings(leagueIds, myUserId, new Date()), {
    ttlMs: opts.force ? 0 : TTL_MS,
  });
}

/** My finish in each completed tournament (tournament_final_ranks), keyed by tournament id. */
export async function loadTournamentFinishes(
  tournamentIds: ReadonlyArray<string>,
  myUserId: string | null,
  opts: { force?: boolean } = {},
): Promise<Map<string, TournamentFinish>> {
  if (!myUserId || tournamentIds.length === 0) return new Map();
  const ids = [...tournamentIds];
  const key = `saved:finishes:${myUserId}:${[...ids].sort().join(',')}`;
  const rows = await cachedFetch(key, async () => ((await sbCall(() => supabase
    .from('tournament_final_ranks')
    .select('tournament_id, user_id, final_rank')
    .in('tournament_id', ids))) ?? []) as unknown as { tournament_id: string; user_id: string; final_rank: number }[],
  { ttlMs: opts.force ? 0 : TTL_MS });
  return tournamentFinishes(rows, myUserId);
}

export type MyLeague = { id: string; name: string; home_court: string | null; is_active: boolean | null };

/** Leagues I'm a member of, newest joined first. */
export async function listMyLeagues(myUserId: string | null): Promise<MyLeague[]> {
  if (!myUserId) return [];
  const rows = (await sbCall(() => supabase
    .from('league_members')
    .select('joined_at, league:leagues(id, name, home_court, is_active)')
    .eq('user_id', myUserId)
    .order('joined_at', { ascending: false }))) ?? [];
  return (rows as unknown as { league: MyLeague | MyLeague[] | null }[])
    .map((r) => (Array.isArray(r.league) ? r.league[0] : r.league))
    .filter((l): l is MyLeague => !!l && !!l.id);
}

/**
 * The ids a standings screen needs when a link carried only one of them:
 * /leagues/:id/standings (the league's current season, else its latest
 * completed one) or /seasons/:id/standings without ?leagueId. null seasonId =
 * the league has no season yet.
 */
export async function resolveStandingsTarget(args: {
  seasonId?: string | null;
  leagueId?: string | null;
}): Promise<{ seasonId: string | null; leagueId: string | null }> {
  if (args.seasonId && args.leagueId) return { seasonId: args.seasonId, leagueId: args.leagueId };
  if (args.seasonId) {
    const row = await sbCall(() => supabase.from('league_seasons')
      .select('league_id').eq('id', args.seasonId as string).maybeSingle()) as { league_id: string } | null;
    return { seasonId: args.seasonId, leagueId: row?.league_id ?? null };
  }
  if (args.leagueId) {
    const rows = ((await sbCall(() => supabase.from('league_seasons')
      .select('id, league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks, total_periods, status, created_at')
      .eq('league_id', args.leagueId as string))) ?? []) as unknown as SavedSeason[];
    return { seasonId: standingsSeasonFor(rows, args.leagueId), leagueId: args.leagueId };
  }
  return { seasonId: null, leagueId: null };
}
