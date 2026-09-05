-- Remote app config, and the first key: the minimum app version we still support.
--
-- Why a server-side table rather than a constant in the bundle: the whole point
-- of a forced-update gate is to act on a version that is ALREADY in users'
-- hands. A value shipped inside the app can only ever describe itself.
--
-- Scope note. This is for genuine native-level breaks only - an app version too
-- old to talk to the current schema. Ordinary JS bugs are fixed by `eas update`
-- without a store round trip, so reaching for this should be rare. Blocking
-- someone out of a working app is the most hostile thing we can do to them.
--
-- The gate ships INERT: 0.0.0 blocks nobody. It exists so the machinery is
-- already in the field on the day it is needed, because a gate can only ever
-- police versions that already contain it.

create table if not exists public.app_config (
  key         text primary key,
  value       jsonb       not null,
  updated_at  timestamptz not null default now()
);

comment on table public.app_config is
  'Small key/value config read by clients at boot. World-readable by design - never put a secret here.';

alter table public.app_config enable row level security;

-- Readable by everyone INCLUDING anon: the version check runs before sign-in,
-- and a signed-out user on a stale build needs the same answer as a signed-in
-- one. Nothing here is sensitive.
drop policy if exists "App config is world readable" on public.app_config;
create policy "App config is world readable" on public.app_config
  for select using (true);

-- No insert/update/delete policy on purpose. With RLS on and no write policy,
-- anon and authenticated cannot write at all; changes go through the dashboard
-- or a service-role connection, which is the correct blast radius for a value
-- that can lock every user out of the app.

insert into public.app_config (key, value)
values (
  'min_supported_version',
  -- Per platform: an iOS-only break should not lock out Android, and the two
  -- stores ship on different timelines anyway. Web is deliberately absent -
  -- a browser always loads the current bundle, so it can never be out of date.
  '{"ios": "0.0.0", "android": "0.0.0"}'::jsonb
)
on conflict (key) do nothing;
