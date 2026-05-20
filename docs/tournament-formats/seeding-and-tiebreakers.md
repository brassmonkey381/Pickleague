# Seeding & Tiebreakers

A canonical cross-cutting reference for how standings turn into playoff
seeds, how seeds pair up inside a bracket, how crossover seeding works for
"Top N per Pool" playoffs, and how ties in standings are broken.

This doc complements the index in
[`../tournament-formats.md`](../tournament-formats.md) and applies across
every Larger Format that can feed a playoff bracket.

---

## App descriptions (source of truth)

These are the hint texts Pickleague shows users on the Create Tournament
screen. Treat them as the canonical short descriptions; the prose below
expands on them.

**Bracket Seeding — PLUPR-based** (`mobile/src/screens/CreateTournamentScreen.tsx:343-345`):

> "Determines bracket structure and which players face off in each round.
> Players are sorted by PLUPR; pools and brackets use snake-draft so the
> top seed faces the bottom seed and skill levels stay balanced across
> pools."

**Bracket Seeding — Random** (`mobile/src/screens/CreateTournamentScreen.tsx:343-347`):

> "Determines bracket structure and which players face off in each round.
> Players are drawn randomly into pools and bracket slots."

**MLP Number of Pools hint** (`mobile/src/screens/CreateTournamentScreen.tsx:377`):

> "Teams are snake-drafted into pools by seed so each pool is balanced."

**Pool Play Number of Pools hint** (`mobile/src/screens/CreateTournamentScreen.tsx:408`):

> "Players are distributed evenly. Snake-draft keeps pools balanced by
> PLUPR when seeding is on."

Two terms to use consistently throughout this doc:

- **Snake-draft** — the app's name for the seeding algorithm that places
  entrants into pools (and into bracket slots) by alternating direction
  across rounds so each pool / bracket half gets a balanced mix of high
  and low seeds.
- **Top seed faces the bottom seed** — the canonical round-1 pairing in
  any bracket of size N: seed 1 vs seed N, seed 2 vs seed N−1, etc. (See
  §2.)

---

## 1. Seeding by Larger Format

The Larger Format determines what "standings" mean and therefore how seed
numbers get assigned for any downstream playoff bracket.

| Larger Format | Standings source | Seed 1 = |
|---|---|---|
| `round_robin` | Flat RR standings (all entrants) | Top of overall standings |
| `pool_play` | Per-pool RR standings (one table per pool) | A1, B1, C1… (top of each pool) |
| `mlp` / `mlp_random` | Per-team sub-match wins (`mlp_team_standings`) | Team with most sub-match wins |
| `rotating_partners` | Individual standings (partners shuffle) | Top individual |
| `single_elimination` | None — pre-seeded at registration | Highest PLUPR (or `tournaments.seeding` value) |
| `double_elimination` | None — pre-seeded at registration | Highest PLUPR (or `tournaments.seeding` value) |

### Round Robin
- Every entrant plays every other.
- Standings are ordered by the tiebreaker sequence in §4.
- Seed `k` = the kth row of the final standings.

### Pool Play
- At registration, entrants are distributed into pools by **snake-draft**
  on PLUPR (when PLUPR-based seeding is selected) so each pool is
  balanced. With Random seeding, entrants are drawn randomly into pools.
- Each pool runs its own RR; per-pool standings use the §4 tiebreaker
  sequence.
- Inter-pool seeding is done by **crossover** rules (§3), not by
  re-sorting all entrants into one flat list. (i.e., A1 and B1 do not
  compete on game-differential to decide which is "#1 overall"; they're
  both seed 1 of their pool and the bracket structure determines whether
  they can meet before the final.)

### MLP / MLP Random
- When pool play is used, teams are **snake-drafted into pools by seed**
  so each pool is balanced (app hint, `CreateTournamentScreen.tsx:377`).
- Standings come from `mlp_team_standings(p_tournament_id)`, which orders
  by **sub-match wins desc, sub-match losses asc, then registration seed**
  as a final tiebreaker.
- Each team meeting produces 4 sub-matches (men's, women's, 2× mixed), so
  one team meeting can contribute up to 4 wins/losses to standings.
- **Caveat (see §4):** this differs from the "pickleball-standard" rule of
  counting full match wins first. It's effectively game-differential at
  the team-meeting level. Documented here so the generalized model can
  decide whether to keep MLP on sub-match counting or switch to
  team-meeting wins.

### Rotating Partners
- Partner pairings shuffle every match (or every round, per
  `partner_rotation`). Team-level standings don't exist.
- Standings are **individual**: a player's record is the sum of their own
  wins/losses regardless of who they were paired with.
- Tiebreakers in §4 apply individually (head-to-head being the trickiest:
  did player X beat player Y when those two were on opposite sides of any
  match?).
- A playoff layered on top (e.g., RP-3 `top_N_se`) must decide how to
  re-pair individuals into doubles teams for the bracket — see the
  rotating-partners deep-dive for that policy.

### Single Elim / Double Elim Larger Formats
- These formats have no group play, so there are no "standings" to derive
  seeds from. Seeds are set at registration via the existing
  `tournaments.seeding` column (PLUPR-descending is the current default).

---

## 2. Bracket Pairing Rules

Once entrants have seeds 1..N, the bracket positions are deterministic. The
canonical rule (matching the app's wording, "the top seed faces the bottom
seed"): **seed `k` plays seed `N - k + 1` in round 1** — so 1 vs N, 2 vs
N−1, and so on — with sub-brackets balanced so the top two seeds meet at
the latest possible round.

### Single Elimination

#### N = 4 (Top 4)

| Round | Match | Pairing |
|---|---|---|
| Semifinal 1 | SF1 | 1 vs 4 |
| Semifinal 2 | SF2 | 2 vs 3 |
| Final | F | SF1.W vs SF2.W |

```
SF1: 1 ──┐
         ├─ SF1.W ──┐
     4 ──┘         │
                   ├─ F
SF2: 2 ──┐         │
         ├─ SF2.W ─┘
     3 ──┘
```

(Optional 3PM: SF1.L vs SF2.L for 3rd place.)

#### N = 8 (Top 8)

| Round | Match | Pairing |
|---|---|---|
| Quarterfinal 1 | QF1 | 1 vs 8 |
| Quarterfinal 2 | QF2 | 4 vs 5 |
| Quarterfinal 3 | QF3 | 2 vs 7 |
| Quarterfinal 4 | QF4 | 3 vs 6 |
| Semifinal 1 | SF1 | QF1.W vs QF2.W |
| Semifinal 2 | SF2 | QF3.W vs QF4.W |
| Final | F | SF1.W vs SF2.W |

The top half of the bracket (1, 8, 4, 5) is separated from the bottom half
(2, 7, 3, 6) so seeds 1 and 2 cannot meet before the Final.

#### N = 16

Standard pairings: 1v16, 2v15, 3v14, 4v13, 5v12, 6v11, 7v10, 8v9. Bracket
quadrants keep 1-vs-2 meeting only in the final and 1-vs-4 / 2-vs-3 meeting
only in their respective semifinals.

#### Non-power-of-2 brackets

When N is not a power of 2, round 1 is a **play-in round**: only the
lowest-seeded entrants play, and the top seeds get a BYE straight into
round 2.

- N = 5 → 1 BYE; play-in: 4 vs 5; round 2: 1 vs (4/5), 2 vs 3.
- N = 6 → 2 BYEs; play-in: 3 vs 6 and 4 vs 5; round 2: 1 vs (4/5), 2 vs
  (3/6).
- N = 12 → 4 BYEs; play-in: 5 vs 12, 6 vs 11, 7 vs 10, 8 vs 9; round 2:
  full 8-team bracket using winners + the four top seeds.

Rule: number of BYEs = (next power of 2) − N. BYEs always go to the top
seeds, in order.

### Double Elimination

Winners-bracket pairings are **identical** to the SE table above. The
losers bracket is generated by feeding WB losers in round-of-drop order
into a separate bracket; see
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for the
drop-down rules. The Grand Final pairs the WB champion against the LB
survivor, with an optional bracket-reset GF2 if the LB survivor wins GF1.

---

## 3. Crossover Seeding for Top-N-per-Pool

When a Pool Play tournament uses a `top_N_per_pool_*` playoff, each pool
contributes its top N finishers. Those entrants need seed slots in the
playoff bracket, and the seeds must be chosen so that **same-pool entrants
do not meet again in round 1**.

The canonical rule used throughout this section: pool winners are spread
apart in the bracket, and within each crossover pair the top entrant from
one pool faces the lower entrant from a different pool.

### P = 2 pools, N = 2 → 4 entrants

Pool A standings: A1, A2.
Pool B standings: B1, B2.

| Bracket slot | Entrant |
|---|---|
| Seed 1 | A1 |
| Seed 2 | B1 |
| Seed 3 | A2 |
| Seed 4 | B2 |

Round 1 pairings (1v4, 2v3 — see §2):

```
SF1: A1 vs B2 ──┐
                ├─ F
SF2: B1 vs A2 ──┘
```

A1 and A2 (same pool) are split across opposite semifinals, so they can
only meet in the Final.

### P = 2 pools, N = 4 → 8 entrants

Pool A: A1, A2, A3, A4.
Pool B: B1, B2, B3, B4.

**Canonical assignment (rationale: snake by pool finish):**

| Bracket slot | Entrant |
|---|---|
| Seed 1 | A1 |
| Seed 2 | B1 |
| Seed 3 | A2 |
| Seed 4 | B2 |
| Seed 5 | A3 |
| Seed 6 | B3 |
| Seed 7 | A4 |
| Seed 8 | B4 |

Round 1 (1v8, 4v5, 2v7, 3v6 from §2):

```
QF1: A1 vs B4 ──┐
                ├─ SF1 ──┐
QF2: B2 vs A3 ──┘        │
                         ├─ F
QF3: B1 vs A4 ──┐        │
                ├─ SF2 ──┘
QF4: A2 vs B3 ──┘
```

Justification: snake-assignment (A1, B1, A2, B2, …) keeps the two pool
winners in opposite halves of the bracket (1 and 2), guarantees that no
same-pool pair meets in round 1, and treats the two pools symmetrically.
This is the same shape as snake-draft pool seeding done in reverse.

Note that same-pool teams **can** meet in the semifinals under this scheme
(e.g., if A1 and A3 both win QF1 and QF2). If avoiding all same-pool
rematches before the final is required, only N = 2 from 2 pools fully
guarantees it. For larger N, the snake assignment is the standard
compromise — minimize early rematches without distorting seed ordering.

### P = 3 pools, N = 2 → 6 entrants (non-power-of-2)

Pool A, Pool B, Pool C → 6 entrants total. The next power of 2 is 8, so
the bracket has 2 BYEs.

**Option A — BYEs for top seeds (recommended):**

Bracket-of-8 seed slots:

| Slot | Entrant |
|---|---|
| Seed 1 | A1 |
| Seed 2 | B1 |
| Seed 3 | C1 |
| Seed 4 | A2 |
| Seed 5 | B2 |
| Seed 6 | C2 |
| Seed 7 | BYE |
| Seed 8 | BYE |

After BYE assignment (seeds 1 and 2 get them):

```
Round 1
  QF1: A1   vs BYE  ─ (A1 advances)
  QF2: A2   vs B2
  QF3: B1   vs BYE  ─ (B1 advances)
  QF4: C1   vs C2     ← same-pool conflict (see below)
Round 2 (Semifinals)
  SF1: A1 vs QF2.W
  SF2: B1 vs QF4.W
Round 3 (Final)
  F:   SF1.W vs SF2.W
```

The C1-vs-C2 round-1 pairing is a known weakness of the
"BYEs to top seeds + standard 1vN crossover" approach. The fix is to
re-pair conflicts: swap QF4's lower-seeded entrant with the next
non-conflicting slot. With three pools and N=2, swapping C2 (seed 6) and
B2 (seed 5) yields:

```
Round 1
  QF1: A1   vs BYE
  QF2: A2   vs C2
  QF3: B1   vs BYE
  QF4: C1   vs B2
```

No same-pool round-1 match, top 2 still get BYEs. **Recommended.**

**Option B — Play-in round for the bottom seeds:**

Seeds 1..4 (A1, B1, C1, A2) get round-1 BYEs; seeds 5..6 (B2, C2) play a
single play-in match. The winner advances and is treated as the
lowest-seeded entrant in a 5-team bracket.

```
Play-in: B2 vs C2 ─┐
                   ├─ ...
Round 1
  QF1: A1 vs (B2/C2).W
  QF2: A2 vs B1   ← same-pool? no, but seeds 4 vs 2 here is unusual
  …
```

This adds an extra match for the bottom two and is harder to reason
about. Use Option A.

### P = 4 pools, N = 2 → 8 entrants

Pools A, B, C, D contribute 2 each → 8 entrants for a clean 8-team
bracket.

| Bracket slot | Entrant |
|---|---|
| Seed 1 | A1 |
| Seed 2 | B1 |
| Seed 3 | C1 |
| Seed 4 | D1 |
| Seed 5 | A2 |
| Seed 6 | B2 |
| Seed 7 | C2 |
| Seed 8 | D2 |

Pool affinity rule: a #1-seed and a #2-seed from the same pool must not
meet before the semifinal. Standard 1v8/4v5/2v7/3v6 pairing:

```
QF1: A1 vs D2 ──┐
                ├─ SF1 ──┐
QF2: D1 vs A2 ──┘        │
                         ├─ F
QF3: B1 vs C2 ──┐        │
                ├─ SF2 ──┘
QF4: C1 vs B2 ──┘
```

A1 and A2 would only meet if both win their QF — i.e., in SF1. To
guarantee no same-pool meeting before the Final, swap A2 (seed 5) and B2
(seed 6):

```
QF1: A1 vs D2
QF2: D1 vs B2
QF3: B1 vs C2
QF4: C1 vs A2
```

Now A2 lives in the bottom half (opposite A1). Same for B/C/D. Use this
pool-affinity-corrected layout when the bracket needs to forbid all
same-pool round-1 and semifinal matches; if the only constraint is
"no round-1 rematch", the unswapped version is fine.

### P = 6 pools, N = 2 → 12 entrants (non-power-of-2)

Next power of 2 is 16, so 4 BYEs. Pool winners A1..F1 take seeds 1..6;
pool runners-up A2..F2 take seeds 7..12. BYEs go to seeds 1..4 (A1, B1,
C1, D1).

```
Bracket of 16:
  Seed  1: A1     vs BYE
  Seed  2: B1     vs BYE
  Seed  3: C1     vs BYE
  Seed  4: D1     vs BYE
  Seed  5: E1     vs F2     ← need rematch check
  Seed  6: F1     vs E2     ← same-pool conflict
  Seed  7: A2     vs D2     ← need rematch check
  Seed  8: B2     vs C2
```

Two of the pairings above re-pair same-pool teams (E1-vs-E2, F1-vs-F2)
because the 1v16 layout puts seed 5 against seed 12 and seed 6 against
seed 11 — and snake-assignment puts E1 at slot 5, E2 at slot 11. Apply
the same "swap with adjacent" fix from the P=3/N=2 case: swap E2 with F2
in the lower half. The general principle for non-power-of-2 with 5+
pools: assign seeds by snake, then walk the round-1 pairings and swap
same-pool conflicts with the nearest non-conflicting opponent.

For 6 pools and N > 2, the resulting bracket size grows quickly (P=6/N=4
= 24 entrants, next power of 2 = 32). Recommendation: cap top-N-per-pool
at N=2 for P ≥ 5, or move to a top_N_consolation format instead.

---

## 4. Tiebreaker Rules

The canonical sequence for breaking ties in Round Robin / Pool standings:

1. **Match wins** — count of full matches won (not games). A "match" is
   one row in `tournament_matches`; a "game" is one entry in
   `match_games`.
2. **Head-to-head record** — applies **only** when exactly 2 teams are
   tied at step 1. With 3+ teams tied, skip to step 3 (head-to-head is
   ambiguous when results form a rock-paper-scissors cycle).
3. **Game differential** — `games_won - games_lost` across all matches.
4. **Point differential** — sum across all games of
   `points_scored - points_allowed`. Capped scores (e.g., 11-9 vs 12-10
   in a win-by-2 game) all contribute as-is.
5. **Pre-tournament seeding (PLUPR)** — final fallback. The team/player
   with the higher registration seed wins the tiebreaker. Guarantees no
   tie can survive to the final ordering.

### Differences from current codebase behavior

- **`mlp_team_standings`** counts **sub-match wins** rather than full
  team-meeting wins (i.e., one team meeting can contribute 0–4 wins
  instead of 0 or 1). This is effectively step 1 + step 3 collapsed into
  a single number. It's reasonable for MLP (where the team-meeting score
  is genuinely "how many of the 4 sub-matches did your team win"), but
  it does not match the canonical sequence above. When generalizing the
  3-axis model, decide whether:
  - (a) Keep MLP on sub-match counting as a format-specific exception, or
  - (b) Switch MLP to team-meeting wins for step 1 and use sub-match
    differential as step 3.

  Option (a) is the minimum-change path; option (b) is more consistent
  across formats.
- **Head-to-head with 2 tied teams** is not currently implemented for any
  format — RR and pool standings today use game/point differential
  directly. Adding step 2 is a behavior change worth calling out in
  release notes.
- **Pre-tournament seeding as final fallback** — `mlp_team_standings`
  already does this (`order by … tp.seed`); RR/Pool standings should do
  the same.

---

## 5. Special Cases

### Withdrawal before standings finalize

A team drops out mid-pool with some matches played, others not. Two
canonical policies:

| Policy | Treatment of remaining matches | Treatment of completed matches |
|---|---|---|
| **Forfeit** | Recorded as 0-X losses for the withdrawing team (X = standard game-cap losses, e.g., 0–11) | Kept as played |
| **Remove** | Not played; not recorded | Also removed (the withdrawing team is treated as if they never played) |

**Recommendation: Forfeit.** Reasons:
- Other teams' standings already depend on the played-vs-not-played
  outcomes. Removing completed matches retroactively penalizes opponents
  who *won* against the withdrawing team.
- Forfeit is consistent with USAPA / DUPR practice and the league norm.
- The withdrawing team's seed is preserved for tiebreaker step 5.

Implementation note: forfeits should mark the match `status = 'completed'`
with `winner_team` = the present team and `match_games` rows that produce
a worst-case point differential for the withdrawing team (so step 4 is
deterministic).

### Tied at the playoff cutoff

Concrete example: 6-team RR with `top_4_se` playoff. After RR:

| Team | Match W | Match L |
|---|---|---|
| T1 | 5 | 0 |
| T2 | 4 | 1 |
| T3 | 3 | 2 |
| T4 | 3 | 2 |
| T5 | 3 | 2 |
| T6 | 0 | 5 |

T3, T4, T5 are all tied at 3-2 for the 3rd / 4th / 5th positions; the 5th
team is eliminated.

Walking the tiebreaker:

1. **Match wins**: all three at 3 — still tied.
2. **Head-to-head**: 3 teams tied → skip.
3. **Game differential**:
   - T3: +4
   - T4: +2
   - T5: +5
   - Result: T5 → 3rd (in standings), T3 → 4th, T4 → 5th (eliminated).

If after step 3 two of the three are still tied (say T3 and T4 both at +4
and T5 at +5):

3. Game diff isolates T5 → 3rd. T3 and T4 are now a 2-team tie for 4th.
4. **Apply step 2 retroactively** to the remaining 2-team tie: T3 beat T4
   in their RR head-to-head → T3 takes 4th, T4 eliminated.

If they didn't play each other (impossible in a single RR but possible in
pool-play crossover scenarios), fall through to step 4 (point
differential), then step 5 (seeding).

> **Important detail:** when more than 2 teams are tied, work the
> sequence on the whole group (steps 1, 3, 4) until the group is reduced
> to 2 teams; **then** head-to-head (step 2) re-enters as a valid
> tiebreaker. Don't apply head-to-head while 3+ teams are still tied.

---

## 6. Cross-references

- [Round Robin](./round-robin.md) — RR standings and Double RR variant.
- [Pool Play](./pool-play.md) — per-pool standings and snake-draft seeding
  at registration.
- [MLP](./mlp.md) — MLP sub-match counting and team-meeting structure.
- [Rotating Partners](./rotating-partners.md) — individual standings and
  partner-rotation policies.
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) — how
  WB losers drop into the LB and how the Grand Final / bracket reset
  resolves.
- [Tournament Formats index](../tournament-formats.md) — top-level 3-axis
  model and full permutation list.
