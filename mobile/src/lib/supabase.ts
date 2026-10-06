// The Supabase client setup moved to @just-messin-around/expo-foundation. This file stays as
// the app's configured singleton — it injects the app's own env vars — so all
// existing `import { supabase } from '../lib/supabase'` call sites are unchanged.
//
// It is also where the foundation's network-resilience stack is switched on.
// This module is imported by every screen, so configuring here guarantees the
// cache and queue are ready before the first `cachedFetch` runs.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSupabase, bindQueryCacheToAuth, readSessionHint } from '@just-messin-around/expo-foundation/supabase';
import {
  configureQueryCachePersistence,
  configureMutationQueue,
} from '@just-messin-around/expo-foundation/cache';

export const supabase = createSupabase(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    // Hardware-backed session storage on native (expo-secure-store + expo-crypto
    // + aes-js). Falls back to AsyncStorage on web, and migrates any existing
    // plaintext session in place on first read — users stay signed in.
    secure: true,
    // Refuse to delete the stored session while confidently offline. Gym and
    // hotel WiFi behind a captive portal answers the token refresh with HTML;
    // supabase-js reads that as a non-retryable auth failure and wipes the
    // session, logging the user out on the very network that's failing — with
    // no way to sign back in. See the foundation's offlineSessionGuard.
    guardOfflineSignOut: true,
    // Transport backstop (foundation 1.20+): every request is aborted after this,
    // so a stalled connection can't hang a screen forever. The default is 60 s;
    // 120 s matches AvatarPickerModal's UPLOAD_TIMEOUT_MS, the one request that
    // can legitimately take that long on a slow link. Screens have tighter
    // budgets of their own (useCachedQuery settles at 20 s).
    requestTimeoutMs: 120_000,
  },
);

// Read the local sign-in hint now, before the client's first auth event. The
// cache binding (bindQueryCacheToAuth, below) checks it synchronously to tell a
// real sign-out from a failed keychain read on a cold start; without it a
// failed read falls back to purging the cache at once (foundation 1.17+).
// AsyncStorage only, never throws, never blocks.
void readSessionHint().catch(() => {});

// On-device query cache. Without this the cache is memory-only, so an offline
// cold start has nothing to show and every screen renders its empty state.
configureQueryCachePersistence({
  storage: AsyncStorage,
  prefix: 'pl:qcache:',
  version: 1,
});

// Queued-write storage. Nothing enqueues yet — which writes are safe to defer is
// a product decision (a match result that lands an hour later still moves PLUPR,
// pickles, and notifications), so they stay fail-loud for now. Configuring here
// means adopting one later is a single `runOrQueue` call.
configureMutationQueue({ storage: AsyncStorage });

// Wipe/re-scope the cache whenever the signed-in user changes, so one account's
// rows can never be served to another, and recover from a dead refresh token.
bindQueryCacheToAuth(supabase, { clearMutationQueueOnUserChange: true });
