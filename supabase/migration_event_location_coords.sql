-- Events adopt the standard venue picker (CourtPicker → foundation
-- VenuePicker over our venues catalog), which yields coordinates alongside
-- the name — same shape tournaments already store. Nullable: hand-typed or
-- pre-picker locations have a name and no coords.
alter table public.league_events
  add column if not exists location_lat double precision,
  add column if not exists location_lng double precision;
