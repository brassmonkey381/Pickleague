// Pure season math for LeagueDetail's Standings section and Home's league
// spotlight (plan section 5, slot 3):
//
//   You #2 of 14 · Period 7 locks Oct 20
//   #1 Alice   5-1   3.82
//   #2 You     4-2   3.71
//   #3 Bob     3-3   3.55
//
// The live-period standings here MUST rank exactly like SeasonStandingsScreen's
// default tab (its `computeStandings` + "first non-locked period whose snapshot
// date hasn't passed"), or the strip would say "You #2" and the screen it opens
// would say #3. So this file is the one source of truth for the period dates
// and the standings sort: SeasonStandings' model (components/standings/
// standingsModel.ts) delegates its computePeriodDate / periodStartDate /
// computeStandings here.
//
// Dates are ISO "YYYY-MM-DD" strings throughout, compared as strings, exactly as
// SeasonStandings does. Every date is a LOCAL calendar day: `today` is passed in
// (callers use localIsoDate(new Date()), as SeasonStandings does), and a match
// belongs to the local day it was played on (playedLocalDay), so a 6:30 PM PDT
// match on a lock day counts in that period, not the next. The server agrees in
// the league's zone (migration_local_day_boundaries.sql: auto_lock_due_periods
// locks at 00:05 local on the lock date, and the snapshot's W-L buckets
// played_at by local day), which is the device zone for a league's own members.
// Passing `today` in keeps every function here deterministic and testable.

/** The season columns this file reads (a LeagueSeason row fits). */
export type SeasonInput = {
  name: string;
  start_date: string;
  end_date: string;
  total_weeks: number;
  lock_frequency_weeks: number;
  total_periods: number;
  status: 'upcoming' | 'active' | 'completed';
  baseline_plupr?: number | null;
};

/** A league_members row with the profile name joined (SeasonStandings' shape). */
export type StandingsMember = {
  user_id: string;
  profile?: { full_name?: string | null } | null;
};

/** The match columns the standings read (SeasonStandings' select list). */
export type StandingsMatch = {
  player1_id: string | null;
  partner1_id: string | null;
  player2_id: string | null;
  partner2_id: string | null;
  winner_team: 'team1' | 'team2' | string | null;
  played_at: string | null;
  game_scores?: { t1: number; t2: number }[] | null;
  player1_rating_before?: number | null;
  player1_rating_after?: number | null;
  player2_rating_before?: number | null;
  player2_rating_after?: number | null;
};

export type SeasonStandingRow = {
  user_id: string;
  full_name: string;
  /** Season PLUPR: baseline + the sum of the player's per-match deltas. */
  rating: number;
  wins: number;
  losses: number;
  /** 1-based position after the sort. */
  rank: number;
};

/** The match columns StandingsMatch reads, as a select list (SeasonStandings' list). */
export const STANDINGS_MATCH_COLUMNS =
  'player1_id, partner1_id, player2_id, partner2_id, winner_team, played_at, game_scores,'
  + ' player1_rating_before, player1_rating_after, player2_rating_before, player2_rating_after';

/** The baseline when a season row predates baseline_plupr (SeasonStandings' default). */
export const DEFAULT_BASELINE_PLUPR = 3.5;

/** Rows shown under the strip's headline before "your row". */
export const SEASON_STRIP_TOP_N = 3;

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" in local time for a Date (a date-only value, no time zone shift). */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar day ("YYYY-MM-DD") a match was played on. played_at is a
 *  real instant (timestamptz, e.g. "2026-10-14T01:30:00+00:00"); its UTC date
 *  is the next day for every US evening match. */
export function playedLocalDay(playedAt: string): string {
  return localIsoDate(new Date(playedAt));
}

/** Whether a match played at `playedAt` falls in the [start, end] window, by
 *  local day. Either bound may be a date or a date-time (periodWindow's end is
 *  "YYYY-MM-DDT23:59:59"); only its date part is compared. Both inclusive. */
export function playedInWindow(playedAt: string, start?: string, end?: string): boolean {
  const day = playedLocalDay(playedAt);
  if (start && day < start.slice(0, 10)) return false;
  if (end && day > end.slice(0, 10)) return false;
  return true;
}

/** Shift an ISO date by whole days. Local-midnight parse, so DST never moves the day. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  // UTC arithmetic on the calendar parts: no DST hour can turn 7 days into 6.99.
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Period N's snapshot (lock) date (standingsModel's computePeriodDate). */
export function periodEndDate(s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks'>, n: number): string {
  return addDaysIso(s.start_date, n * s.lock_frequency_weeks * 7);
}

/** First day of period N: the season start for period 1, else the day after
 *  period N-1's snapshot date (standingsModel's periodStartDate). */
export function periodStartDate(s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks'>, n: number): string {
  if (n <= 1) return s.start_date;
  return addDaysIso(periodEndDate(s, n - 1), 1);
}

/** The lowest period that hasn't been locked yet (the next lock), or null when all are. */
export function nextUnlockedPeriod(s: Pick<SeasonInput, 'total_periods'>, locked: ReadonlySet<number>): number | null {
  for (let p = 1; p <= s.total_periods; p++) if (!locked.has(p)) return p;
  return null;
}

/**
 * The period whose standings the strip ranks: SeasonStandings' default tab,
 * the first non-locked period whose snapshot date hasn't passed. When every
 * unlocked period is overdue (an admin hasn't locked yet), the LAST period, as
 * SeasonStandings' default tab does (`findLivePeriod(...) ?? total_periods`),
 * so "You #N" matches the tab the strip opens. null once every period is locked.
 */
export function livePeriodNumber(
  s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks' | 'total_periods'>,
  locked: ReadonlySet<number>,
  today: string,
): number | null {
  for (let p = 1; p <= s.total_periods; p++) {
    if (locked.has(p)) continue;
    if (today > periodEndDate(s, p)) continue;
    return p;
  }
  return nextUnlockedPeriod(s, locked) == null ? null : s.total_periods;
}

/**
 * Season standings over league members, optionally windowed to
 * [startIso, endIso] by the local day of played_at (playedInWindow).
 * Rating = baseline + the player's summed per-match deltas; each game of a
 * multi-game match counts as its own W/L. Sort: rating desc, then (W-L) desc,
 * then W desc. standingsModel's computeStandings wraps this.
 */
export function computeSeasonStandings(
  members: ReadonlyArray<StandingsMember>,
  matches: ReadonlyArray<StandingsMatch>,
  baseline: number,
  startIso?: string,
  endIso?: string,
): SeasonStandingRow[] {
  const inRange = matches.filter((m) => !!m.played_at && playedInWindow(m.played_at, startIso, endIso));
  return members
    .map((m) => {
      const uid = m.user_id;
      let wins = 0;
      let losses = 0;
      let delta = 0;
      for (const x of inRange) {
        const onTeam1 = x.player1_id === uid || x.partner1_id === uid;
        const onTeam2 = x.player2_id === uid || x.partner2_id === uid;
        if (!onTeam1 && !onTeam2) continue;
        const games = Array.isArray(x.game_scores) && x.game_scores.length > 0 ? x.game_scores : null;
        if (games) {
          for (const g of games) {
            if (onTeam1) {
              if (g.t1 > g.t2) wins++;
              else if (g.t2 > g.t1) losses++;
            } else {
              if (g.t2 > g.t1) wins++;
              else if (g.t1 > g.t2) losses++;
            }
          }
        } else if (onTeam1) {
          if (x.winner_team === 'team1') wins++;
          else if (x.winner_team === 'team2') losses++;
        } else {
          if (x.winner_team === 'team2') wins++;
          else if (x.winner_team === 'team1') losses++;
        }
        // Partners share the nominal player's delta (same rule as the screen).
        if (onTeam1 && x.player1_rating_before != null && x.player1_rating_after != null) {
          delta += x.player1_rating_after - x.player1_rating_before;
        } else if (onTeam2 && x.player2_rating_before != null && x.player2_rating_after != null) {
          delta += x.player2_rating_after - x.player2_rating_before;
        }
      }
      return {
        user_id: uid,
        full_name: m.profile?.full_name ?? 'Player',
        rating: baseline + delta,
        wins,
        losses,
        rank: 0,
      };
    })
    .sort((a, b) => b.rating - a.rating || (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The [start, end] window (local days, see playedInWindow) SeasonStandings uses
 *  for an unlocked period. */
export function periodWindow(
  s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks'>,
  n: number,
  today: string,
): { start: string; end: string } {
  const snapshot = periodEndDate(s, n);
  const effectiveEnd = snapshot < today ? snapshot : today;
  return { start: periodStartDate(s, n), end: effectiveEnd + 'T23:59:59' };
}

export type SeasonSummary = {
  seasonName: string;
  /** 'upcoming' until the start date, by date (a season row's status can lag). */
  phase: 'upcoming' | 'active';
  startsOn: string | null;
  /** The ranked period (see livePeriodNumber), null once every period is locked. */
  period: number | null;
  totalPeriods: number;
  /** The next lock (the lowest unlocked period), null once every period is locked. */
  nextPeriod: number | null;
  /** The next lock's date (the lowest unlocked period's snapshot date). */
  nextLockOn: string | null;
  /** The season's end_date. The last lock falls on it only when the weeks
   *  divide evenly (total_periods is total_weeks / lock_frequency_weeks,
   *  integer division), so the status line checks before saying "Season ends". */
  endsOn: string | null;
  /** That lock's date has arrived and it still isn't locked: due ON the date
   *  itself (local), exactly when SeasonStandings enables its Lock button. */
  lockDue: boolean;
  /** At least one match counted in the ranked period. Ranks show only then:
   *  before the first match everyone sits on the baseline and "#2" means nothing. */
  hasMatches: boolean;
  myRank: number | null;
  /** The first SEASON_STRIP_TOP_N rows (empty without matches). Only the unit
   *  tests read `top`/`me` now (the strip ranks via useLeagueStandings). */
  top: SeasonStandingRow[];
  /** The viewer's row when it isn't already in `top`. */
  me: SeasonStandingRow | null;
};

export type SummarizeSeasonArgs = {
  season: SeasonInput;
  /** Period numbers that have locked snapshots (season_snapshots). */
  lockedPeriods: Iterable<number>;
  members: ReadonlyArray<StandingsMember>;
  /** Matches covering at least the ranked period's window (extra rows are filtered out). */
  matches: ReadonlyArray<StandingsMatch>;
  myUserId: string | null;
  /** The viewer's LOCAL calendar date (localIsoDate). */
  today: string;
  topN?: number;
};

export function summarizeSeason({
  season,
  lockedPeriods,
  members,
  matches,
  myUserId,
  today,
  topN = SEASON_STRIP_TOP_N,
}: SummarizeSeasonArgs): SeasonSummary {
  const locked = new Set(lockedPeriods);
  const base: SeasonSummary = {
    seasonName: season.name,
    phase: 'active',
    startsOn: null,
    period: null,
    totalPeriods: season.total_periods,
    nextPeriod: null,
    nextLockOn: null,
    endsOn: season.end_date ? season.end_date.slice(0, 10) : null,
    lockDue: false,
    hasMatches: false,
    myRank: null,
    top: [],
    me: null,
  };

  if (today < season.start_date) {
    return { ...base, phase: 'upcoming', startsOn: season.start_date };
  }

  const next = nextUnlockedPeriod(season, locked);
  const nextLockOn = next != null ? periodEndDate(season, next) : null;
  const period = livePeriodNumber(season, locked, today);
  const summary: SeasonSummary = {
    ...base,
    period,
    nextPeriod: next,
    nextLockOn,
    // >=, not >: due on the snapshot date itself, like isLockDue (now >= due).
    lockDue: nextLockOn != null && season.status !== 'completed' && today >= nextLockOn,
  };
  if (period == null) return summary;

  const { start, end } = periodWindow(season, period, today);
  const inWindow = matches.some((m) => !!m.played_at && playedInWindow(m.played_at, start, end));
  if (!inWindow) return summary;

  const baseline = Number(season.baseline_plupr ?? DEFAULT_BASELINE_PLUPR);
  const rows = computeSeasonStandings(members, matches, baseline, start, end);
  const top = rows.slice(0, Math.max(0, topN));
  const mine = myUserId ? rows.find((r) => r.user_id === myUserId) ?? null : null;
  return {
    ...summary,
    hasMatches: true,
    myRank: mine?.rank ?? null,
    top,
    me: mine && mine.rank > top.length ? mine : null,
  };
}

/** "Oct 20" for an ISO date, in the device locale (or `locale`). */
export function shortDate(iso: string, locale?: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * A date as the status line says it, from the viewer's local `today`:
 * "today", "tomorrow", "Thu Oct 16" within the next 6 days, else "Oct 20".
 * Whole calendar days (daysBetween), so a DST change never shifts the cut.
 */
export function relativeShortDate(iso: string, today: string, locale?: string): string {
  const days = daysBetween(today, iso);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const md = shortDate(iso, locale);
  if (days > 1 && days <= 6) {
    return `${new Date(iso + 'T00:00:00').toLocaleDateString(locale, { weekday: 'short' })} ${md}`;
  }
  return md;
}

/** The season facts the status line reads (a SeasonSummary fits). */
export type SeasonStatusFacts = Pick<SeasonSummary, 'phase' | 'startsOn' | 'nextPeriod' | 'nextLockOn' | 'endsOn' | 'totalPeriods' | 'lockDue'>;

type StatusDateOpts = {
  isAdmin?: boolean;
  now: Date;
  locale?: string;
  /** A list row's short form (LeaguesScreen, a 1-line subtitle): "P7 locks
   *  Oct 20", "Ends Dec 1", "P7 locking soon", no weekday or "tomorrow". */
  compact?: boolean;
};

/**
 * The status line's date part: the next date that matters. Upcoming: "Starts
 * Nov 3". Mid-season: "Period 7 locks Oct 20"; when that lock is the last
 * period's and falls on end_date, it IS the season end: "Season ends Dec 1"
 * (a season whose weeks don't divide evenly reads "Final lock Nov 17", since
 * it still runs to end_date). A lock that is due (its date has arrived,
 * local) is admin information, so admins read "Lock due" (it drives Manage)
 * and members the date-free "Period 7 locking soon" / "Season ending soon" /
 * "Final lock soon". Every period locked but the season not completed yet:
 * "Final standings soon". Due is re-checked against `now`, so a cached
 * summary never says "locks today" for a lock that is already due.
 * `compact` gives the short forms ("P7 locks Oct 20", "Ends Dec 1").
 */
export function seasonDatePart(s: SeasonStatusFacts, { isAdmin = false, now, locale, compact = false }: StatusDateOpts): string {
  const today = localIsoDate(now);
  const fmt = (iso: string) => (compact ? shortDate(iso, locale) : relativeShortDate(iso, today, locale));
  const period = compact ? `P${s.nextPeriod}` : `Period ${s.nextPeriod}`;
  if (s.phase === 'upcoming') {
    return s.startsOn ? `Starts ${fmt(s.startsOn)}` : 'Starts soon';
  }
  if (s.nextPeriod == null || s.nextLockOn == null) return compact ? 'Final soon' : 'Final standings soon';
  const last = s.nextPeriod >= s.totalPeriods;
  // The last lock is the season's end only when the weeks divide evenly
  // (total_periods is total_weeks / lock_frequency_weeks, integer division).
  const endsWithLock = last && (s.endsOn == null || s.endsOn === s.nextLockOn);
  if (s.lockDue || s.nextLockOn <= today) {
    if (isAdmin) return 'Lock due';
    if (endsWithLock) return compact ? 'Ending soon' : 'Season ending soon';
    return last ? 'Final lock soon' : `${period} locking soon`;
  }
  const when = fmt(s.nextLockOn);
  if (endsWithLock) return compact ? `Ends ${when}` : `Season ends ${when}`;
  return last ? `Final lock ${when}` : `${period} locks ${when}`;
}

export type SeasonStatusArgs = StatusDateOpts & {
  /** The active / upcoming season's facts; null for a completed season's final standings. */
  summary: SeasonStatusFacts | null;
  /** The viewer's rank in the standings shown beside the line, null when unranked. */
  myRank: number | null;
  /** Rows in those SAME standings: the "of 14". */
  rankedCount: number;
};

/**
 * The season's one status line (LeagueDetail's Standings section and Home's
 * spotlight), your rank out of everyone ranked + the next date that matters:
 *   "You #2 of 14 · Period 7 locks Oct 20"     mid-season
 *   "You #2 of 14 · Season ends Dec 1"         last period (on end_date)
 *   "You #2 of 14 · Final lock Nov 17"         last period, before end_date
 *   "14 players · Period 7 locks Oct 20"       not ranked (no matches / not in the table)
 *   "Starts Nov 3"                             upcoming
 *   "Final · You #3 of 14" / "Final · 14 players"   completed
 * See seasonDatePart for the due / admin forms.
 */
export function seasonStatusLine({ summary, myRank, rankedCount, ...opts }: SeasonStatusArgs): string {
  const who = myRank != null
    ? `You #${myRank} of ${rankedCount}`
    : `${rankedCount} player${rankedCount === 1 ? '' : 's'}`;
  if (!summary) return `Final · ${who}`;
  if (summary.phase === 'upcoming') return seasonDatePart(summary, opts);
  return `${who} · ${seasonDatePart(summary, opts)}`;
}

/**
 * A season's status facts from its dates alone, for a list row that doesn't
 * read the season's locks (LeaguesScreen): the next lock is the first period
 * whose lock date hasn't passed, and one that has passed reads as due.
 * `today` is the viewer's local date.
 */
export function seasonDateFacts(
  s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks' | 'total_periods'> & { end_date?: string | null },
  today: string,
): SeasonStatusFacts {
  const endsOn = s.end_date ? s.end_date.slice(0, 10) : null;
  if (today < s.start_date) {
    return { phase: 'upcoming', startsOn: s.start_date, nextPeriod: null, nextLockOn: null, endsOn, totalPeriods: s.total_periods, lockDue: false };
  }
  const next = livePeriodNumber(s, new Set(), today);
  const nextLockOn = next != null ? periodEndDate(s, next) : null;
  return {
    phase: 'active',
    startsOn: null,
    nextPeriod: next,
    nextLockOn,
    endsOn,
    totalPeriods: s.total_periods,
    lockDue: nextLockOn != null && nextLockOn <= today,
  };
}

/**
 * Which season the Standings tile opens (plan section 5): the active or
 * upcoming season, else the most recent completed one, else none (the tile is
 * then disabled and says "No season yet"). `completedNewestFirst` is ordered
 * by end_date descending, as LeagueDetail loads it.
 */
export function standingsTargetSeasonId(
  activeOrUpcoming: { id: string } | null | undefined,
  completedNewestFirst: ReadonlyArray<{ id: string }>,
): string | null {
  return activeOrUpcoming?.id ?? completedNewestFirst[0]?.id ?? null;
}
