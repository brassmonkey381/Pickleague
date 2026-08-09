import { useCallback, useEffect, useRef, useState } from 'react';
import {
  manageChannel,
  sbCall,
  currentUserId,
  type RealtimeChannelStatus,
} from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

/**
 * Toast shown when the signed-in user earns a new badge. The hook subscribes
 * to `public.player_badges` realtime inserts filtered by user_id, fetches the
 * matching `badges` row to populate icon + name, and auto-dismisses each toast
 * after AUTO_DISMISS_MS.
 *
 * The channel is managed by the kit's manageChannel (the primitive behind
 * useRealtimeChannel), so it self-heals: it re-joins automatically when the
 * network comes back or the app returns to the foreground, instead of silently
 * staying dead after a socket drop. manageChannel is used directly (rather
 * than the hook wrapper) because we only subscribe once the session lookup
 * resolves a user id.
 *
 * Re-joining alone isn't enough, though: postgres_changes has no replay, so a
 * badge earned while the socket was dead is never delivered — it would be lost
 * for good, since nothing else in the app surfaces it. Every (re)subscribe
 * therefore runs a catch-up query for badges earned since the last one we saw.
 */
export type BadgeToastItem = {
  id: string;            // player_badges.id
  badgeId: string;
  name: string;
  icon: string;
};

const AUTO_DISMISS_MS = 4000;

/** Cap on a single catch-up: a long offline stint shouldn't dump 50 toasts. */
const BACKFILL_LIMIT = 5;

export function useBadgeNotifications() {
  const [toasts, setToasts] = useState<BadgeToastItem[]>([]);
  // Track per-toast dismiss timers so we can clear them on manual dismiss.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // player_badges ids already toasted this session. Without it, a catch-up that
  // overlaps a realtime insert would toast the same badge twice.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Only badges earned after this instant are ours to announce; advanced as we
  // see them so a reconnect doesn't replay the whole session.
  const sinceRef = useRef<string>(new Date().toISOString());

  const dismissToast = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(x => x.id !== id));
  }, []);

  const enqueueToast = useCallback((item: BadgeToastItem) => {
    if (seenIdsRef.current.has(item.id)) return;
    seenIdsRef.current.add(item.id);
    setToasts(prev => (prev.some(x => x.id === item.id) ? prev : [...prev, item]));
    const timer = setTimeout(() => {
      timersRef.current.delete(item.id);
      setToasts(prev => prev.filter(x => x.id !== item.id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(item.id, timer);
  }, []);

  // Resolve the signed-in user before subscribing (realtime filter needs it).
  // LOCAL session read — getUser() is a network call, so on a bad connection
  // this resolved null and the user got no badge toasts at all that session.
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    currentUserId(supabase).then(id => {
      if (!cancelled) setUserId(id);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!userId) return;
    const uid = userId;
    let stopped = false;

    /** Announce anything earned while we weren't listening. */
    async function backfill() {
      const since = sinceRef.current;
      const startedAt = new Date().toISOString();
      try {
        const rows = await sbCall(() =>
          supabase
            .from('player_badges')
            .select('id, badge_id, earned_at, badge:badges(name, icon)')
            .eq('user_id', uid)
            .gt('earned_at', since)
            .order('earned_at', { ascending: true })
            .limit(BACKFILL_LIMIT),
        );
        if (stopped) return;
        for (const row of (rows ?? []) as any[]) {
          // PostgREST embeds are typed loosely (object or single-element array).
          const badge = Array.isArray(row.badge) ? row.badge[0] : row.badge;
          if (!badge) continue;
          enqueueToast({ id: row.id, badgeId: row.badge_id, name: badge.name, icon: badge.icon });
        }
        // Only advance on success — a failed catch-up must stay retryable, or
        // the badge it missed is gone forever.
        sinceRef.current = startedAt;
      } catch {
        // The next rejoin (or the next status change) tries again.
      }
    }

    const managed = manageChannel(
      supabase,
      `badge-toasts-${uid}`,
      ch =>
        ch.on(
          // Cast: supabase-js typings for realtime args are loose; this matches docs.
          'postgres_changes' as any,
          {
            event: 'INSERT',
            schema: 'public',
            table: 'player_badges',
            filter: `user_id=eq.${uid}`,
          },
          async (payload: any) => {
            const row = payload?.new;
            if (!row?.id || !row?.badge_id) return;
            if (seenIdsRef.current.has(row.id)) return;
            try {
              const badge = await sbCall(() =>
                supabase.from('badges').select('name, icon').eq('id', row.badge_id).maybeSingle(),
              );
              if (!badge || stopped) return;
              enqueueToast({
                id: row.id,
                badgeId: row.badge_id,
                name: badge.name,
                icon: badge.icon,
              });
            } catch {
              // Couldn't resolve the badge's name/icon. Leave `since` alone so
              // the next catch-up re-announces it rather than dropping it.
            }
            if (row.earned_at && row.earned_at > sinceRef.current) {
              sinceRef.current = row.earned_at;
            }
          },
        ),
      {
        // The status was previously discarded, which is why nothing ever
        // noticed a dead socket — or filled the gap once it came back.
        onStatus: (status: RealtimeChannelStatus) => {
          if (status === 'subscribed') void backfill();
        },
      },
    );

    return () => {
      stopped = true;
      managed.stop();
    };
  }, [userId, enqueueToast]);

  // Clear any pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return { toasts, dismissToast };
}
