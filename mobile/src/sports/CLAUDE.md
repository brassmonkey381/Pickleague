# CLAUDE.md — sport verticals (`mobile/src/sports/`)

Working agreement for all **multi-sport** work in Pickleague (pickleball, basketball, and future
sports). This complements the repo-root `CLAUDE.md` (which still applies in full) with the rules
specific to building sport verticals. **Read both.** Specs:
[`docs/basketball-vertical.md`](../../../docs/basketball-vertical.md) ·
[`docs/location-pipeline.md`](../../../docs/location-pipeline.md).

## The one rule that governs everything here

**No screen, data module, or DB call hardcodes a sport.** Sport-specific behavior lives in **one
place** — the `SportConfig` in this directory — and everything else reads it via `getSport(sport)`.
When you feel the urge to write `if (sport === 'basketball')` in a screen, stop: that branch belongs in
the config or a `ScoringStrategy`, not the UI. Adding sport #3 must be *a new folder + a registry
entry*, never a sweep through screens. If a change would touch more than the sport's own folder +
`registry.ts` + the 2 DB dispatch functions (`validate_match_score`, `_sport_rating_params`) + the enum
CHECKs, the abstraction is leaking — fix the seam, not the symptom.

## Foundation-first (this is not optional)

Per the root `CLAUDE.md`, **reach into `@just-messin-around/expo-foundation` before you build
anything.** The multi-sport app is almost entirely assembled from kit modules — building a bespoke
version of something the kit already ships is a defect, not a shortcut. Concretely, use:

| Need | Use from the foundation | Don't |
| --- | --- | --- |
| Fetch + cache data (leagues, venues, standings) | `cache` → `useCachedQuery` / `cachedFetch` (offline fast-path, TTL, persist) | roll your own `useState`+`useEffect` fetch |
| Loading / error / empty around fetched data | `ui` → `QueryState`, `LoadingState`, `EmptyState`, `Skeleton` | hand-write spinners/empties |
| Pick a court/venue | `ui` → `VenuePicker` via the `CourtPicker` shim + `localSearch` (our `venues` DB) | call Google Places directly |
| Courts near me, on a map | `ui` → `RadiusPlacesMap`, `MapPinModal`, `ClusterChooser`; `platform` → `distanceMeters`, `getCurrentCoords` | custom map/geo math |
| Schedule games / mutual free times | `scheduling` → `slots`, `availability`, `drillTime`; `ui` → `AvailabilityGrid`, `MonthCalendar` | new slot math |
| Add game/tournament to calendar | `scheduling/calendarLink` → `addToCalendar`, `buildIcs` | — |
| Supabase reads with retry + friendly errors | `supabase` → `sbCall`, `classifySbError`, `friendlySbMessage` | raw `.from().select()` without the taxonomy |
| Live score / RSVP updates | `supabase` → `useRealtimeChannel` (auto-resubscribe) | manual channel wiring |
| Points / levels / progress | `gamification` → `levelFromPoints`, `progressToNext`, `ProgressBar` | reinvent XP math |
| Skill/position/play-style tags | `tags` → `createTagCatalog` (each sport supplies its own catalog) | hardcoded tag lists |
| Toggles / sheets / selects / filters | `ui` → `SegmentedToggle`, `BottomSheet`, `SingleSelectModal`, `FilterChipRow`, `Chip`, `Badge` | bespoke controls |
| Text inputs / buttons | `forms` → `TextField`, `Button` | raw `TextInput` |
| Formatting (distance, duration, "ago") | `format` → `formatDistance`, `formatDuration`, `formatTimeAgoShort` | ad-hoc formatters |

**If the kit is *almost* right, extend it in the foundation repo and publish** (root `CLAUDE.md`
cross-repo checklist) — don't fork a copy into `mobile/`. The known extension this effort needs is the
`VenuePicker` `externalSearch: 'none'` prop (see `docs/location-pipeline.md`). If a genuinely new,
domain-agnostic abstraction emerges (a `LocationPicker` with no external provider, a geo-radius helper),
it goes in the **foundation**, not here. What stays here is only Pickleague's *sport domain*.

## Layout & structure

```
mobile/src/sports/
  types.ts        # SportId, SportConfig, ScoringStrategy, ScoreInput, TournamentFormatId, SportFeature, RatingParams, SportCopy
  registry.ts     # SPORTS: Record<SportId, SportConfig>; getSport(id); SPORT_IDS; DEFAULT_SPORT = 'pickleball'
  <sport>/        # one folder per sport
    index.ts      #   the SportConfig (the public surface)
    scoring.ts    #   ScoringStrategy: validate / winner / format / ratingInput
    copy.ts       #   all user-facing strings for the sport (labels, scoring explainer, badges)
```

- **`registry.ts` is the only import site screens use** — `import { getSport } from '../sports/registry'`.
  Never deep-import a specific sport from a screen; go through the registry so the set of sports is
  swappable and screens stay sport-blind.
- **`SportConfig` is the single source of truth** for a sport: scoring, offered tournament formats,
  match types, feature flags (which pickleball-only modules to show), rating calibration, venue sport
  filter, accent color/icon, and copy. If a screen needs to know *anything* sport-specific, it's a
  field on the config — add it there.
- **Pure and testable.** `scoring.ts` and the config are pure TS with no React/Supabase imports. That
  keeps them unit-testable in `mobile/src/lib/__tests__/` (see Verify) and reusable server-side logic
  stays mirrored, not duplicated.
- **DB mirrors the strategy, doesn't diverge from it.** The client `ScoringStrategy.validate` and the
  SQL `validate_match_score(sport,…)` must agree; the client `ratingInput` normalization and
  `_sport_rating_params(sport)` must agree. When you change one, change its twin in the same PR and
  note it in the commit. The DB is the enforcement boundary; the client is the fast, friendly mirror.

## Data & correctness

- **Sport is set once, at league/tournament creation**, and inherited by matches through their parent.
  Read it from the league/tournament, never infer it.
- **Migrations default `sport` to `'pickleball'`** so every existing row is correct with no backfill.
  New sports never rewrite history.
- **Locations come from our `venues` table** (see `docs/location-pipeline.md`), searched via
  `VenuePicker.localSearch`, filtered by `venues.sport && ARRAY[<sport>]`. Do not add new Google Places
  call sites — we are removing that dependency, not extending it.
- **Follow the root data-path rule:** Supabase access goes through the `lib/supabase` singleton and the
  `data/*` modules; prefer `useCachedQuery` over manual fetching for anything a second screen also
  shows (leagues, venues, standings), so cross-screen updates are free.

## UX & aesthetics

- **One design language, sport-tinted — not sport-fragmented.** Every sport reuses the same foundation
  primitives (`Panel`, `ListCard`, `QueryState`, `EmptyState`, `Chip`/`Badge`, `SegmentedToggle`) so a
  basketball screen is indistinguishable in polish from a pickleball one. A sport gets an **accent color
  + icon** from its config — that's the visual differentiation, nothing more.
- **Theme tokens + presets only.** Use `useTheme()` from `lib/ThemeContext` for color (never a literal
  hex/rgba) and the foundation typography presets for text. A sport accent is a token on the config, not
  a scattered constant. Support light/dark by construction.
- **The match-entry widget adapts to the sport, the screen doesn't fork.** `MatchEntryScreen` renders
  the input dictated by `getSport(sport).scoring` (games grid vs single total) — same screen shell,
  swappable body. Keep the entry fast, forgiving (clear inline validation via the strategy's `validate`
  message), and thumb-friendly.
- **Copy is data.** Sport words ("games to 11", "winner", scoring explainer, badge text) come from
  `SportCopy` on the config. No sport-specific string literals in shared screens — that's how a stray
  "pickleball always has a winner" ends up on a basketball scoreboard.
- **Empty and offline states are first-class.** Every list uses `QueryState`/`EmptyState`; the app is
  expected to work on a gym's bad wifi — lean on the `cache` offline fast-path and, for writes people
  do courtside (report a score, RSVP), the foundation mutation queue + `OfflineBanner`.
- **Courts deserve a map.** Prefer `RadiusPlacesMap` + `MapPinModal` for venue discovery over a bare
  text field — it's a real UX upgrade and it's already built.

## Scalability check (apply before merging a sport-touching change)

- Could I add sport #3 by only adding a folder + a registry line + the DB dispatch branches? If not,
  something sport-specific leaked into shared code — pull it back into the config/strategy.
- Did I add a `switch (sport)` anywhere outside `registry.ts` / a strategy / the 2 DB functions? Replace
  it with a config field.
- Did I hardcode a sport word, color, or format list in a screen? Move it to `SportCopy` / `accent` /
  `formats`.
- Is anything I built generic enough to serve the *foundation* (not just Pickleague)? If so, it belongs
  in the kit — hoist it.

## Verify (from `mobile/`)

- **Every change:** `npx tsc --noEmit` (expect 0).
- **Scoring / tournament / rating logic:** `npm test` (vitest — put strategy unit tests beside the
  existing `src/lib/__tests__/` bracket/tiebreaker suites) **and** the relevant `simulations/` sweep
  when you touch `tournament.ts` or its inputs. These pure suites are why generalization is safe — keep
  them green and extend them per sport.
- **Before a push / web-affecting UI:** also `npm run build:web` (web is a first-class target; some
  native-only Expo APIs and `RefreshControl` behave differently under `react-native-web`).
- A green bundle isn't a working app — the user does the visual pass on their running dev server. Never
  suggest dev-server commands.
