-- ============================================================
-- Format × match_type constraint
-- mlp, mlp_random, and rotating_partners are doubles-only.
-- ============================================================

alter table public.tournaments
  drop constraint if exists tournaments_format_match_type_check;

alter table public.tournaments
  add constraint tournaments_format_match_type_check
  check (
    match_type = 'doubles'
    or format not in ('mlp', 'mlp_random', 'rotating_partners')
  ) not valid;

-- VALIDATE will raise if any existing row violates; that surfaces
-- the issue rather than silently letting bad data through.
alter table public.tournaments
  validate constraint tournaments_format_match_type_check;

notify pgrst, 'reload schema';
