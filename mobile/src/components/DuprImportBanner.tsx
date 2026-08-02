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
  /** Set when the roster row is held by an unclaimed placeholder we'd absorb. */
  placeholder_profile: string | null;
};

type ClaimResult = {
  ok: boolean;
  reason?: string;
  rating?: number | null;
  /** False when the player already had match history — link only, rating kept. */
  rating_applied?: boolean;
  absorbed_placeholder?: boolean;
  placeholder_kept?: boolean;
};

/**
 * Why a claim came back not-ok, in the player's words. Every one of these is
 * terminal — the banner stops offering rather than silently retrying forever.
 */
function refusalMessage(reason: string | undefined): string {
  switch (reason) {
    case 'already_claimed':
      return 'That DUPR profile is already linked to another Pickleague account.';
    case 'email_not_confirmed':
      return 'Confirm your email address first, then we can link your DUPR profile.';
    case 'no_match':
      return 'We could not find your DUPR profile any more — it may have been re-synced.';
    default:
      return 'We could not link your DUPR profile. Try again later.';
  }
}

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
 * Both answers are PERSISTED (profiles.dupr_import_dismissed_at, filtered by
 * my_dupr_match). Hiding in component state alone meant the banner returned on
 * every reload, which is exactly what it did in production: an account with match
 * history could never claim, and the refusal was swallowed silently.
 *
 * Rendered inline near the top of Home, same as GuestUpgradeBanner.
 */
export default function DuprImportBanner() {
  const { colors: c } = useTheme();
  const [match, setMatch] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

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
    if (error) {
      setFailed('Something went wrong linking your DUPR profile. Try again later.');
      return;
    }
    const result = data as ClaimResult | null;
    if (result?.ok) {
      // Linking always happens; the rating is only ever a SEED for an account
      // with no matches yet, so say which one the player actually got.
      setDone(
        result.rating_applied
          ? `PLUPR set to ${Number(result.rating).toFixed(2)}`
          : 'DUPR profile linked. Your PLUPR is unchanged — it is earned from matches you have played here.',
      );
      setMatch(null);
      return;
    }
    // Every refusal is terminal. Say why and record the dismissal, or the banner
    // returns on the next reload and the player is stuck in a loop.
    setFailed(refusalMessage(result?.reason));
    setMatch(null);
    void supabase.rpc('dismiss_dupr_import');
  }, []);

  const onDismiss = useCallback(async () => {
    setMatch(null);
    // Persisted server-side — component state alone does not survive a reload.
    await supabase.rpc('dismiss_dupr_import');
  }, []);

  if (done) {
    return (
      <View style={[styles.banner, { backgroundColor: c.primary }]}>
        <Text style={styles.title}>✅  DUPR profile linked</Text>
        <Text style={styles.sub}>{done}</Text>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={[styles.banner, { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.text }]}>DUPR link unavailable</Text>
        <Text style={[styles.sub, { color: c.textSub }]}>{failed}</Text>
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
        <TouchableOpacity activeOpacity={0.85} style={styles.dismiss} onPress={onDismiss}>
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
