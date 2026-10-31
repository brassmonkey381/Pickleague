-- Guest event votes need an account (Brian, 2026-10-31: "No more votes
-- without signing up!").
--
-- Before: a g/<token> link signed the visitor in anonymously and
-- redeem_guest_invite gave that throwaway account a 7-day guest pass. Two gaps:
--   - anyone could type any name, and two guests could claim the same one;
--   - the pass lived in one browser, so closing the window locked the vote.
-- Now the link still shows the event and its times signed out, and voting
-- needs a free account: sign up (or sign in), then join_guest_invite.
--
--   1. redeem_guest_invite refuses: an anonymous session can't join anymore.
--      Shipped builds that still call it show the refusal and sign the
--      throwaway session out (GuestJoinScreen's rollback).
--   2. join_guest_invite(token): a signed-in account (not anonymous) joins
--      the invite's league until the invite expires, as the guest pass did,
--      so a closed league's event and its times are visible to vote on. An
--      existing membership is kept; a shorter temporary one is extended.
--   3. get_guest_invite_slots(token): the event's times, signed out, for
--      the link's landing page.
--   4. An anonymous session can't vote or decline (a trigger on both tables,
--      so the vote_event_slots RPC and notification buttons are covered).
--      Guests who already voted keep their votes; they can still withdraw
--      them, and the upgrade banner still turns the pass into an account.
--
-- Unchanged: create_guest_invite (the invite link itself), the hourly
-- cleanup_expired_guests (it still removes expired memberships and the old
-- anonymous accounts), complete_guest_upgrade and the guest banner.
-- Re-runnable. Needs migration_rls_hardening_2026q3.sql re-run after (the
-- two new RPCs are on its allowlist).

-- ── 1. Anonymous sessions no longer redeem an invite ──────────────────────
create or replace function public.redeem_guest_invite(p_token text, p_name text)
returns table (
  league_id   uuid,
  league_name text,
  event_id    uuid,
  event_title text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    message = 'Voting needs a free Pickleague account. Sign up, then open the invite link again.',
    hint = 'pl:guest.account_needed';
end;
$$;

revoke execute on function public.redeem_guest_invite(text, text) from public, anon;
grant execute on function public.redeem_guest_invite(text, text) to authenticated, service_role;

-- ── 2. A signed-in account joins the invite's league for the vote ─────────
create or replace function public.join_guest_invite(p_token text)
returns table (
  league_id   uuid,
  league_name text,
  event_id    uuid,
  event_title text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_inv public.guest_invites;
begin
  if auth.uid() is null then
    raise exception using message = 'Sign in to vote.', hint = 'pl:guest.account_needed';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using
      message = 'Voting needs a free Pickleague account. Sign up, then open the invite link again.',
      hint = 'pl:guest.account_needed';
  end if;

  select * into v_inv
    from public.guest_invites
   where upper(token) = upper(p_token)
   limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    raise exception using
      message = 'This invite link has expired. Ask whoever invited you to send a new one.',
      hint = 'pl:guest.invite_expired';
  end if;

  -- Until the invite expires, like the guest pass. A permanent membership
  -- stays permanent; a shorter temporary one is extended.
  insert into public.league_members (league_id, user_id, role, expires_at)
  values (v_inv.league_id, auth.uid(), 'member', v_inv.expires_at)
  on conflict (league_id, user_id) do update
     set expires_at = greatest(public.league_members.expires_at, excluded.expires_at)
   where public.league_members.expires_at is not null;

  return query
    select l.id, l.name, e.id, e.title
      from public.leagues l
      join public.league_events e on e.id = v_inv.event_id
     where l.id = v_inv.league_id;
end;
$$;

revoke execute on function public.join_guest_invite(text) from public, anon;
grant execute on function public.join_guest_invite(text) to authenticated, service_role;

-- ── 3. The event's times, for the signed-out landing page ─────────────────
create or replace function public.get_guest_invite_slots(p_token text)
returns table (
  starts_at timestamptz,
  ends_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.starts_at, s.ends_at
    from public.guest_invites gi
    join public.event_slots s on s.event_id = gi.event_id
   where upper(gi.token) = upper(p_token)
     and gi.is_active
     and gi.expires_at >= now()
   order by s.starts_at
   limit 20;
$$;

revoke execute on function public.get_guest_invite_slots(text) from public;
grant execute on function public.get_guest_invite_slots(text) to anon, authenticated, service_role;

-- ── 4. Anonymous sessions can't vote or decline ───────────────────────────
create or replace function public._pl_vote_needs_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only a signed-in request carries the claim; cron and service jobs pass.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using
      message = 'Voting needs a free Pickleague account. Create one from the banner at the top, then vote again.',
      hint = 'pl:guest.account_needed';
  end if;
  return new;
end $$;
revoke all on function public._pl_vote_needs_account() from public, anon, authenticated;

drop trigger if exists vote_needs_account on public.event_slot_votes;
create trigger vote_needs_account
  before insert on public.event_slot_votes
  for each row execute function public._pl_vote_needs_account();

drop trigger if exists decline_needs_account on public.event_declines;
create trigger decline_needs_account
  before insert on public.event_declines
  for each row execute function public._pl_vote_needs_account();

notify pgrst, 'reload schema';
