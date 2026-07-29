-- Signup-time DUPR matching: the consent-first half of the claim story.
--
-- When someone signs up for Pickleague normally and CONFIRMS their email, that
-- confirmation proves they control the address. If that same address appears in
-- an imported DUPR club roster, we can offer to carry their DUPR rating over.
-- No outbound mail, no pre-created account, nothing happens without a tap.
--
-- Both functions are SECURITY DEFINER because dupr_club_members is godmode-only
-- under RLS. They are safe to expose because they are scoped to the CALLER's own
-- confirmed email and never return contact PII — name, club and ratings only.

-- The caller's email, but only once Supabase has confirmed it. Anything
-- unconfirmed returns null, so an unverified address can never match.
create or replace function public.confirmed_email_of_caller()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select lower(u.email)
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null
    and coalesce(u.is_anonymous, false) = false;
$$;

revoke execute on function public.confirmed_email_of_caller() from public, anon, authenticated;

-- Does the caller's confirmed email appear on an imported roster?
-- Returns at most one row, and deliberately no email/phone/address/birthdate.
create or replace function public.my_dupr_match()
returns table (
  dupr_id     text,
  club_name   text,
  full_name   text,
  singles     numeric,
  doubles     numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select m.dupr_id, m.dupr_club_name, m.dupr_full_name, m.dupr_singles, m.dupr_doubles
  from public.dupr_club_members m
  where m.dupr_email is not null
    and lower(m.dupr_email) = public.confirmed_email_of_caller()
    and m.profile_id is null          -- not already linked to someone
  order by m.last_synced_at desc
  limit 1;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so the revoke is load-bearing:
-- granting to `authenticated` alone would still leave anon able to call it.
revoke execute on function public.my_dupr_match() from public, anon;
grant execute on function public.my_dupr_match() to authenticated;

-- Apply the matched DUPR rating to the caller's own profile.
--
-- Guarded to a FRESH profile (no matches played, no dupr_id yet): PLUPR is on the
-- same scale as DUPR, so overwriting an established rating would corrupt a real
-- ELO history rather than seed it. Returns a jsonb summary of what was applied.
create or replace function public.import_my_dupr_rating()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_match   record;
  v_played  int;
  v_has_id  text;
  v_rating  numeric;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select total_matches_played, dupr_id into v_played, v_has_id
  from public.profiles where id = v_uid;

  if v_has_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_imported');
  end if;
  if coalesce(v_played, 0) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'has_match_history');
  end if;

  select * into v_match from public.my_dupr_match();
  if v_match is null then
    return jsonb_build_object('ok', false, 'reason', 'no_match');
  end if;

  v_rating := coalesce(v_match.doubles, v_match.singles);
  if v_rating is null then
    return jsonb_build_object('ok', false, 'reason', 'unrated');
  end if;

  update public.profiles
     set dupr_id              = v_match.dupr_id,
         rating               = v_rating,
         singles_rating       = coalesce(v_match.singles, v_rating),
         doubles_rating       = coalesce(v_match.doubles, v_rating),
         mixed_doubles_rating = coalesce(v_match.doubles, v_rating)
   where id = v_uid;

  -- Link the roster row so it stops being offered to anyone else.
  update public.dupr_club_members
     set profile_id = v_uid,
         matched_by = 'email'
   where dupr_email is not null
     and lower(dupr_email) = public.confirmed_email_of_caller()
     and profile_id is null;

  return jsonb_build_object(
    'ok', true,
    'dupr_id', v_match.dupr_id,
    'club', v_match.club_name,
    'rating', v_rating,
    'singles', v_match.singles,
    'doubles', v_match.doubles
  );
end;
$$;

revoke execute on function public.import_my_dupr_rating() from public, anon;
grant execute on function public.import_my_dupr_rating() to authenticated;
