// User preference storage backed by Supabase (table: user_preferences).
// Previously lived in AsyncStorage — see migration_add_user_preferences.sql.
//
// Single JSONB blob per user; new keys here don't require a schema migration.
// Read merges DB values onto DEFAULT_PREFS so new keys appear with their default
// even for old rows. Write upserts the entire blob.
//
// Because the write is whole-blob, a read that FAILED must never be allowed to
// seed one: returning DEFAULT_PREFS from a failed read and then saving that blob
// overwrites every setting the user had — including flipping pushEnabled off —
// with no error shown. So reads report failure separately from "no row yet"
// (loadUserPreferencesResult), and a save is refused until a read has succeeded
// this session.

import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { savePrefs } from './offlineWrites';

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

/**
 * Outcome of a preferences read. `ok` carries the merged prefs plus whether a
 * row actually existed; `failed` means we couldn't tell what the user's
 * settings are and callers must not present (or persist) defaults as if they
 * were the user's choices.
 */
export type PrefsResult =
  | { status: 'ok'; prefs: Prefs; exists: boolean }
  | { status: 'signedOut' }
  | { status: 'failed'; error: unknown };

/** Last read (or write) we know landed — the only blob safe to fall back to. */
let lastGoodPrefs: Prefs | null = null;
/** Whether prefs have been read successfully this session; gates writes. */
let prefsLoaded = false;

export async function loadUserPreferencesResult(): Promise<PrefsResult> {
  // LOCAL session read: getUser() is a network call, so offline it reported
  // "signed out" and every preference read fell back to defaults.
  const userId = await currentUserId(supabase);
  if (!userId) return { status: 'signedOut' };
  try {
    const data = await sbCall(() =>
      supabase.from('user_preferences').select('prefs').eq('user_id', userId).maybeSingle(),
    );
    const stored = (data?.prefs ?? null) as Partial<Prefs> | null;
    const prefs = { ...DEFAULT_PREFS, ...(stored ?? {}) };
    lastGoodPrefs = prefs;
    prefsLoaded = true;
    return { status: 'ok', prefs, exists: !!stored };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * Convenience read for callers that only need values to act on (not to display
 * or save). Falls back to the last successful read of this session before
 * DEFAULT_PREFS, so one bad request doesn't make a user who enabled push look
 * like they never did.
 */
export async function loadUserPreferences(): Promise<Prefs> {
  const result = await loadUserPreferencesResult();
  return result.status === 'ok' ? result.prefs : lastGoodPrefs ?? DEFAULT_PREFS;
}

export async function saveUserPreferences(prefs: Prefs): Promise<{ error: string | null }> {
  const userId = await currentUserId(supabase);
  if (!userId) return { error: 'Not signed in' };
  // Refuse to write a blob that could have been built on top of defaults from a
  // read that never landed — that write is silent, total, and irreversible.
  if (!prefsLoaded) {
    return { error: "Couldn't load your current settings — reload before changing them." };
  }
  try {
    // Queued on a transport failure, deduped per user so a burst of offline
    // toggles collapses to the final state instead of replaying stale blobs.
    // Either way the user's choice is recorded, so this reports success.
    await savePrefs({ userId, prefs });
    lastGoodPrefs = prefs;
    return { error: null };
  } catch (e) {
    return { error: friendlySbMessage(e, 'Failed to save preferences.') };
  }
}
