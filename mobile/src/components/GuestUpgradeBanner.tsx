import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';
import { navigationRef } from '../lib/navigationRef';

/**
 * Persistent bottom nudge for guest (anonymous) accounts: "save your account".
 * Tapping opens the upgrade flow. Re-checks `profiles.is_guest` on every auth
 * state change (including the refreshSession the upgrade screen fires on
 * success), so it disappears once the guest converts. Rendered app-wide from
 * App.tsx beside the other banners.
 */
export default function GuestUpgradeBanner() {
  const { colors: c } = useTheme();
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const { data: { user } } = await supabase.auth.getUser();
      // Only anonymous sessions can be guests — skip the DB query entirely for
      // every normal (non-anonymous) user, on every auth event.
      if (!user || !user.is_anonymous) { if (!cancelled) setIsGuest(false); return; }
      const { data } = await supabase
        .from('profiles')
        .select('is_guest')
        .eq('id', user.id)
        .maybeSingle();
      if (!cancelled) setIsGuest(!!data?.is_guest);
    }
    check();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => check());
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  if (!isGuest) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <TouchableOpacity
        activeOpacity={0.85}
        style={[styles.banner, { backgroundColor: c.primary }]}
        onPress={() => { if (navigationRef.isReady()) navigationRef.navigate('UpgradeAccount'); }}
      >
        <Text style={styles.title}>👋  You're a guest — save your account</Text>
        <Text style={styles.sub}>Add an email & password so you don't lose access  →</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 16,
    zIndex: 9998,
  },
  banner: {
    width: '100%',
    maxWidth: 480,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '800' },
  sub:   { color: '#fff', fontSize: 12, marginTop: 2, opacity: 0.95 },
});
