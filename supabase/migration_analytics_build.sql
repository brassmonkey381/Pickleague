-- analytics_sessions: which binary, installed when (mirrors doggle 0400).
--
-- app_version is the marketing version ("1.0.4"), which never moves between
-- builds. app_build is the real CFBundleVersion / versionCode read from the
-- installed binary (expo-application, from 1.0.4), and installed_at is the OS
-- install timestamp. Together they answer "who is still on an old build",
-- which the minimum-version gate needs answered before anyone raises the
-- floor, and "how fast do people update after a release".
--
-- Additive: nullable, set on insert only, null on web and on 1.0.3 and older
-- (those builds never send the keys). Table-level grants already cover new
-- columns, so the anon/authenticated insert path needs no grant change.

alter table public.analytics_sessions
  add column if not exists app_build    int,
  add column if not exists installed_at timestamptz;

create index if not exists analytics_sessions_app_build_idx
  on public.analytics_sessions (platform, app_build)
  where app_build is not null;
