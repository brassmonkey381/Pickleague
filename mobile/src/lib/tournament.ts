/**
 * Tournament bracket and scheduling utilities.
 * All functions are pure — they take player IDs (and optional PLUPR ratings)
 * and return structured match/pool data ready to insert into the DB.
 */

import type { IconName } from '@just-messin-around/expo-foundation/icons';

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
      label: `Pool ${String.fromCharCode(65 + pi)}, Round ${m.round}`,
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
// Social mixer for 2v2: partners change every round, and everyone plays the
// same number of matches (PKL-044, Brian 2026-11-18: byes rotate, so nobody
// gets extra chances to win).
//
// How many rounds: rotatingPartnersRounds(n). Each round fields floor(n/4)
// courts, so 4 x courts players play and the rest sit out. The round count is
// the multiple of n / gcd(n, 4 x courts) nearest to the old default
// ceil(n/4) x 3, which makes every player's match count equal
// (10 players: 10 rounds, 8 matches each, 2 sit-outs each).
//
// The schedule:
//   - n % 4 is 0 or 1: the round-robin "circle" (fix position 0, rotate the
//     rest by r, pair mirrored positions). With n % 4 = 1 a lone BYE pads the
//     circle and its partner sits out, so everyone sits once in n rounds.
//     No partnership repeats within the circle's rounds.
//   - n % 4 is 2 or 3 (some pairs must sit each round): a seeded search. Each
//     round the players with the fewest matches so far play (ties drawn by the
//     seed), they pair with partners they have never had, and the pairs face
//     each other so repeat opponents are as rare as it finds. The seed is
//     fixed per field size, so a field always gets the same schedule. If no
//     repeat-free schedule turns up (one always has for 4-24 players),
//     partners may repeat; match counts stay equal either way.
//
// Returns [] for fewer than 4 players (can't field a single 2v2 court).

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Rounds for a rotating-partners field of n players: equal matches for everyone. */
export function rotatingPartnersRounds(n: number): number {
  if (n < 4) return 0;
  const courts = Math.floor(n / 4);
  const target = Math.ceil(n / 4) * 3;
  const step = n / gcd(n, 4 * courts);
  return Math.max(1, Math.round(target / step)) * step;
}

/** Small seeded PRNG (mulberry32): the same seed gives the same schedule. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function circleRotatingPartners(seededPlayers: string[], numRounds: number): MatchPairing[] {
  const N = seededPlayers.length;
  const numCourts = Math.floor(N / 4);
  const base = [...seededPlayers];
  if (base.length % 2 !== 0) base.push('BYE');
  const size = base.length;
  const fixed = base[0];
  const rest = base.slice(1);
  const restLen = rest.length;
  const matches: MatchPairing[] = [];
  for (let r = 0; r < numRounds; r++) {
    const rotated = rest.map((_, i) => rest[((i - r) % restLen + restLen) % restLen]);
    const cyc = [fixed, ...rotated];
    const pairs: [string, string][] = [];
    for (let i = 0; i < size / 2; i++) pairs.push([cyc[i], cyc[size - 1 - i]]);
    const realPairs = pairs.filter(p => p[0] !== 'BYE' && p[1] !== 'BYE');
    let order = 0;
    for (let j = 0; order < numCourts && j + 1 < realPairs.length; j += 2) {
      matches.push({ round: r + 1, matchOrder: order++, team1: realPairs[j], team2: realPairs[j + 1] });
    }
  }
  return matches;
}

type IndexMatch = { round: number; team1: [number, number]; team2: [number, number] };

/** One attempt of the seeded search; null when a round can't avoid a repeat partner. */
function searchRotatingPartners(
  N: number, numRounds: number, rand: () => number, allowRepeats: boolean,
): IndexMatch[] | null {
  const courts = Math.floor(N / 4);
  const played: number[] = new Array(N).fill(0);
  const partnered = new Map<string, number>();
  const faced = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const out: IndexMatch[] = [];

  for (let r = 0; r < numRounds; r++) {
    const playing = seededShuffle([...Array(N).keys()], rand)
      .sort((a, b) => played[a] - played[b])
      .slice(0, 4 * courts);

    // Partners: a perfect matching of `playing` with no earlier partnership
    // (or, when allowed, the fewest repeats in the order tried).
    const pairs: [number, number][] = [];
    let steps = 0;
    const match = (left: number[]): boolean => {
      if (left.length === 0) return true;
      if (++steps > 20000) return false;
      const a = left[0];
      let cands = seededShuffle(left.slice(1), rand);
      if (allowRepeats) {
        cands = cands.sort((x, y) => (partnered.get(key(a, x)) ?? 0) - (partnered.get(key(a, y)) ?? 0));
      }
      for (const b of cands) {
        if (!allowRepeats && partnered.has(key(a, b))) continue;
        pairs.push([a, b]);
        if (match(left.filter(x => x !== a && x !== b))) return true;
        pairs.pop();
      }
      return false;
    };
    if (!match(playing)) return null;

    // Opponents: the grouping of pairs with the fewest repeat meetings.
    let best: [number, number][][] = [];
    let bestCost = Infinity;
    for (let t = 0; t < 40 && bestCost > 0; t++) {
      const ps = seededShuffle(pairs, rand);
      const groups: [number, number][][] = [];
      let cost = 0;
      for (let i = 0; i + 1 < ps.length; i += 2) {
        for (const p of ps[i]) for (const q of ps[i + 1]) cost += faced.get(key(p, q)) ?? 0;
        groups.push([ps[i], ps[i + 1]]);
      }
      if (cost < bestCost) { bestCost = cost; best = groups; }
    }
    for (const [t1, t2] of best) {
      partnered.set(key(t1[0], t1[1]), (partnered.get(key(t1[0], t1[1])) ?? 0) + 1);
      partnered.set(key(t2[0], t2[1]), (partnered.get(key(t2[0], t2[1])) ?? 0) + 1);
      for (const p of t1) for (const q of t2) faced.set(key(p, q), (faced.get(key(p, q)) ?? 0) + 1);
      for (const p of [...t1, ...t2]) played[p]++;
      out.push({ round: r + 1, team1: t1, team2: t2 });
    }
  }
  return out;
}

export function generateRotatingPartners(
  seededPlayers: string[],
  numRounds: number = rotatingPartnersRounds(seededPlayers.length),
): MatchPairing[] {
  const N = seededPlayers.length;
  if (N < 4) return [];
  if (N % 4 === 0 || N % 4 === 1) {
    // The circle never repeats a partner within its rounds (N-1 when N is
    // even, N when odd); past that it starts over.
    return circleRotatingPartners(seededPlayers, numRounds);
  }
  let found: IndexMatch[] | null = null;
  for (let attempt = 0; attempt < 200 && !found; attempt++) {
    found = searchRotatingPartners(N, numRounds, seededRandom(N * 7919 + attempt), false);
  }
  if (!found) found = searchRotatingPartners(N, numRounds, seededRandom(N * 7919), true);
  const orderInRound = new Map<number, number>();
  return (found ?? []).map(m => {
    const order = orderInRound.get(m.round) ?? 0;
    orderInRound.set(m.round, order + 1);
    return {
      round: m.round,
      matchOrder: order,
      team1: [seededPlayers[m.team1[0]], seededPlayers[m.team1[1]]] as [string, string],
      team2: [seededPlayers[m.team2[0]], seededPlayers[m.team2[1]]] as [string, string],
    };
  });
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
      label: `Pool ${String.fromCharCode(65 + pi)}, Round ${m.round}`,
      poolIndex: pi,
    }));
    matches.push(...poolMatches);
  });
  return { pools, matches };
}

// ── Format labels ─────────────────────────────────────────────
// `iconName` names the foundation glyph drawn for the format (<Icon name=…>,
// Chip `iconName`). Type-only import: simulations/ runs this file under tsx
// with no React Native, and a type import is erased.
export const FORMAT_META: Record<TournamentFormat, { label: string; iconName: IconName; description: string }> = {
  round_robin:         { label: 'Round Robin',       iconName: 'repeat',    description: 'Every player faces every other player.' },
  single_elimination:  { label: 'Single Elim',       iconName: 'trophy',    description: 'One loss and you\'re out.' },
  double_elimination:  { label: 'Double Elim',       iconName: 'bracket',   description: 'Two losses to be eliminated.' },
  pool_play:           { label: 'Pool Play',          iconName: 'grid',      description: 'Balanced pools, then bracket.' },
  mlp:                 { label: 'MLP / Fixed Teams',  iconName: 'handshake', description: 'Teams of 4 (2M + 2W). Captains form rosters and lock in.' },
  mlp_random:          { label: 'MLP / Random Teams', iconName: 'dice',      description: 'Teams of 4 auto-generated from approved players (random or snake-draft) with wacky names.' },
  rotating_partners:   { label: 'Rotating Partners',  iconName: 'shuffle',   description: 'Partners rotate each round.' },
};
