/**
 * Pure helpers for bracket-structure verification. Split out from
 * bracketVerification.ts so tests can import the math without pulling in
 * the supabase client.
 */

/** Number of matches the snake-draft pool assignment produces for N players in P pools. */
export function expectedPoolPlayMatchCount(N: number, P: number): number {
  const sizes = poolSizes(N, P);
  return sizes.reduce((sum, sz) => sum + (sz * (sz - 1)) / 2, 0);
}

/** Snake-draft pool sizes — mirrors assignPools in tournament.ts. */
export function poolSizes(N: number, P: number): number[] {
  const sizes = new Array(P).fill(0);
  for (let i = 0; i < N; i++) {
    const period = P * 2;
    const snakePos = i % period;
    const poolIdx = snakePos < P ? snakePos : period - 1 - snakePos;
    sizes[Math.min(poolIdx, P - 1)]++;
  }
  return sizes;
}

/** Round-robin: N(N-1)/2 matches, N-1 rounds (or N rounds with BYE for odd N). */
export function expectedRoundRobinMatchCount(N: number): number {
  return (N * (N - 1)) / 2;
}

export function expectedRoundRobinRoundCount(N: number): number {
  return N % 2 === 0 ? N - 1 : N;
}

/** Next power of 2 at or above N. */
export function nextPow2(N: number): number {
  let p = 1;
  while (p < N) p *= 2;
  return p;
}

/** Single elim round-1 match count after BYE padding (top seeds get the byes). */
export function expectedSingleElimRound1MatchCount(N: number): number {
  const pow2 = nextPow2(N);
  const byes = pow2 - N;
  return pow2 / 2 - byes;
}
