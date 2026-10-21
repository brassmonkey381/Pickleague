-- ============================================================
-- Court stars: at most 3, and "replace one" when the list is full
-- (Doggle parity, the user's standing rule: "as much parity with Doggle as
-- possible").
--
-- Doggle caps favorite locations at 3 (db/migrations/0047_favorites_max_three.sql;
-- 0281/0284 raise it only for Doggle+, which Pickleague doesn't have). When
-- the list is full, its star opens "Replace a favorite?" with the 3 to pick
-- from, and replace_user_favorite (0059) swaps the picked one for the new one
-- in one call. This file does the same for court_favorites:
--
--   1. set_court_favorite(p_venue, p_on)   same signature and body as the
--      latest one (migration_refusal_messages.sql, from the live definition of
--      2026-10-16); only the cap (5 -> 3) and its message change. The code is
--      still pl:court.favorites_full.
--   2. replace_court_favorite(p_remove_venue, p_add_venue)   new client RPC:
--      unstars one of my courts and stars another, atomically (any refusal
--      rolls the unstar back). Like Doggle's replace_user_favorite: the court
--      to drop must be one of mine, the new one must not be starred already.
--      The new star is a fresh court_favorites row, so its auto_checkin is the
--      column default (on), as a plain star is; the dropped court's row (and
--      its switch) goes, so court arrival stops checking in there, as after
--      an unstar (_pl_court_arrival_off reads court_favorites each time).
--      Refusals: pl:auth.signed_out, pl:request.bad (an id missing),
--      pl:court.not_starred (the court to drop isn't one of mine),
--      pl:court.gone (the new court isn't in Pickleague), pl:court.already_starred,
--      pl:court.favorites_full (still full after the drop: an account over the
--      cap from before this file).
--   3. A one-time trim of accounts over 3 (only TestFlight testers of 1.0.4
--      could star 4 or 5). Doggle 0047 deleted nothing: it lowered the cap
--      and limited list_user_favorites to the first 3 by created_at, so the
--      3 OLDEST stayed on screen and the newer ones were hidden. Here the
--      stars also drive court arrival (every row is a watched court), so the
--      rows past the cap are deleted rather than hidden, keeping the same 3
--      Doggle would show: the oldest (created_at, then venue_id, the order of
--      list_my_court_favorites).
--
-- Idempotent: create or replace, and the trim deletes nothing on a second run.
-- No top-level transaction statements (the persona test wraps this file).
-- Re-apply after any re-run of migration_refusal_messages.sql or
-- migration_presence_p1_reads.sql: both put the 5-court set_court_favorite back.
-- Then re-run migration_rls_hardening_2026q3.sql (replace_court_favorite is on
-- its allowlist).
--
-- Test: supabase/tests/court_star_cap_personas.sql
--   node supabase/tests/build-court-star-cap-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- ============================================================

-- ── 1. The cap: 3 ──────────────────────────────────────────────────────────
create or replace function public.set_court_favorite(p_venue text, p_on boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me    uuid := auth.uid();
  v_canon text := public._pl_canonical_venue(p_venue);
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if v_canon is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so it can''t be starred.', hint = 'pl:court.gone';
  end if;
  perform pg_advisory_xact_lock(hashtext('court_favorites:' || v_me::text));

  if not coalesce(p_on, true) then
    delete from public.court_favorites f
     where f.user_id = v_me
       and f.venue_id in (select v.id from public.venues v where v.id = v_canon or v.canonical_id = v_canon);
    return false;
  end if;

  if exists (select 1 from public.court_favorites where user_id = v_me and venue_id = v_canon) then
    return true;
  end if;
  if (select count(*) from public.court_favorites where user_id = v_me) >= 3 then
    raise exception using message = 'You can star up to 3 courts. Unstar one to add this one.', hint = 'pl:court.favorites_full';
  end if;
  insert into public.court_favorites (user_id, venue_id) values (v_me, v_canon);
  return true;
end $function$;
revoke all on function public.set_court_favorite(text, boolean) from public, anon;
grant execute on function public.set_court_favorite(text, boolean) to authenticated;

-- ── 2. Replace one star with another ───────────────────────────────────────
-- Returns true (the new court is starred). The court to drop matches a star
-- on its canonical row or a duplicate, as unstarring does; the new court is
-- stored canonical, as starring does.
create or replace function public.replace_court_favorite(p_remove_venue text, p_add_venue text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_remove text := coalesce(public._pl_canonical_venue(p_remove_venue), p_remove_venue);
  v_add    text := public._pl_canonical_venue(p_add_venue);
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if nullif(btrim(p_remove_venue), '') is null or nullif(btrim(p_add_venue), '') is null then
    raise exception using message = 'Couldn''t change your courts because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  perform pg_advisory_xact_lock(hashtext('court_favorites:' || v_me::text));

  delete from public.court_favorites f
   where f.user_id = v_me
     and f.venue_id in (select v.id from public.venues v where v.id = v_remove or v.canonical_id = v_remove);
  if not found then
    raise exception using message = 'That court isn''t one of your starred courts any more. Pick one of your starred courts to replace.', hint = 'pl:court.not_starred';
  end if;

  if v_add is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so it can''t be starred.', hint = 'pl:court.gone';
  end if;
  if exists (select 1 from public.court_favorites where user_id = v_me and venue_id = v_add) then
    raise exception using message = 'That court is already one of your starred courts.', hint = 'pl:court.already_starred';
  end if;
  if (select count(*) from public.court_favorites where user_id = v_me) >= 3 then
    raise exception using message = 'You can star up to 3 courts. Unstar one to add this one.', hint = 'pl:court.favorites_full';
  end if;
  insert into public.court_favorites (user_id, venue_id) values (v_me, v_add);
  return true;
end $$;
revoke all on function public.replace_court_favorite(text, text) from public, anon;
grant execute on function public.replace_court_favorite(text, text) to authenticated;

-- ── 3. One-time trim: keep each account's 3 oldest stars ───────────────────
delete from public.court_favorites f
 using (select user_id, venue_id,
               row_number() over (partition by user_id order by created_at, venue_id) as rn
          from public.court_favorites) r
 where f.user_id = r.user_id
   and f.venue_id = r.venue_id
   and r.rn > 3;

comment on table public.court_favorites is
  'My courts: at most 3 per player (set_court_favorite, replace_court_favorite). venue_id is canonical.';

notify pgrst, 'reload schema';
