// Pure season math for LeagueDetail's season strip (plan section 5, slot 3):
//
//   Fall · Wk 7 of 12 · You #2 · locks Oct 20 >
//   #1 Alice   5-1   3.82
//   #2 You     4-2   3.71
//   #3 Bob     3-3   3.55
//
// The live-period standings here MUST rank exactly like SeasonStandingsScreen's
// default tab (its `computeStandings` + "first non-locked period whose snapshot
// date hasn't passed"), or the strip would say "You #2" and the screen it opens
// would say #3. So the period helpers and the sort below mirror that screen line
// for line; change both together. (SeasonStandings can import these instead of
// its private copies; until then they are duplicates by design.)
//
// Dates are ISO "YYYY-MM-DD" strings throughout, compared as strings, exactly as
// SeasonStandings does. `today` is passed in (the caller uses the same UTC date
// SeasonStandings uses: `new Date().toISOString().slice(0, 10)`), which keeps
// every function here deterministic and testable. The one exception is the
// lock-due flag: SeasonStandings' Lock button (standingsModel's isLockDue) turns
// on at LOCAL midnight of the snapshot date, so lockDue takes a local date
// (`lockToday`, see SummarizeSeasonArgs) and compares with >=.

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

/** The baseline when a season row predates baseline_plupr (SeasonStandings' default). */
export const DEFAULT_BASELINE_PLUPR = 3.5;

/** Rows shown under the strip's headline before "your row". */
export const SEASON_STRIP_TOP_N = 3;

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" in local time for a Date (a date-only value, no time zone shift). */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** Period N's snapshot (lock) date. Mirrors SeasonStandings' computePeriodDate. */
export function periodEndDate(s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks'>, n: number): string {
  return addDaysIso(s.start_date, n * s.lock_frequency_weeks * 7);
}

/** First day of period N: the season start for period 1, else the day after
 *  period N-1's snapshot date. Mirrors SeasonStandings' periodStartDate. */
export function periodStartDate(s: Pick<SeasonInput, 'start_date' | 'lock_frequency_weeks'>, n: number): string {
  if (n <= 1) return s.start_date;
  return addDaysIso(periodEndDate(s, n - 1), 1);
}

/** 1-based season week on `today`, clamped to the season's length; null before it starts. */
export function seasonWeek(s: Pick<SeasonInput, 'start_date' | 'total_weeks'>, today: string): number | null {
  const days = daysBetween(s.start_date, today);
  if (days < 0) return null;
  const week = Math.floor(days / 7) + 1;
  return Math.max(1, Math.min(week, Math.max(1, s.total_weeks)));
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
 * [startIso, endIso] on played_at (string compare, as SeasonStandings does).
 * Rating = baseline + the player's summed per-match deltas; each game of a
 * multi-game match counts as its own W/L. Sort: rating desc, then (W-L) desc,
 * then W desc. A copy of SeasonStandings' computeStandings.
 */
export function computeSeasonStandings(
  members: ReadonlyArray<StandingsMember>,
  matches: ReadonlyArray<StandingsMatch>,
  baseline: number,
  startIso?: string,
  endIso?: string,
): SeasonStandingRow[] {
  const inRange = matches.filter((m) => {
    if (!m.played_at) return false;
    if (startIso && m.played_at < startIso) return false;
    if (endIso && m.played_at > endIso) return false;
    return true;
  });
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

/** The [start, end] played_at window SeasonStandings uses for an unlocked period. */
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
  week: number | null;
  totalWeeks: number;
  /** The ranked period (see livePeriodNumber), null once every period is locked. */
  period: number | null;
  totalPeriods: number;
  /** The next lock's date (the lowest unlocked period's snapshot date). */
  nextLockOn: string | null;
  /** That lock's date has arrived and it still isn't locked: due ON the date
   *  itself (local), exactly when SeasonStandings enables its Lock button. */
  lockDue: boolean;
  /** At least one match counted in the ranked period. Ranks show only then:
   *  before the first match everyone sits on the baseline and "#2" means nothing. */
  hasMatches: boolean;
  myRank: number | null;
  /** The first SEASON_STRIP_TOP_N rows (empty without matches). */
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
  today: string;
  /** The LOCAL calendar date for the lock-due check (lib's localIsoDate), to
   *  match isLockDue's local-midnight due time; defaults to `today`. The period
   *  windows keep using the UTC `today`, as SeasonStandings' tabs do. */
  lockToday?: string;
  topN?: number;
};

export function summarizeSeason({
  season,
  lockedPeriods,
  members,
  matches,
  myUserId,
  today,
  lockToday,
  topN = SEASON_STRIP_TOP_N,
}: SummarizeSeasonArgs): SeasonSummary {
  const locked = new Set(lockedPeriods);
  const base: SeasonSummary = {
    seasonName: season.name,
    phase: 'active',
    startsOn: null,
    week: null,
    totalWeeks: season.total_weeks,
    period: null,
    totalPeriods: season.total_periods,
    nextLockOn: null,
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
    week: seasonWeek(season, today),
    period,
    nextLockOn,
    // >=, not >: due on the snapshot date itself, like isLockDue (now >= due).
    lockDue: nextLockOn != null && season.status !== 'completed' && (lockToday ?? today) >= nextLockOn,
  };
  if (period == null) return summary;

  const { start, end } = periodWindow(season, period, today);
  const inWindow = matches.some((m) => !!m.played_at && m.played_at >= start && m.played_at <= end);
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

/** "Oct 20" for an ISO date, in the device locale. */
export function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The strip's one line, e.g. "Fall · Wk 7 of 12 · You #2 · locks Oct 20".
 * Upcoming: "Fall · Starts Nov 3". `fmt` formats an ISO date (tests pass a
 * fixed one; the app uses the device locale).
 */
export function seasonHeadline(s: SeasonSummary, fmt: (iso: string) => string = shortDate): string {
  const parts: (string | null)[] = [s.seasonName];
  if (s.phase === 'upcoming') {
    parts.push(s.startsOn ? `Starts ${fmt(s.startsOn)}` : null);
  } else {
    parts.push(s.week != null ? `Wk ${s.week} of ${s.totalWeeks}` : null);
    parts.push(s.myRank != null ? `You #${s.myRank}` : null);
    parts.push(s.lockDue ? 'Lock due' : s.nextLockOn ? `locks ${fmt(s.nextLockOn)}` : null);
  }
  return parts.filter((p): p is string => !!p && !!p.trim()).join(' · ');
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
