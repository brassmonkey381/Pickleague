-- ============================================================
-- Split court ratings into gendered / mixed doubles
--
-- Run AFTER migration_add_mixed_doubles.sql.
--
-- player_location_ratings.match_type previously took 'singles' | 'doubles'.
-- After this migration it takes 'singles' | 'doubles_gendered' | 'doubles_mixed'.
--
-- Existing 'doubles' rows are deleted because we can't tell which bucket
-- they belong in without replaying. After running this migration, run
-- `node scripts/recalculate-elo.js` (with SUPABASE_URL +
-- SUPABASE_SERVICE_ROLE_KEY set) to repopulate them by replaying matches
-- with current gender data.
-- ============================================================

-- Drop the old check constraint (its name is auto-generated; look it up).
do $$
declare
  con_name text;
begin
  select conname into con_name
    from pg_constraint
   where conrelid = 'public.player_location_ratings'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) like '%match_type%';
  if con_name is not null then
    execute format('alter table public.player_location_ratings drop constraint %I', con_name);
  end if;
end $$;

-- Wipe legacy 'doubles' rows; recalculate-elo.js will repopulate them.
delete from public.player_location_ratings where match_type = 'doubles';

-- Add the new constraint.
alter table public.player_location_ratings
  add constraint player_location_ratings_match_type_check
  check (match_type in ('singles', 'doubles_gendered', 'doubles_mixed'));
