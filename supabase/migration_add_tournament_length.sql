-- ============================================================
-- Tournament: expected length in hours.
--
-- Decimal so partial hours work (1.5h, 2.5h, etc.).  Allowed range
-- of 0.5 .. 168 covers everything from a one-game pickleball match
-- to a week-long event.
-- ============================================================

alter table public.tournaments
  add column if not exists expected_length_hours decimal(5,2)
  check (expected_length_hours is null or (expected_length_hours >= 0.5 and expected_length_hours <= 168));
