# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pickleague is a pickleball league management app: Expo + React Native + TypeScript on the front end, Supabase (Postgres + Auth) on the back end. The same codebase ships to iOS/Android (Expo) and to the web (`react-native-web`, deployed on Vercel at pickleague.club, auto-deploy on push to `master`).

## Repo layout

This is a multi-package repo. Each of these has its own `node_modules` and is installed/run independently — there is no root package manifest.

- `mobile/` — the Expo app. Almost all product work happens here. Its domain-agnostic Expo/RN foundation (Supabase client factory, theming, toast, navigation ref, UI primitives, platform + scheduling utils) comes from the published `@just-messin-around/expo-foundation` package.
- `supabase/` — `schema.sql` (full fresh-install schema) plus ~145 incrementally-applied `migration_*.sql` files. This is the source of truth for DB structure, RLS, and the Postgres triggers/RPCs that drive ratings, payouts, and notifications.
- `scripts/` — Node (CommonJS) admin/seeding scripts run directly against Supabase (seed users/matches/paddles, recalculate ELO, backdate tournaments).
- `simulations/` — `tsx` scripts that exercise tournament generator logic end-to-end and assert on results (exit 1 on failure).

## Commands

All commands are run from the relevant package directory (`cd mobile`, `cd simulations`, etc.), not the repo root.

### mobile/
```bash
npm install
npx expo start            # dev server (also: npm run android | ios | web)
npm test                  # vitest run — all tests
npm run build:web         # expo export --platform web -> dist/ (what Vercel builds)
```
Run a single test file / test:
```bash
npx vitest run src/lib/__tests__/tournament-bracket.test.ts
npx vitest run -t "name of the test"
npx vitest            # watch mode
```
Vitest tests live in `mobile/src/lib/__tests__/` and cover the pure domain logic (bracket generation, tiebreakers, head-to-head).

### simulations/
```bash
cd simulations && npm install
npm run brackets            # sweep bracket generators across player counts
npm run rotating-partners
npm run sweep-doubles
npm run sweep-mlp-schedule
```
These import pure functions from `mobile/src/lib/tournament.ts` and assert structural invariants. When you change tournament generation logic, run the relevant sweep.

## Architecture

### Front end (mobile/src)
- **Navigation** — a single React Navigation native-stack in `navigation/AppNavigator.tsx`. Every route and its params are typed in `types/index.ts` (`RootStackParamList`); add new screens there.
- **Screens** own their data fetching (direct Supabase queries), `lib/` holds pure helpers and hooks, `components/` holds reusable UI, `data/` holds static option catalogs.
- **App shell** (`App.tsx`) wraps everything in `ThemeProvider` (light/dark) plus global `EmailConfirmedBanner` and `BadgeToast` overlays.
- **Supabase singleton** — `lib/supabase.ts` is a thin wrapper that injects this app's `EXPO_PUBLIC_*` env vars into `createSupabase()` from the shared foundation. Always `import { supabase } from '../lib/supabase'`.

### Foundation (@just-messin-around/expo-foundation) — reach here FIRST

**Foundation-first is the prime directive.** The foundation is the shared, domain-agnostic base that
Pickleague and its sibling apps (e.g. Doggle) all consume; it lives in its own repo at
`C:\Users\Brian\source\repos\expo-foundation` and is published to GitHub Packages. Before you build any
component, hook, util, provider, or platform helper:

1. **Look in the foundation first** — skim its README/module catalog and `rg -i <concept>` in
   `C:\Users\Brian\source\repos\expo-foundation\src`. It already covers Supabase (client factory,
   retrying `sbCall`, error taxonomy, realtime), theming, toast, navigation ref, the SWR-lite query
   `cache`, offline/mutation-queue, tour, push, contacts, ~40 UI primitives (modals, pickers,
   `EmptyState`/`Skeleton`/`QueryState`/`OfflineBanner`, `VenuePicker`), and scheduling math.
2. **exists** → import it from `@just-messin-around/expo-foundation/<subpath>`.
3. **almost exists** → *extend the foundation primitive* (add a prop/variant/option) in the foundation
   repo and publish — don't fork a private copy into `mobile/`. The recent tour options
   (`counterSeparator`, `footerMarginTop`) are the model: a need became two additive options on the
   existing primitive.
4. **new + generic** → build it as a **new abstraction in the foundation repo**, publish, and bump
   `mobile/`'s dependency (checklist below). Only Pickleague-specific things — tournament/bracket/ELO
   logic, league schema, screens, domain copy — stay in `mobile/`.

An app file may *wrap* a foundation primitive to inject Pickleague routing/domain (the adapter pattern,
e.g. `components/SpotlightTour.tsx` skinning the kit overlay) — re-implementing one the foundation
already has is not.

**Cross-repo extension checklist** (the foundation is a separate published repo, so hoisting is a small
release cycle):
1. In `expo-foundation`: add/extend `src/<area>/…` (relative imports; `useTheme` from `../theme`; keep
   it **domain-agnostic** — no pickleball names/tables/palette/copy). Export from the area `index.ts` +
   root barrel; a new area needs a `"./<area>"` entry in its `package.json` `"exports"`.
2. `npm run typecheck` (expect 0), bump the version (minor = additive, major = breaking), commit, push,
   `npm publish` (needs `$env:GITHUB_TOKEN = (gh auth token)`).
3. In `mobile/`: bump `@just-messin-around/expo-foundation`, reinstall
   (`$env:GITHUB_TOKEN = (gh auth token); npm install`), consume it, then `npx tsc --noEmit` + `npm test`.

**Wiring:**
- Published TypeScript-source package (no build step) exposed via subpath exports (`/supabase`, `/theme`, `/ui`, `/platform`, `/cache`, etc.). React/RN deps are `peerDependencies` — when you add a foundation runtime lib, add it to `mobile/package.json` too.
- `mobile/metro.config.js` pins `react`, `react-native`, etc. to `mobile/node_modules` via `extraNodeModules` so the foundation resolves a single React copy. If you see "Invalid hook call" or a broken `useTheme`/`useToast`, suspect a duplicate React copy and check this config.
- Platform-specific files use the `.web.tsx` convention (e.g. `AppDateTimePicker.web.tsx`) so web and native diverge without branching in code.

### Back end (supabase/)
- **The database is not just storage — it is where core game logic lives.** Ratings, tournament advancement, payouts, and notifications are implemented as Postgres triggers and RPC functions, not in app code.
- **Ratings:** ELO (K=32) split several ways — overall `rating`, `singles_rating`, `doubles_rating`, plus per-court `player_location_ratings`. Recomputed by triggers on match insert. The user-facing rating label is "PLUPR" (see `migration_convert_to_plupr.sql` and later `plupr_*` migrations).
- **Migrations are append-only and hand-applied** in filename order; `schema.sql` is the consolidated fresh-install version. When changing the schema, add a new `migration_*.sql` rather than editing an old one, and keep `schema.sql` consistent if you're changing the base structure.
- Nearly every table has RLS enabled; new tables need explicit policies.
- **Function grants are locked down** (`migration_rls_hardening_2026q3.sql`): internal SECURITY DEFINER helpers have EXECUTE revoked from `anon`/`authenticated`. A new client-callable RPC must be granted explicitly (or added to that migration's allowlist); a new internal helper should include `revoke execute on function <fn> from public, anon, authenticated;`.
- When writing RLS policies with subqueries, qualify or hoist new-row column references — an unqualified column inside `exists (select … from other_table t …)` binds to `other_table` if the name collides (this silently broke a policy once). Test policies live with `set local role authenticated` + `set_config('request.jwt.claims', …)` in a rolled-back transaction.

### Data flow to keep in mind
A match insert cascades through DB triggers that update multiple rating columns, tournament standings/advancement, pickle (currency) ledgers, and `notifications` rows — which a client-side push layer turns into Expo push notifications. A "small" schema or trigger change can ripple across all of these, which is why the `simulations/` sweeps and the `mobile/src/lib/__tests__/` bracket tests exist. Run them after touching tournament or rating logic.

## Environment

`mobile/.env` (gitignored; see `mobile/.env.example`) needs:
- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_GOOGLE_PLACES_KEY` (court location autocomplete)

EAS/OTA updates are configured in `mobile/app.json` (project `a6b4311e-…`, owner `brassmonkey381`, `runtimeVersion.policy: appVersion`).

## Conventions

- **Foundation-first (see Architecture → Foundation).** Before writing any generic component/hook/util,
  check `@just-messin-around/expo-foundation` and extend it (or add a new abstraction there) rather than
  building a one-off in `mobile/`. Only pickleball-domain code stays in the app.
- **New match-history display dimension → add a filter pill.** Whenever a new vertical is shown on match history cards, add the corresponding filter control.
- **SIM data against prod** (simulations that write to the real DB): users are `sim_*@pickleague.test`, leagues and tournaments are named `[SIM] …`, and each script must run an idempotent `cleanup()` at both start and end that deletes SIM rows in FK order. Assertions key on counts of newly created rows, never on table totals. See `simulations/README.md`.
- Web is a first-class target: after non-trivial UI changes, sanity-check the web build renders (some native-only Expo APIs and `RefreshControl` behave differently under `react-native-web`).
