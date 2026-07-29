-- Claim flow: fold a DUPR-seeded placeholder profile into a real account.
--
-- Delivery is a Supabase magic link, not a token of ours. The built-in SMTP is
-- wired only to Auth emails (there is no send-arbitrary-mail API), so the claim
-- mail has to be an auth mail — which turns out to be the better design: clicking
-- it signs the person in with a CONFIRMED email, and that IS the proof of
-- ownership. public.profile_claims stays as the rate-limit + audit ledger.
--
-- Sending lives in the request-claim edge function. Nothing here sends anything.

create or replace function public.claim_my_dupr_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_row    record;
  v_ghost  uuid;
  v_rating numeric;
  v_played int;
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

  -- PLUPR shares the DUPR scale, so never overwrite a rating a real player earned.
  select total_matches_played into v_played from public.profiles where id = v_uid;
  if coalesce(v_played, 0) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'has_match_history');
  end if;

  v_rating := coalesce(v_row.dupr_doubles, v_row.dupr_singles);

  update public.profiles
     set dupr_id              = v_row.dupr_id,
         rating               = coalesce(v_rating, rating),
         singles_rating       = coalesce(v_row.dupr_singles, v_rating, singles_rating),
         doubles_rating       = coalesce(v_row.dupr_doubles, v_rating, doubles_rating),
         mixed_doubles_rating = coalesce(v_row.dupr_doubles, v_rating, mixed_doubles_rating)
   where id = v_uid;

  -- Retire the placeholder so the club shows one person, not two. The synthetic
  -- auth.users row is left behind (it can never sign in: unconfirmed, random
  -- password) and is swept by seed-claimable-profiles.mjs --delete.
  if v_ghost is not null and v_ghost <> v_uid then
    delete from public.profiles where id = v_ghost and is_unclaimed;
  end if;

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
    'absorbed_placeholder', v_ghost is not null and v_ghost <> v_uid
  );
end;
$$;

revoke execute on function public.claim_my_dupr_profile() from public, anon;
grant execute on function public.claim_my_dupr_profile() to authenticated;

-- my_dupr_match must also surface rows already linked to an UNCLAIMED placeholder,
-- otherwise a seeded player could never be offered their own row. Adding the
-- column changes the return type, so the old function has to be dropped first.
drop function if exists public.my_dupr_match();

create function public.my_dupr_match()
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
  order by m.last_synced_at desc
  limit 1;
$$;

revoke execute on function public.my_dupr_match() from public, anon;
grant execute on function public.my_dupr_match() to authenticated;

-- Kept for API compatibility. Once my_dupr_match started matching placeholder-
-- linked rows, the old body would have imported a rating WITHOUT absorbing the
-- placeholder — leaving two rows for the same person on the leaderboard. One
-- code path removes that whole class of bug.
create or replace function public.import_my_dupr_rating()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.claim_my_dupr_profile();
$$;

revoke execute on function public.import_my_dupr_rating() from public, anon;
grant execute on function public.import_my_dupr_rating() to authenticated;
