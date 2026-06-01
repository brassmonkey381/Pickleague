-- Server-side enforcement of guest-pass expiry
--
-- Follow-up to migration_guest_event_invites.sql. Previously, an expired guest's
-- anonymous session kept working: RLS only checks auth.uid(), and the temporary
-- league_members row lingered until a once-daily cron removed it. So an expired
-- guest could still cast votes. This migration closes that two ways:
--
--   1. An RLS guard blocks expired guests from casting votes even while they
--      still hold a (≤1h) valid access token.
--   2. The cleanup job now DELETES the expired anonymous auth.users row (instead
--      of just the membership). FK cascades remove their profile, membership,
--      votes, and push tokens, and GoTrue drops their sessions/refresh tokens —
--      so no new access token can be issued. It now runs hourly, not daily.
--
-- Residual window: an already-issued access token stays valid until it expires
-- (~1h). The vote guard covers the one write that matters in that window; other
-- member-gated actions stop once the hourly delete removes their membership.

-- ── Predicate: is this user an expired guest? (RLS-safe) ───────────────────
create or replace function public.is_expired_guest(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = p_uid
      and is_guest
      and guest_expires_at is not null
      and guest_expires_at < now()
  );
$$;

grant execute on function public.is_expired_guest(uuid) to anon, authenticated;

-- ── Block expired guests from voting (live-token window) ───────────────────
drop policy if exists "Users can cast votes" on public.event_slot_votes;
create policy "Users can cast votes" on public.event_slot_votes
  for insert with check (
    auth.uid() = user_id
    and not public.is_expired_guest(auth.uid())
  );

-- ── Full revocation: delete expired anonymous users (cascades) ─────────────
create or replace function public.cleanup_expired_guests()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Deleting the anonymous auth.users row cascades to the profile and, through
  -- it, to league_members / event_slot_votes / push_tokens, and GoTrue drops the
  -- user's sessions + refresh tokens. The `u.is_anonymous` guard guarantees we
  -- never delete a real account even if a profile were somehow mis-flagged.
  delete from auth.users u
  using public.profiles p
  where p.id = u.id
    and u.is_anonymous
    and p.is_guest
    and p.guest_expires_at is not null
    and p.guest_expires_at < now();
end;
$$;

-- ── Run it hourly (was daily) ──────────────────────────────────────────────
do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-cleanup-expired-guests') then
    perform cron.unschedule('pickleague-cleanup-expired-guests');
  end if;
  perform cron.schedule(
    'pickleague-cleanup-expired-guests',
    '15 * * * *',
    $cron$ select public.cleanup_expired_guests(); $cron$
  );
end $$;
