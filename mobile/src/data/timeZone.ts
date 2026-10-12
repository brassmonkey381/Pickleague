// The signed-in player's IANA time zone, for times the server prints in push
// bodies and for drill session start times (supabase/migration_time_zones.sql).
//
// Best-effort and bounded: called after sign-in, never throws, never blocks a
// screen. Writes only when the zone changed for this user (remembered per user),
// so a normal launch costs no round trip.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceTimeZone } from '@just-messin-around/expo-foundation/platform/push';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

const KEY = 'pickleague_tz_synced_v1';

export async function syncMyTimeZone(): Promise<void> {
  try {
    const tz = deviceTimeZone();
    if (!tz) return;
    // LOCAL session read, never getUser().
    const uid = await currentUserId(supabase);
    if (!uid) return;
    const marker = `${uid}:${tz}`;
    if ((await AsyncStorage.getItem(KEY).catch(() => null)) === marker) return;
    const ok = await sbCall(() => supabase.rpc('set_pickleague_time_zone', { p_tz: tz }), {
      retries: 1,
      timeoutMs: 8_000,
    });
    // false = the server refused the zone; don't retry it every launch.
    if (ok === true || ok === false) await AsyncStorage.setItem(KEY, marker).catch(() => {});
  } catch {
    // Not critical: the server falls back to America/Los_Angeles.
  }
}
