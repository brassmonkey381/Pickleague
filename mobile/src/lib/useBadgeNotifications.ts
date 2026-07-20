import { useCallback, useEffect, useRef, useState } from 'react';
import { manageChannel } from '@just-messin-around/expo-foundation/supabase';
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
 * than the hook wrapper) because we only subscribe once the async
 * auth.getUser() lookup resolves a user id.
 */
export type BadgeToastItem = {
  id: string;            // player_badges.id
  badgeId: string;
  name: string;
  icon: string;
};

const AUTO_DISMISS_MS = 4000;

export function useBadgeNotifications() {
  const [toasts, setToasts] = useState<BadgeToastItem[]>([]);
  // Track per-toast dismiss timers so we can clear them on manual dismiss.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(x => x.id !== id));
  }, []);

  const enqueueToast = useCallback((item: BadgeToastItem) => {
    setToasts(prev => (prev.some(x => x.id === item.id) ? prev : [...prev, item]));
    const timer = setTimeout(() => {
      timersRef.current.delete(item.id);
      setToasts(prev => prev.filter(x => x.id !== item.id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(item.id, timer);
  }, []);

  // Resolve the signed-in user before subscribing (realtime filter needs it).
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!cancelled) setUserId(user?.id ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!userId) return;

    const managed = manageChannel(supabase, `badge-toasts-${userId}`, ch =>
      ch.on(
        // Cast: supabase-js typings for realtime args are loose; this matches docs.
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'player_badges',
          filter: `user_id=eq.${userId}`,
        },
        async (payload: any) => {
          const row = payload?.new;
          if (!row?.id || !row?.badge_id) return;
          const { data: badge } = await supabase
            .from('badges')
            .select('name, icon')
            .eq('id', row.badge_id)
            .maybeSingle();
          if (!badge) return;
          enqueueToast({
            id: row.id,
            badgeId: row.badge_id,
            name: badge.name,
            icon: badge.icon,
          });
        },
      ),
    );

    return () => managed.stop();
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
