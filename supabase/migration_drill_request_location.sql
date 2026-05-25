-- ============================================================
-- drill_requests: shared location for the drill.
--
-- Either party (from_user or to_user) can set/change it — the existing
-- "Users update drill requests they are part of" RLS policy already
-- permits both. Once set, the card shows it as the confirmed location.
-- ============================================================

alter table public.drill_requests
  add column if not exists location_name text,
  add column if not exists location_id   uuid references public.court_locations(id) on delete set null;
