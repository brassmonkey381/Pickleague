import React, { useState } from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
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
        <View style={styles.titleRow}>
          <Icon name="mail" size={18} color={c.primary} />
          <Text style={[styles.sentTitle, { color: c.text }]}>Check your email</Text>
        </View>
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
      <Button size="sm" title="Claim this account" onPress={onPress} loading={busy} style={styles.btn} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: SPACE.lg,
    marginTop: SPACE.md,
    padding: SPACE.lg,
    borderRadius: RADIUS.lg,
    borderWidth: HAIRLINE,
    alignItems: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  title: { fontSize: FONT.size.lg, fontWeight: FONT.weight.heavy },
  body: { fontSize: FONT.size.sm, marginTop: SPACE.xs, textAlign: 'center', lineHeight: 17 },
  btn: { marginTop: SPACE.sm, alignSelf: 'center' },
  sentTitle: { fontSize: FONT.size.lg, fontWeight: FONT.weight.heavy },
  sentBody: { fontSize: FONT.size.sm, marginTop: SPACE.xs, textAlign: 'center', lineHeight: 17 },
});
