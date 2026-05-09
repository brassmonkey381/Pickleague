/**
 * Partner Chemistry — measures how much two players' win rate improves
 * (or worsens) when paired together versus each player's baseline.
 *
 * Matrix approach:
 *   For player A paired with player B we build two win-rate vectors
 *   indexed by opponent ELO bucket:
 *
 *     together[bucket] = wins_together / matches_together
 *     without[bucket]  = wins_without  / matches_without   (A with any other partner)
 *
 *   chemistry_delta[bucket] = together[bucket] - without[bucket]
 *
 *   overall_delta = weighted mean of chemistry_delta
 *                   (weight = min(matches_together, matches_without) per bucket)
 *
 * If per-bucket data is too sparse we fall back to:
 *   overall_delta = win_rate_together - baseline_win_rate
 */

export const ELO_BUCKETS = ['< 900', '900–1100', '1100–1300', '1300+'] as const;
export type EloBucket = typeof ELO_BUCKETS[number];

export type BucketStats = {
  label:    EloBucket;
  together: { wins: number; total: number };
  without:  { wins: number; total: number };
  /** together win% - without win%, NaN when either side is empty */
  delta: number;
};

export type ChemistryResult = {
  partnerId:         string;
  matchesTogether:   number;
  winRateTogether:   number;  // 0–1, NaN if 0 matches together
  baselineWinRate:   number;  // 0–1 (A with all other partners), NaN if insufficient
  overallDelta:      number;  // signed, e.g. 0.12 = "+12%"
  significant:       boolean; // true when matchesTogether >= 5
  buckets:           BucketStats[];
  insights:          string[];
};

// Minimal shape from matches table (select only what's needed)
export type DoublesMatch = {
  player1_id:            string;
  partner1_id:           string | null;
  player2_id:            string;
  partner2_id:           string | null;
  winner_team:           'team1' | 'team2' | null;
  player1_rating_before: number | null;
  player2_rating_before: number | null;
};

function eloBucket(elo: number): EloBucket {
  if (elo < 900)  return '< 900';
  if (elo < 1100) return '900–1100';
  if (elo < 1300) return '1100–1300';
  return '1300+';
}

/** True if myId is on the winning team in match m */
function didWin(m: DoublesMatch, myId: string): boolean {
  const onTeam1 = m.player1_id === myId || m.partner1_id === myId;
  return (onTeam1 && m.winner_team === 'team1') ||
         (!onTeam1 && m.winner_team === 'team2');
}

/** Approximate opponent ELO — only team-captain rating is stored */
function opponentElo(m: DoublesMatch, myId: string): number {
  const onTeam1 = m.player1_id === myId || m.partner1_id === myId;
  return onTeam1
    ? (m.player2_rating_before ?? 1000)
    : (m.player1_rating_before ?? 1000);
}

/** True if myId and partnerId were on the same team */
function playedTogether(m: DoublesMatch, myId: string, partnerId: string): boolean {
  return (
    (m.player1_id === myId  && m.partner1_id === partnerId) ||
    (m.partner1_id === myId && m.player1_id  === partnerId) ||
    (m.player2_id === myId  && m.partner2_id === partnerId) ||
    (m.partner2_id === myId && m.player2_id  === partnerId)
  );
}

/** True if myId was in the match (any position) */
function wasInMatch(m: DoublesMatch, myId: string): boolean {
  return m.player1_id === myId || m.partner1_id === myId ||
         m.player2_id === myId || m.partner2_id === myId;
}

export function computeChemistry(
  myId:      string,
  partnerId: string,
  doubles:   DoublesMatch[],
): ChemistryResult {
  const together = doubles.filter(m => playedTogether(m, myId, partnerId));
  const without  = doubles.filter(m => wasInMatch(m, myId) && !playedTogether(m, myId, partnerId));

  // Build per-bucket matrix
  const buckets: BucketStats[] = ELO_BUCKETS.map(label => ({
    label,
    together: { wins: 0, total: 0 },
    without:  { wins: 0, total: 0 },
    delta:    NaN,
  }));

  const bIdx = (m: DoublesMatch) => ELO_BUCKETS.indexOf(eloBucket(opponentElo(m, myId)));

  for (const m of together) {
    const i = bIdx(m);
    if (i < 0) continue;
    buckets[i].together.total++;
    if (didWin(m, myId)) buckets[i].together.wins++;
  }
  for (const m of without) {
    const i = bIdx(m);
    if (i < 0) continue;
    buckets[i].without.total++;
    if (didWin(m, myId)) buckets[i].without.wins++;
  }

  // Per-bucket delta
  for (const b of buckets) {
    const wr_t = b.together.total > 0 ? b.together.wins / b.together.total : NaN;
    const wr_w = b.without.total  > 0 ? b.without.wins  / b.without.total  : NaN;
    b.delta = isNaN(wr_t) || isNaN(wr_w) ? NaN : wr_t - wr_w;
  }

  // Weighted overall delta (buckets where both sides have data)
  let weightedSum  = 0;
  let totalWeight  = 0;
  for (const b of buckets) {
    if (isNaN(b.delta)) continue;
    const w = Math.min(b.together.total, b.without.total);
    weightedSum += b.delta * w;
    totalWeight += w;
  }

  const togetherWins    = together.filter(m => didWin(m, myId)).length;
  const withoutWins     = without.filter(m => didWin(m, myId)).length;
  const winRateTogether = together.length > 0 ? togetherWins / together.length : NaN;
  const baselineWinRate = without.length  > 0 ? withoutWins  / without.length  : NaN;

  const overallDelta = totalWeight >= 5
    ? weightedSum / totalWeight
    : !isNaN(winRateTogether) && !isNaN(baselineWinRate)
      ? winRateTogether - baselineWinRate
      : 0;

  // Generate human-readable insights
  const insights: string[] = [];
  const sig = together.length >= 5;
  if (sig) {
    const pct = Math.round(Math.abs(overallDelta) * 100);
    if (overallDelta >= 0.08) {
      insights.push(`You win ${pct}% more often together — great chemistry!`);
    } else if (overallDelta >= 0.03) {
      insights.push(`Slight win-rate edge together (+${pct}%)`);
    } else if (overallDelta <= -0.08) {
      insights.push(`Win rate dips ${pct}% when paired together`);
    } else if (overallDelta <= -0.03) {
      insights.push(`Slight dip together (${-pct}%)`);
    } else {
      insights.push('Win rate is about the same together or apart');
    }

    // Best single bucket
    const validBuckets = buckets
      .filter(b => b.together.total >= 2 && b.without.total >= 2)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (validBuckets.length > 0 && Math.abs(validBuckets[0].delta) >= 0.10) {
      const b   = validBuckets[0];
      const bPct = Math.round(Math.abs(b.delta) * 100);
      const dir  = b.delta > 0 ? '+' : '-';
      insights.push(`${dir}${bPct}% vs ${b.label} ELO opponents together`);
    }
  }

  return {
    partnerId,
    matchesTogether:   together.length,
    winRateTogether,
    baselineWinRate,
    overallDelta,
    significant:       sig,
    buckets,
    insights,
  };
}

/** Compute chemistry for every partner A has played with (min 3 matches), sorted by |delta| */
export function computeAllPartnerChemistry(
  myId:    string,
  doubles: DoublesMatch[],
): ChemistryResult[] {
  const partnerIds = new Set<string>();
  for (const m of doubles) {
    if (m.player1_id  === myId && m.partner1_id) partnerIds.add(m.partner1_id);
    if (m.partner1_id === myId && m.player1_id)  partnerIds.add(m.player1_id!);
    if (m.player2_id  === myId && m.partner2_id) partnerIds.add(m.partner2_id);
    if (m.partner2_id === myId && m.player2_id)  partnerIds.add(m.player2_id!);
  }

  return [...partnerIds]
    .map(pid => computeChemistry(myId, pid, doubles))
    .filter(r => r.matchesTogether >= 3)
    .sort((a, b) => Math.abs(b.overallDelta) - Math.abs(a.overallDelta));
}

/** Format delta as "+12%" or "-5%" */
export function fmtDelta(delta: number): string {
  const pct = Math.round(Math.abs(delta) * 100);
  return `${delta >= 0 ? '+' : '-'}${pct}%`;
}

/** Color for a chemistry delta */
export function chemistryColor(delta: number): string {
  if (delta >=  0.08) return '#2e7d32';  // strong positive — green
  if (delta >=  0.03) return '#558b2f';  // mild positive
  if (delta <= -0.08) return '#c62828';  // strong negative — red
  if (delta <= -0.03) return '#e65100';  // mild negative
  return '#888';                          // neutral
}
