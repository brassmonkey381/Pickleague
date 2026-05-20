# Bracket-Generation Verification Approach

## Why this matters

The deep-dive docs in this directory describe what each tournament format *should* produce — match counts, round counts, seeding pairings, bracket labels, pool distributions. Verification proves that the code in `mobile/src/lib/tournament.ts` and the SQL bracket generators in `supabase/migration_*.sql` actually match those descriptions. Without verification, the docs and the code can silently drift apart, and a regression in bracket generation may not surface until a live tournament breaks.

The codebase has two layers that generate brackets:

- **TypeScript generators** in `mobile/src/lib/tournament.ts`: `generateRoundRobin`, `generateSingleElim`, `generatePoolPlay`, `generateDoublesPoolPlay`, `generateRotatingPartners`, `generateMLPSchedule`, `generateDoubleElim`, `generateDoublesRoundRobin`, `generateDoublesSingleElim`, `generateDoublesDoubleElim`.
- **SQL functions (SECURITY DEFINER)** in the Supabase migrations: `generate_mlp_bracket`, `generate_mlp_playoff`, and the `_advance_double_elim_bracket` trigger that fills in losers-bracket / grand-final matches as results come in.

A complete verification story has to cover both layers.

## Tier 1: TypeScript Unit Tests (recommended starting point)

- **Where:** `mobile/src/lib/__tests__/tournament-bracket.test.ts` (new file; not committed in this PR).
- **What it covers:** the pure functions in `mobile/src/lib/tournament.ts`.
- **Why this tier first:** zero infra (no DB, no auth, no network), fastest feedback loop, catches the majority of bracket-structure bugs. The functions are already pure and deterministic (apart from `seedPlayers`/`seedTeams` with `mode='random'`, which use `shuffle`), so assertions are straightforward.

Example assertions — these match the actual `MatchPairing` shape in `tournament.ts`, where each match carries `team1`/`team2` tuples (singles uses a single-element tuple, doubles uses a pair):

```ts
import {
  generateRoundRobin,
  generateSingleElim,
  generatePoolPlay,
  generateDoubleElim,
  generateRotatingPartners,
  generateMLPSchedule,
} from '../tournament';

describe('generateRoundRobin', () => {
  it('produces N(N-1)/2 unique pairings for N=8', () => {
    const players = ['p1','p2','p3','p4','p5','p6','p7','p8'];
    const matches = generateRoundRobin(players);
    expect(matches).toHaveLength(28); // 8 * 7 / 2

    const pairs = new Set(
      matches.map(m => [m.team1[0], m.team2[0]].sort().join('|'))
    );
    expect(pairs.size).toBe(28); // every pairing unique
  });

  it('uses N rounds (with one BYE) for odd N=7', () => {
    const players = ['p1','p2','p3','p4','p5','p6','p7'];
    const matches = generateRoundRobin(players);
    const rounds = new Set(matches.map(m => m.round));
    expect(rounds.size).toBe(7); // N rounds when padded with BYE
    expect(matches).toHaveLength(21); // 7 * 6 / 2 — BYE matches dropped
  });
});

describe('generateSingleElim', () => {
  it('pairs top seed vs bottom seed in round 1 for N=8', () => {
    const seeded = ['s1','s2','s3','s4','s5','s6','s7','s8'];
    const r1 = generateSingleElim(seeded);
    expect(r1).toHaveLength(4);
    expect(r1[0]).toMatchObject({ round: 1, team1: ['s1'], team2: ['s8'] });
    expect(r1[3]).toMatchObject({ round: 1, team1: ['s4'], team2: ['s5'] });
  });

  it('pads non-power-of-2 fields with BYEs and drops BYE matches', () => {
    const seeded = ['s1','s2','s3','s4','s5','s6']; // pads to 8
    const r1 = generateSingleElim(seeded);
    // Slots are 1v8, 2v7, 3v6, 4v5 — seeds 7 and 8 become BYE, so 1v8 and 2v7 drop.
    expect(r1).toHaveLength(2);
    expect(r1[0]).toMatchObject({ team1: ['s3'], team2: ['s6'] });
    expect(r1[1]).toMatchObject({ team1: ['s4'], team2: ['s5'] });
  });
});

describe('generatePoolPlay snake-draft', () => {
  it('distributes 12 seeded players into 3 pools by snake order', () => {
    const seeded = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    const { pools } = generatePoolPlay(seeded, 3);
    // Snake: A gets s1, s6, s7, s12; B gets s2, s5, s8, s11; C gets s3, s4, s9, s10.
    expect(pools[0]).toEqual(['s1','s6','s7','s12']);
    expect(pools[1]).toEqual(['s2','s5','s8','s11']);
    expect(pools[2]).toEqual(['s3','s4','s9','s10']);
  });

  it('labels every match with its pool letter and round number', () => {
    const seeded = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
    const { matches } = generatePoolPlay(seeded, 2);
    expect(matches.every(m => /^Pool [AB] · Round \d+$/.test(m.label ?? ''))).toBe(true);
    expect(matches.every(m => m.poolIndex === 0 || m.poolIndex === 1)).toBe(true);
  });
});

describe('generateDoubleElim', () => {
  it('returns round-1 winners-bracket pairings tagged bracket="winners"', () => {
    const seeded = ['s1','s2','s3','s4','s5','s6','s7','s8'];
    const r1 = generateDoubleElim(seeded);
    expect(r1).toHaveLength(4);
    expect(r1.every(m => m.bracket === 'winners')).toBe(true);
  });
});

describe('generateRotatingPartners', () => {
  it('produces N/4 matches per round for a multiple of 4', () => {
    const seeded = ['p1','p2','p3','p4','p5','p6','p7','p8'];
    const matches = generateRotatingPartners(seeded, 3);
    expect(matches).toHaveLength(6); // 8/4 = 2 matches/round * 3 rounds
    expect(new Set(matches.map(m => m.round)).size).toBe(3);
    expect(matches.every(m => m.team1.length === 2 && m.team2.length === 2)).toBe(true);
  });
});

describe('generateMLPSchedule', () => {
  it('round-robins fixed pairs (each pair plays every other pair once)', () => {
    const teams: [string, string][] = [
      ['a1','a2'], ['b1','b2'], ['c1','c2'], ['d1','d2'],
    ];
    const matches = generateMLPSchedule(teams);
    expect(matches).toHaveLength(6); // 4 * 3 / 2
    expect(matches.every(m => m.team1.length === 2 && m.team2.length === 2)).toBe(true);
  });
});
```

A few notes for whoever implements Tier 1:

- The `MatchPairing` shape lives in `mobile/src/lib/tournament.ts` and uses `team1: [string, string?]` / `team2: [string, string?]` — not `{ a, b }`. The examples above already use that shape.
- `seedPlayers` / `seedTeams` with `mode='random'` call `shuffle` (non-deterministic). For tests, seed the players in deterministic order rather than testing the random branch.
- `generateRoundRobin` adds a `'BYE'` slot for odd N and drops matches that touch it. Assert match counts accordingly (N\*(N-1)/2 for even N; same formula for odd N after dropping BYE matches).

## Tier 2: Godmode E2E Playthrough

- **Where:** a new "Verify all bracket formats" button in `mobile/src/screens/GodmodeScreen.tsx` (deferred — describe the design only).
- **What it covers:** end-to-end including the SQL bracket generators (`generate_mlp_bracket`, `generate_mlp_playoff`) and the `_advance_double_elim_bracket` trigger that runs on match completion.
- **Flow:** for each permutation enumerated in the index doc, create a throwaway tournament with N=8 or N=16 synthetic players (the same approach godmode already uses for seeding), lock-in to fire bracket generation, then query `tournament_rounds` and `matches` and assert structural properties — match count, `round_type` distribution, `bracket` labels, pool membership. After assertions, delete the tournament.
- **Why this tier:** catches divergence between the TS generators and the SQL bracket generators (they don't share code — they should produce the same shape but historically have drifted), plus catches RLS/auth edge cases that pure functions can't see.

## Tier 3: SQL Integration Tests (optional)

- **Where:** `supabase/tests/bracket-generation.sql` (new directory; not in the codebase yet).
- **What it covers:** SECURITY DEFINER functions in isolation, including paths not easily exposed through godmode — e.g., `_advance_double_elim_bracket` firing on partial bracket completion, or `generate_mlp_playoff` running on edge-case seeding ties.
- **Flow:** `BEGIN;` → insert synthetic tournament + player rows → call the function → assert via SQL (`SELECT count(*) FROM matches WHERE …`) → `ROLLBACK;`. The same pattern Supabase recommends for migration testing.
- **Why this tier:** SECURITY DEFINER bracket paths run with elevated privileges and are awkward to exercise from TS. SQL tests can target them directly without going through the app layer.

## Recommended path forward

- **Start with Tier 1.** It writes itself in ~1–2 hours, catches ~70% of bugs, and the deep-dive docs already specify the expected bracket structure for every permutation — so the test assertions are essentially transcriptions of the docs.
- **Add Tier 2 next** if regressions show up specifically in the SQL bracket generators (most likely candidate: double-elim losers-bracket advancement, since the trigger is the most logic-heavy SQL path).
- **Add Tier 3 only** if Tier 2 misses something — typically only worth it for edge cases that require precise control over intermediate match state.

## What the deep-dive docs already gave us

Each format doc in this directory specifies the expected match count, round count, seeding pairings, and (for pool play) pool distribution. Those specifications are exactly the assertions a Tier 1 test would make — there's almost no extra design work to start writing tests. Cross-reference:

- [Round Robin](./round-robin.md)
- [Pool Play](./pool-play.md)
- [Elimination Brackets](./elim-brackets.md)
- [Rotating Partners](./rotating-partners.md)
- [MLP](./mlp.md)
- [Losers-Bracket Playoff](./losers-bracket-playoff.md)
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md)
- [Schedule Formulas](./schedule-formulas.md)

## What this doc does NOT do

This is a design doc, not an implementation. No test file is committed in this PR. Implementing Tier 1 is a separate task the user can request next.
