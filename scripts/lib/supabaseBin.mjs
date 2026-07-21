// Single source of truth for the Supabase CLI binary our scripts shell out to, so
// every tool references the same one. Override per-machine with the SUPABASE_BIN
// env var (the toolbox injects it from its saved keys); otherwise fall back to the
// known install path on this dev machine. Change the default here once and every
// script follows.
export const SUPABASE_BIN =
  (process.env.SUPABASE_BIN || '').trim() || 'C:/Users/Brian/tools/supabase/supabase.exe';
