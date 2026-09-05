// Minimum-supported-version gate.
//
// Reads `app_config.min_supported_version` (world-readable, see
// supabase/migration_app_config_min_version.sql) and reports whether THIS build
// is too old to keep running. The value lives server-side because the point of
// a forced update is to act on a version already in users' hands - a constant
// compiled into the bundle can only ever describe itself.
//
// FAIL OPEN is the governing rule here, and every early return below is an
// instance of it. Offline, missing row, missing table, unparseable version,
// unknown platform: all resolve to "not blocked". Locking someone out of a
// working app because a config read timed out on hotel wifi would be a far
// worse bug than the one this feature exists to fix.
//
// Reserve it for genuine native-level breaks - a client too old to speak to the
// current schema. Ordinary JS bugs ship over the air without a store round trip.
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { supabase } from './supabase';
import { compareVersions } from './versionCompare';

// Re-exported so callers have one obvious import site for the whole gate.
export { compareVersions };

/** The config read is never awaited by anything the user is waiting on, but an
 *  unbounded promise still leaks; this bounds it. */
const CONFIG_TIMEOUT_MS = 8_000;

/**
 * True only when we are certain this build is below the configured minimum.
 * Never throws.
 */
export async function isUpdateRequired(): Promise<boolean> {
  try {
    // The web build always serves the current bundle, so it cannot be stale -
    // and there is no store page to send a browser to anyway.
    if (Platform.OS === 'web') return false;

    const current = Constants.expoConfig?.version;
    if (!current) return false;

    const { data, error } = await withTimeout(
      supabase.from('app_config').select('value').eq('key', 'min_supported_version').maybeSingle(),
      CONFIG_TIMEOUT_MS,
    );
    if (error || !data) return false;

    const byPlatform = data.value as Record<string, unknown> | null;
    const min = byPlatform?.[Platform.OS];
    if (typeof min !== 'string' || min.length === 0) return false;

    return compareVersions(current, min) < 0;
  } catch {
    return false;
  }
}
