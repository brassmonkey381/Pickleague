// One player's achievements for AchievementsScreen and AchievementGroupScreen:
// load on mount, re-read on every later focus (back from a claim, the Shop or
// a match), pull-to-refresh, and the owner's hide-from-profile writes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { currentUserId, friendlySbMessage, sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { loadAchievements, type AchievementsLoad } from './achievementsData';
import type { PickleagueAchievement } from './achievements';

export type UseAchievements = {
  loading: boolean;
  error: string | null;
  data: AchievementsLoad | null;
  /** The signed-in user's own page. */
  own: boolean;
  /** Whose page (resolved: the signed-in user when no userId was passed). */
  userId: string | null;
  reload: () => Promise<void>;
  /** Hide (or show) every instance of an earned achievement on the public profile. */
  setHidden: (a: PickleagueAchievement, hidden: boolean) => Promise<void>;
  /** Hide or show all of them. */
  setAllHidden: (hidden: boolean) => Promise<void>;
};

export function useAchievements(userIdParam: string | undefined, onError?: (msg: string) => void): UseAchievements {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AchievementsLoad | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const userId = userIdParam ?? me;
  const own = !!me && (!userIdParam || userIdParam === me);

  const load = useCallback(async () => {
    // LOCAL session read (getUser() is a round trip that fails offline).
    const uid = await currentUserId(supabase);
    setMe(uid);
    const target = userIdParam ?? uid;
    if (!target) { setLoading(false); return; }
    try {
      setData(await loadAchievements(target, !userIdParam || userIdParam === uid));
      setError(null);
    } catch (e) {
      // An empty page would read as "you've earned nothing"; say it failed.
      setError(friendlySbMessage(e, "Couldn't load achievements."));
    } finally {
      setLoading(false);
    }
  }, [userIdParam]);

  useEffect(() => { void load(); }, [load]);
  const focusCount = useRef(0);
  useFocusEffect(useCallback(() => {
    focusCount.current += 1;
    if (focusCount.current > 1) void load(); // the mount effect covers the first
  }, [load]));

  const setHidden = useCallback(async (a: PickleagueAchievement, hidden: boolean) => {
    const meta = a.meta;
    if (!meta) return;
    try {
      if (meta.kind === 'collectible' && meta.collectible) {
        const id = meta.collectible.id;
        await sbCall(() => supabase.rpc('set_purchase_hidden', { p_purchase_id: id, p_hidden: hidden }));
      } else if (meta.awards.length > 0) {
        const ids = meta.awards.map(w => w.id);
        await sbCall(() => supabase.from('player_badges').update({ is_hidden: hidden }).in('id', ids));
      }
      // Re-read after the write lands, never before: on bad WiFi a badge must
      // not look hidden while the server still shows it.
      await load();
    } catch (e) {
      onError?.(friendlySbMessage(e, `Could not ${hidden ? 'hide' : 'show'} that badge.`));
    }
  }, [load, onError]);

  const setAllHidden = useCallback(async (hidden: boolean) => {
    if (!own || !userId) return;
    try {
      await sbCall(() => supabase.from('player_badges').update({ is_hidden: hidden }).eq('user_id', userId));
      const collectibles = (data?.achievements ?? [])
        .map(a => a.meta?.collectible)
        .filter((c): c is NonNullable<typeof c> => !!c);
      await Promise.all(collectibles.map(c =>
        sbCall(() => supabase.rpc('set_purchase_hidden', { p_purchase_id: c.id, p_hidden: hidden })),
      ));
      await load();
    } catch (e) {
      onError?.(friendlySbMessage(e, `Could not ${hidden ? 'hide' : 'show'} your badges.`));
    }
  }, [own, userId, data, load, onError]);

  return { loading, error, data, own, userId, reload: load, setHidden, setAllHidden };
}
