# Schedule Formulas & Court Allocation

Canonical quantitative reference for every tournament-format permutation in the 3-axis model (Larger Format + Additional Format + Playoff Format). Covers total match count, round count, max parallelism (= court requirement for fastest run), and an approximate duration estimate.

All duration estimates assume **30-minute matches**. Two regimes are reported:

- **Round-limited duration** (`rounds × 30 min`) — the floor when courts are unconstrained.
- **Court-limited duration** (`rounds × ceil(matches_per_round / courts) × 30 min`) — accounts for the fact that within a round each match is parallel but rounds are sequential. For formats without strict round structure (or where matches across rounds can backfill empty courts), this degenerates to `ceil(total_matches / courts) × 30 min`.

The reported court-constrained value is the larger (binding) of those two estimates.

See the [tournament-formats index](../tournament-formats.md) for the canonical permutation IDs (RR-*, PP-*, SE-*, DE-*, RP-*, MLP-*).

---

## Source of truth: app descriptions

The app currently exposes a single Larger Format choice plus a small handful of secondary settings (pool count, partner rotation, MLP play format, MLP playoff size). The deep-dive permutations below extend that surface with proposed additional/playoff axes that are not yet user-visible. This section pins each permutation code to the exact app text it inherits, so this doc stays anchored to what users actually see.

### Quoted app text

**FORMAT_META** (`mobile/src/lib/tournament.ts:382-390`):

```ts
export const FORMAT_META: Record<TournamentFormat, { label: string; icon: string; description: string }> = {
  round_robin:         { label: 'Round Robin',       icon: '🔄', description: 'Every player faces every other player.' },
  single_elimination:  { label: 'Single Elim',       icon: '🏆', description: 'One loss and you\'re out.' },
  double_elimination:  { label: 'Double Elim',       icon: '🔁', description: 'Two losses to be eliminated.' },
  pool_play:           { label: 'Pool Play',          icon: '🏊', description: 'Balanced pools, then bracket.' },
  mlp:                 { label: 'MLP / Fixed Teams',  icon: '🤝', description: 'Teams of 4 (2M + 2W). Captains form rosters and lock in.' },
  mlp_random:          { label: 'MLP / Random Teams', icon: '🎲', description: 'Teams of 4 auto-generated from approved players (random or snake-draft) with wacky names.' },
  rotating_partners:   { label: 'Rotating Partners',  icon: '🔀', description: 'Partners rotate each round.' },
};
```

**MLP Play Format hint** (`mobile/src/screens/CreateTournamentScreen.tsx:359-367`):

> "Every team plays every team once. Final standings by sub-matches won." (round_robin)
> "Teams split into pools, round-robin within each pool. Final standings by combined pool W-L." (pool_play)
> "Round-robin first, then the top teams advance to a single-elim playoff (quarters / semis / finals)." (round_robin_playoff)
> "Pool play first, then the top teams from each pool advance to a single-elim playoff." (pool_play_playoff)

**MLP Playoff Size hint** (`mobile/src/screens/CreateTournamentScreen.tsx:389-393`):

> "Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4)." (Top 2)
> "Semifinals + Finals." (Top 4)
> "Quarterfinals + Semifinals + Finals." (Top 8)

**Pool count hint** (`mobile/src/screens/CreateTournamentScreen.tsx:408`):

> "Players are distributed evenly. Snake-draft keeps pools balanced by PLUPR when seeding is on."

**Partner Rotation hint** (`mobile/src/screens/CreateTournamentScreen.tsx:420`):

> "Partners rotate so every player pairs with different teammates over the course of the tournament."

### Permutation → app-text mapping

| Permutation code | Larger Format text (FORMAT_META) | Additional/Playoff hint text |
|---|---|---|
| RR-1..RR-7 | "Every player faces every other player." | (no app hint — additional/playoff axes don't exist in app yet for RR) |
| RR-8 | "Every player faces every other player." | "Double round-robin" — proposed (no app hint yet) |
| PP-1..PP-9 | "Balanced pools, then bracket." | Pool count hint: "Players are distributed evenly..." (`CreateTournamentScreen.tsx:408`) |
| SE-1..SE-3 | "One loss and you're out." | (none — 3PM/consolation proposed) |
| DE-1..DE-2 | "Two losses to be eliminated." | (none — reset toggle proposed) |
| RP-1..RP-2 | "Partners rotate each round." | Partner Rotation hint (`CreateTournamentScreen.tsx:420`) |
| RP-3..RP-4 | "Partners rotate each round." | (none — proposed playoff) |
| MLP-1..MLP-2 | "Teams of 4 (2M + 2W). Captains form rosters and lock in." | MLP Play Format hints (`CreateTournamentScreen.tsx:359-367`) |
| MLP-3..MLP-12 | "Teams of 4 (2M + 2W). Captains form rosters and lock in." | MLP Play Format + Playoff Size hints (`CreateTournamentScreen.tsx:359-393`) |

Anywhere the table below references playoff atoms, consolation brackets, GF reset toggles, or partner-rotation variants beyond the binary every-match/every-round switch, those are **deep-dive extensions**, not options the user can pick today.

---

## 1. Atomic Formulas

The building blocks. Every permutation below is a composition of one or more of these atoms.

### 1.1 Round Robin (singles, N players)

| Quantity | Formula | Notes |
|---|---|---|
| Total matches | `N(N-1)/2` | Each pair plays once. |
| Rounds | `N-1` if N even; `N` if N odd (one BYE rotates) | Circle method. |
| Max parallel matches | `floor(N/2)` | One match per "slot" per round. |
| Matches per player | `N-1` | |

### 1.2 Double Round Robin (singles, N players) — *new*

| Quantity | Formula | Notes |
|---|---|---|
| Total matches | `N(N-1)` | Each pair plays twice. |
| Rounds | `2(N-1)` if N even; `2N` if N odd | Two passes of the circle. |
| Max parallel matches | `floor(N/2)` | Same as single RR. |
| Matches per player | `2(N-1)` | |

### 1.3 Round Robin (doubles, N teams)

| Quantity | Formula | Notes |
|---|---|---|
| Total matches | `N(N-1)/2` | Same as singles, but each "slot" holds 2 players. |
| Rounds | `N-1` (even) / `N` (odd) | |
| Max parallel matches | `floor(N/2)` | |
| Player count on court | `4 × floor(N/2)` | |

### 1.4 Single Elimination (N entrants)

Let `P = next_pow2(N)` (e.g. N=12 → P=16). Lower-seeded entrants get round-1 BYEs to fill the bracket.

| Quantity | Formula | Notes |
|---|---|---|
| Total matches | `P - 1` | A tournament with one winner has one losing match per non-winner. |
| Rounds | `log2(P)` | Each round halves the field. |
| Max parallel (round 1) | `P / 2` | After that, each round halves it. |
| Round k parallelism | `P / 2^k` | k = 1..log2(P). |

### 1.5 Double Elimination (N entrants)

Standard WB + LB bracket. Let `R_WB = ceil(log2(N))`.

| Quantity | Formula / Estimate | Notes |
|---|---|---|
| Total matches | `2N - 2` (no GF reset) or `2N - 1` (with GF reset) | Each non-winner must lose twice; the bracket winner has 0 or 1 losses. Assumes N is a power of 2. |
| Rounds | `2 · R_WB + 1` (no reset), `2 · R_WB + 2` (with reset) | LB rounds interleave with WB rounds; LB has `2·R_WB - 1` rounds. |
| Max parallel | WB R1 = `N/2` | LB rounds typically have lower parallelism (LB sub-round sizes: N/4, N/4, N/8, N/8, ...). |
| GF reset | `+1 match`, `+1 round` | Only if LB winner beats WB winner once. |

### 1.6 Pool Play (P pools, S players per pool)

Each pool runs an independent round robin in parallel.

| Quantity | Formula | Notes |
|---|---|---|
| Matches per pool | `S(S-1)/2` | Pool-level RR. |
| Total matches | `P · S(S-1)/2` | |
| Rounds | `S-1` (even S) / `S` (odd S) | All pools run in lockstep. |
| Max parallel | `P · floor(S/2)` | All pools active simultaneously. |
| Total entrants | `P · S` | |

### 1.7 MLP team meeting (4 teams across two team meetings → individual)

One MLP team meeting = **4 sub-matches** (typically 2 men's doubles, 2 women's doubles, or some equivalent fixed split) that **must run in parallel on 4 courts**.

| Quantity | Formula | Notes |
|---|---|---|
| Sub-matches per team meeting | `4` | Always parallel. |
| Rounds per team meeting | `1` (if 4 courts) or more if courts < 4 | Treated as atomic when ≥4 courts. |
| Team meetings in a T-team RR | `T(T-1)/2` | |
| Total sub-matches in T-team RR | `4 · T(T-1)/2 = 2T(T-1)` | |
| Max parallel sub-matches | `4` per team meeting; can be multiplied if courts allow concurrent team meetings. | |

---

## 2. Combined Permutation Table

One row per permutation (using the canonical IDs from the index doc). Worked examples use **N = 8, 12, 16, 24** for player-based formats and **T = 4, 6, 8** for MLP team-based formats.

Duration formula recap: `rounds × 30 min` (court-unconstrained) and `rounds × ceil(matches_per_round / courts) × 30 min` (court-constrained). The court-constrained column reports `max` of those two values. For composite formats (e.g. RR + bracket), the playoff phase is added to the larger-format phase rather than backfilled, which matches how tournaments are actually scheduled.

### 2.1 Round Robin variants (RR-*)

Assumed: single round robin in singles unless noted. Add the playoff atom for variants with a top-cut bracket.

| ID | Variant | Entrants | Matches | Rounds | Max parallel | Duration @ unconstrained | Duration @ 4 courts |
|---|---|---|---|---|---|---|---|
| RR-1 | Pure singles RR | 8 | 28 | 7 | 4 | 3.5 h | 3.5 h |
|  |  | 12 | 66 | 11 | 6 | 5.5 h | 11.0 h |
|  |  | 16 | 120 | 15 | 8 | 7.5 h | 15.0 h |
|  |  | 24 | 276 | 23 | 12 | 11.5 h | 34.5 h |
| RR-2 | Pure doubles RR (teams) | 8 teams | 28 | 7 | 4 | 3.5 h | 3.5 h |
|  |  | 12 teams | 66 | 11 | 6 | 5.5 h | 11.0 h |
|  |  | 16 teams | 120 | 15 | 8 | 7.5 h | 15.0 h |
| RR-3 | Double RR singles | 8 | 56 | 14 | 4 | 7.0 h | 7.0 h |
|  |  | 12 | 132 | 22 | 6 | 11.0 h | 22.0 h |
|  |  | 16 | 240 | 30 | 8 | 15.0 h | 30.0 h |
| RR-4 | RR + top-cut SE (top 4) | 8 | 28 + 3 = 31 | 7 + 2 = 9 | 4 | 4.5 h | 4.5 h |
|  |  | 12 | 66 + 3 = 69 | 11 + 2 = 13 | 6 | 6.5 h | 12.0 h |
|  |  | 16 | 120 + 3 = 123 | 15 + 2 = 17 | 8 | 8.5 h | 16.0 h |
| RR-5 | RR + top-cut SE (top 8) | 12 | 66 + 7 = 73 | 11 + 3 = 14 | 6 | 7.0 h | 12.5 h |
|  |  | 16 | 120 + 7 = 127 | 15 + 3 = 18 | 8 | 9.0 h | 16.5 h |
|  |  | 24 | 276 + 7 = 283 | 23 + 3 = 26 | 12 | 13.0 h | 36.0 h |
| RR-6 | RR + top-cut DE (top 4) | 8 | 28 + ~7 = 35 | 7 + 5 = 12 | 4 | 6.0 h | 6.0 h |
|  |  | 12 | 66 + ~7 = 73 | 11 + 5 = 16 | 6 | 8.0 h | 13.5 h |
|  |  | 16 | 120 + ~7 = 127 | 15 + 5 = 20 | 8 | 10.0 h | 17.5 h |
| RR-7 | RR + top-cut DE (top 8) | 12 | 66 + ~15 = 81 | 11 + 7 = 18 | 6 | 9.0 h | 14.5 h |
|  |  | 16 | 120 + ~15 = 135 | 15 + 7 = 22 | 8 | 11.0 h | 18.5 h |
|  |  | 24 | 276 + ~15 = 291 | 23 + 7 = 30 | 12 | 15.0 h | 38.0 h |
| RR-8 | RR + 1-game final (top 2) | 8 | 28 + 1 = 29 | 7 + 1 = 8 | 4 | 4.0 h | 4.0 h |
|  |  | 12 | 66 + 1 = 67 | 11 + 1 = 12 | 6 | 6.0 h | 11.5 h |
|  |  | 16 | 120 + 1 = 121 | 15 + 1 = 16 | 8 | 8.0 h | 15.5 h |

### 2.2 Pool Play variants (PP-*)

Pool sizes denoted `P × S` (P pools of S players each).

| ID | Pool config | Entrants | Pool matches | Playoff atom | Total matches | Pool rounds | Playoff rounds | Total rounds | Max parallel (pool phase) | Duration @ unconstrained | Duration @ 4 courts |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PP-1 | 2 × 4 | 8 | 12 | none | 12 | 3 | 0 | 3 | 4 | 1.5 h | 1.5 h |
| PP-2 | 2 × 4 + SE top 4 | 8 | 12 | SE-4 (3 matches) | 15 | 3 | 2 | 5 | 4 | 2.5 h | 2.0 h |
| PP-3 | 2 × 4 + DE top 4 | 8 | 12 | DE-4 (~7 matches) | 19 | 3 | 5 | 8 | 4 | 4.0 h | 2.5 h |
| PP-4 | 3 × 4 | 12 | 18 | none | 18 | 3 | 0 | 3 | 6 | 1.5 h | 3.0 h |
| PP-5 | 3 × 4 + SE top 8 (with byes) | 12 | 18 | SE-8 (7 matches) | 25 | 3 | 3 | 6 | 6 | 3.0 h | 4.5 h |
| PP-6 | 4 × 4 | 16 | 24 | none | 24 | 3 | 0 | 3 | 8 | 1.5 h | 3.0 h |
| PP-7 | 4 × 4 + SE top 8 | 16 | 24 | SE-8 (7 matches) | 31 | 3 | 3 | 6 | 8 | 3.0 h | 4.5 h |
| PP-8 | 4 × 4 + DE top 8 | 16 | 24 | DE-8 (~15 matches) | 39 | 3 | 7 | 10 | 8 | 5.0 h | 6.5 h |
| PP-9 | 4 × 6 + SE top 8 | 24 | 60 | SE-8 (7 matches) | 67 | 5 | 3 | 8 | 12 | 4.0 h | 9.0 h |

### 2.3 Single Elimination variants (SE-*)

| ID | Variant | Entrants | Matches | Rounds | Max parallel (R1) | Duration @ unconstrained | Duration @ 4 courts |
|---|---|---|---|---|---|---|---|
| SE-1 | Pure SE | 8 | 7 | 3 | 4 | 1.5 h | 1.5 h |
|  |  | 16 | 15 | 4 | 8 | 2.0 h | 2.0 h |
|  |  | 24 (padded → 32) | 23 (8 R1 byes) | 5 | 8 (R1) | 2.5 h | 3.5 h |
| SE-2 | SE + 3rd-place match | 8 | 8 | 3 | 4 | 1.5 h | 2.0 h |
|  |  | 16 | 16 | 4 | 8 | 2.0 h | 2.0 h |
| SE-3 | SE with consolation bracket (losers play a parallel SE) | 8 | 7 + 3 = 10 | 3 (parallel) | 4 + 2 = 6* | 1.5 h | 2.5 h |
|  |  | 16 | 15 + 7 = 22 | 4 (parallel) | 8 + 4 = 12* | 2.0 h | 3.0 h |

*Consolation bracket starts after WB R1; max simultaneous matches across both brackets stacks.

### 2.4 Double Elimination variants (DE-*)

| ID | Variant | Entrants | Matches | Rounds (no reset) | Max parallel | Duration @ unconstrained | Duration @ 4 courts |
|---|---|---|---|---|---|---|---|
| DE-1 | Pure DE (no GF reset) | 8 | 14 | 7 | 4 (R1) | 3.5 h | 3.5 h |
|  |  | 16 | 30 | 9 | 8 (R1) | 4.5 h | 4.0 h |
|  |  | 24 (padded → 32) | ~62 | 11 | 16 (R1) | 5.5 h | 8.0 h |
| DE-2 | DE with GF reset (LB winner gets 2nd life) | 8 | 14 + 1 = 15 | 7 + 1 = 8 | 4 (R1) | 4.0 h | 4.0 h |
|  |  | 16 | 30 + 1 = 31 | 9 + 1 = 10 | 8 (R1) | 5.0 h | 4.0 h |
|  |  | 24 (padded → 32) | ~63 | 11 + 1 = 12 | 16 (R1) | 6.0 h | 8.0 h |

### 2.5 Rotating Partners variants (RP-*)

Rotation algorithms (e.g. King of the Court, Mexicano, Round-robin partner shuffle). Each "round" all players play exactly one match with a new partner assignment. Let **R** be the number of rotations chosen and **N** the player count.

| ID | Variant | Entrants | Rotations R | Matches | Rounds | Max parallel | Duration @ unconstrained | Duration @ 4 courts |
|---|---|---|---|---|---|---|---|---|
| RP-1 | Mexicano (fixed R rotations, no playoff) | 8 | 6 | 12 | 6 | 2 (only floor(N/4) courts active) | 3.0 h | 3.0 h |
|  |  | 12 | 6 | 18 | 6 | 3 | 3.0 h | 3.0 h |
|  |  | 16 | 6 | 24 | 6 | 4 | 3.0 h | 3.0 h |
| RP-2 | Rotating partners + 1-game final (top 2) | 8 | 6 | 12 + 1 = 13 | 7 | 2 | 3.5 h | 3.5 h |
|  |  | 16 | 6 | 24 + 1 = 25 | 7 | 4 | 3.5 h | 3.5 h |
| RP-3 | Rotating partners + SE top 4 | 12 | 6 | 18 + 3 = 21 | 6 + 2 = 8 | 3 | 4.0 h | 4.0 h |
|  |  | 16 | 6 | 24 + 3 = 27 | 6 + 2 = 8 | 4 | 4.0 h | 4.0 h |
| RP-4 | Rotating partners + DE top 4 | 12 | 6 | 18 + ~7 = 25 | 6 + 5 = 11 | 3 | 5.5 h | 4.0 h |
|  |  | 16 | 6 | 24 + ~7 = 31 | 6 + 5 = 11 | 4 | 5.5 h | 4.0 h |

Note: RP max parallel is `floor(N/4)` because each match consumes 4 players (doubles) and every player plays every round.

### 2.6 MLP variants (MLP-*)

T = number of MLP **teams** (each team has 4 players). One team meeting = 4 sub-matches in parallel = 1 "round" if ≥4 courts.

A T-team RR schedules `floor(T/2)` team meetings simultaneously per round, so RR rounds = `T-1` (T even) and team meetings = `T(T-1)/2`. Each team meeting needs 4 courts atomically.

| ID | Variant | Teams T | Team meetings | Sub-matches | Rounds | Max parallel (sub-matches) | Duration @ 4 courts | Duration @ 8 courts |
|---|---|---|---|---|---|---|---|---|
| MLP-1 | RR team meetings (T=4) | 4 | 6 | 24 | 3 | 8 (2 meetings/round) | 3.0 h (1 mtg/wave, 6 waves) | 1.5 h |
| MLP-2 | RR team meetings (T=6) | 6 | 15 | 60 | 5 | 12 (3 meetings/round) | 7.5 h | 3.75 h (2 mtgs/wave) |
| MLP-3 | RR team meetings (T=8) | 8 | 28 | 112 | 7 | 16 (4 meetings/round) | 14.0 h | 7.0 h |
| MLP-4 | Double RR team meetings (T=4) | 4 | 12 | 48 | 6 | 8 | 6.0 h | 3.0 h |
| MLP-5 | Pool play 2×3 team meetings | 6 | 6 (2 pools × 3 mtgs) | 24 | 3 | 8 (both pools concurrent) | 3.0 h | 1.5 h |
| MLP-6 | Pool play 2×4 team meetings | 8 | 12 (2 pools × 6 mtgs) | 48 | 3 (per pool) | 16 (2 pools × 2 mtgs) | 6.0 h | 3.0 h |
| MLP-7 | RR (T=4) + SE top 2 (final = 1 team meeting) | 4 | 6 + 1 = 7 | 28 | 3 + 1 = 4 | 8 | 3.5 h | 2.0 h |
| MLP-8 | RR (T=4) + SE top 4 (semis + final) | 4 | 6 + 3 = 9 | 36 | 3 + 2 = 5 | 8 | 4.5 h | 2.5 h |
| MLP-9 | RR (T=6) + SE top 4 | 6 | 15 + 3 = 18 | 72 | 5 + 2 = 7 | 12 | 9.0 h | 5.0 h |
| MLP-10 | RR (T=8) + SE top 4 | 8 | 28 + 3 = 31 | 124 | 7 + 2 = 9 | 16 | 15.5 h | 8.5 h |
| MLP-11 | Pool play (T=8, 2×4) + SE top 4 | 8 | 12 + 3 = 15 | 60 | 3 + 2 = 5 | 16 (pool phase) | 7.5 h | 4.0 h |
| MLP-12 | RR (T=4) + DE top 2 (with GF reset) | 4 | 6 + 2 = 8 | 32 | 3 + 2 = 5 | 8 | 4.0 h | 2.5 h |

---

## 3. Court Allocation Considerations

### 3.1 Pool Play has the highest pool-phase parallelism

A `P × S` pool play runs all P pools simultaneously, peaking at **`P · floor(S/2)` parallel matches**. Examples:

| Config | Max parallel | Implication |
|---|---|---|
| 2 × 4 | 4 | Fits 4-court facility perfectly. |
| 3 × 4 | 6 | Needs 6+ courts; 4-court facility splits across two waves. |
| 4 × 4 | 8 | Needs 8+ courts. |
| 4 × 6 | 12 | Needs 12+ courts to run all pools fully parallel. |

Pool play is the **best fit when courts are abundant and time is scarce**.

### 3.2 MLP is court-hungry per team meeting

An MLP team meeting requires **4 sub-matches simultaneously**, so:

- **4 courts** → exactly 1 team meeting at a time. The schedule is fully serialized over team meetings, regardless of the underlying RR round structure.
- **8 courts** → 2 team meetings can run side-by-side. For T ≥ 4 this matches the natural `floor(T/2)` RR concurrency; for T = 4 it cuts duration in half.
- **12+ courts** → 3+ team meetings concurrently (only fully utilized when T ≥ 6).
- **<4 courts** → break the team meeting into sequential sub-matches; the "atomic" property is lost and the format degrades.

### 3.3 DE playoff has lower parallelism than WB-only

In a pure SE bracket, round 1 occupies `P/2` courts and each subsequent round halves the demand. In DE, the LB lags one round behind WB. Practical impact:

- **WB round k** and **LB round k-1** can sometimes overlap, doubling parallelism vs. WB-only.
- But near the end of the bracket, LB and WB late rounds **serialize** (e.g. WB final must finish before GF; LB semi must finish before LB final).
- Net effect: DE total parallelism averages slightly above SE but never as low as the GF tail.

### 3.4 Sequential dependencies in SE/DE

Round N cannot start until round N-1 finishes. Match-count vs. court-count interaction:

| Round | Parallelism (SE, N=16) | Courts needed |
|---|---|---|
| R1 | 8 | 8 |
| Quarterfinals | 4 | 4 |
| Semifinals | 2 | 2 |
| Final | 1 | 1 |

A 4-court facility wastes 0 court-slots in QF/SF/F but creates a backlog at R1 (8 matches → 2 waves). So bracket tournaments are **court-elastic**: extra courts only help the first 1-2 rounds.

### 3.5 Rotating partners is rotation-constrained, not court-constrained

Every player plays every round, so all `floor(N/4)` courts are used every round. There is no "elasticity" — extra courts beyond `floor(N/4)` are wasted in the pool phase. The bottleneck is the **rotation algorithm**, not the court count.

---

## 4. Bottleneck Analysis

For each Larger Format, what limits how fast the tournament can finish?

| Larger Format | Bottleneck | Effect of adding courts |
|---|---|---|
| Round Robin | **Round count** (sequential within a single group). | Diminishing returns past `floor(N/2)` courts. |
| Pool Play (pool phase) | **Match count distributed across pools** — highly parallel. | Helps until courts = `P · floor(S/2)`. |
| Pool Play (with playoff) | **The playoff bracket** following the pool phase becomes the long pole. | Helps WB R1 only. |
| Single Elimination | **Late rounds (semi, final)** that drop to 1-2 courts. | Helps R1/R2 only. |
| Double Elimination | **GF (and possible reset)** at the end. LB pacing also slows the middle. | Helps R1/R2 only. |
| MLP | **Courts in multiples of 4** — every team meeting needs 4. | 8 courts = 2 meetings concurrently; 12 = 3; saturates at `4 · floor(T/2)`. |
| Rotating Partners | **Rotation algorithm** (each round consumes all players). | No benefit past `floor(N/4)`. |

### 4.1 Court-saturation table

For each Larger Format, the **court count beyond which adding more does not shorten the tournament**:

| Format | Saturation point (courts) | Notes |
|---|---|---|
| RR (N players) | `floor(N/2)` | All matches of one round at once. |
| Double RR | `floor(N/2)` | Same. |
| Pool Play `P × S` | `P · floor(S/2)` | All pools fully parallel. |
| SE (N entrants, N pow2) | `N/2` | R1 only — useless after. |
| DE | `N/2` | Same as SE; LB never reaches `N/2`. |
| Rotating Partners | `floor(N/4)` | Every round uses all players. |
| MLP (T teams) | `4 · floor(T/2)` | Team-meeting atomicity rounds courts down to the nearest multiple of 4; useful concurrency = floor(courts/4) meetings. |

---

## 5. Cross-references

- [Round Robin](./round-robin.md)
- [Pool Play](./pool-play.md)
- [Elimination Brackets](./elim-brackets.md)
- [MLP](./mlp.md)
- [Rotating Partners](./rotating-partners.md)
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md)
- [Index: Tournament Formats](../tournament-formats.md)
