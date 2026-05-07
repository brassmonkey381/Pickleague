/**
 * Tournament bracket and scheduling utilities.
 * All functions are pure — they take player IDs (and optional ELO ratings)
 * and return structured match/pool data ready to insert into the DB.
 */

export type TournamentFormat =
  | 'round_robin'
  | 'single_elimination'
  | 'double_elimination'
  | 'pool_play'
  | 'mlp'
  | 'rotating_partners';

export type MatchPairing = {
  round: number;
  matchOrder: number;
  team1: [string, string?];   // [player1, player2?] (player2 only for doubles)
  team2: [string, string?];
  label?: string;
};

// ── Shuffle ───────────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Seeded order (best ELO first) ────────────────────────────
export function seedPlayers(
  playerIds: string[],
  ratings: Record<string, number>,
  mode: 'random' | 'elo'
): string[] {
  if (mode === 'random') return shuffle(playerIds);
  return [...playerIds].sort((a, b) => (ratings[b] ?? 1000) - (ratings[a] ?? 1000));
}

// ── Round Robin (singles) ─────────────────────────────────────
// Circle algorithm: N-1 rounds, each player plays every other player once.
export function generateRoundRobin(playerIds: string[]): MatchPairing[] {
  const players = [...playerIds];
  if (players.length % 2 !== 0) players.push('BYE');
  const n = players.length;
  const rounds: MatchPairing[] = [];

  for (let r = 0; r < n - 1; r++) {
    let order = 0;
    for (let i = 0; i < n / 2; i++) {
      const p1 = players[i];
      const p2 = players[n - 1 - i];
      if (p1 !== 'BYE' && p2 !== 'BYE') {
        rounds.push({ round: r + 1, matchOrder: order++, team1: [p1], team2: [p2] });
      }
    }
    // Rotate: fix index 0, rotate rest
    players.splice(1, 0, players.pop()!);
  }
  return rounds;
}

// ── Pool assignment ───────────────────────────────────────────
// Snake-draft for ELO seeding: 1→A, 2→B, 3→C, 4→C, 5→B, 6→A, …
export function assignPools(
  seededPlayers: string[],
  poolCount: number
): string[][] {
  const pools: string[][] = Array.from({ length: poolCount }, () => []);
  seededPlayers.forEach((p, i) => {
    const snakePos = i % (poolCount * 2);
    const poolIdx  = snakePos < poolCount ? snakePos : poolCount * 2 - 1 - snakePos;
    pools[Math.min(poolIdx, poolCount - 1)].push(p);
  });
  return pools;
}

// ── Pool Play schedule ────────────────────────────────────────
export function generatePoolPlay(
  seededPlayers: string[],
  poolCount: number
): { pools: string[][]; matches: MatchPairing[] } {
  const pools = assignPools(seededPlayers, poolCount);
  const matches: MatchPairing[] = [];
  pools.forEach((pool, pi) => {
    const poolMatches = generateRoundRobin(pool).map(m => ({
      ...m,
      label: `Pool ${String.fromCharCode(65 + pi)} · Round ${m.round}`,
    }));
    matches.push(...poolMatches);
  });
  return { pools, matches };
}

// ── Single elimination bracket ────────────────────────────────
// Pads to next power of 2 with BYEs; top seed vs bottom seed.
export function generateSingleElim(seededPlayers: string[]): MatchPairing[] {
  let slots = seededPlayers.length;
  let bracketSize = 1;
  while (bracketSize < slots) bracketSize *= 2;

  const padded = [...seededPlayers];
  while (padded.length < bracketSize) padded.push('BYE');

  // Round 1 pairings: 1 vs N, 2 vs N-1, …
  const round1: MatchPairing[] = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const p1 = padded[i];
    const p2 = padded[bracketSize - 1 - i];
    if (p1 !== 'BYE' && p2 !== 'BYE') {
      round1.push({ round: 1, matchOrder: i, team1: [p1], team2: [p2] });
    }
  }
  return round1;
  // Subsequent rounds are generated as results come in — handled in TournamentDetailScreen
}

// ── Rotating partners ─────────────────────────────────────────
// Classic 4-player rotation for 2v2:
// Each round: every group of 4 players rotates partners.
// Generates `numRounds` rounds of pairings for all players.
export function generateRotatingPartners(
  seededPlayers: string[],
  numRounds: number
): MatchPairing[] {
  const n = seededPlayers.length;
  if (n < 4) return [];

  const matches: MatchPairing[] = [];

  for (let r = 0; r < numRounds; r++) {
    // Rotate the array: shift by r positions
    const rotated = [...seededPlayers.slice(r % n), ...seededPlayers.slice(0, r % n)];
    let order = 0;
    // Pair up in groups of 4
    for (let i = 0; i + 3 < rotated.length; i += 4) {
      const [a, b, c, d] = rotated.slice(i, i + 4);
      // Partners: (a,b) vs (c,d) in round 1, (a,c) vs (b,d) in round 2, etc.
      const pairingVariant = r % 3;
      let t1: [string, string], t2: [string, string];
      if (pairingVariant === 0)      { t1 = [a, b]; t2 = [c, d]; }
      else if (pairingVariant === 1) { t1 = [a, c]; t2 = [b, d]; }
      else                           { t1 = [a, d]; t2 = [b, c]; }
      matches.push({ round: r + 1, matchOrder: order++, team1: t1, team2: t2 });
    }
  }
  return matches;
}

// ── MLP (Fixed-team round robin) ──────────────────────────────
// Treats each pair of players as a team. Teams play round-robin.
export function generateMLPSchedule(teams: [string, string][]): MatchPairing[] {
  const teamIds = teams.map((_, i) => String(i));
  const rrPairings = generateRoundRobin(teamIds);
  return rrPairings.map(m => ({
    ...m,
    team1: teams[parseInt(m.team1[0])],
    team2: teams[parseInt(m.team2[0])],
  }));
}

// ── Format labels ─────────────────────────────────────────────
export const FORMAT_META: Record<TournamentFormat, { label: string; icon: string; description: string }> = {
  round_robin:         { label: 'Round Robin',       icon: '🔄', description: 'Every player faces every other player.' },
  single_elimination:  { label: 'Single Elim',       icon: '🏆', description: 'One loss and you\'re out.' },
  double_elimination:  { label: 'Double Elim',       icon: '🔁', description: 'Two losses to be eliminated.' },
  pool_play:           { label: 'Pool Play',          icon: '🏊', description: 'Balanced pools, then bracket.' },
  mlp:                 { label: 'MLP / Fixed Teams',  icon: '🤝', description: 'Pre-formed teams compete.' },
  rotating_partners:   { label: 'Rotating Partners',  icon: '🔀', description: 'Partners rotate each round.' },
};
