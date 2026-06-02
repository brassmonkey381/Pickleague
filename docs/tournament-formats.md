# Tournament Format Permutations

This document enumerates every meaningful permutation of tournament structure
in Pickleague, organized on three axes: **Larger Format**, **Additional
Format**, and **Playoff Format**. It also introduces a proposed
*Double-Elimination Playoff* (losers-bracket) variant that can be layered on
top of group-play formats.

The goal is to align on names and flows before any code changes. Existing
columns are noted next to each option; anything labeled **(NEW)** does not yet
exist in the schema or UI.

---

## The 3-Axis Model

Every tournament can be described by a tuple `(Larger, Additional, Playoff)`:

| Axis | Purpose | DB column today |
|---|---|---|
| **Larger Format** | The top-level shape of group / bracket play | `tournaments.format` |
| **Additional Format** | Sub-shape modifier within the larger format | `tournaments.pool_count`, `partner_rotation`, `mlp_play_format`, `mlp_pool_count` |
| **Playoff Format** | What happens after group play (if anything) | `tournaments.mlp_playoff_teams` (MLP only today) |

The current schema only exposes Additional+Playoff axes for MLP. The proposal
below generalizes those axes so any group-play format (Round Robin, Pool Play,
MLP) can opt into a playoff bracket — including a new double-elim playoff
variant.

---

## Axis 1 — Larger Format

Seven values, all already supported (`tournaments.format`):

| Value | Label | Match type | Group play? | Built-in bracket? |
|---|---|---|---|---|
| `round_robin` | Round Robin | singles / doubles | yes (flat) | no |
| `pool_play` | Pool Play | singles / doubles | yes (pools) | no |
| `single_elimination` | Single Elim | singles / doubles | no | yes — single elim |
| `double_elimination` | Double Elim | singles / doubles | no | yes — winners + losers + GF |
| `rotating_partners` | Rotating Partners | doubles only | yes (rotating) | no |
| `mlp` | MLP / Fixed Teams | doubles only (teams of 4: 2M+2W) | yes | depends on `mlp_play_format` |
| `mlp_random` | MLP / Random Teams | doubles only (auto-generated teams) | yes | depends on `mlp_play_format` |

---

## Axis 2 — Additional Format

The available modifiers depend on the Larger Format.

### Round Robin
- **Single RR** (default) — every player/team plays every other once.
- **Double RR** **(NEW)** — every pair plays twice (home/away parity). Useful
  for short leagues that want more matches without adding entrants.

### Pool Play
- **Pool count**: 2, 3, 4, 6 (matches `tournaments.pool_count`).
- Each pool internally runs a single round robin (existing behavior).
- Snake-draft seeding by PLUPR is the current default; random seeding is also
  supported via `tournaments.seeding`.

### Single Elimination
- **Seeding only** — no further sub-shape. (Could later add an optional
  consolation bracket; see Playoff Format §3.)

### Double Elimination
- **Bracket reset on / off** **(NEW toggle, infra already exists)** — if the
  losers-bracket finalist wins Grand Final 1, an optional GF2 ("reset")
  forces a true 2-loss elimination. The migration trigger
  `_advance_double_elim_bracket` already implements this; just needs a UI
  toggle.

### Rotating Partners
- **Rotate every match** vs **rotate every round** (`partner_rotation`).

### MLP / MLP Random
- **Play format** (`mlp_play_format`):
  - `round_robin` — every team plays every team once.
  - `pool_play` — teams snake-drafted into pools, RR within pool.
  - `round_robin_playoff` — RR then top-N advance to playoff.
  - `pool_play_playoff` — pool play then top-N advance to playoff.
- **Pool count** (`mlp_pool_count`, 2–8) when play format is pool-based.
- Each team meeting is a 4-sub-match round: men's, women's, 2× mixed.

---

## Axis 3 — Playoff Format

This is where the proposal extends the existing model. Today, only MLP
exposes a playoff (`mlp_playoff_teams`: 2 / 4 / 8) and it is always
single-elimination. The plan generalizes Playoff Format to all group-play
larger formats and adds a losers-bracket option.

| Code | Label | Description |
|---|---|---|
| `none` | No Playoff | Final standings come from group play. Existing default for RR / Pool Play. |
| `top_2_final` | Top 2 — Final | The top two seed into a single championship match. |
| `top_2_final_3pm` | Top 2 — Final + 3rd Place Match | Adds a 3rd-vs-4th match (existing for MLP top-2). |
| `top_4_se` | Top 4 — Single Elim | Semis → Final (3PM optional toggle). |
| `top_8_se` | Top 8 — Single Elim | Quarters → Semis → Final (3PM optional toggle). |
| `top_4_de` **(NEW)** | Top 4 — Double Elim | 4 seeds into a double-elim bracket. Losers-bracket survivor meets winners-bracket champ in Grand Final (with optional bracket reset). |
| `top_8_de` **(NEW)** | Top 8 — Double Elim | Same as `top_4_de` but with 8 seeds. |
| `top_N_per_pool_se` **(NEW name)** | Top N per Pool — Single Elim | Pool-Play only: top N of each pool seeded across pools (crossover bracket: A1 vs B2, B1 vs A2 …). |
| `top_N_per_pool_de` **(NEW)** | Top N per Pool — Double Elim | Same crossover seeding, but into a double-elim playoff bracket. |
| `top_N_consolation` **(NEW)** | Top N — Consolation Bracket | Single-elim main bracket plus a single-elim consolation bracket for first-round losers (lighter-weight alternative to full double-elim). |

**Important:** "Double Elim playoff" is *not* the same as choosing
`double_elimination` as the Larger Format. The Larger Format option means
the *entire* tournament is double-elim with no group play. The Playoff
Format option means group play runs first, then only the top N seeds enter a
double-elim playoff bracket.

The schema already has full double-elim infrastructure
(`_advance_double_elim_bracket`, winners / losers / `grand_final` round
types, third-place-match round type), so the Playoff Format `top_N_de`
variants reuse the same auto-advancement triggers — just gated to start
from the seeded top-N rather than the full entrant list.

---

## Concrete Permutations

The cross-product of `(Larger, Additional, Playoff)` produces dozens of
shapes. Below are the meaningful named permutations. Any combination not
listed is either redundant (e.g., a playoff on top of a single-elim bracket)
or not yet planned.

### Round Robin

| # | Permutation | Flow |
|---|---|---|
| RR-1 | `round_robin` + Single RR + none | Everyone plays everyone; standings = final result. |
| RR-2 | `round_robin` + Single RR + `top_2_final` | RR → Final between #1 and #2. |
| RR-3 | `round_robin` + Single RR + `top_2_final_3pm` | RR → Final + 3rd-place match. |
| RR-4 | `round_robin` + Single RR + `top_4_se` | RR → Semis → Final (+ optional 3PM). |
| RR-5 | `round_robin` + Single RR + `top_4_de` **(NEW)** | RR → 4-team double-elim playoff (losers bracket gives a 2nd life). |
| RR-6 | `round_robin` + Single RR + `top_8_se` | RR → Quarters → Semis → Final. |
| RR-7 | `round_robin` + Single RR + `top_8_de` **(NEW)** | RR → 8-team double-elim playoff. |
| RR-8 | `round_robin` + Double RR + any of the above **(NEW additional)** | Same playoffs but each RR pair plays twice. |

### Pool Play

For each pool count P ∈ {2, 3, 4, 6}:

| # | Permutation | Flow |
|---|---|---|
| PP-1 | `pool_play` + P pools + none | Pools run RR; final standings = within-pool order. |
| PP-2 | `pool_play` + P pools + `top_2_final` | Pool winners cross over for a single Final (only valid when P = 2). |
| PP-3 | `pool_play` + P pools + `top_4_se` | Top 1 from each of 4 pools (or 2 from each of 2 pools) → Semis → Final. |
| PP-4 | `pool_play` + P pools + `top_4_de` **(NEW)** | Same seeding, double-elim playoff bracket. |
| PP-5 | `pool_play` + P pools + `top_8_se` | Crossover seeding into an 8-team SE bracket (2 per pool for P=4, etc.). |
| PP-6 | `pool_play` + P pools + `top_8_de` **(NEW)** | Same as PP-5 with a losers bracket. |
| PP-7 | `pool_play` + P pools + `top_N_per_pool_se` **(NEW name)** | N from each pool seeded with crossover rules (A1 vs B2, B1 vs A2, etc.). |
| PP-8 | `pool_play` + P pools + `top_N_per_pool_de` **(NEW)** | Same crossover, double-elim playoff. |
| PP-9 | `pool_play` + P pools + `top_N_consolation` **(NEW)** | Top N → SE main, first-round losers → SE consolation. |

> **Example (user's prompt):** Pool Play + 3 pools + Top 2 = permutation
> PP-7 with N=2. Top 2 from each of 3 pools (6 entrants) seed into a
> bracket; either single-elim (PP-7) or double-elim (PP-8) playoff.

### Single Elimination (no group play)

| # | Permutation | Flow |
|---|---|---|
| SE-1 | `single_elimination` + (none) + N/A | Standard knockout bracket. |
| SE-2 | `single_elimination` + (none) + 3PM toggle **(NEW)** | Knockout + 3rd-place match between losing semifinalists. |
| SE-3 | `single_elimination` + Consolation bracket **(NEW)** | Knockout + consolation bracket for round-1 losers. |

### Double Elimination (no group play)

| # | Permutation | Flow |
|---|---|---|
| DE-1 | `double_elimination` + bracket reset OFF | Winners + losers + single GF. If LB champ wins GF, they're the champ outright. |
| DE-2 | `double_elimination` + bracket reset ON **(NEW toggle)** | Winners + losers + GF1; if LB champ wins GF1, GF2 enforces true 2-loss elimination. (Trigger already supports both modes.) |

### Rotating Partners

| # | Permutation | Flow |
|---|---|---|
| RP-1 | `rotating_partners` + every match + none | Individual standings from rotating-partner matches. |
| RP-2 | `rotating_partners` + every round + none | Same; partners stay across rounds, rotate between rounds. |
| RP-3 | `rotating_partners` + either + `top_N_se` **(NEW)** | Top N individuals are paired (e.g., by adjacent ranking) into a single-elim playoff. |
| RP-4 | `rotating_partners` + either + `top_N_de` **(NEW)** | Same as RP-3 with a losers bracket. |

### MLP (Fixed Teams) and MLP Random

All combinations apply to both `mlp` and `mlp_random`. Replace `mlp` below
with `mlp_random` for the auto-generated-team variant.

| # | Permutation | Flow |
|---|---|---|
| MLP-1 | `mlp` + `round_robin` + none | All teams round-robin; standings final. |
| MLP-2 | `mlp` + `pool_play` (P pools) + none | Pool RR; within-pool order final. |
| MLP-3 | `mlp` + `round_robin_playoff` + Top 2 (Final + 3PM) | RR → Final + 3PM. |
| MLP-4 | `mlp` + `round_robin_playoff` + Top 4 (Semis) | RR → Semis → Final. |
| MLP-5 | `mlp` + `round_robin_playoff` + Top 8 (Quarters) | RR → QF → SF → Final. |
| MLP-6 | `mlp` + `round_robin_playoff` + Top 4 DE **(NEW)** | RR → 4-team double-elim playoff. |
| MLP-7 | `mlp` + `round_robin_playoff` + Top 8 DE **(NEW)** | RR → 8-team double-elim playoff. |
| MLP-8 | `mlp` + `pool_play_playoff` (P pools) + Top 2 | Pool play → Final + 3PM. |
| MLP-9 | `mlp` + `pool_play_playoff` (P pools) + Top 4 | Pool play → Semis → Final. |
| MLP-10 | `mlp` + `pool_play_playoff` (P pools) + Top 8 | Pool play → QF → SF → Final. |
| MLP-11 | `mlp` + `pool_play_playoff` (P pools) + Top 4 DE **(NEW)** | Pool play → 4-team double-elim playoff. |
| MLP-12 | `mlp` + `pool_play_playoff` (P pools) + Top 8 DE **(NEW)** | Pool play → 8-team double-elim playoff. |

---

## Double-Elim Playoff Flow (the losers-bracket extension)

This is the heart of the new request: after group play, the top N teams
enter a bracket where one loss does **not** eliminate you. You drop into
the losers bracket and can fight back to the Grand Final.

### Top 4 Double-Elim Playoff

Seeded entrants: S1, S2, S3, S4 (e.g., RR top 4 or 1 per pool).

```
Winners Bracket
  WSF1: S1 vs S4 ──┐
                   ├── WF: WSF1.W vs WSF2.W ── GF
  WSF2: S2 vs S3 ──┘                              │
                                                  │
Losers Bracket                                    │
  LR1: WSF1.L vs WSF2.L                           │
  LF: LR1.W vs WF.L  ──────────────────── GF.LB  ─┘
                                                  │
                                       (optional) GF2 if LB wins GF1
```

8 teams advance through a similar structure:
- WB Round 1 (Quarterfinals): 4 matches
- WB Semifinals: 2 matches
- WB Final: 1 match
- LB consolidation + drop-in rounds running in parallel
- Grand Final (with optional bracket reset)

### Top 4 Double-Elim Playoff after Pool Play

Pool Play + 2 pools + `top_N_per_pool_de` with N=2:

```
Pool A standings: A1, A2 ─┐
Pool B standings: B1, B2 ─┘
                ↓ crossover seeding
  WSF1: A1 vs B2
  WSF2: B1 vs A2
              … rest is identical to "Top 4 Double-Elim Playoff" above
```

### Why this is worth doing
- Adds resilience for upset losses in single-match playoffs (one bad game
  doesn't end a strong team's tournament).
- Roughly doubles the number of bracket matches → more games per entrant,
  more spectator value, more wagering opportunities (relevant given the
  recently shipped wagering feature).
- Cost: scheduling complexity (LB matches happen between WB rounds), and a
  longer day. UI needs to render both brackets side-by-side.

---

## What Already Exists vs. What's New

| Capability | Status |
|---|---|
| 7 larger formats including `double_elimination` and `pool_play` | ✅ Exists |
| Pool count 2 / 3 / 4 / 6 for `pool_play` | ✅ Exists |
| MLP playoff with top 2 / 4 / 8 single-elim | ✅ Exists |
| Third-place match for MLP top-2 playoff | ✅ Exists |
| Double-elim winners + losers + grand final + bracket reset infra | ✅ Exists (`_advance_double_elim_bracket` trigger) |
| Generalized Playoff Format axis for non-MLP formats | ❌ New |
| Double-elim playoff bracket (top N from group play → DE) | ❌ New (reuses existing DE trigger) |
| Consolation bracket for SE | ❌ New |
| Double round robin | ❌ New |
| Bracket reset toggle for `double_elimination` larger format | ❌ New UI surface (infra exists) |
| 3PM toggle for non-MLP single-elim playoffs | ❌ New |
| Top-N-per-pool crossover seeding rules | ❌ New (current pool-play has no playoff layer at all) |

---

## Proposed Schema Sketch (for future PRs)

To generalize the model, the schema would converge around three columns:

```sql
alter table public.tournaments
  -- Generalized "additional format" stays per-Larger-Format:
  --   pool_count, partner_rotation, mlp_play_format, mlp_pool_count stay
  --   add: rr_double boolean default false   -- single vs double RR
  --   add: de_bracket_reset boolean default true  -- DE Larger Format toggle

  -- Generalized "playoff format" replaces the MLP-only column:
  add column if not exists playoff_format text default 'none',
    -- one of: none, top_2_final, top_2_final_3pm,
    --         top_4_se, top_4_de, top_8_se, top_8_de,
    --         top_N_per_pool_se, top_N_per_pool_de,
    --         top_N_consolation
  add column if not exists playoff_n integer,
    -- N for top_N_per_pool_* (e.g., 2 = top-2-per-pool)
  add column if not exists playoff_third_place boolean default false;
    -- toggle 3PM for SE playoffs
```

The existing `mlp_playoff_teams` column would be derived from
`playoff_format` for MLP (`top_4_se` → 4, `top_8_de` → 8, etc.) or kept as a
shim during migration.

The generators in `mobile/src/lib/tournament.ts` already cover all the
bracket primitives; new permutations are mostly orchestration:
1. Run group-play generator (existing).
2. After lock-in, read top N standings.
3. Hand seeded entrants to either `generateSingleElim` or
   `generateDoubleElim` (both exist).

---

## Open Questions (for a future planning session, not now)

- For `top_N_per_pool_*`, what's the crossover rule when pool counts and
  N produce non-power-of-2 brackets (e.g., 3 pools × top 2 = 6 entrants)?
  Two natural options: byes for top seeds, or a play-in round.
- For double-elim playoff after pool play, do we always reset the bracket
  on GF1 upset, or expose the toggle per tournament?
- Should `rotating_partners` playoffs pair top individuals by rank-adjacent
  matching (1+2, 3+4) or rank-spread (1+8, 2+7) for fairness?
- Does `double_round_robin` change anything for tournament scheduling
  (court allocation, total-rounds calculation)?

---

*This document is a planning artifact. Nothing in `mobile/` or `supabase/`
has been changed.*
