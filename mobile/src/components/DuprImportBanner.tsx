import React, { useCallback, useEffect, useState } from 'react';
import { Text, StyleSheet, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';

type Match = {
  dupr_id: string | null;
  club_name: string | null;
  full_name: string | null;
  singles: number | null;
  doubles: number | null;
};

/**
 * "We found your DUPR rating — import it?" nudge.
 *
 * Shown only when the signed-in user's CONFIRMED email appears on an imported
 * DUPR club roster (see public.my_dupr_match). Everything is opt-in: we never
 * mail anyone, and nothing is written until the player taps Import.
 *
 * The RPC is scoped server-side to the caller's own confirmed address and
 * returns name/club/ratings only — never contact details — so there is nothing
 * sensitive to render here.
 *
 * Rendered inline near the top of Home, same as GuestUpgradeBanner.
 */
export default function DuprImportBanner() {
  const { colors: c } = useTheme();
  const [match, setMatch] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Same auth-lock hazard as GuestUpgradeBanner: never call a supabase.auth
    // method inside onAuthStateChange — it deadlocks. `supabase.rpc` is
    // lock-free, but we still defer with setTimeout to stay off the lock.
    async function check(userId: string | undefined) {
      if (!userId) { if (!cancelled) setMatch(null); return; }
      const { data, error } = await supabase.rpc('my_dupr_match');
      if (cancelled || error) return;
      const row: Match | undefined = Array.isArray(data) ? data[0] : data;
      // Only offer it when there is actually a rating to carry over.
      setMatch(row && (row.doubles != null || row.singles != null) ? row : null);
    }

    supabase.auth.getSession().then(({ data: { session } }) => check(session?.user?.id));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      const id = session?.user?.id;
      setTimeout(() => check(id), 0);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const onImport = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('import_my_dupr_rating');
    setBusy(false);
    if (error) return;
    if (data?.ok) {
      setDone(`PLUPR set to ${Number(data.rating).toFixed(2)}`);
      setMatch(null);
    } else {
      // has_match_history / already_imported / no_match — stop offering either way.
      setMatch(null);
    }
  }, []);

  if (done) {
    return (
      <View style={[styles.banner, { backgroundColor: c.primary }]}>
        <Text style={styles.title}>✅  DUPR rating imported</Text>
        <Text style={styles.sub}>{done}</Text>
      </View>
    );
  }

  if (!match) return null;

  const rating = match.doubles ?? match.singles;

  return (
    <View style={[styles.banner, { backgroundColor: c.primary }]}>
      <Text style={styles.title}>🎾  We found your DUPR rating</Text>
      <Text style={styles.sub}>
        {match.club_name ? `${match.club_name} — ` : ''}
        {Number(rating).toFixed(2)} doubles. Start your PLUPR here?
      </Text>
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={busy}
          style={[styles.btn, { backgroundColor: '#fff' }]}
          onPress={onImport}
        >
          {busy
            ? <ActivityIndicator size="small" color={c.primary} />
            : <Text style={[styles.btnText, { color: c.primary }]}>Import</Text>}
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.85} style={styles.dismiss} onPress={() => setMatch(null)}>
          <Text style={styles.dismissText}>Not me</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 16,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '800' },
  sub: { color: '#fff', fontSize: 12, marginTop: 2, opacity: 0.95, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 12 },
  btn: { paddingVertical: 7, paddingHorizontal: 22, borderRadius: 8 },
  btnText: { fontSize: 14, fontWeight: '800' },
  dismiss: { paddingVertical: 7, paddingHorizontal: 10 },
  dismissText: { color: '#fff', fontSize: 13, fontWeight: '600', opacity: 0.9 },
});
