import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

/**
 * Toast shown when the signed-in user earns a new badge. The hook subscribes
 * to `public.player_badges` realtime inserts filtered by user_id, fetches the
 * matching `badges` row to populate icon + name, and auto-dismisses each toast
 * after AUTO_DISMISS_MS.
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

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;

      channel = supabase
        .channel(`badge-toasts-${user.id}`)
        .on(
          // Cast: supabase-js typings for realtime args are loose; this matches docs.
          'postgres_changes' as any,
          {
            event: 'INSERT',
            schema: 'public',
            table: 'player_badges',
            filter: `user_id=eq.${user.id}`,
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
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
      timersRef.current.forEach(t => clearTimeout(t));
      timersRef.current.clear();
    };
  }, [enqueueToast]);

  return { toasts, dismissToast };
}
