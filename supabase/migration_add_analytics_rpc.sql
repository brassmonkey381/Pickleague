-- Fix for the spine migration: RLS select-gating silently blanked every anon-side session update.
--
-- Postgres rule (CREATE POLICY docs): an UPDATE whose WHERE clause references table columns
-- also requires the target rows to pass a SELECT policy. The anon role deliberately has no
-- SELECT policy here, so the spine migration's "anon sessions update" could never match a row — PostgREST
-- answered 204 while landing_route stayed null (found live on the first end-to-end test).
-- The authenticated CLAIM of a null-user row had the same defect: an unclaimed row is not
-- visible through "own sessions select", so the claim UPDATE matched nothing either.
--
-- Rather than exposing session rows to anon through a broad SELECT policy (anyone with the
-- publishable key could then enumerate visitor sessions), the writes that must touch a row
-- the caller cannot SELECT go through SECURITY DEFINER functions. The unguessable session
-- uuid is the bearer capability; what a caller can change is pinned inside the function
-- bodies, not left to column grants.

-- The dead policy: it can never match (see above), and keeping it would imply a capability
-- that does not exist.
drop policy if exists "anon sessions update" on public.analytics_sessions;

-- The claim clause moves into analytics_claim(); own-row updates keep working normally
-- (an authenticated user's own rows ARE selectable, so plain updates on them are fine).
drop policy if exists "own sessions update" on public.analytics_sessions;
create policy "own sessions update" on public.analytics_sessions
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Heartbeat + landing_route, for any role holding the session uuid. landing_route writes
-- only if still null (same first-touch idempotence the emitters had) and is length-capped.
create or replace function public.analytics_touch(p_session uuid, p_landing text default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.analytics_sessions
     set last_seen_at = now(),
         landing_route = coalesce(landing_route, left(p_landing, 300))
   where id = p_session;
$$;

-- The claim: a signed-out session gains its identity. auth.uid() comes from the caller's JWT
-- (never a parameter), only ever fills a NULL user_id, and stamps upgraded_at. Idempotent;
-- a claimed row is never re-claimed. is_guest stays immutable by simply not being touched.
create or replace function public.analytics_claim(p_session uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.analytics_sessions
     set user_id = auth.uid(), upgraded_at = now()
   where id = p_session
     and user_id is null
     and auth.uid() is not null;
$$;

revoke all on function public.analytics_touch(uuid, text) from public;
revoke all on function public.analytics_claim(uuid) from public;
grant execute on function public.analytics_touch(uuid, text) to anon, authenticated;
grant execute on function public.analytics_claim(uuid) to authenticated;
