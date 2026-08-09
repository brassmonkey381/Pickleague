import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Claim'> };

/**
 * Landing screen for the magic link sent by the request-claim edge function
 * (deep link: https://pickleague.club/claim).
 *
 * By the time we get here Supabase has already signed the person in, which is
 * the whole proof: only the owner of the DUPR address on file could have opened
 * that link. All that's left is to fold the placeholder profile into their
 * account, which claim_my_dupr_profile() does server-side.
 *
 * Every failure mode is a plain `ok:false` + reason rather than an exception, so
 * this screen just maps reasons to copy.
 */
const REASON_COPY: Record<string, string> = {
  email_not_confirmed: "Your email isn't confirmed yet. Open the link from the email we sent.",
  no_match: "We couldn't find a DUPR roster entry for this email address.",
  already_claimed: 'That player has already been claimed by another account.',
  has_match_history:
    "Your account already has match history, so we didn't overwrite your PLUPR. Nothing was changed.",
};

export default function ClaimAccountScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const [state, setState] = useState<'working' | 'done' | 'failed' | 'signed-out'>('working');
  const [message, setMessage] = useState('');

  // Every exit from `working` has to be reachable, including the ones nobody
  // planned for: the only escape button on this screen is gated on state, so a
  // hang or a throw here strands the very first screen a claim user ever sees
  // with a spinner and no way off. Hence the try/catch AND the bounded call.
  const run = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setState('signed-out'); return; }

      const data = await sbCall(() => supabase.rpc('claim_my_dupr_profile')) as
        { ok?: boolean; reason?: string; rating?: number | null; club?: string | null } | null;
      if (data?.ok) {
        setState('done');
        setMessage(
          data.rating != null
            ? `Your PLUPR starts at ${Number(data.rating).toFixed(2)}${data.club ? `, from ${data.club}` : ''}.`
            : 'Your account is claimed.',
        );
        return;
      }
      setState('failed');
      setMessage((data?.reason && REASON_COPY[data.reason]) ?? 'This claim link is no longer valid.');
    } catch (e) {
      setState('failed');
      setMessage(friendlySbMessage(
        e,
        'Something went wrong finishing the claim. Please try the link again.',
        { network: "We couldn't reach Pickleague. Check your connection and open the link again." },
      ));
    }
  }, []);

  useEffect(() => { run(); }, [run]);

  return (
    <View style={[styles.container, { backgroundColor: c.bg }]}>
      {state === 'working' && (
        <>
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={[styles.title, { color: c.text }]}>Finishing your claim…</Text>
        </>
      )}

      {state === 'done' && (
        <>
          <Text style={styles.emoji}>🎉</Text>
          <Text style={[styles.title, { color: c.text }]}>Account claimed</Text>
          <Text style={[styles.body, { color: c.textSub }]}>{message}</Text>
        </>
      )}

      {state === 'failed' && (
        <>
          <Text style={styles.emoji}>🤔</Text>
          <Text style={[styles.title, { color: c.text }]}>We couldn't finish that</Text>
          <Text style={[styles.body, { color: c.textSub }]}>{message}</Text>
        </>
      )}

      {state === 'signed-out' && (
        <>
          <Text style={styles.emoji}>🔑</Text>
          <Text style={[styles.title, { color: c.text }]}>Open the link from your email</Text>
          <Text style={[styles.body, { color: c.textSub }]}>
            The sign-in link has to be opened on this device so we know it's you.
          </Text>
        </>
      )}

      {state !== 'working' && (
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.btn, { backgroundColor: c.primary }]}
          onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })}
        >
          <Text style={styles.btnText}>Go to Pickleague</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  emoji: { fontSize: 44 },
  title: { fontSize: 19, fontWeight: '800', marginTop: 14, textAlign: 'center' },
  body: { fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  btn: { marginTop: 26, paddingVertical: 12, paddingHorizontal: 30, borderRadius: 10 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
