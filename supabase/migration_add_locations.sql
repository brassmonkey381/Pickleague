-- Add home court to leagues and location to matches

alter table public.leagues
  add column if not exists home_court      text,
  add column if not exists home_court_lat  double precision,
  add column if not exists home_court_lng  double precision;

alter table public.matches
  add column if not exists location_name   text,
  add column if not exists location_lat    double precision,
  add column if not exists location_lng    double precision;
