// Saved (BookmarksScreen) shows "where am I" for every league on it, so the
// standings you care about are one tap from Saved instead of three
// (Saved -> league -> Standings). This file is the PURE half: which season a
// row points at, my rank in it, and the one line the row prints. The loads
// (batched across every saved league, no per-league round trips) are in
// lib/savedStandingsData.ts.
//
// The season choice and the ranking mirror components/league/useLeagueStandings
// (LeagueDetail's Standings section), which mirrors SeasonStandings' DEFAULT
// tab, so "You #3 of 16" here is the row the tap lands on:
//   1. an active/upcoming season (newest created): before its start date it is
//      'upcoming'; otherwise the live period's computed table ('live'), or the
//      period that just locked ('locked'), or 'noMatches' when nothing counted;
//   2. else the newest completed season's final standings ('final');
//   3. else 'none' (no season ever): the row opens the league itself.
// No React / React Native imports, so vitest exercises it directly.
import {
  computeSeasonStandings, periodStartDate, periodWindow, playedInWindow, shortDate,
  type SeasonInput, type StandingsMatch,
} from './seasonSummary';
import { findLivePeriod } from '../components/standings/standingsModel';

/** A league_seasons row (select *) fits. */
export type SavedSeason = SeasonInput & {
  id: string;
  league_id: string;
  created_at?: string | null;
};

/** The snapshot columns this file reads. */
export type SavedSnapshot = {
  season_id: string;
  period_number: number;
  user_id: string;
  rank_at_snapshot: number;
};

/** The season_final_standings columns this file reads. */
export type SavedFinal = { season_id: string; user_id: string; final_rank: number };

export type SavedStandingKind = 'live' | 'locked' | 'noMatches' | 'upcoming' | 'final' | 'none';

export type SavedStanding = {
  leagueId: string;
  kind: SavedStandingKind;
  /** The season a tap opens (SeasonStandings); null = open the league. */
  seasonId: string | null;
  seasonName: string | null;
  /** The ranked period ('live' / 'locked'), else null. */
  period: number | null;
  totalPeriods: number | null;
  /** My rank in the ranked rows; null when I'm not in them (or nothing is ranked). */
  myRank: number | null;
  /** How many rows are ranked (the "of 16"). */
  rankedCount: number;
  /** 'upcoming': the start date (YYYY-MM-DD). */
  startsOn: string | null;
};

/** The two seasons a league's row can point at, picked from one batched read. */
export function pickLeagueSeasons(
  seasons: ReadonlyArray<SavedSeason>,
): Map<string, { current: SavedSeason | null; completed: SavedSeason | null }> {
  const out = new Map<string, { current: SavedSeason | null; completed: SavedSeason | null }>();
  for (const s of seasons) {
    const slot = out.get(s.league_id) ?? { current: null, completed: null };
    if (s.status === 'completed') {
      // Newest end date wins (LeagueDetail's completed list, [0]).
      if (!slot.completed || s.end_date > slot.completed.end_date) slot.completed = s;
    } else {
      // Newest created wins (LeagueDetail's active/upcoming query).
      if (!slot.current || (s.created_at ?? '') > (slot.current.created_at ?? '')) slot.current = s;
    }
    out.set(s.league_id, slot);
  }
  return out;
}

/** The period SeasonStandings' default tab ranks for an active season, or null when none is ranked yet. */
export function rankedPeriod(season: SavedSeason, locked: ReadonlySet<number>, today: string): number | null {
  const tab = findLivePeriod({ ...season, status: 'active' }, locked, today) ?? season.total_periods;
  // The live period starts tomorrow (the last one locked on its lock day):
  // rank the period that just locked, as LeagueDetail does.
  if (!locked.has(tab) && periodStartDate(season, tab) > today) {
    return locked.size > 0 ? Math.max(...locked) : null;
  }
  return tab;
}

/** The [start, end] window to read a live season's matches for (null = no match read needed). */
export function liveMatchWindow(
  season: SavedSeason,
  snaps: ReadonlyArray<SavedSnapshot>,
  today: string,
): { start: string; end: string } | null {
  if (today < season.start_date) return null;
  const locked = lockedPeriods(season.id, snaps);
  const p = rankedPeriod(season, locked, today);
  if (p == null || locked.has(p)) return null;
  return periodWindow(season, p, today);
}

function lockedPeriods(seasonId: string, snaps: ReadonlyArray<SavedSnapshot>): Set<number> {
  const out = new Set<number>();
  for (const r of snaps) if (r.season_id === seasonId) out.add(r.period_number);
  return out;
}

export type SavedStandingInput = {
  leagueId: string;
  current: SavedSeason | null;
  completed: SavedSeason | null;
  /** The league's member ids. */
  memberIds: ReadonlyArray<string>;
  /** Snapshots of `current` (other seasons' rows are ignored). */
  snaps: ReadonlyArray<SavedSnapshot>;
  /** Final standings of `completed` (other seasons' rows are ignored). */
  finals: ReadonlyArray<SavedFinal>;
  /** The league's completed matches covering the live window (others are filtered out). */
  matches: ReadonlyArray<StandingsMatch>;
  myUserId: string | null;
  /** LOCAL calendar day, YYYY-MM-DD (localIsoDate). */
  today: string;
};

export function savedLeagueStanding(i: SavedStandingInput): SavedStanding {
  const none: SavedStanding = {
    leagueId: i.leagueId, kind: 'none', seasonId: null, seasonName: null, period: null,
    totalPeriods: null, myRank: null, rankedCount: i.memberIds.length, startsOn: null,
  };
  const s = i.current;
  if (s) {
    const base: SavedStanding = {
      ...none, seasonId: s.id, seasonName: s.name, totalPeriods: s.total_periods,
    };
    if (i.today < s.start_date) return { ...base, kind: 'upcoming', startsOn: s.start_date };

    const snaps = i.snaps.filter((r) => r.season_id === s.id);
    const locked = lockedPeriods(s.id, snaps);
    const p = rankedPeriod(s, locked, i.today);
    if (p != null && locked.has(p)) {
      const rows = snaps.filter((r) => r.period_number === p);
      if (rows.length > 0) {
        const mine = i.myUserId ? rows.find((r) => r.user_id === i.myUserId) : undefined;
        return { ...base, kind: 'locked', period: p, myRank: mine?.rank_at_snapshot ?? null, rankedCount: rows.length };
      }
    }
    if (p == null || locked.has(p)) return { ...base, kind: 'noMatches', period: p };

    const w = periodWindow(s, p, i.today);
    const inWindow = i.matches.filter((m) => !!m.played_at && playedInWindow(m.played_at, w.start, w.end));
    if (inWindow.length === 0) return { ...base, kind: 'noMatches', period: p };
    const baseline = Number(s.baseline_plupr ?? 3.5);
    const rows = computeSeasonStandings(i.memberIds.map((user_id) => ({ user_id })), inWindow, baseline, w.start, w.end);
    const mine = i.myUserId ? rows.find((r) => r.user_id === i.myUserId) : undefined;
    return { ...base, kind: 'live', period: p, myRank: mine?.rank ?? null, rankedCount: rows.length };
  }

  const c = i.completed;
  if (c) {
    const rows = i.finals.filter((r) => r.season_id === c.id);
    const mine = i.myUserId ? rows.find((r) => r.user_id === i.myUserId) : undefined;
    return {
      ...none, kind: 'final', seasonId: c.id, seasonName: c.name, totalPeriods: c.total_periods,
      // No stored finals (a season completed outside complete_season): the
      // screen rebuilds them; the row just names the season.
      myRank: mine?.final_rank ?? null, rankedCount: rows.length,
    };
  }
  return none;
}

/**
 * A standing whose reads came back truncated (at the row cap): keep the season
 * (the tap still opens its standings) but show no rank and no line.
 */
export function unknownStanding(s: SavedStanding): SavedStanding {
  return { ...s, kind: 'none', period: null, myRank: null };
}

/**
 * The SeasonStandings params a Saved league row's tap uses, or null to open
 * the league page instead. Carries the period the line named ("P6 locked"),
 * which differs from the screen's default tab when the next period starts
 * tomorrow, so the tap lands on the table the line described.
 */
export function savedStandingsParams(
  s: SavedStanding | undefined,
  leagueId: string,
  leagueName: string,
): { seasonId: string; leagueId: string; leagueName: string; focusMe: true; period?: number } | null {
  if (!s?.seasonId) return null;
  const base = { seasonId: s.seasonId, leagueId, leagueName, focusMe: true as const };
  return (s.kind === 'live' || s.kind === 'locked') && s.period != null ? { ...base, period: s.period } : base;
}

/**
 * The row's one line:
 *   live      "You #3 of 16 · Fall 2026 · P7"
 *   locked    "You #3 of 16 · Fall 2026 · P6 locked"
 *   noMatches "Fall 2026 · P7 · no matches yet"
 *   upcoming  "Fall 2026 starts Nov 3"
 *   final     "Finished #2 of 14 · Spring 2026"
 *   none      null (the caller keeps its own subtitle)
 * Without a rank of mine, the count leads: "16 players · Fall 2026 · P7".
 */
export function savedStandingLine(s: SavedStanding, opts: { locale?: string } = {}): string | null {
  const name = s.seasonName ?? 'Season';
  const periodPart = s.period != null && (s.totalPeriods ?? 0) > 1 ? `P${s.period}` : null;
  const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ');
  const count = `${s.rankedCount} player${s.rankedCount === 1 ? '' : 's'}`;
  switch (s.kind) {
    case 'live':
      return join(s.myRank != null ? `You #${s.myRank} of ${s.rankedCount}` : count, name, periodPart);
    case 'locked':
      return join(
        s.myRank != null ? `You #${s.myRank} of ${s.rankedCount}` : count,
        name,
        periodPart ? `${periodPart} locked` : 'locked',
      );
    case 'noMatches':
      return join(name, periodPart, 'no matches yet');
    case 'upcoming':
      return s.startsOn ? `${name} starts ${shortDate(s.startsOn, opts.locale)}` : `${name} · upcoming`;
    case 'final':
      return s.myRank != null && s.rankedCount > 0
        ? join(`Finished #${s.myRank} of ${s.rankedCount}`, name)
        : join(name, 'final standings');
    case 'none':
    default:
      return null;
  }
}

/** The screen-reader version: "#3 of 16" reads as "number 3 of 16" otherwise. */
export function savedStandingA11y(s: SavedStanding, opts: { locale?: string } = {}): string | null {
  const line = savedStandingLine(s, opts);
  if (!line) return null;
  return line.replace(/#(\d+) of (\d+)/g, 'ranked $1 of $2').replace(/\bP(\d+)\b/g, 'period $1').replace(/ · /g, ', ');
}

/** A completed tournament's finish for me, from tournament_final_ranks rows. */
export type TournamentFinish = { rank: number; of: number };

export function tournamentFinishes(
  rows: ReadonlyArray<{ tournament_id: string; user_id: string; final_rank: number }>,
  myUserId: string | null,
): Map<string, TournamentFinish> {
  const counts = new Map<string, number>();
  const mine = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.tournament_id, (counts.get(r.tournament_id) ?? 0) + 1);
    if (myUserId && r.user_id === myUserId) mine.set(r.tournament_id, r.final_rank);
  }
  const out = new Map<string, TournamentFinish>();
  for (const [tid, rank] of mine) out.set(tid, { rank, of: counts.get(tid) ?? rank });
  return out;
}

/** "Finished #2 of 8". */
export function tournamentFinishLine(f: TournamentFinish | null | undefined): string | null {
  return f ? `Finished #${f.rank} of ${f.of}` : null;
}

/**
 * Saved's "Your leagues" suggestions: leagues I'm a member of, still active,
 * and not saved yet, in the order given (newest joined first), at most `max`.
 */
export function leagueSuggestions<T extends { id: string; is_active?: boolean | null }>(
  myLeagues: ReadonlyArray<T>,
  savedLeagueIds: ReadonlySet<string>,
  max = 5,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of myLeagues) {
    if (l.is_active === false || savedLeagueIds.has(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/** The season a league-level standings link (/leagues/:id/standings) opens. */
export function standingsSeasonFor(
  seasons: ReadonlyArray<SavedSeason>,
  leagueId: string,
): string | null {
  const slot = pickLeagueSeasons(seasons.filter((s) => s.league_id === leagueId)).get(leagueId);
  return slot?.current?.id ?? slot?.completed?.id ?? null;
}
