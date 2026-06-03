# @stockman/rn-foundation

Domain-agnostic Expo / React Native foundation, extracted from the Pickleague app so it
can be reused as the base for other Expo (web + native) apps.

This package ships **TypeScript source** (no build step) and is consumed by an app's Metro
bundler + Babel. It declares `react`, `react-native`, and the other shared runtime libraries
as **peerDependencies** so the consuming app provides a single copy (avoids duplicate-React
hook/context bugs).

## What's in here

| Area | Import | Contents |
| --- | --- | --- |
| Supabase | `@stockman/rn-foundation/supabase` | `createSupabase(url, anonKey)` client factory |
| Theme | `@stockman/rn-foundation/theme` | `Theme` shape, `configureTheme`, `ThemeProvider`, `useTheme` |
| Toast | `@stockman/rn-foundation/toast` | `ToastProvider`, `useToast` |
| Navigation | `@stockman/rn-foundation/navigation` | `createNavigationRef<ParamList>()` |
| Tour | `@stockman/rn-foundation/tour` | `createTourContext({ storagePrefix, tours })` |
| Hooks | `@stockman/rn-foundation/hooks` | `useEscapeKey`, `useStatusMessage` |
| Platform | `@stockman/rn-foundation/platform` | `clipboard`, `share`, `sms`, `contacts` |
| Scheduling | `@stockman/rn-foundation/scheduling` | `availability`, `drillTime` slot math |
| Styles | `@stockman/rn-foundation/styles` | `globalStyles` factory |
| UI | `@stockman/rn-foundation/ui` | Modals, pickers, banners, date/court pickers, icons |

Everything is also re-exported from the root (`@stockman/rn-foundation`).

## Consuming app setup

1. Add the dependency: `"@stockman/rn-foundation": "file:../shared"`.
2. Add a `metro.config.js` that watches this folder and pins a single copy of `react` /
   `react-native` (see `mobile/metro.config.js` for the reference config).
3. Inject app config via thin adapters (Supabase env vars, theme palette + storage key, etc.).

## Domain code stays in the app

Pickleball/league-specific logic (ratings, leagues, tournaments, drills, wagers) is intentionally
**not** in this package.
