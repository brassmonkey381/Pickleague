// Court presence privacy, server side: "who sees me at the courts", the pause,
// the one-time consent and the hide-from list. Wrappers over the RPCs in
// docs/play-sessions-presence-api.md ("Privacy settings"). The settings row is
// owner-only with no write policies, so every write goes through
// set_presence_settings, which returns the full row; that row is written
// straight into the shared cache, so the Settings rows, the pause chip and the
// consent sheet all re-render from one write.
//
// A missing row means the defaults, resolved in SQL; normalizePresenceSettings
// fills any field the jsonb leaves out, so nothing reads `undefined`.
import { useMemo } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import {
  cachedFetch,
  invalidateQueries,
  setQueryData,
  useCachedQuery,
} from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';
import {
  normalizePresenceSettings,
  type CheckinsLevel,
  type PlansLevel,
  type PresenceSettings,
} from '../lib/presencePrivacy';

export const PRESENCE_SETTINGS_KEY = 'me:presenceSettings';
export const PRESENCE_HIDDEN_KEY = 'me:presenceHidden';

/** Settings change rarely, and only from this account: a long TTL is safe. */
const SETTINGS_TTL_MS = 5 * 60_000;
const HIDDEN_TTL_MS = 60_000;
const PERSIST_MS = 7 * 24 * 60 * 60 * 1000;

const BOUND = { timeoutMs: 9_000 };

export type PresenceHiddenPlayer = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

export async function getMyPresenceSettings(): Promise<PresenceSettings> {
  return normalizePresenceSettings(await sbCall(() => supabase.rpc('get_my_presence_settings'), BOUND));
}

/** Cached read; `force` bypasses the TTL (the consent check before a check-in). */
export function loadPresenceSettings(force = false): Promise<PresenceSettings> {
  return cachedFetch(PRESENCE_SETTINGS_KEY, getMyPresenceSettings, {
    ttlMs: force ? 0 : SETTINGS_TTL_MS,
    persistMs: PERSIST_MS,
  });
}

export function usePresenceSettings(enabled = true) {
  return useCachedQuery<PresenceSettings>(PRESENCE_SETTINGS_KEY, getMyPresenceSettings, {
    ttlMs: SETTINGS_TTL_MS,
    persistMs: PERSIST_MS,
    enabled,
  });
}

/**
 * Change one or more settings; fields left out stay as they are. `pausedUntil`
 * pauses until then; `clearPause` ends a pause now; `consentSeen` records the
 * consent sheet. The returned row replaces the cached one.
 */
export async function setPresenceSettings(p: {
  checkinsLevel?: CheckinsLevel;
  plansLevel?: PlansLevel;
  pausedUntil?: string;
  clearPause?: boolean;
  consentSeen?: boolean;
}): Promise<PresenceSettings> {
  const row = normalizePresenceSettings(
    await sbCall(
      () =>
        supabase.rpc('set_presence_settings', {
          p_checkins_level: p.checkinsLevel ?? null,
          p_plans_level: p.plansLevel ?? null,
          p_paused_until: p.pausedUntil ?? null,
          p_clear_pause: p.clearPause ?? false,
          p_consent_seen: p.consentSeen ?? false,
        }),
      BOUND,
    ),
  );
  setQueryData(PRESENCE_SETTINGS_KEY, row);
  return row;
}

export async function listPresenceHidden(): Promise<PresenceHiddenPlayer[]> {
  return ((await sbCall(() => supabase.rpc('list_presence_hidden'), BOUND)) ?? []) as PresenceHiddenPlayer[];
}

export function usePresenceHidden(enabled = true) {
  return useCachedQuery<PresenceHiddenPlayer[]>(PRESENCE_HIDDEN_KEY, listPresenceHidden, {
    ttlMs: HIDDEN_TTL_MS,
    persistMs: PERSIST_MS,
    enabled,
  });
}

/** Ids I hide my presence from, for menus (same cache as the Settings list). */
export function usePresenceHiddenIds(enabled = true): Set<string> {
  const { data } = usePresenceHidden(enabled);
  return useMemo(() => new Set((data ?? []).map((r) => r.user_id)), [data]);
}

/** Hide (or stop hiding) my presence from one player. Idempotent. */
export async function hidePresenceFrom(userId: string, hidden: boolean): Promise<boolean> {
  const ok = (await sbCall(
    () => supabase.rpc('hide_presence_from', { p_user: userId, p_hidden: hidden }),
    BOUND,
  )) as boolean;
  invalidateQueries(PRESENCE_HIDDEN_KEY);
  return ok;
}
