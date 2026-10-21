// The data behind a league's Standings section (LeagueDetail; Home's LeagueSpotlight calls loadLeagueStandings too):
// which standings to show, the rows, and the one-line header facts.
//
// Season choice, first match wins (the section never renders empty):
//   1. an active season: SeasonStandings' DEFAULT TAB, ranked the way that
//      screen ranks it, so a row here equals the same row in "Full table":
//        - the live period (computeSeasonStandings over the period window,
//          change = PLUPR - baseline), kind 'live';
//        - a locked period (every period locked but the season not completed
//          yet, or the live period starts tomorrow because the last one was
//          locked on its lock day): the snapshot rows, change measured with
//          periodStartPlupr, kind 'locked';
//        - the live period before its first match: everyone sits on the
//          baseline at 0-0 and a rank means nothing, so the members by PLUPR,
//          kind 'noMatches';
//   2. an upcoming season (or an active one before its start date): the
//      members by PLUPR as a preview, kind 'upcoming';
//   3. the latest completed season's final standings (season_final_standings,
//      else SeasonStandings' computed median-rank finals), kind 'final';
//   4. no season ever: the members by PLUPR, kind 'leaderboard'.
//
// Every read here is one SeasonStandings / LeagueDetail already makes:
// league_seasons, season_snapshots, season_final_standings (readable by
// everyone: migration_add_seasons / migration_restore_season_snapshots_...),
// league_members + profiles, and the league's matches.
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../../lib/supabase';
import {
  STANDINGS_MATCH_COLUMNS, DEFAULT_BASELINE_PLUPR, addDaysIso, computeSeasonStandings, localIsoDate,
  periodEndDate, periodStartDate, periodWindow, playedInWindow, seasonDatePart, seasonStatusLine, summarizeSeason,
  type SeasonInput, type SeasonSummary, type StandingsMatch,
} from '../../lib/seasonSummary';
import {
  computeMedianFinals, findLivePeriod, periodStartPlupr, type SnapshotPeriod,
} from '../standings/standingsModel';
import type { SeasonFinalStanding, SeasonSnapshot } from '../../types';
import type { StandingsPreviewRow } from './StandingsPreview';

/** The profile columns the rows read (names, flair, avatar, PLUPR). */
export const STANDINGS_PROFILE_COLUMNS =
  'full_name, rating, avatar_id, total_matches_played, name_color, list_name_style_id';

/** league_members select list for LeagueStandingsMember. */
export const STANDINGS_MEMBER_SELECT = `user_id, profile:profiles(${STANDINGS_PROFILE_COLUMNS})`;

export type StandingsProfile = {
  full_name?: string | null;
  rating?: number | null;
  avatar_id?: number | null;
  total_matches_played?: number | null;
  name_color?: string | null;
  list_name_style_id?: string | null;
};

/** A league_members row with STANDINGS_PROFILE_COLUMNS joined (a LeagueDetail MemberRow fits). */
export type LeagueStandingsMember = { user_id: string; profile?: StandingsProfile | null };

/** A league_seasons row (select *) fits. */
export type LeagueStandingsSeason = SeasonInput & { id: string };

export type LeagueStandingsKind = 'live' | 'locked' | 'noMatches' | 'upcoming' | 'final' | 'leaderboard';

export type LeagueStandings = {
  kind: LeagueStandingsKind;
  /** The season the rows belong to ("Full table" opens it); null for 'leaderboard'. */
  seasonId: string | null;
  seasonName: string | null;
  /** The active / upcoming season's facts (next lock, lockDue); null for 'final' / 'leaderboard'. */
  summary: SeasonSummary | null;
  /** The period the rows rank ('live' / 'locked'), else null. */
  period: number | null;
  /** The FULL ranked list, in rank order (StandingsPreview slices it). */
  rows: StandingsPreviewRow[];
  /** StandingsPreview's third column: "W-L", "Median" (final), or null (by-PLUPR lists). */
  middleLabel: string | null;
  /** Medals for real standings; plain numbers for a by-PLUPR list. */
  medals: boolean;
  /** The viewer's rank in real standings ('live' / 'locked' / 'final'), else null. */
  myRank: number | null;
};

export type LoadLeagueStandingsArgs = {
  leagueId: string;
  /** The viewer (their row is `isMe`). undefined = read the local session. */
  myUserId?: string | null;
  /** The league's active or upcoming season (LeagueDetail's query: newest
   *  created first). undefined = fetch it; null = there is none. */
  season?: LeagueStandingsSeason | null;
  /** Completed seasons, newest end_date first (only [0] is read). undefined = fetch. */
  completedSeasons?: ReadonlyArray<LeagueStandingsSeason>;
  /** Members with STANDINGS_PROFILE_COLUMNS. undefined / null = fetch. */
  members?: ReadonlyArray<LeagueStandingsMember> | null;
  /** Clock override (tests). */
  now?: Date;
};

type SnapRow = Pick<SeasonSnapshot,
  'period_number' | 'user_id' | 'rank_at_snapshot' | 'elo_at_snapshot' | 'wins_in_season' | 'losses_in_season' | 'profile'>;

const SNAPSHOT_SELECT = 'period_number, user_id, rank_at_snapshot, elo_at_snapshot, wins_in_season, losses_in_season,'
  + ' profile:profiles(full_name, avatar_id, name_color, list_name_style_id)';

const isRated = (p: StandingsProfile | null | undefined) =>
  p?.rating != null && Number.isFinite(Number(p.rating)) && p.total_matches_played !== 0;

/** Members by PLUPR (rated first, then by name): the preview / leaderboard list. */
export function membersByPlupr(
  members: ReadonlyArray<LeagueStandingsMember>,
  myUserId: string | null,
): StandingsPreviewRow[] {
  return [...members]
    .sort((a, b) => {
      const ra = isRated(a.profile) ? Number(a.profile!.rating) : -Infinity;
      const rb = isRated(b.profile) ? Number(b.profile!.rating) : -Infinity;
      if (ra !== rb) return rb - ra;
      return (a.profile?.full_name ?? '').localeCompare(b.profile?.full_name ?? '');
    })
    .map((m, i) => ({
      userId: m.user_id,
      rank: i + 1,
      name: m.profile?.full_name ?? '',
      flair: { nameColor: m.profile?.name_color ?? null, styleId: m.profile?.list_name_style_id ?? null },
      avatar: m.profile?.avatar_id ?? null,
      rating: isRated(m.profile) ? Number(m.profile!.rating) : null,
      isMe: !!myUserId && m.user_id === myUserId,
    }));
}

/** A locked period's rows, as SeasonStandings' period tab maps its snapshots. */
function lockedRows(
  periodNumber: number,
  snaps: ReadonlyArray<SnapRow>,
  baseline: number,
  myUserId: string | null,
): StandingsPreviewRow[] {
  const rows = snaps.filter((r) => r.period_number === periodNumber)
    .sort((a, b) => a.rank_at_snapshot - b.rank_at_snapshot);
  const prevPeriod = { rows: snaps.filter((r) => r.period_number === periodNumber - 1) as SeasonSnapshot[] };
  return rows.map((r) => {
    const end = Number(r.elo_at_snapshot ?? baseline);
    return {
      userId: r.user_id,
      rank: r.rank_at_snapshot,
      name: r.profile?.full_name ?? '',
      flair: { nameColor: r.profile?.name_color ?? null, styleId: r.profile?.list_name_style_id ?? null },
      avatar: r.profile?.avatar_id ?? null,
      wins: r.wins_in_season,
      losses: r.losses_in_season,
      rating: end,
      ratingDelta: end - periodStartPlupr({ period: { periodNumber, locked: true }, prevPeriod, userId: r.user_id, baseline }),
      isMe: !!myUserId && r.user_id === myUserId,
    };
  });
}

/** Final standings rows, as SeasonStandings' Final tab maps them. */
function finalRows(finals: ReadonlyArray<SeasonFinalStanding>, baseline: number, myUserId: string | null): StandingsPreviewRow[] {
  return [...finals].sort((a, b) => a.final_rank - b.final_rank).map((r) => ({
    userId: r.user_id,
    rank: r.final_rank,
    name: r.profile?.full_name ?? '',
    flair: { nameColor: r.profile?.name_color ?? null, styleId: r.profile?.list_name_style_id ?? null },
    avatar: r.profile?.avatar_id ?? null,
    middle: Number(r.median_rank).toFixed(1),
    rating: Number(r.new_elo ?? baseline),
    // On the Final tab the change is the rank bonus on top of the baseline.
    ratingDelta: Number(r.elo_bonus ?? 0),
    isMe: !!myUserId && r.user_id === myUserId,
  }));
}

const rankOf = (rows: ReadonlyArray<StandingsPreviewRow>) => rows.find((r) => r.isMe)?.rank ?? null;

export async function loadLeagueStandings(args: LoadLeagueStandingsArgs): Promise<LeagueStandings> {
  const { leagueId } = args;
  const [myUserId, season, memberRows] = await Promise.all([
    args.myUserId !== undefined ? Promise.resolve(args.myUserId) : currentUserId(supabase),
    args.season !== undefined
      ? Promise.resolve(args.season)
      : sbCall(() => supabase.from('league_seasons')
        .select('*')
        .eq('league_id', leagueId)
        .in('status', ['upcoming', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as Promise<LeagueStandingsSeason | null>,
    args.members
      ? Promise.resolve(args.members)
      : sbCall(() => supabase.from('league_members').select(STANDINGS_MEMBER_SELECT).eq('league_id', leagueId)),
  ]);
  const members = (memberRows ?? []) as unknown as LeagueStandingsMember[];
  // The same LOCAL "today" SeasonStandings ranks with (see lib/seasonSummary.ts).
  const now = args.now ?? new Date();
  const today = localIsoDate(now);
  const base = { myRank: null, period: null, medals: true, middleLabel: 'W-L' as string | null };

  if (season) {
    const baseline = Number(season.baseline_plupr ?? DEFAULT_BASELINE_PLUPR);
    const summarize = (locked: Iterable<number>, matches: StandingsMatch[]) => summarizeSeason({
      season, lockedPeriods: locked, members, matches, myUserId, today,
    });
    const preview = (kind: 'upcoming' | 'noMatches', summary: SeasonSummary): LeagueStandings => ({
      ...base, kind, seasonId: season.id, seasonName: season.name, summary,
      rows: membersByPlupr(members, myUserId), medals: false, middleLabel: null,
    });

    if (today < season.start_date) return preview('upcoming', summarize([], []));

    const snaps = ((await sbCall(() => supabase.from('season_snapshots')
      .select(SNAPSHOT_SELECT)
      .eq('season_id', season.id))) ?? []) as unknown as SnapRow[];
    const locked = new Set(snaps.map((r) => r.period_number));

    // SeasonStandings' default tab (status is never 'completed' here).
    const tab = findLivePeriod({ ...season, status: 'active' }, locked, today) ?? season.total_periods;
    let ranked: number | null = tab;
    // The live period starts tomorrow (the last one was locked on its lock
    // day): SeasonStandings shows an empty "starts" note there, so rank the
    // period that just locked instead.
    if (!locked.has(tab) && periodStartDate(season, tab) > today) {
      ranked = locked.size > 0 ? Math.max(...locked) : null;
    }

    if (ranked != null && locked.has(ranked)) {
      const rows = lockedRows(ranked, snaps, baseline, myUserId);
      if (rows.length > 0) {
        return {
          ...base, kind: 'locked', seasonId: season.id, seasonName: season.name,
          summary: summarize(locked, []), period: ranked, rows, myRank: rankOf(rows),
        };
      }
    }
    if (ranked == null || locked.has(ranked)) return preview('noMatches', summarize(locked, []));

    const w = periodWindow(season, ranked, today);
    // A day of slack on each side of the window: computeSeasonStandings
    // filters by local day (playedInWindow), so the server bound (UTC
    // midnights) only has to be wide enough, never exact.
    const matches = ((await sbCall(() => supabase.from('matches')
      .select(STANDINGS_MATCH_COLUMNS)
      .eq('league_id', leagueId)
      .neq('status', 'scheduled')
      .gte('played_at', addDaysIso(w.start, -1))
      .lte('played_at', addDaysIso(w.end.slice(0, 10), 2)))) ?? []) as unknown as StandingsMatch[];
    const summary = summarize(locked, matches);
    const inWindow = matches.some((m) => !!m.played_at && playedInWindow(m.played_at, w.start, w.end));
    if (!inWindow) return preview('noMatches', summary);

    const byId = new Map(members.map((m) => [m.user_id, m.profile ?? null]));
    const rows: StandingsPreviewRow[] = computeSeasonStandings(members, matches, baseline, w.start, w.end).map((r) => {
      const p = byId.get(r.user_id);
      return {
        userId: r.user_id,
        rank: r.rank,
        name: p?.full_name ?? '',
        flair: { nameColor: p?.name_color ?? null, styleId: p?.list_name_style_id ?? null },
        avatar: p?.avatar_id ?? null,
        wins: r.wins,
        losses: r.losses,
        rating: r.rating,
        // An unlocked period measures from the flat baseline (periodStartPlupr).
        ratingDelta: r.rating - baseline,
        isMe: !!myUserId && r.user_id === myUserId,
      };
    });
    return {
      ...base, kind: 'live', seasonId: season.id, seasonName: season.name, summary, period: ranked, rows,
      myRank: rankOf(rows),
    };
  }

  const completed = args.completedSeasons !== undefined
    ? args.completedSeasons[0] ?? null
    : ((await sbCall(() => supabase.from('league_seasons')
      .select('*')
      .eq('league_id', leagueId)
      .eq('status', 'completed')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle())) as LeagueStandingsSeason | null);

  if (completed) {
    const rows = await loadFinalRows(leagueId, completed, members, myUserId);
    if (rows.length > 0) {
      return {
        ...base, kind: 'final', seasonId: completed.id, seasonName: completed.name, summary: null, rows,
        middleLabel: 'Median', myRank: rankOf(rows),
      };
    }
  }

  return {
    ...base, kind: 'leaderboard', seasonId: null, seasonName: null, summary: null,
    rows: membersByPlupr(members, myUserId), medals: false, middleLabel: null,
  };
}

/** Stored final standings, else SeasonStandings' computed median-rank finals. */
async function loadFinalRows(
  leagueId: string,
  season: LeagueStandingsSeason,
  members: ReadonlyArray<LeagueStandingsMember>,
  myUserId: string | null,
): Promise<StandingsPreviewRow[]> {
  const baseline = Number(season.baseline_plupr ?? DEFAULT_BASELINE_PLUPR);
  const stored = ((await sbCall(() => supabase.from('season_final_standings')
    .select('*, profile:profiles(full_name, avatar_id, name_color, list_name_style_id)')
    .eq('season_id', season.id)
    .order('final_rank'))) ?? []) as SeasonFinalStanding[];
  if (stored.length > 0) return finalRows(stored, baseline, myUserId);

  // No stored finals (a season completed outside complete_season): rebuild
  // every period the way SeasonStandings does, then take median ranks.
  const lastEnd = periodEndDate(season, season.total_periods);
  const [snapRows, matchRows] = await Promise.all([
    sbCall(() => supabase.from('season_snapshots').select(SNAPSHOT_SELECT).eq('season_id', season.id)),
    sbCall(() => supabase.from('matches')
      .select(STANDINGS_MATCH_COLUMNS)
      .eq('league_id', leagueId)
      .neq('status', 'scheduled')
      .gte('played_at', addDaysIso(season.start_date, -1))
      .lte('played_at', addDaysIso(lastEnd, 2))),
  ]);
  const snaps = (snapRows ?? []) as unknown as SnapRow[];
  const matches = (matchRows ?? []) as unknown as StandingsMatch[];
  // A completed season's periods have all ended: each window closes on its own lock date.
  const today = addDaysIso(lastEnd, 1);
  const periods: SnapshotPeriod[] = [];
  for (let p = 1; p <= season.total_periods; p++) {
    const date = periodEndDate(season, p);
    const lockedRowsP = snaps.filter((r) => r.period_number === p) as SeasonSnapshot[];
    if (lockedRowsP.length > 0) {
      periods.push({ periodNumber: p, date, rows: lockedRowsP, locked: true });
      continue;
    }
    const w = periodWindow(season, p, today);
    const rows = computeSeasonStandings(members, matches, baseline, w.start, w.end).map((r) => ({
      user_id: r.user_id, rank_at_snapshot: r.rank,
    })) as SeasonSnapshot[];
    periods.push({ periodNumber: p, date, rows, locked: false });
  }
  const finals = computeMedianFinals(periods, members as any[], leagueId, season.id, baseline)
    .map((f) => ({ ...f, profile: f.profile ? { ...f.profile, full_name: f.profile.full_name ?? '' } : undefined }));
  return finalRows(finals as SeasonFinalStanding[], baseline, myUserId);
}

export type LeagueStandingsHeader = {
  /** SectionHeader title: "Standings" / "Leaderboard". */
  title: string;
  /** SectionHeader count: the season name, "12 members". */
  label: string | null;
  /** The one status line under the header (seasonStatusLine): "You #2 of 14 ·
   *  Period 7 locks Oct 20". Home's spotlight shows the same line. The
   *  preview kinds say their rows are by PLUPR: "14 players by PLUPR · Period
   *  1 locks Oct 20", "Starts Nov 3 · by PLUPR". */
  subtitle: string | null;
};

/**
 * The section's header facts: the season's name in the header, and under it
 * your rank out of THESE rows plus the next date that matters (lib/
 * seasonSummary's seasonStatusLine). "Lock due" is admin information: pass
 * `privileged: false` for members.
 */
export function leagueStandingsHeader(
  d: LeagueStandings,
  opts: { privileged?: boolean; now?: Date; locale?: string } = {},
): LeagueStandingsHeader {
  const dateOpts = { isAdmin: !!opts.privileged, now: opts.now ?? new Date(), locale: opts.locale };
  const status = (summary: SeasonSummary | null) => seasonStatusLine({
    summary,
    myRank: d.myRank,
    rankedCount: d.rows.length,
    ...dateOpts,
  });
  const n = d.rows.length;
  switch (d.kind) {
    case 'live':
    case 'locked':
      return { title: 'Standings', label: d.seasonName, subtitle: d.summary ? status(d.summary) : null };
    // The preview rows are the members by PLUPR, not season results (no
    // season match has counted yet), so the line says so.
    case 'noMatches':
      return {
        title: 'Standings',
        label: d.seasonName,
        subtitle: d.summary
          ? `${n} player${n === 1 ? '' : 's'} by PLUPR · ${seasonDatePart(d.summary, dateOpts)}`
          : 'Members by PLUPR',
      };
    case 'upcoming':
      return {
        title: 'Standings',
        label: d.seasonName,
        subtitle: d.summary ? `${status(d.summary)} · by PLUPR` : 'Members by PLUPR',
      };
    case 'final':
      return { title: 'Standings', label: d.seasonName, subtitle: status(null) };
    case 'leaderboard':
    default:
      return {
        title: 'Leaderboard',
        label: `${d.rows.length} member${d.rows.length === 1 ? '' : 's'}`,
        subtitle: 'Members by PLUPR · no season yet',
      };
  }
}
