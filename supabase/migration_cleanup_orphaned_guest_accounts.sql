-- Orphaned guest accounts now actually get cleaned up.
--
-- Guest sessions are anonymous Supabase users: no email, no password — the
-- session token in the visitor's browser is the ONLY key. Closing the
-- browser (or the 7-day pass expiring) strands the account forever, and
-- every extra incognito open of an invite link mints another one. The
-- hourly cleanup_expired_guests cron only deleted expired league_members
-- rows; the auth users + profiles accumulated unboundedly.
--
-- Now: after a 14-day grace past guest_expires_at (so a just-finished
-- event keeps its vote tallies intact), never-upgraded guest accounts are
-- deleted outright. Two independent conditions must BOTH hold, so an
-- upgraded account can never match:
--   - profiles.is_guest = true (upgrade flow clears this), and
--   - auth.users.is_anonymous = true (linking credentials clears this).
-- Deletion cascades through profiles to memberships/votes/notifications.

create or replace function public.cleanup_expired_guests()
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Expired memberships drop immediately (guest can no longer act).
  delete from public.league_members
  where expires_at is not null and expires_at < now();

  -- Expired, never-upgraded guest ACCOUNTS drop after a 14-day grace.
  delete from auth.users u
  using public.profiles p
  where p.id = u.id
    and p.is_guest = true
    and p.guest_expires_at is not null
    and p.guest_expires_at < now() - interval '14 days'
    and u.is_anonymous = true;
end;
$$;
revoke execute on function public.cleanup_expired_guests() from public, anon, authenticated;
