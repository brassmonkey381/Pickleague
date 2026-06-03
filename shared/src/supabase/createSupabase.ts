import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Create a Supabase client configured for Expo (web + native):
 *  - AsyncStorage-backed session persistence + auto token refresh.
 *  - `detectSessionInUrl` on web so email-confirmation / magic-link hashes are
 *    read on landing.
 *
 * The URL and anon key are injected by the consuming app (typically from its
 * own `EXPO_PUBLIC_*` env vars) so this package stays env-agnostic.
 */
export function createSupabase(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  });
}
