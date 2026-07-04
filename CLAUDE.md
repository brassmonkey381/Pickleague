# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pickleague is a pickleball league management app: Expo + React Native + TypeScript on the front end, Supabase (Postgres + Auth) on the back end. The same codebase ships to iOS/Android (Expo) and to the web (`react-native-web`, deployed on Vercel at pickleague.club, auto-deploy on push to `master`).

## Repo layout

This is a multi-package repo. Each of these has its own `node_modules` and is installed/run independently — there is no root package manifest.

- `mobile/` — the Expo app. Almost all product work happens here.
- `shared/` — `@stockman/rn-foundation`, a domain-agnostic Expo/RN foundation (Supabase client factory, theming, toast, navigation ref, UI primitives, platform + scheduling utils) extracted from `mobile/` to seed future apps. Consumed by `mobile/` via `file:../shared`.
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

### shared/ (@stockman/rn-foundation)
- TypeScript-source package (no build step) exposed via subpath exports (`/supabase`, `/theme`, `/ui`, `/platform`, etc.) — see `shared/package.json` `exports`. React/RN deps are `peerDependencies`.
- `mobile/metro.config.js` is what makes this work: it adds `shared/` to `watchFolders` (so edits hot-reload) and pins `react`, `react-native`, etc. to `mobile/node_modules` via `extraNodeModules`. If you see "Invalid hook call" or a broken `useTheme`/`useToast`, suspect a duplicate React copy and check this config.
- Platform-specific files use the `.web.tsx` convention (e.g. `AppDateTimePicker.web.tsx`) so web and native diverge without branching in code.

### Back end (supabase/)
- **The database is not just storage — it is where core game logic lives.** Ratings, tournament advancement, payouts, and notifications are implemented as Postgres triggers and RPC functions, not in app code.
- **Ratings:** ELO (K=32) split several ways — overall `rating`, `singles_rating`, `doubles_rating`, plus per-court `player_location_ratings`. Recomputed by triggers on match insert. The user-facing rating label is "PLUPR" (see `migration_convert_to_plupr.sql` and later `plupr_*` migrations).
- **Migrations are append-only and hand-applied** in filename order; `schema.sql` is the consolidated fresh-install version. When changing the schema, add a new `migration_*.sql` rather than editing an old one, and keep `schema.sql` consistent if you're changing the base structure.
- Nearly every table has RLS enabled; new tables need explicit policies.

### Data flow to keep in mind
A match insert cascades through DB triggers that update multiple rating columns, tournament standings/advancement, pickle (currency) ledgers, and `notifications` rows — which a client-side push layer turns into Expo push notifications. A "small" schema or trigger change can ripple across all of these, which is why the `simulations/` sweeps and the `mobile/src/lib/__tests__/` bracket tests exist. Run them after touching tournament or rating logic.

## Environment

`mobile/.env` (gitignored; see `mobile/.env.example`) needs:
- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_GOOGLE_PLACES_KEY` (court location autocomplete)

EAS/OTA updates are configured in `mobile/app.json` (project `a6b4311e-…`, owner `brassmonkey381`, `runtimeVersion.policy: appVersion`).

## Conventions

- **New match-history display dimension → add a filter pill.** Whenever a new vertical is shown on match history cards, add the corresponding filter control.
- **SIM data against prod** (simulations that write to the real DB): users are `sim_*@pickleague.test`, leagues and tournaments are named `[SIM] …`, and each script must run an idempotent `cleanup()` at both start and end that deletes SIM rows in FK order. Assertions key on counts of newly created rows, never on table totals. See `simulations/README.md`.
- Web is a first-class target: after non-trivial UI changes, sanity-check the web build renders (some native-only Expo APIs and `RefreshControl` behave differently under `react-native-web`).
