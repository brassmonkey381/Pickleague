// Pure season-standings math for SeasonStandingsScreen: period dates, the
// season-scoped table, the median-rank finals, and the one-line header. No
// React / React Native imports, so vitest can exercise it directly
// (components/standings/__tests__).
//
// The period dates and the table math come from lib/seasonSummary.ts, the one
// source of truth LeagueDetail's season strip also ranks with, so the strip's
// "You #N" always equals this screen's rank. This file adds the screen-only
// pieces on top (profile fields on each row, finals, lock gating, header).
import type { LeagueSeason, SeasonSnapshot, SeasonFinalStanding } from '../../types';
import { periodEndDate, periodStartDate as seasonPeriodStartDate, computeSeasonStandings } from '../../lib/seasonSummary';

type SeasonDates = Pick<LeagueSeason, 'start_date' | 'lock_frequency_weeks'>;

/** Local ISO date "YYYY-MM-DD" for a period N's snapshot/end date. */
export function computePeriodDate(s: SeasonDates, periodNumber: number): string {
  return periodEndDate(s, periodNumber);
}

/** Local ISO date "YYYY-MM-DD" for the first day of period N.
 *   Period 1 starts on the season's start_date.
 *   Period N (>1) starts the day after period N-1's snapshot/end date. */
export function periodStartDate(s: SeasonDates, periodNumber: number): string {
  return seasonPeriodStartDate(s, periodNumber);
}

export type LiveRow = {
  user_id: string; full_name: string; rating: number;
  avatar_id: number; avatar_url: string | null;
  name_color: string | null;
  list_name_style_id: string | null;
  wins: number; losses: number;
  total_matches_played: number;
};

export type SnapshotPeriod = {
  periodNumber: number;
  date: string;
  rows: SeasonSnapshot[];
  // True when the row comes from season_snapshots; false when computed
  // on-the-fly from match data for a period that hasn't been locked yet.
  locked: boolean;
};

// Compute season-scoped standings for league members against an in-league
// match list, optionally windowed by [startIso, endIso] on played_at.
//
// "Season PLUPR" is computed from the season's baseline plus the sum of
// each player's per-match team deltas (player1_rating_after - _before for
// team1 / player2_after - player2_before for team2). Partners on the same
// team share the nominal player's delta. This ignores the player's global
// PLUPR entirely — exactly the contract the user asked for. Each game of a
// multi-game match counts as its own W/L.
//
// Sort: season PLUPR desc → (W-L) desc → W desc. The math and the sort are
// seasonSummary's computeSeasonStandings; this only adds the profile fields
// the table renders.
export function computeStandings(
  members: any[],
  matches: any[],
  baseline: number,
  startIso?: string,
  endIso?: string,
): LiveRow[] {
  const memberById = new Map<string, any>(members.map(m => [m.user_id, m]));
  return computeSeasonStandings(members, matches, baseline, startIso, endIso).map(r => {
    const profile = memberById.get(r.user_id)?.profile;
    return {
      user_id: r.user_id,
      // '' rather than 'Unknown': the row renders a neutral "Player" fallback
      // (content rule 3, no "Unknown" to non-admins).
      full_name: profile?.full_name ?? '',
      rating: r.rating,
      avatar_id: profile?.avatar_id ?? 1,
      avatar_url: profile?.avatar_url ?? null,
      name_color: profile?.name_color ?? null,
      list_name_style_id: profile?.list_name_style_id ?? null,
      wins: r.wins,
      losses: r.losses,
      total_matches_played: profile?.total_matches_played ?? 0,
    };
  });
}

/** PLUPR rank bonuses for the end-of-period soft reset. Mirrors the SQL trigger. */
export const RANK_BONUSES: ReadonlyArray<{ rank: number; bonus: number }> = [
  { rank: 1, bonus: 0.20 },
  { rank: 2, bonus: 0.15 },
  { rank: 3, bonus: 0.10 },
  { rank: 4, bonus: 0.05 },
  { rank: 5, bonus: 0.02 },
];

export function bonusForRank(rank: number): number {
  return RANK_BONUSES.find(b => b.rank === rank)?.bonus ?? 0;
}

// Median-rank final standings derived from period snapshots (locked or computed).
// elo_bonus and new_elo are derived from the season baseline + the bonus
// associated with each player's final_rank, matching the SQL complete_season
// reset logic.
export function computeMedianFinals(
  periods: SnapshotPeriod[],
  members: any[],
  leagueId: string,
  seasonId: string,
  baseline: number,
): SeasonFinalStanding[] {
  const ranks: Record<string, number[]> = {};
  for (const period of periods) {
    for (const row of period.rows) {
      if (!ranks[row.user_id]) ranks[row.user_id] = [];
      ranks[row.user_id].push(row.rank_at_snapshot);
    }
  }
  function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[Math.floor(mid)];
  }
  const memberProfileById = new Map(members.map(m => [m.user_id, m.profile]));

  const ranked = Object.entries(ranks)
    .map(([user_id, rs]) => ({ user_id, median_rank: median(rs) }))
    .sort((a, b) => a.median_rank - b.median_rank);

  return ranked.map((r, i) => {
    const finalRank = i + 1;
    const bonus = bonusForRank(finalRank);
    return {
      id: `computed-final-${r.user_id}`,
      season_id: seasonId,
      league_id: leagueId,
      user_id: r.user_id,
      final_rank: finalRank,
      median_rank: r.median_rank,
      elo_bonus: bonus,
      new_elo: baseline + bonus,
      profile: memberProfileById.get(r.user_id) ?? undefined,
    };
  });
}

/** The live period: the first non-locked period whose end date hasn't passed.
 *  Null for a completed season, or when every open period's window is over. */
export function findLivePeriod(
  season: Pick<LeagueSeason, 'start_date' | 'lock_frequency_weeks' | 'total_periods' | 'status'>,
  lockedPeriods: ReadonlySet<number>,
  todayIso: string,
): number | null {
  if (season.status === 'completed') return null;
  for (let p = 1; p <= season.total_periods; p++) {
    if (lockedPeriods.has(p)) continue;
    if (todayIso > computePeriodDate(season, p)) continue;
    return p;
  }
  return null;
}

/** The period the next lock applies to: one past the highest locked period. */
export function nextLockPeriod(lockedPeriods: ReadonlySet<number>): number {
  return lockedPeriods.size === 0 ? 1 : Math.max(...lockedPeriods) + 1;
}

/** Whether period `n`'s lock is due at `now` (its snapshot date has arrived).
 *  Same date math the Lock button has always used. */
export function isLockDue(
  season: Pick<LeagueSeason, 'start_date' | 'lock_frequency_weeks' | 'total_periods' | 'status'>,
  n: number,
  now: Date,
): boolean {
  if (season.status === 'completed') return false;
  if (n > season.total_periods) return false;
  const start = new Date(season.start_date + 'T00:00:00');
  const due = new Date(start.getTime() + n * season.lock_frequency_weeks * 7 * 86400000);
  return now >= due;
}

/**
 * The one-line season header (plan section 5): "P7 of 12 · locks Oct 20".
 * `fmtDay` formats an ISO day ("Oct 20"); injected so tests don't depend on
 * the runtime's locale.
 */
export function seasonHeaderLine(args: {
  season: Pick<LeagueSeason, 'start_date' | 'lock_frequency_weeks' | 'total_periods' | 'status'>;
  livePeriod: number | null;
  nextPeriod: number;
  lockDue: boolean;
  todayIso: string;
  fmtDay: (iso: string) => string;
}): string {
  const { season, livePeriod, nextPeriod, lockDue, todayIso, fmtDay } = args;
  const total = season.total_periods;
  if (season.status === 'completed') return `Completed · ${total} period${total === 1 ? '' : 's'}`;
  if (season.start_date > todayIso) {
    return `Starts ${fmtDay(season.start_date)} · ${total} period${total === 1 ? '' : 's'}`;
  }
  if (lockDue && nextPeriod <= total) return `P${nextPeriod} of ${total} · lock due`;
  if (livePeriod != null) return `P${livePeriod} of ${total} · locks ${fmtDay(computePeriodDate(season, livePeriod))}`;
  return `All ${total} periods played`;
}

/**
 * The PLUPR a player opened `period` at, which the table's change column
 * measures against.
 *
 * Locked periods: the snapshot stores profiles.rating after the previous
 * period's soft reset, so it already includes the rank bonus carried in from
 * that lock. Start = baseline (P1) or baseline + bonusForRank(prev rank).
 *
 * Unlocked (computed) periods: computeStandings() returns baseline + this
 * window's match deltas and never adds the carried bonus, so the start has to
 * be the flat baseline too. Adding the bonus here showed last period's #1 at
 * "−0.20" on the live tab before they'd played a match.
 */
export function periodStartPlupr(args: {
  period: Pick<SnapshotPeriod, 'periodNumber' | 'locked'>;
  prevPeriod: Pick<SnapshotPeriod, 'rows'> | undefined;
  userId: string;
  baseline: number;
}): number {
  const { period, prevPeriod, userId, baseline } = args;
  if (!period.locked || period.periodNumber <= 1) return baseline;
  return baseline + bonusForRank(prevPeriod?.rows.find(r => r.user_id === userId)?.rank_at_snapshot ?? 0);
}

/** "+0.12" / "−0.05" / "" (no change), for the PLUPR column. */
export function formatPluprChange(delta: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.005) return '';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
}
