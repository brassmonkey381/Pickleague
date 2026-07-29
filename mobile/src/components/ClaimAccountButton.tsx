import React, { useState } from 'react';
import { Text, StyleSheet, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';

type Props = { profileId: string; isUnclaimed?: boolean | null };

/**
 * "Is this you? Claim this account" on a DUPR-seeded placeholder profile.
 *
 * Calls the request-claim edge function, which mails a magic link to the DUPR
 * address on file. We deliberately never render that address — not even masked —
 * because anyone can view this screen, and a partial address is still a leak.
 *
 * The edge function answers identically whether or not the profile is claimable,
 * so the confirmation copy below must stay non-committal ("if that account can be
 * claimed") rather than implying an email definitely went out. Saying otherwise
 * would turn this button into an oracle for who is on the roster.
 */
export default function ClaimAccountButton({ profileId, isUnclaimed }: Props) {
  const { colors: c } = useTheme();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (!isUnclaimed) return null;

  const onPress = async () => {
    setBusy(true);
    // Errors are swallowed on purpose: a failure vs. success distinction here
    // would leak the same thing the opaque server response is protecting.
    try {
      await supabase.functions.invoke('request-claim', { body: { profile_id: profileId } });
    } catch {
      /* ignore */
    }
    setBusy(false);
    setSent(true);
  };

  if (sent) {
    return (
      <View style={[styles.wrap, { borderColor: c.border }]}>
        <Text style={[styles.sentTitle, { color: c.text }]}>📬  Check your email</Text>
        <Text style={[styles.sentBody, { color: c.textSub }]}>
          If that account can be claimed, we've sent a sign-in link to the email on file.
          Open it on this device to finish.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { borderColor: c.border }]}>
      <Text style={[styles.title, { color: c.text }]}>Is this you?</Text>
      <Text style={[styles.body, { color: c.textSub }]}>
        This player was added from a DUPR club roster and hasn't been claimed yet.
        We'll email a sign-in link to the address on file.
      </Text>
      <TouchableOpacity
        activeOpacity={0.85}
        disabled={busy}
        onPress={onPress}
        style={[styles.btn, { backgroundColor: c.primary, opacity: busy ? 0.7 : 1 }]}
      >
        {busy
          ? <ActivityIndicator size="small" color="#fff" />
          : <Text style={styles.btnText}>Claim this account</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 14,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  title: { fontSize: 15, fontWeight: '800' },
  body: { fontSize: 12, marginTop: 4, textAlign: 'center', lineHeight: 17 },
  btn: { marginTop: 12, paddingVertical: 9, paddingHorizontal: 26, borderRadius: 8 },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  sentTitle: { fontSize: 15, fontWeight: '800' },
  sentBody: { fontSize: 12, marginTop: 4, textAlign: 'center', lineHeight: 17 },
});
