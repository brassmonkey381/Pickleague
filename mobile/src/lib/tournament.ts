/**
 * Tournament bracket and scheduling utilities.
 * All functions are pure — they take player IDs (and optional PLUPR ratings)
 * and return structured match/pool data ready to insert into the DB.
 */

export type TournamentFormat =
  | 'round_robin'
  | 'single_elimination'
  | 'double_elimination'
  | 'pool_play'
  | 'mlp'
  | 'mlp_random'
  | 'rotating_partners';

export type MatchPairing = {
  round: number;
  matchOrder: number;
  team1: [string, string?];   // [player1, player2?] (player2 only for doubles)
  team2: [string, string?];
  label?: string;
  /** Which bracket this match belongs to. Defaults to 'winners' for single-elim. */
  bracket?: 'winners' | 'losers' | 'grand_final';
  /** Zero-based pool index for pool_play matches (A=0, B=1, ...). Undefined otherwise. */
  poolIndex?: number;
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

// ── Seeded order (best PLUPR first) ──────────────────────────
export function seedPlayers(
  playerIds: string[],
  ratings: Record<string, number>,
  mode: 'random' | 'elo'
): string[] {
  if (mode === 'random') return shuffle(playerIds);
  return [...playerIds].sort((a, b) => (ratings[b] ?? 3.25) - (ratings[a] ?? 3.25));
}

// ── Validation ────────────────────────────────────────────────
export type ValidationError = { code: string; message: string };

// Doubles teams: every entry must have two distinct, non-null partners,
// and no player may appear on more than one team.
export function validateDoublesTeams(teams: [string, string][]): ValidationError | null {
  for (const [i, t] of teams.entries()) {
    if (!t[0] || !t[1]) {
      return { code: 'INCOMPLETE_DOUBLES_TEAM',
        message: `Doubles team #${i + 1} is missing a partner. Every team needs 2 players.` };
    }
    if (t[0] === t[1]) {
      return { code: 'DUPLICATE_PARTNER',
        message: `Doubles team #${i + 1} has the same player listed twice.` };
    }
  }
  const seen = new Set<string>();
  for (const t of teams) {
    for (const uid of t) {
      if (seen.has(uid)) {
        return { code: 'PLAYER_ON_MULTIPLE_TEAMS',
          message: `A player is on more than one doubles team. Fix the doubles pairs and try again.` };
      }
      seen.add(uid);
    }
  }
  return null;
}

// MLP teams: every team must have all four slots filled (2M + 2F), no
// duplicates within a team, no player on more than one team.
export type MlpTeamShape = {
  id?:           string;
  name?:         string | null;
  male_1_id:     string | null;
  male_2_id:     string | null;
  female_1_id:   string | null;
  female_2_id:   string | null;
};
export function validateMlpTeams(teams: MlpTeamShape[]): ValidationError | null {
  if (teams.length < 2) {
    return { code: 'NOT_ENOUGH_MLP_TEAMS',
      message: `Need at least 2 MLP teams to generate a bracket (have ${teams.length}).` };
  }
  for (const t of teams) {
    const slots = [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id];
    const filled = slots.filter(s => s != null).length;
    if (filled < 4) {
      return { code: 'INCOMPLETE_MLP_TEAM',
        message: `Team "${t.name ?? t.id ?? '(unnamed)'}" only has ${filled}/4 members. MLP teams need 2 men + 2 women.` };
    }
    const ids = slots.filter((s): s is string => s != null);
    if (new Set(ids).size !== ids.length) {
      return { code: 'DUPLICATE_PLAYER_IN_MLP_TEAM',
        message: `Team "${t.name ?? t.id ?? '(unnamed)'}" lists the same player in more than one slot.` };
    }
  }
  const seen = new Set<string>();
  for (const t of teams) {
    for (const uid of [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id]) {
      if (!uid) continue;
      if (seen.has(uid)) {
        return { code: 'PLAYER_ON_MULTIPLE_MLP_TEAMS',
          message: `A player is on more than one MLP team. Resolve the conflict before locking in.` };
      }
      seen.add(uid);
    }
  }
  return null;
}

// Pool play: pool count must match expected, every pool must have at
// least 2 entrants, and every pool must have at least one match generated.
export function validatePools<T>(
  pools:         T[][],
  expectedCount: number,
  matches:       MatchPairing[],
): ValidationError | null {
  if (pools.length !== expectedCount) {
    return { code: 'WRONG_POOL_COUNT',
      message: `Expected ${expectedCount} pool(s) but ${pools.length} were generated.` };
  }
  for (const [i, pool] of pools.entries()) {
    const letter = String.fromCharCode(65 + i);
    if (pool.length < 2) {
      return { code: 'POOL_UNDERFULL',
        message: `Pool ${letter} only has ${pool.length} entrant(s) — need at least 2 to play matches.` };
    }
    const poolMatches = matches.filter(m => m.label?.startsWith(`Pool ${letter}`));
    if (poolMatches.length === 0) {
      return { code: 'POOL_HAS_NO_MATCHES',
        message: `Pool ${letter} was created but no matches were scheduled inside it.` };
    }
  }
  return null;
}

// ── Round Robin (singles) ─────────────────────────────────────
// Circle algorithm: N-1 rounds, each player plays every other player once.
export function generateRoundRobin(playerIds: string[]): MatchPairing[] {
  if (playerIds.length < 2) {
    throw new Error(`generateRoundRobin: need at least 2 players (got ${playerIds.length})`);
  }
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
// Snake-draft for PLUPR seeding: 1→A, 2→B, 3→C, 4→C, 5→B, 6→A, …
export function assignPools(
  seededPlayers: string[],
  poolCount: number
): string[][] {
  if (poolCount < 1) {
    throw new Error(`assignPools: poolCount must be >= 1 (got ${poolCount})`);
  }
  if (seededPlayers.length < poolCount * 2) {
    throw new Error(
      `assignPools: need at least ${poolCount * 2} players to fill ${poolCount} pool(s) with 2 each (got ${seededPlayers.length})`
    );
  }
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
      poolIndex: pi,
    }));
    matches.push(...poolMatches);
  });
  return { pools, matches };
}

// ── Single elimination bracket ────────────────────────────────
// Pads to next power of 2 with BYEs; top seed vs bottom seed.
export function generateSingleElim(seededPlayers: string[]): MatchPairing[] {
  if (seededPlayers.length < 2) {
    throw new Error(`generateSingleElim: need at least 2 entrants (got ${seededPlayers.length})`);
  }
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
// Whist-style "social mixer" schedule for 2v2 where partnerships rotate every
// round (not just opponents). Each round we run the standard round-robin
// "circle" over all players (padded to even with a single BYE that represents
// a forced sit-out so the rester rotates too):
//
//   Fix position 0; rotate the rest of the circle by `r` each round.
//   Pair mirrored positions: (cyc[0], cyc[n-1]), (cyc[1], cyc[n-2]), …
//   These pairs are the partnerships — and because the whole circle rotates,
//   each player draws a *new* partner every round (no partnership repeats over
//   the first n-1 rounds).
//
//   Pairs containing the BYE placeholder are dropped (those players sit out
//   this round). From the surviving real pairs we form exactly floor(N/4)
//   matches by grouping them two-at-a-time: pair[0] vs pair[1], pair[2] vs
//   pair[3], … This guarantees floor(N/4) matches *every* round and rotates
//   who sits out fairly, instead of dropping whole matches when a BYE lands
//   inside a fixed group-of-4.
//
// Returns [] for fewer than 4 players (can't field a single 2v2 court).
export function generateRotatingPartners(
  seededPlayers: string[],
  numRounds: number
): MatchPairing[] {
  const N = seededPlayers.length;
  if (N < 4) return [];

  const numCourts = Math.floor(N / 4);

  // Pad to even so the circle is well-defined. A lone BYE marks the rester
  // (only present when N is odd); pairs touching it are skipped below.
  const base = [...seededPlayers];
  if (base.length % 2 !== 0) base.push('BYE');
  const size = base.length;            // even
  const fixed = base[0];
  const rest = base.slice(1);
  const restLen = rest.length;         // size - 1

  const matches: MatchPairing[] = [];

  for (let r = 0; r < numRounds; r++) {
    // Circle rotation: keep `fixed` at position 0, rotate the rest by r.
    const rotated = rest.map((_, i) => rest[((i - r) % restLen + restLen) % restLen]);
    const cyc = [fixed, ...rotated];

    // Mirrored pairings are the partnerships for this round.
    const pairs: [string, string][] = [];
    for (let i = 0; i < size / 2; i++) pairs.push([cyc[i], cyc[size - 1 - i]]);

    // Drop pairs that include the BYE rester, preserving order.
    const realPairs = pairs.filter(p => p[0] !== 'BYE' && p[1] !== 'BYE');

    // Group surviving pairs into 2v2 matches, capped at floor(N/4) courts.
    let order = 0;
    for (let j = 0; order < numCourts && j + 1 < realPairs.length; j += 2) {
      matches.push({
        round: r + 1,
        matchOrder: order++,
        team1: realPairs[j],
        team2: realPairs[j + 1],
      });
    }
  }
  return matches;
}

// ── MLP (Fixed-team round robin) ──────────────────────────────
// Treats each pair of players as a team. Teams play round-robin.
export function generateMLPSchedule(teams: [string, string][]): MatchPairing[] {
  if (teams.length < 2) {
    throw new Error(`generateMLPSchedule: need at least 2 teams (got ${teams.length})`);
  }
  const teamIds = teams.map((_, i) => String(i));
  const rrPairings = generateRoundRobin(teamIds);
  return rrPairings.map(m => ({
    ...m,
    team1: teams[parseInt(m.team1[0])],
    team2: teams[parseInt(m.team2[0])],
  }));
}

// ── Doubles team helpers ──────────────────────────────────────
// For non-MLP doubles tournaments (round-robin / single-elim / pool play),
// every team is a fixed pair drawn from doubles_pairs (or a random pairing
// of unpaired approved players at bracket draw time). These wrap the
// underlying singles generators by treating each pair as a single token.

/** Sort pairs by combined PLUPR (average of partners), descending. */
export function seedTeams(
  teams: [string, string][],
  ratings: Record<string, number>,
  mode: 'random' | 'elo',
): [string, string][] {
  if (mode === 'random') return shuffle(teams);
  return [...teams].sort((a, b) => {
    const ar = ((ratings[a[0]] ?? 3.25) + (ratings[a[1]] ?? 3.25)) / 2;
    const br = ((ratings[b[0]] ?? 3.25) + (ratings[b[1]] ?? 3.25)) / 2;
    return br - ar;
  });
}

/** Round-robin between pairs (same shape as generateMLPSchedule). */
export function generateDoublesRoundRobin(teams: [string, string][]): MatchPairing[] {
  const tokenIds = teams.map((_, i) => `__T${i}`);
  return generateRoundRobin(tokenIds).map(m => ({
    ...m,
    team1: teams[parseInt(m.team1[0].slice(3))],
    team2: teams[parseInt(m.team2[0].slice(3))],
  }));
}

/** Single-elim bracket between pairs. Returns round-1 only — later rounds
 *  fill in as results come in. */
export function generateDoublesSingleElim(seededTeams: [string, string][]): MatchPairing[] {
  const tokenIds = seededTeams.map((_, i) => `__T${i}`);
  return generateSingleElim(tokenIds).map(m => ({
    ...m,
    team1: seededTeams[parseInt(m.team1[0].slice(3))],
    team2: seededTeams[parseInt(m.team2[0].slice(3))],
  }));
}

// ── Double elimination bracket ────────────────────────────────
// Round 1 only — the trigger `_advance_double_elim_bracket` handles the rest
// (winners advancement, losers-bracket creation/advancement, grand finals).
// Returns the same shape as `generateSingleElim` but tags each pairing with
// bracket='winners' so the trigger knows where to drop losers.
export function generateDoubleElim(seededPlayers: string[]): MatchPairing[] {
  return generateSingleElim(seededPlayers).map(m => ({ ...m, bracket: 'winners' as const }));
}

/** Double-elim bracket between pairs. Round-1 winners-bracket only — the
 *  trigger fills in losers bracket + grand finals as results come in. */
export function generateDoublesDoubleElim(seededTeams: [string, string][]): MatchPairing[] {
  return generateDoublesSingleElim(seededTeams).map(m => ({ ...m, bracket: 'winners' as const }));
}

/** Pool play between pairs: snake-draft teams into pools, then round-robin within each pool. */
export function generateDoublesPoolPlay(
  seededTeams: [string, string][],
  poolCount: number,
): { pools: [string, string][][]; matches: MatchPairing[] } {
  // Snake-assign teams to pools by their pre-sorted order.
  const pools: [string, string][][] = Array.from({ length: poolCount }, () => []);
  seededTeams.forEach((team, i) => {
    const snakePos = i % (poolCount * 2);
    const poolIdx  = snakePos < poolCount ? snakePos : poolCount * 2 - 1 - snakePos;
    pools[Math.min(poolIdx, poolCount - 1)].push(team);
  });

  const matches: MatchPairing[] = [];
  pools.forEach((pool, pi) => {
    const poolMatches = generateDoublesRoundRobin(pool).map(m => ({
      ...m,
      label: `Pool ${String.fromCharCode(65 + pi)} · Round ${m.round}`,
      poolIndex: pi,
    }));
    matches.push(...poolMatches);
  });
  return { pools, matches };
}

// ── Format labels ─────────────────────────────────────────────
export const FORMAT_META: Record<TournamentFormat, { label: string; icon: string; description: string }> = {
  round_robin:         { label: 'Round Robin',       icon: '🔄', description: 'Every player faces every other player.' },
  single_elimination:  { label: 'Single Elim',       icon: '🏆', description: 'One loss and you\'re out.' },
  double_elimination:  { label: 'Double Elim',       icon: '🔁', description: 'Two losses to be eliminated.' },
  pool_play:           { label: 'Pool Play',          icon: '🏊', description: 'Balanced pools, then bracket.' },
  mlp:                 { label: 'MLP / Fixed Teams',  icon: '🤝', description: 'Teams of 4 (2M + 2W). Captains form rosters and lock in.' },
  mlp_random:          { label: 'MLP / Random Teams', icon: '🎲', description: 'Teams of 4 auto-generated from approved players (random or snake-draft) with wacky names.' },
  rotating_partners:   { label: 'Rotating Partners',  icon: '🔀', description: 'Partners rotate each round.' },
};
