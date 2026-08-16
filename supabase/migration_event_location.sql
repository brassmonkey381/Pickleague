-- Events get a proper place field. Until now the CreateEventScreen description
-- placeholder said "Location, notes..." — the venue was freeform prose inside
-- the description, so nothing (detail screen, OG cards, nudge texts) could
-- show it as a location. Nullable: an event without a venue is fine.
alter table public.league_events
  add column if not exists location_name text;

comment on column public.league_events.location_name is
  'Freeform venue label ("The HUB Alameda"). Display-only — not a venues FK, '
  'since a vote often predates knowing the exact court.';
