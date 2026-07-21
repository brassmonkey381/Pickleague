# Basketball vertical — multi-sport spec

**Status:** plan / not yet built · **Owner:** TBD · **Related:** [location-pipeline.md](./location-pipeline.md) · **Working agreement:** [`mobile/src/sports/CLAUDE.md`](../mobile/src/sports/CLAUDE.md)

## Vision

Pickleague becomes a **multi-sport** league + tournament platform. The concept is identical across
sports — leagues, memberships, scheduled events, ratings, brackets, standings, venues — only the
**scoring rules**, **tournament formats offered**, and **location dataset** differ. Basketball is
vertical #2 and the proof that the abstraction holds. Adding sport #3 (soccer, tennis, volleyball…)
should be *a new folder + a registry entry*, not a rewrite.

> Naming: "Pickleague" stays as the brand for now; internally the code is sport-neutral. A rename to a
> multi-sport brand is a product decision out of scope here.

## The core idea: a `sport` discriminator + a strategy registry

Investigation confirmed the codebase is **already clean** — there is **no `sport` column anywhere**,
and the pieces (leagues, memberships, events, tournaments, bracket generators, the ELO/PLUPR *engine*,
`VenuePicker`) are structurally sport-agnostic. Pickleball assumptions are concentrated in ~4 spots.
So the plan is **not a rewrite** — it's:

1. Add **`sport`** to `leagues` and `tournaments` (matches/tournament-matches inherit through their
   parent). One new dimension.
2. Introduce a **per-sport strategy registry** in the app (`mobile/src/sports/`) that owns everything
   sport-specific: scoring rules, which tournament formats to offer, rating calibration, copy, theme
   accent, and which venue sport-filter to use.
3. Make the ~4 pickleball-tuned spots **read from the strategy** (client) or **dispatch on `sport`**
   (DB), instead of hardcoding pickleball.

Everything else is reused as-is.

## What's reusable as-is (do NOT touch)

- **Leagues / memberships / events / slot-voting / scheduling / invites / notifications** — fully generic.
- **Bracket generators** in `mobile/src/lib/tournament.ts` for round-robin, single-elim, double-elim,
  and pool-play — they operate on opaque player/team tokens. A basketball team is just a token (the
  `__T{i}` team-token wrapping already used by MLP/doubles round-robin).
- **ELO/PLUPR *plumbing*** — delta application, per-league/global/facet updates, `recompute_all_plupr`.
  Only the *calibration constants* are pickleball-tuned (see Ratings below).
- **`VenuePicker` + `localSearch`** — the location picker and its app-catalog seam.
- **Seeding by rating, tiebreakers, head-to-head, bracket verification** — all sport-neutral.
- **The whole foundation stack** — `cache`, `QueryState`, scheduling math, `RadiusPlacesMap`, `tags`,
  `gamification`, `supabase` `sbCall`/error taxonomy, `SegmentedToggle`, `forms`. See the CLAUDE.md.

## The ~4 pickleball-tuned spots — and what basketball needs

### 1. Scoring & validation
**Where it's baked in:**
- DB CHECK constraints `matches_score_sanity_check` / `tournament_matches_score_sanity_check`
  (`supabase/migration_audit_fixes_2026q2.sql:116-159`): enforce `winner ≥ 11 && win-by-2 && ≤ 50`.
  This **rejects basketball** (a 98–92 game exceeds 50 and basketball allows win-by-1).
- Client `mobile/src/screens/MatchEntryScreen.tsx:488-516`: rejects ties ("pickleball always has a
  winner"), derives winner by **games-won majority** over the `game_scores` jsonb array.
- Score defaults `coalesce(score, 11/7)` throughout the PLUPR SQL.

**Basketball needs:** final point totals (~0–200), **no win-by-2**, **no cap of 50**, win-by-1 allowed,
and typically **a single final score** (or quarters), not a best-of-N series. Winner = higher total.

**Design — a per-sport ScoringStrategy:**
- **Client:** `mobile/src/sports/<sport>/scoring.ts` exports a `ScoringStrategy`:
  ```ts
  interface ScoringStrategy {
    // score entry shape: pickleball = games[], basketball = single total (or quarters[])
    validate(input: ScoreInput): { ok: true } | { ok: false; error: string };
    winner(input: ScoreInput): 'team1' | 'team2' | null;
    format(input: ScoreInput): string;            // "11-9, 8-11, 11-7" | "98-92"
    ratingInput(input: ScoreInput): { s1: number; s2: number }; // normalized signed margin inputs
  }
  ```
  `MatchEntryScreen` calls `getSport(league.sport).scoring` instead of hardcoding pickleball rules.
- **DB:** replace the two hardcoded CHECK constraints with a sport-aware
  `validate_match_score(sport text, s1 int, s2 int) returns boolean` called from a `BEFORE INSERT`
  trigger (or referenced by the constraint). Pickleball branch = the current rule; basketball branch =
  `greatest(s1,s2) > least(s1,s2) and s1 <> s2` with a sane upper bound (~250).

The `game_scores jsonb` column generalizes cleanly: pickleball stores games, basketball stores a single
`{t1,t2}` (or quarters). The integer `player1_score`/`player2_score` continue to hold the decisive
totals.

### 2. Ratings (PLUPR)
**Where:** almost entirely Postgres (`migration_plupr_margin_of_victory.sql`,
`migration_court_ratings_plupr.sql`); the only app file is `mobile/src/lib/plupr.ts` (pure display,
sport-agnostic). The math is margin-of-victory ELO:
```sql
expected_diff := 10.0 * tanh((team1_avg - team2_avg) / 1.0);  -- ±10 cap
surprise      := (actual_diff - expected_diff) / 10.0;         -- normalized to a ~10-pt max margin
delta         := k_factor * surprise;
```
The **framework is sport-agnostic**; the **constants are calibrated to games-to-11**. A basketball
26-point margin would blow up `surprise`.

**Basketball needs its own calibration**, not new math. Add a `_sport_rating_params(sport)` helper
returning `{ margin_scale, margin_cap, default_scores }`; basketball normalizes `actual_diff` by an
expected total (~divide by 20–30) so a blowout maps to a comparable `surprise` magnitude. The delta
application, per-facet updates, and `recompute_all_plupr` are untouched.

**Rating facets:** `profiles` today carries `rating` + `singles_rating`/`doubles_rating`/
`mixed_doubles_rating` (racquet-shaped) and per-location `player_location_ratings` keyed by
`match_type`. For v1 basketball, use a single overall `rating` facet (and optionally per-team). Do
**not** retrofit basketball into the racquet facets. *(Open decision — see below.)*

### 3. Tournament formats
**Where:** `mobile/src/lib/tournament.ts` (pure), `tournaments.format` CHECK
(`migration_add_tournaments.sql:13`), `match_type check ('singles','doubles')`, and the
`FORMAT_META`/`FORMATS` list in `CreateTournamentScreen.tsx`.

**Generalizes directly:** round-robin, single-elim, double-elim, pool-play (treat a basketball team as
a token). **Drop for basketball:** `generateRotatingPartners` (a racquet-doubles mixer) and **MLP**
(`generateMLPSchedule` — gender-slotted "2M + 2W" Major League *Pickleball* format). Add a `'team'`
`match_type` for 5v5.

**Design — a per-sport format set:** the strategy exposes
`formats: TournamentFormatId[]` (which to offer) and `matchTypes: MatchTypeId[]`.
`CreateTournamentScreen` filters `FORMAT_META` by `getSport(sport).formats`; extend the `format` /
`match_type` CHECK constraints to include the basketball values. The generators need **no per-sport
code** — only the *menu* of offered formats changes.

### 4. Locations
**Where:** locations are **free text** copied onto rows (`matches.location_name/lat/lng`,
`tournaments.*`, `leagues.home_court*`); the `court_locations` table is pickleball court metadata
(indoor/outdoor, surface, court_count) matched by **name string**, not an FK.

**Basketball (and pickleball) both move to the `venues` table** from
[location-pipeline.md](./location-pipeline.md): a real venues catalog, FK-referenced by matches, fed
into `VenuePicker.localSearch`, filtered by the league's `sport` (`venues.sport && ARRAY[sport]`). A
multi-sport complex naturally serves both. `court_locations`' pickleball-specific fields move to a
sport-specific side table (or are dropped for basketball).

## Pickleball-only modules — gate by sport, don't generalize

These stay pickleball-only and simply don't surface for basketball: **MLP** (`mlp_*`, gender slots),
**doubles pairs** (`doubles_pairs`), **paddles/equipment** (`paddle_*`, `player_paddles`,
`match_paddle_usage`), indoor/outdoor court classification, and the mixed-doubles rating facet. The
registry decides visibility (`getSport(sport).features.includes('paddles')`), so screens hide them
cleanly rather than branching everywhere.

## Proposed app layout — `mobile/src/sports/`

A small registry so sport logic lives in one place, not scattered `if (sport === …)` across screens.

```
mobile/src/sports/
  CLAUDE.md              # working agreement for all sport-vertical work (foundation-first, patterns)
  types.ts               # SportId, SportConfig, ScoringStrategy, ScoreInput, TournamentFormatId, feature flags
  registry.ts            # SPORTS: Record<SportId, SportConfig>; getSport(id); SPORT_IDS; DEFAULT_SPORT
  pickleball/
    index.ts             # SportConfig for pickleball (extracted from today's hardcoded rules)
    scoring.ts           # games-to-11, win-by-2, best-of-N; winner by games-won majority
    copy.ts              # labels, ScoringAlgo explainer text, badge copy
  basketball/
    index.ts             # SportConfig for basketball
    scoring.ts           # single final total (or quarters), win-by-1, higher-total wins
    copy.ts
```

`SportConfig` is the single source of truth per sport:
```ts
interface SportConfig {
  id: SportId;                     // 'pickleball' | 'basketball'
  label: string;                   // "Pickleball" | "Basketball"
  icon: ReactNode;                 // foundation ActivityIcons (BallIcon, …) or a sport glyph
  accent: string;                  // theme accent token for sport-tinted UI
  scoring: ScoringStrategy;        // §1
  formats: TournamentFormatId[];   // §3 — which tournament formats to offer
  matchTypes: MatchTypeId[];       // 'singles' | 'doubles' | 'team'
  features: SportFeature[];        // 'paddles' | 'mlp' | 'doublesPairs' | 'mixedRating' — gates pickleball-only UI
  ratingParams: RatingParams;      // §2 — margin scale/cap/default-scores (mirrors DB _sport_rating_params)
  venueSports: string[];           // which venues.sport values to search
  copy: SportCopy;                 // all user-facing strings (no hardcoded sport words in screens)
}
```

Screens read `getSport(league.sport)` and drive off the config. **No screen hardcodes a sport.** Adding
a sport = add a folder + a registry entry + the DB `validate_match_score`/`_sport_rating_params`
branches + extend the enums. That's the whole surface.

## Data model changes (summary)

| Table | Change |
| --- | --- |
| `leagues` | `+ sport text not null default 'pickleball'` |
| `tournaments` | `+ sport text not null default 'pickleball'`; extend `format` + `match_type` CHECKs |
| `matches` / `tournament_matches` | score CHECK → sport-aware `validate_match_score()`; `match_type` gains `'team'` |
| `profiles` | basketball uses overall `rating`; no new racquet facets (open decision) |
| `venues` (new) | from location-pipeline.md; FK target for match/tournament/league location |
| `court_locations` | pickleball-specific fields retained pickleball-only or migrated into `venues` side data |
| new fn | `validate_match_score(sport, s1, s2)`, `_sport_rating_params(sport)` |

## UX / aesthetics

- **Sport is chosen once, at creation.** League/tournament create gets a `SegmentedToggle` (foundation)
  sport selector; sport is then implicit everywhere downstream (badge on cards, filters, match entry).
- **Match entry adapts to the sport.** Pickleball → the games grid; basketball → a single final-score
  entry (or quarters). Driven by `getSport(sport).scoring` — same screen, different input widget.
- **Sport-tinted, not sport-fragmented.** One coherent design language; each sport gets an **accent
  color + icon** (from the config), not a separate visual identity. Reuse foundation `Panel`,
  `ListCard`, `QueryState`, `EmptyState`, `Chip`/`Badge` so basketball screens feel identical in
  quality to pickleball.
- **Courts on a map.** Reuse `RadiusPlacesMap` + `MapPinModal` to show venues near the user, filtered
  by sport — a real upgrade over the current text-only venue field.
- **Filters.** League/tournament browse gains a sport filter (`FilterChipRow`); default to the user's
  last-played sport.
- **Copy comes from the config.** The `ScoringAlgoScreen` explainer, "winner" wording, and badges pull
  from `SportCopy` — no "pickleball always has a winner" strings left in shared screens.

## Phased rollout

- [ ] **P0 — Extract pickleball into a strategy.** Create `mobile/src/sports/` + `types.ts` +
      `registry.ts` + `pickleball/`. Move today's hardcoded pickleball scoring/format/copy into the
      config **with zero behavior change** (pure refactor; `npm test` + simulations stay green). This
      de-risks everything after — basketball just adds a sibling.
- [ ] **P1 — `sport` dimension.** Migration: `sport` on `leagues` + `tournaments` (default
      `'pickleball'`, so all existing rows are correct). Create screens pass `sport`; UI reads it.
- [ ] **P2 — Basketball scoring.** `basketball/scoring.ts`; DB `validate_match_score(sport,…)` replacing
      the hardcoded CHECKs; `MatchEntryScreen` drives its input off the strategy.
- [ ] **P3 — Basketball ratings.** `_sport_rating_params(sport)` + basketball calibration; verify a
      blowout produces a sane delta.
- [ ] **P4 — Basketball tournaments.** Offer RR/SE/DE/pools; add `'team'` match_type; extend enums;
      filter `FORMAT_META` by sport; hide rotating-partners/MLP.
- [ ] **P5 — Venues.** Land [location-pipeline.md](./location-pipeline.md); FK matches to `venues`;
      filter the picker by sport.
- [ ] **P6 — Polish.** Sport filter on browse, accent/icon theming, sport-aware copy + badges, courts
      map. Web build sanity-check.

## Open decisions (confirm before building)

1. **Teams model.** Rec basketball is usually **team-based** (a named roster plays a season), not
   ad-hoc partners. Do we add a generic `teams` table (per league) now, or treat a "team" as an opaque
   token for v1 and defer rosters? This shapes P1–P4. *(Recommendation: minimal `teams` table now —
   name + members per league — since basketball leagues need it and it generalizes.)*
2. **Rating facets for basketball.** Overall `rating` only for v1, or per-position / per-team? *(Rec:
   overall + optional per-team for v1; skip positions.)*
3. **Does basketball ship with tournaments in v1, or leagues-only first?** *(Rec: leagues + match
   recording + venues first; tournaments in a fast-follow — smaller, safer launch.)*
4. **Scoring granularity.** Basketball final score only, or quarters? *(Rec: final total for v1;
   quarters are a later enhancement via `game_scores`.)*
