-- ============================================================
-- Google Places cache fields on venues (for the gap-fill ingest).
-- Google's terms allow storing place_id (external_id) indefinitely, but the
-- display fields are a PERFORMANCE CACHE with a ~30-day expiry. These columns
-- let ingest-google-venues.mjs stamp/refresh a TTL and purge stale google rows.
-- Nullable — only google-sourced rows use them. Mirrors Doggle's local_businesses
-- cache pattern.
-- Apply:  supabase db query --linked -f supabase/migration_add_venue_google_cache.sql
-- ============================================================

alter table public.venues
  add column if not exists last_refreshed_at   timestamptz,
  add column if not exists details_expires_at  timestamptz;

create index if not exists venues_google_expiry_idx
  on public.venues (details_expires_at) where source = 'google';

notify pgrst, 'reload schema';
