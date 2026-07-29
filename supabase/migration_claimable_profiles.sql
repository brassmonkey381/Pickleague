-- Claimable (unclaimed) profiles seeded from a DUPR club roster.
--
-- An unclaimed profile is a real row in public.profiles so that leaderboards,
-- search, and match history need no special-casing — but it is backed by an
-- auth.users row with a SYNTHETIC email (dupr-<member_id>@unclaimed.pickleague.club).
-- The person's real address lives only in public.dupr_club_members, behind RLS.
--
-- Consequences of that choice, on purpose:
--   • no Supabase auth email (confirm, reset, magic link) can ever reach a real
--     person who has not asked for it — the synthetic mailbox does not exist;
--   • the real address is written into auth.users only when a claim SUCCEEDS,
--     i.e. only after someone has proven they control that inbox;
--   • profiles itself never holds DUPR PII. Name and ratings only. In particular
--     profiles.phone is deliberately NOT populated from dupr_phone.

alter table public.profiles add column if not exists is_unclaimed boolean not null default false;
-- Where the row came from, e.g. 'dupr_club:8354485564'. Null for real signups.
alter table public.profiles add column if not exists claim_source text;

create index if not exists profiles_unclaimed_idx on public.profiles (is_unclaimed) where is_unclaimed;

-- One row per claim attempt. The raw token is NEVER stored — only its sha256 —
-- so a leak of this table cannot be used to claim anyone.
create table if not exists public.profile_claims (
  id             bigint generated always as identity primary key,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  token_hash     text not null unique,
  -- Audit trail: which address the mail actually went to, and who asked.
  sent_to_email  text not null,
  requested_by   uuid references public.profiles(id) on delete set null,
  requested_ip   inet,
  requested_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  -- Set when the claim is redeemed, so we can tell a completed claim from an
  -- abandoned one without joining back to profiles.
  claimed_by     uuid references public.profiles(id) on delete set null
);

create index if not exists profile_claims_profile_idx on public.profile_claims (profile_id, requested_at desc);
create index if not exists profile_claims_live_idx    on public.profile_claims (expires_at) where consumed_at is null;

-- Rate limit: how many claim emails have been sent for this profile recently.
-- The edge function calls this before sending so a "Claim this account" button
-- cannot be used to repeatedly mail a stranger.
create or replace function public.recent_claim_count(p_profile_id uuid, p_window interval default interval '24 hours')
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.profile_claims
  where profile_id = p_profile_id
    and requested_at > now() - p_window;
$$;

-- Internal helper — the edge function calls it with the service role, which
-- bypasses RLS and grants anyway. No client should reach it.
revoke execute on function public.recent_claim_count(uuid, interval) from public, anon, authenticated;

alter table public.profile_claims enable row level security;

-- Deny by default. profile_claims holds the target email address, so it is
-- godmode-only for reads; all writes happen with the service-role key from the
-- claim edge functions. No anon access, no authenticated INSERT/UPDATE/DELETE.
drop policy if exists "Godmode reads profile claims" on public.profile_claims;
create policy "Godmode reads profile claims"
  on public.profile_claims for select
  to authenticated
  using (public.is_godmode_user());

revoke all on public.profile_claims from anon;
grant select on public.profile_claims to authenticated;
