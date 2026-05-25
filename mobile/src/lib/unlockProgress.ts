import { supabase } from './supabase';

// One badge's progress toward being earned. `perLeague` badges have no global
// threshold we can compute account-wide (they're tracked per-league by DB
// triggers), so their `current`/`target`/`pct` are not meaningful — callers
// that surface "closest to earning" should filter them out.
export type BadgeProgress = {
  badge: string;        // badge name
  current: number;
  target: number;
  pct: number;          // 0..1
  label: string;        // e.g. "3 / 5 wins in a row"
  earned: boolean;
  perLeague: boolean;   // true for league-tracked badges with no global threshold
};

// Account-wide threshold badges. Mirrors the inline definitions previously in
// UnlockProgressScreen. Each builds a BadgeProgress from a computed `current`
// value. perLeague badges are added separately (no global threshold).
type ThresholdDef = {
  badge: string;
  target: number;
  value: (m: Metrics) => number;
  label: (current: number, target: number) => string;
  // Progress baseline. pct is measured from `floor` (default 0) up to target,
  // so e.g. a rating that starts at 3.25 doesn't read as 81% toward a 4.0 goal.
  floor?: number;
};

type Metrics = {
  streak: number;
  courts: number;
  doublesPlayed: number;
  singlesPlayed: number;
  memberDays: number;
  elo: number;
  totalMatches: number;
};

const THRESHOLDS: ThresholdDef[] = [
  { badge: 'First Rally',        target: 1,   value: m => m.totalMatches,   label: (c, t) => `${c} / ${t} matches played` },
  { badge: 'Hot Streak',         target: 5,   value: m => m.streak,         label: (c, t) => `${c} / ${t} wins in a row` },
  { badge: 'Top Rated',          target: 4.0, floor: 3.25, value: m => m.elo, label: (c, t) => `${c.toFixed(2)} / ${t.toFixed(2)} PLUPR` },
  { badge: 'Veteran',            target: 30,  value: m => m.memberDays,     label: (c, t) => `${c} / ${t} days as member` },
  { badge: 'Court Hopper',       target: 5,   value: m => m.courts,         label: (c, t) => `${c} / ${t} courts played` },
  { badge: 'Doubles Dynamo',     target: 20,  value: m => m.doublesPlayed,  label: (c, t) => `${c} / ${t} doubles matches` },
  { badge: 'Singles Specialist', target: 25,  value: m => m.singlesPlayed,  label: (c, t) => `${c} / ${t} singles matches` },
];

// League-tracked badges with no global threshold. Progress is tracked per
// league by DB triggers, so we can't compute an account-wide percentage.
const PER_LEAGUE_BADGES = [
  'League Leader',
  'Hat Trick',
  'Home Court Hero',
  'League Regular',
  'Dominant',
  'Iron Player',
  'Comeback King',
] as const;

/**
 * Compute progress toward every progression badge for a user, account-wide.
 *
 * Returns threshold badges with a real current/target/pct plus the per-league
 * badges (pct 0, perLeague true). `earned` reflects the user's player_badges.
 *
 * Sorted so the badges closest to being earned come first: not-yet-earned,
 * non-perLeague badges by descending pct, then everything else.
 */
export async function computeBadgeProgress(userId: string): Promise<BadgeProgress[]> {
  const [profileRes, badgesRes, matchesRes] = await Promise.all([
    supabase.from('profiles').select('rating, created_at').eq('id', userId).single(),
    supabase.from('player_badges').select('badge:badges(name)').eq('user_id', userId),
    supabase
      .from('matches')
      .select('match_type, player1_id, partner1_id, player2_id, partner2_id, winner_team, location_name')
      .or(`player1_id.eq.${userId},partner1_id.eq.${userId},player2_id.eq.${userId},partner2_id.eq.${userId}`)
      .order('played_at', { ascending: false })
      .limit(200),
  ]);

  const earnedNames = new Set(
    ((badgesRes.data ?? []) as any[]).map(b => b.badge?.name).filter(Boolean) as string[],
  );

  const prof = profileRes.data as { rating: number | null; created_at: string } | null;
  const mx = (matchesRes.data ?? []) as any[];

  const didWin = (m: any) => {
    const t1 = m.player1_id === userId || m.partner1_id === userId;
    return (t1 && m.winner_team === 'team1') || (!t1 && m.winner_team === 'team2');
  };
  let streak = 0;
  for (const m of mx) { if (didWin(m)) streak++; else break; }

  const metrics: Metrics = {
    streak,
    courts: new Set(mx.map(m => m.location_name).filter(Boolean)).size,
    doublesPlayed: mx.filter(m => m.match_type === 'doubles').length,
    singlesPlayed: mx.filter(m => m.match_type === 'singles').length,
    memberDays: prof ? Math.floor((Date.now() - new Date(prof.created_at).getTime()) / 86_400_000) : 0,
    elo: prof?.rating ?? 3.25,
    totalMatches: mx.length,
  };

  const result: BadgeProgress[] = THRESHOLDS.map(def => {
    const current = def.value(metrics);
    const lo = def.floor ?? 0;
    const pct = def.target > lo
      ? Math.min(Math.max((current - lo) / (def.target - lo), 0), 1)
      : 0;
    return {
      badge: def.badge,
      current,
      target: def.target,
      pct,
      label: def.label(current, def.target),
      earned: earnedNames.has(def.badge),
      perLeague: false,
    };
  });

  for (const badge of PER_LEAGUE_BADGES) {
    result.push({
      badge,
      current: 0,
      target: 0,
      pct: 0,
      label: 'Progress tracked per-league',
      earned: earnedNames.has(badge),
      perLeague: true,
    });
  }

  // Closest-to-earning first: not-yet-earned non-perLeague by descending pct,
  // then everything else (earned, or perLeague).
  return result.sort((a, b) => {
    const aRankable = !a.earned && !a.perLeague;
    const bRankable = !b.earned && !b.perLeague;
    if (aRankable && bRankable) return b.pct - a.pct;
    if (aRankable) return -1;
    if (bRankable) return 1;
    return 0;
  });
}
