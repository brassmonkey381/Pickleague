// User preference storage backed by Supabase (table: user_preferences).
// Previously lived in AsyncStorage — see migration_add_user_preferences.sql.
//
// Single JSONB blob per user; new keys here don't require a schema migration.
// Read merges DB values onto DEFAULT_PREFS so new keys appear with their default
// even for old rows. Write upserts the entire blob.

import { supabase } from './supabase';

export type MatchType = 'singles' | 'doubles';
export type ScoreLimit = 11 | 15 | 21;

export type Prefs = {
  /** Master switch for phone push notifications. Opt-in: defaults off until the
   *  user enables it and grants OS permission. In-app notifications are
   *  unaffected — they always appear in the bell/list regardless. */
  pushEnabled:              boolean;
  notifyMatchResults:       boolean;
  notifyEventReminders:     boolean;
  notifyLeagueUpdates:      boolean;
  notifyTournamentUpdates:  boolean;
  notifyChallenges:         boolean;
  defaultMatchType:         MatchType;
  defaultScoreLimit:        ScoreLimit;
};

export const DEFAULT_PREFS: Prefs = {
  pushEnabled:              false,
  notifyMatchResults:       true,
  notifyEventReminders:     true,
  notifyLeagueUpdates:      true,
  notifyTournamentUpdates:  true,
  notifyChallenges:         true,
  defaultMatchType:         'doubles',
  defaultScoreLimit:        11,
};

export async function loadUserPreferences(): Promise<Prefs> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return DEFAULT_PREFS;
  const { data } = await supabase
    .from('user_preferences')
    .select('prefs')
    .eq('user_id', user.id)
    .maybeSingle();
  return { ...DEFAULT_PREFS, ...((data?.prefs as Partial<Prefs>) ?? {}) };
}

export async function saveUserPreferences(prefs: Prefs): Promise<{ error: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not signed in' };
  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: user.id, prefs, updated_at: new Date().toISOString() });
  return { error: error?.message ?? null };
}
