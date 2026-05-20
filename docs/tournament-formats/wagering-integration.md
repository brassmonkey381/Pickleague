# Wagering Integration — Tournament Formats

A cross-cutting reference for how each tournament permutation in
[`docs/tournament-formats.md`](../tournament-formats.md) maps onto the
existing wager subject types, plus what's missing for the proposed
double-elim (losers-bracket) playoff variants.

This doc is descriptive — it does not propose any code change beyond the
NEW wager subject ideas in §3, which are left as future enhancements.

---

## 1. Existing Wager Subject Inventory

From `mobile/src/lib/wager.ts` (verbatim):

```ts
export type WagerSubject =
  | { type: 'match';                  matchId: string;            teamLabels: { team1: string; team2: string }; pickedTeam: 'team1' | 'team2' }
  | { type: 'tournament_match';       tournamentMatchId: string;  teamLabels: { team1: string; team2: string }; pickedTeam: 'team1' | 'team2' }
  | { type: 'match_score';            matchId: string;            team1Score: number; team2Score: number; teamLabels: { team1: string; team2: string } }
  | { type: 'tournament_match_score'; tournamentMatchId: string;  team1Score: number; team2Score: number; teamLabels: { team1: string; team2: string } }
  | { type: 'tournament_rank';        tournamentId: string;       tournamentName: string; userId: string; userName: string; rank: number }
  | { type: 'period_rank';            seasonId: string;           periodNumber: number; userId: string; userName: string; rank: number }
  | { type: 'season_rank';            seasonId: string;           userId: string; userName: string; rank: number };
```

The matching DB-side `subject_type` enum (from
`supabase/migration_add_wagering.sql`) is exactly:

```
'match','tournament_match','tournament_rank',
'period_rank','season_rank','match_score','tournament_match_score'
```

### Plain-language summary

| Subject | Bet on | Subject ID points at | Predicate |
|---|---|---|---|
| `match` | Winner of a regular league match | `matches.id` | `{ winner_team: 'team1' \| 'team2' }` |
| `tournament_match` | Winner of any tournament bracket / pool match | `tournament_matches.id` | `{ winner_team: 'team1' \| 'team2' }` |
| `match_score` | Exact final score of a league match | `matches.id` | `{ team1_score, team2_score }` |
| `tournament_match_score` | Exact final score of a tournament match | `tournament_matches.id` | `{ team1_score, team2_score }` |
| `tournament_rank` | A player's finishing rank in a tournament (v1: rank=1 only) | `tournaments.id` | `{ user_id, rank }` |
| `period_rank` | A player's rank within a season period (v1: rank=1) | `seasons.id` | `{ period_number, user_id, rank }` |
| `season_rank` | A player's full-season rank (v1: rank=1) | `seasons.id` | `{ user_id, rank }` |

Two important properties for the rest of this doc:

1. **`tournament_match` is uniform across all bracket / pool / playoff
   contexts.** A bet on a Winners-Bracket Round 2 match, a pool-play
   round-robin match, an MLP sub-match, and a Grand Final 2 ("bracket
   reset") match all use the same subject type. The bracket context is
   carried by the `tournament_matches` row, not by the wager subject.
2. **`tournament_rank` only encodes "player X finishes at rank N in
   tournament T".** It cannot express "team X wins" directly (teams
   aren't first-class subjects), nor can it express compound predicates
   like "champion comes from the losers bracket."

---

## 2. Mapping Table: Permutation → Wagerable Subjects

Every permutation in the [index doc](../tournament-formats.md) is covered
by the existing subject set, modulo the team-vs-individual nuance noted
below. The columns below describe what each subject *means* in each
larger format.

| Larger Format | `tournament_match` | `tournament_rank` | `tournament_match_score` | Notes |
|---|---|---|---|---|
| Round Robin (RR-1..8) | each RR pairing + each playoff match | finishing rank per player / pair | each match's exact score | Double RR (RR-8) doubles the number of wagerable matches but adds no new subject. |
| Pool Play (PP-1..9) | each pool match + each playoff match | overall finishing rank after playoff | each match's exact score | Pool-stage rank is not its own subject — only the final post-playoff rank counts. |
| Single Elim (SE-1..3) | each bracket match (incl. 3PM, consolation) | champion (and lower ranks once supported) | each match's exact score | Consolation bracket matches are still `tournament_match` rows. |
| Double Elim (DE-1..2) | each WB / LB / GF match (and GF2 on reset) | champion | each match's exact score | Bracket reset (DE-2) introduces GF2 as a separate `tournament_match` row. |
| Rotating Partners (RP-1..4) | each rotating match + each playoff match | individual standings (rank is per player, not per pair) | each match's exact score | Playoff pairs (RP-3/RP-4) form *new* `tournament_match` rows once seeds lock. |
| MLP / MLP Random (MLP-1..12) | each team meeting's 4 sub-matches + each playoff sub-match | team standings — but the existing subject is *player*-keyed (see §5) | each sub-match's exact score | MLP playoff DE variants (MLP-6/7/11/12) are new permutations, not new subjects. |

### Cross-cutting observations

- **No new wager subject is required for any of the proposed `top_N_de`
  or `top_N_per_pool_de` playoff variants.** Every match in a DE
  playoff bracket — WB, LB, GF, GF2 — is materialized as a regular
  `tournament_matches` row, so `tournament_match` and
  `tournament_match_score` already cover them.
- **No new subject is required for the `top_N_consolation` variant
  either** — consolation matches are likewise stored as
  `tournament_matches` rows.
- **The Double RR addition (RR-8) is fully transparent to wagering** —
  it just multiplies match count.

---

## 3. Gaps for the New DE Playoff Variants

The new `top_4_de`, `top_8_de`, `top_N_per_pool_de` playoff variants
unlock a few interesting bet *concepts* even though they do not strictly
require new subjects.

### 3.1. WB vs LB match wagers — no new type needed

A bet on "Team X wins Losers Round 2" is just a `tournament_match` wager
on the relevant `tournament_matches` row. The **only** integration work
is in the UI: the propose-wager modal and the open-wagers list need to
display bracket context — e.g.

> **Losers Round 2:** Snipers vs Crustaceans

…instead of an unlabeled match card. The `tournament_matches` table
already carries enough metadata (round type / round number / bracket
side via the double-elim trigger fields) for the UI to derive this
label.

### 3.2. Grand Final reset bets — no new type needed

When `de_bracket_reset` is ON and the LB champion wins GF1, a second
match GF2 is generated. Both GF1 and GF2 are independent rows in
`tournament_matches`, so:

- Wagering on **GF1 alone** → `tournament_match` on the GF1 row.
- Wagering on **GF2 alone** → `tournament_match` on the GF2 row
  (created lazily by `_advance_double_elim_bracket` after GF1
  finishes).
- Wagering on **"who wins the championship after reset"** →
  `tournament_rank` with rank=1 (already supported).

The one wrinkle: GF2 doesn't exist as a row until the trigger creates
it, so wagers on GF2 cannot be opened until after GF1 completes — a
reasonable product behavior (you can't bet on a match that may not
happen).

### 3.3. "Comeback through the losers bracket" — NEW concept

A bet that **the eventual champion comes from the losers bracket**
(i.e., the LB winner runs the table in GF1 and GF2). This is not
expressible with existing subjects:

- `tournament_rank` picks a *player* and a *rank*, not a *bracket
  path*.
- `tournament_match` picks the winner of one specific match, not a
  chain of conditions.

#### Proposed future subject: `tournament_lb_comeback`

```ts
| { type: 'tournament_lb_comeback';
    tournamentId: string;
    tournamentName: string;
    happens: boolean }   // bet for or against the comeback
```

DB shape (sketch):

```
subject_type = 'tournament_lb_comeback'
subject_id   = tournaments.id
predicate    = { happens: true | false }
```

Settlement: at tournament completion, the trigger that populates
`tournament_final_ranks` would emit a wager-settlement event based on
whether the eventual champion was the LB finalist (queryable from
`tournament_matches` via the existing double-elim bracket-side
metadata).

This subject is **not** part of the initial DE-playoff rollout — it's
called out here so we don't paint ourselves into a corner.

### 3.4. "Reaches Grand Final via losers bracket" — NEW concept

A narrower variant of §3.3: bet that **a specific player or team makes
it to the Grand Final via the LB route**. Useful because it pays out
even if they ultimately lose GF1.

#### Proposed future subject: `tournament_lb_finalist`

```ts
| { type: 'tournament_lb_finalist';
    tournamentId: string;
    tournamentName: string;
    userId: string;
    userName: string }
```

DB shape (sketch):

```
subject_type = 'tournament_lb_finalist'
subject_id   = tournaments.id
predicate    = { user_id: <uuid> }
```

Settlement: when the LB Final row in `tournament_matches` transitions
to `completed`, the winner's `user_id` settles all open
`tournament_lb_finalist` wagers for that tournament.

### 3.5. Why defer these?

- They only make sense in the DE playoff context — proposing them now,
  before the DE playoff variants ship, would add dead types.
- Both can be added later without migrating existing wagers — they're
  pure additions to the `subject_type` check constraint.
- The MVP DE playoff rollout is fully usable with just `tournament_match`
  / `tournament_match_score` / `tournament_rank`.

---

## 4. Worked Examples

### 4.1. RR-4 — Round Robin + Top 4 Single-Elim Playoff

Eight players play a single round robin; top 4 by W-L (PLUPR
tiebreak) advance to semis.

- **During the round-robin stage,** a bettor likes Player A:
  - Opens a `tournament_rank` wager: *"A to finish 1st in 'Spring
    Smash'"* — uses the tournament-level subject; no specific bracket
    match exists yet.
  - As specific RR matchups become matchable, opens individual
    `tournament_match` wagers on A's matches.
- **After the RR stage locks in seeds,** the SE bracket materializes:
  WSF1 = S1 vs S4, WSF2 = S2 vs S3.
  - Bettor opens a `tournament_match` wager on the WSF1 row.
  - Bettor opens a `tournament_match_score` wager *"WSF1 ends 11-9"*.
- **After both semis,** the Final row exists — open another
  `tournament_match` wager on it.
- **Settlement:** match wagers settle as each
  `tournament_matches.status` flips to `completed`; the
  `tournament_rank` wager settles when `tournament_final_ranks` is
  populated at tournament completion.

### 4.2. PP-7 — Pool Play, 3 pools, Top 2 per Pool → 6-team SE Playoff

Three pools (A, B, C) of 4 players each; top 2 per pool advance to a
crossover SE bracket (6 entrants → 2 byes or play-in; see Open
Questions in the index doc).

- **"Which pool produces the most playoff seeds?"** — *not directly
  expressible* with existing subjects (no pool-level subject). A
  bettor wanting to express this would have to compose it from
  individual `tournament_rank` wagers on each player.
- **Per-pool match bets** are straightforward: each pool-stage match
  is a `tournament_matches` row, so `tournament_match` and
  `tournament_match_score` apply uniformly.
- **Playoff bets** behave exactly like RR-4 above once the crossover
  bracket materializes.

This example surfaces a genuine modeling gap: there is no
`pool_rank` subject. It's not proposed here, but logged for future
consideration if pool-level betting becomes a frequent ask.

### 4.3. MLP-6 — MLP + Round-Robin + Top 4 Double-Elim Playoff (NEW)

Six MLP teams play a single round robin (each team meeting is 4
sub-matches: men's, women's, 2× mixed). Top 4 teams seed into a 4-team
DE playoff.

- **During RR,** bettor places `tournament_match` wagers on individual
  sub-matches as scheduled.
- **After RR seeds lock,** the DE playoff bracket materializes:
  WSF1, WSF2, LB Round 1, WB Final, LB Final, Grand Final.
- **Comeback bet:** *"Team Smashville comes back through the losers
  bracket to win the championship"* — **not expressible today**. See
  §3.3 — would need `tournament_lb_comeback` (and team-level subjects,
  see §5 caveat).
- **Practical workaround until §3.3 ships:** the bettor places a
  `tournament_rank` wager on a Smashville player to finish 1st (MLP
  champions all share rank=1), and a `tournament_match` wager on
  whichever LB match they need Smashville to win — but this is two
  separate bets, not a single compound predicate.

---

## 5. UI Implications

### 5.1. Bracket context labels in the wager modal

When proposing a `tournament_match` wager, the modal must show the
bracket round so the bettor knows *which* match they're betting on:

- Pool-play: "Pool A — Round 2"
- Single-elim playoff: "Quarterfinal 3", "Semifinal 1", "Final",
  "3rd-Place Match"
- Double-elim playoff: "Winners Round 1", "Losers Round 2", "Winners
  Final", "Losers Final", "Grand Final 1", "Grand Final 2 (Bracket
  Reset)"
- MLP sub-match: "Round 3 vs Crustaceans — Mixed 2"

These labels are derivable from `tournament_matches` columns (round
type, round number, bracket side). The open-wagers history view needs
the same labels.

### 5.2. Rotating-partners playoffs (RP-3 / RP-4)

`tournament_rank` works fine for individual standings in the RR phase,
but the playoff entrants are *pairs formed after the rotating phase*.
Two follow-on UI/odds questions:

- Pairs need synthetic team identities for the playoff
  `tournament_matches` rows. Existing schema handles this via the
  same team-pair columns used in MLP / rotating play; no new wager
  subject is needed.
- Odds for `tournament_match` on a freshly formed playoff pair require
  partner-aware probability — the existing odds calc uses individual
  PLUPR; pairs derived from rotating playoffs may need an averaging
  rule. (Out of scope for this doc; logged for the odds-engine
  follow-up.)

### 5.3. Team-vs-individual modeling caveat (MLP)

`tournament_rank` is **player-keyed** (`predicate.user_id`). For MLP,
where the team is the natural unit, this works only because all
players on the winning team share rank=1. As soon as the rollout adds
multi-rank wagers (rank=2, rank=3), MLP wagers will need either:

- A team-keyed variant (e.g., `tournament_team_rank`), or
- A convention that any team member's rank is the team's rank.

The §3 comeback / LB-finalist proposals likewise inherit this caveat —
if the bettor wants to bet on "Team Smashville comes back via LB", the
subject would have to be team-keyed, not player-keyed.

### 5.4. GF2 reveal timing

When `de_bracket_reset` is ON, GF2 doesn't exist as a `tournament_matches`
row until GF1 finishes and the LB finalist wins. The wager UI should:

- Not show GF2 as an open-for-wagers card before GF1 settles.
- Once GF2 is generated (via `_advance_double_elim_bracket`), surface
  it as a fresh wagerable match — likely with shorter wagering window
  than other matches given the tight turnaround.

---

## 6. Cross-references

- [Round Robin permutations](./round-robin.md)
- [Pool Play permutations](./pool-play.md)
- [Elimination Brackets (SE / DE Larger Formats)](./elim-brackets.md)
- [Rotating Partners permutations](./rotating-partners.md)
- [MLP permutations](./mlp.md)
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md)
- Source of truth for current subjects: `mobile/src/lib/wager.ts`
- DB enforcement: `supabase/migration_add_wagering.sql` (`subject_type`
  check constraint and `place_wager` / `cancel_wager` /
  `calculate_wager_odds` RPCs).

---

*This document is a planning artifact. No code or schema in `mobile/`
or `supabase/` has been changed.*
