-- Add expected_duration_hours to tournaments. Default 3 (hours).
alter table public.tournaments
  add column if not exists expected_duration_hours numeric(4,1) default 3;

notify pgrst, 'reload schema';
