-- ============================================================
-- Quick bump: every profile gets at least 5000 🥒. Anyone already
-- above 5000 (e.g. godmode user from the 50k grant) is untouched.
-- Idempotent — re-running is a no-op once everyone is at 5000+.
-- ============================================================

update public.profiles
   set pickles = greatest(coalesce(pickles, 0), 5000);

-- Quick sanity print.
do $$
declare
  v_total integer;
  v_above integer;
  v_min   integer;
begin
  select count(*), min(pickles) into v_total, v_min from public.profiles;
  select count(*) into v_above from public.profiles where pickles >= 5000;
  raise notice 'pickles bump: % profiles, min balance = %, % at or above 5000', v_total, v_min, v_above;
end$$;
