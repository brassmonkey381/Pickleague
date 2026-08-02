-- DUPR claim, second pass: separate LINKING from RATING SEEDING, and make
-- "not me" stick.
--
-- Three bugs surfaced by a real account (5 matches played, on The HUB roster):
--
-- 1. claim_my_dupr_profile() refused outright when the caller had any match
--    history. The guard is right about the RATING — PLUPR shares the DUPR scale,
--    so overwriting an earned ELO would corrupt real history — but it was also
--    blocking the dupr_id LINK and the placeholder absorb, which are harmless.
--    Result: an active player could never claim their own roster row, and the
--    duplicate unclaimed profile stayed on the leaderboard forever.
--
-- 2. Because the claim always failed, my_dupr_match() kept returning the row and
--    the Home banner reappeared on every reload. The client hid it in component
--    state only, so nothing survived a refresh.
--
-- 3. "Not me" was never persisted anywhere at all.
--
-- Fix: always link + absorb; seed ratings only for a profile that has not
-- played; persist dismissal on the profile and filter it out server-side.

-- ── 1. Persist "not me" ──────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists dupr_import_dismissed_at timestamptz;

comment on column public.profiles.dupr_import_dismissed_at is
  'Set when the player dismissed the "we found your DUPR rating" banner. '
  'Suppresses my_dupr_match() for them; cleared by setting it back to null.';

create or replace function public.dismiss_dupr_import()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set dupr_import_dismissed_at = now()
   where id = auth.uid();
$$;

revoke execute on function public.dismiss_dupr_import() from public, anon;
grant execute on function public.dismiss_dupr_import() to authenticated;

-- ── 2. Stop offering a row the caller already said no to ─────────────────────
-- Return type is unchanged, so create-or-replace is enough here.
--
-- The dismissal lookup is deliberately aliased (`me`): the outer query already
-- has a `profiles p` in scope, and an unqualified column inside the subquery
-- would silently bind to the wrong relation.
create or replace function public.my_dupr_match()
returns table (
  dupr_id             text,
  club_name           text,
  full_name           text,
  singles             numeric,
  doubles             numeric,
  placeholder_profile uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select m.dupr_id, m.dupr_club_name, m.dupr_full_name, m.dupr_singles, m.dupr_doubles,
         case when p.is_unclaimed then p.id else null end
  from public.dupr_club_members m
  left join public.profiles p on p.id = m.profile_id
  where m.dupr_email is not null
    and lower(m.dupr_email) = public.confirmed_email_of_caller()
    and (m.profile_id is null or p.is_unclaimed)
    and (select me.dupr_import_dismissed_at
           from public.profiles me
          where me.id = auth.uid()) is null
  order by m.last_synced_at desc
  limit 1;
$$;

revoke execute on function public.my_dupr_match() from public, anon;
grant execute on function public.my_dupr_match() to authenticated;

-- ── 3. Link always; seed ratings only when there is nothing to destroy ───────
create or replace function public.claim_my_dupr_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_row       record;
  v_ghost     uuid;
  v_rating    numeric;
  v_played    int;
  v_apply     boolean;
  v_absorbed  boolean := false;
  v_ghost_fk  boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_email := public.confirmed_email_of_caller();
  if v_email is null then
    return jsonb_build_object('ok', false, 'reason', 'email_not_confirmed');
  end if;

  select * into v_row
  from public.dupr_club_members
  where dupr_email is not null and lower(dupr_email) = v_email
  order by last_synced_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_match');
  end if;

  v_ghost := v_row.profile_id;

  -- Linked to somebody already? Only an UNCLAIMED placeholder may be absorbed.
  if v_ghost is not null and v_ghost <> v_uid
     and not exists (select 1 from public.profiles where id = v_ghost and is_unclaimed) then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  select total_matches_played into v_played from public.profiles where id = v_uid;

  v_rating := coalesce(v_row.dupr_doubles, v_row.dupr_singles);

  -- The rating is a SEED, not a sync. A profile that has already played owns an
  -- ELO derived from real results; DUPR must not overwrite it. Linking the ID
  -- and absorbing the duplicate are safe either way, so they happen regardless.
  v_apply := coalesce(v_played, 0) = 0 and v_rating is not null;

  -- Retire the placeholder FIRST. profiles.dupr_id is UNIQUE and the placeholder
  -- already holds this DUPR id, so writing it onto the claimer while the ghost is
  -- still around raises 23505 and aborts the whole claim. (That ordering is why
  -- no placeholder-linked claim ever succeeded.)
  --
  -- The synthetic auth.users row is left behind (it can never sign in:
  -- unconfirmed, random password) and is swept by seed-claimable-profiles.mjs
  -- --delete.
  --
  -- matches/tournament_matches are ON DELETE NO ACTION, so a placeholder someone
  -- recorded a game against cannot be deleted. That must not blow up the claim
  -- with a raw FK error — strip its DUPR identity, keep the shell holding the
  -- history, and report it so a human can merge deliberately.
  if v_ghost is not null and v_ghost <> v_uid then
    select exists (
      select 1 from public.matches
       where player1_id = v_ghost or player2_id = v_ghost
          or partner1_id = v_ghost or partner2_id = v_ghost
          or winner_id = v_ghost
      union all
      select 1 from public.tournament_matches
       where team1_player1 = v_ghost or team1_player2 = v_ghost
          or team2_player1 = v_ghost or team2_player2 = v_ghost
    ) into v_ghost_fk;

    if v_ghost_fk then
      update public.profiles set dupr_id = null
       where id = v_ghost and is_unclaimed;
    else
      delete from public.profiles where id = v_ghost and is_unclaimed;
      v_absorbed := true;
    end if;
  end if;

  update public.profiles
     set dupr_id              = v_row.dupr_id,
         rating               = case when v_apply then v_rating else rating end,
         singles_rating       = case when v_apply
                                     then coalesce(v_row.dupr_singles, v_rating)
                                     else singles_rating end,
         doubles_rating       = case when v_apply
                                     then coalesce(v_row.dupr_doubles, v_rating)
                                     else doubles_rating end,
         mixed_doubles_rating = case when v_apply
                                     then coalesce(v_row.dupr_doubles, v_rating)
                                     else mixed_doubles_rating end,
         -- Claiming answers the banner's question; never ask again.
         dupr_import_dismissed_at = now()
   where id = v_uid;

  update public.dupr_club_members
     set profile_id = v_uid, matched_by = 'email'
   where id = v_row.id;

  update public.profile_claims
     set consumed_at = now(), claimed_by = v_uid
   where profile_id = v_ghost and consumed_at is null;

  return jsonb_build_object(
    'ok', true,
    'dupr_id', v_row.dupr_id,
    'club', v_row.dupr_club_name,
    'rating', v_rating,
    'rating_applied', v_apply,
    'absorbed_placeholder', v_absorbed,
    'placeholder_kept', v_ghost_fk
  );
end;
$$;

revoke execute on function public.claim_my_dupr_profile() from public, anon;
grant execute on function public.claim_my_dupr_profile() to authenticated;
