// Pure season-standings math for SeasonStandingsScreen: period dates, the
// season-scoped table, the median-rank finals, and the one-line header. No
// React / React Native imports, so vitest can exercise it directly
// (components/standings/__tests__).
//
// The table math moved here unchanged from the screen (P4 compaction); only the
// presentation around it changed.
import type { LeagueSeason, SeasonSnapshot, SeasonFinalStanding } from '../../types';

type SeasonDates = Pick<LeagueSeason, 'start_date' | 'lock_frequency_weeks'>;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local ISO date "YYYY-MM-DD" for a period N's snapshot/end date. */
export function computePeriodDate(s: SeasonDates, periodNumber: number): string {
  const d = new Date(s.start_date + 'T00:00:00');
  d.setDate(d.getDate() + periodNumber * s.lock_frequency_weeks * 7);
  return isoDay(d);
}

/** Local ISO date "YYYY-MM-DD" for the first day of period N.
 *   Period 1 starts on the season's start_date.
 *   Period N (>1) starts the day after period N-1's snapshot/end date. */
export function periodStartDate(s: SeasonDates, periodNumber: number): string {
  if (periodNumber <= 1) return s.start_date;
  const d = new Date(computePeriodDate(s, periodNumber - 1) + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return isoDay(d);
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
// PLUPR entirely — exactly the contract the user asked for.
//
// Sort: season PLUPR desc → (W-L) desc → W desc.
export function computeStandings(
  members: any[],
  matches: any[],
  baseline: number,
  startIso?: string,
  endIso?: string,
): LiveRow[] {
  const inRange = matches.filter(m => {
    if (!m.played_at) return false;
    if (startIso && m.played_at < startIso) return false;
    if (endIso   && m.played_at > endIso)   return false;
    return true;
  });
  return members.map(m => {
    const uid = m.user_id;
    // Each game in a multi-game match counts independently. A best-of-3
    // ending 2-1 produces 2 W + 1 L for the winning side. Single-game
    // matches (game_scores null) keep the old 1 W or 1 L behavior.
    let wins = 0;
    let losses = 0;
    for (const x of inRange) {
      const onTeam1 = x.player1_id === uid || x.partner1_id === uid;
      const onTeam2 = x.player2_id === uid || x.partner2_id === uid;
      if (!onTeam1 && !onTeam2) continue;
      const games = Array.isArray(x.game_scores) && x.game_scores.length > 0
        ? x.game_scores
        : null;
      if (games) {
        for (const g of games as { t1: number; t2: number }[]) {
          if (onTeam1) { if (g.t1 > g.t2) wins++; else if (g.t2 > g.t1) losses++; }
          else         { if (g.t2 > g.t1) wins++; else if (g.t1 > g.t2) losses++; }
        }
      } else {
        if (onTeam1 && x.winner_team === 'team1') wins++;
        else if (onTeam1 && x.winner_team === 'team2') losses++;
        else if (onTeam2 && x.winner_team === 'team2') wins++;
        else if (onTeam2 && x.winner_team === 'team1') losses++;
      }
    }
    let seasonDelta = 0;
    for (const x of inRange) {
      const onTeam1 = x.player1_id === uid || x.partner1_id === uid;
      const onTeam2 = x.player2_id === uid || x.partner2_id === uid;
      if (onTeam1 && x.player1_rating_before != null && x.player1_rating_after != null) {
        seasonDelta += x.player1_rating_after - x.player1_rating_before;
      } else if (onTeam2 && x.player2_rating_before != null && x.player2_rating_after != null) {
        seasonDelta += x.player2_rating_after - x.player2_rating_before;
      }
    }
    return {
      user_id: uid,
      // '' rather than 'Unknown': the row renders a neutral "Player" fallback
      // (content rule 3, no "Unknown" to non-admins).
      full_name: m.profile?.full_name ?? '',
      rating: baseline + seasonDelta,
      avatar_id: m.profile?.avatar_id ?? 1,
      avatar_url: m.profile?.avatar_url ?? null,
      name_color: m.profile?.name_color ?? null,
      list_name_style_id: m.profile?.list_name_style_id ?? null,
      wins, losses,
      total_matches_played: m.profile?.total_matches_played ?? 0,
    };
  }).sort((a, b) =>
    (b.rating - a.rating) ||
    ((b.wins - b.losses) - (a.wins - a.losses)) ||
    (b.wins - a.wins)
  );
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
