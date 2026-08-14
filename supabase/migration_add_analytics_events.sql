-- First-party in-app analytics spine for pickleague. Ported from the michi/tcgscan spine
-- (tcgscan/michi-maker/supabase/migrations/20260805100000_analytics_events.sql) with ONE
-- deliberate difference: user_id is NULLABLE and the anon role may insert.
--
-- Why: a pickleague.club visitor is signed out until they log in, register, or redeem a guest
-- invite — signInAnonymously exists here ONLY for guest passes (GuestJoinScreen) and must not
-- be minted for mere browsing, which would tangle analytics identities into the guest-pass
-- semantics. A printed QR campaign lands exactly those signed-out visitors, so an
-- authenticated-only spine would be blind to the one population campaign attribution is for.
-- A nullable user_id keeps this purely telemetry.
--
-- The claim: a session inserted signed-out has user_id null. If the visitor signs in or signs
-- up mid-session, the client "claims" the row (sets user_id, stamps upgraded_at). That
-- transition IS campaign conversion: landed anonymous with a code, left with an account.
-- is_guest stays immutable ("this session STARTED without an account"), mirroring michi.
--
-- Abuse surface: anon inserts are open to anyone with the publishable key — the same exposure
-- class as michi's signInAnonymously spine. Anon can never write a user_id (WITH CHECK below),
-- so nobody can plant rows on someone's account. Session rows are addressable only by their
-- unguessable uuid. This is telemetry, not a ledger of record.
--
-- The studio reads through the Management API; there is deliberately NO broad read policy and
-- no admin RPC surface (pickleague has no in-app studio page).

create table if not exists public.analytics_sessions (
  id           uuid primary key default gen_random_uuid(),
  -- Nullable: a signed-out visit is a real visit. Defaults to auth.uid() so an authenticated
  -- insert self-stamps and an anon insert stays null without the client sending anything.
  user_id      uuid default auth.uid() references auth.users(id) on delete cascade,
  app          text not null check (app = 'pickleague'),
  -- Immutable "this session STARTED without an account" (claiming does not rewrite it).
  is_guest     boolean not null default false,
  platform     text,
  app_version  text,
  -- Durable per-browser/install random opaque UUID (a coincidence key, never a fingerprint).
  device_id    text,
  -- First screen of the session; carries the allowlisted campaign query (?code=..&utm_..) when
  -- the visit arrived through a printed/linked campaign URL.
  landing_route text,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Stamped when a signed-out session gains an identity mid-session (the claim).
  upgraded_at  timestamptz
);

create index if not exists analytics_sessions_user_started_idx
  on public.analytics_sessions (user_id, started_at desc);
create index if not exists analytics_sessions_device_idx
  on public.analytics_sessions (device_id, started_at desc)
  where device_id is not null;

alter table public.analytics_sessions enable row level security;

-- Anonymous visitors may record their own (identity-less) sessions, and may never claim to be
-- anyone: WITH CHECK pins user_id to null on both insert and update.
create policy "anon sessions insert" on public.analytics_sessions
  for insert to anon with check (user_id is null);
-- Heartbeats (last_seen_at) and landing_route on unclaimed rows. Rows are addressable only by
-- unguessable uuid; user_id cannot be set from this role.
create policy "anon sessions update" on public.analytics_sessions
  for update to anon using (user_id is null) with check (user_id is null);

create policy "own sessions insert" on public.analytics_sessions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own sessions select" on public.analytics_sessions
  for select to authenticated using (auth.uid() = user_id);
-- Own-row updates PLUS the claim: an authenticated user may take over an unclaimed (null-user)
-- session — that is the signed-out-visitor-converted moment this spine exists to record.
create policy "own sessions update" on public.analytics_sessions
  for update to authenticated
  using (user_id is null or auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- analytics_events: append-only. No UPDATE/DELETE policy for anyone — the ledger is immutable
-- from the client. Events recorded while signed out keep user_id null forever; they join their
-- person through session_id once the session is claimed. NEVER rewrite recorded identity.
-- ---------------------------------------------------------------------------
create table if not exists public.analytics_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid default auth.uid() references auth.users(id) on delete cascade,
  session_id uuid references public.analytics_sessions(id) on delete set null,
  app        text not null check (app = 'pickleague'),
  name       text not null,
  props      jsonb not null default '{}'::jsonb,
  ts         timestamptz not null default now()
);

create index if not exists analytics_events_user_ts_idx    on public.analytics_events (user_id, ts);
create index if not exists analytics_events_session_ts_idx on public.analytics_events (session_id, ts);
create index if not exists analytics_events_name_ts_idx    on public.analytics_events (name, ts desc);
create index if not exists analytics_events_app_ts_idx     on public.analytics_events (app, ts desc);

alter table public.analytics_events enable row level security;

create policy "anon events insert" on public.analytics_events
  for insert to anon with check (user_id is null);
create policy "own events insert" on public.analytics_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own events select" on public.analytics_events
  for select to authenticated using (auth.uid() = user_id);
