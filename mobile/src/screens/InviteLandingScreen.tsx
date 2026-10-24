// www.pickleague.club/invite/CODE (Doggle's InviteLandingScreen): who invited
// you, what you both get, and the way in. Registered only while
// REFERRALS_ENABLED is on, in both stacks (a signed-in member tapping a
// friend's link lands here too, and is sent on to Home).
//
// The code itself is captured by ReferralHost (it sees every launch URL and
// records the click for deferred matching); this screen stashes it again,
// defensively, for a navigation that arrived without a URL event.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { normalizeReferralCode } from '@just-messin-around/expo-foundation/referrals';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { REFERRAL_REWARD_PICKLES } from '../lib/referralRules';
import { getReferralPreview, referralStash, type ReferralPreview } from '../data/referrals';
import GetTheAppButton from '../components/GetTheAppButton';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'InviteLanding'>;

const ICON = require('../../assets/icon.png');

export default function InviteLandingScreen({ route, navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const code = normalizeReferralCode(route.params?.code) ?? '';

  const [preview, setPreview] = useState<ReferralPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    if (code) void referralStash.put(code);
    void currentUserId(supabase).then((id) => active && setSignedIn(!!id)).catch(() => active && setSignedIn(false));
    getReferralPreview(code)
      .then((p) => active && setPreview(p))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [code]);

  const name = preview?.referrer_name?.trim() || '';
  const title = name ? `${name} invited you to Pickleague` : "You're invited to Pickleague";

  // Not typed as reachable from both stacks, so navigate by name loosely.
  const go = (screen: 'Register' | 'Login' | 'Home') => (navigation as unknown as { navigate: (s: string) => void }).navigate(screen);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={styles.scroll}>
      <View style={styles.container}>
        <View style={[styles.hero, { backgroundColor: c.primaryLight }]}>
          {loading ? (
            <ActivityIndicator color={c.primary} style={styles.spinner} />
          ) : (
            <>
              {preview?.avatar_url ? (
                <Image source={{ uri: preview.avatar_url }} style={styles.avatar} accessibilityIgnoresInvertColors />
              ) : preview?.avatar_emoji ? (
                <View style={[styles.avatar, styles.emojiAvatar, { backgroundColor: preview.avatar_bg_color || c.surface }]}>
                  <Text style={styles.emoji}>{preview.avatar_emoji}</Text>
                </View>
              ) : (
                <Image source={ICON} style={styles.avatar} />
              )}
              <Text style={[t.h1, styles.center]}>{title}</Text>
              <Text style={[t.body, styles.center, styles.gap, { color: c.textSub }]}>
                Track your matches and PLUPR rating, join leagues and tournaments, and find people to play with at your courts.
              </Text>
              <Text style={[t.title, styles.center, styles.gap, { color: c.primary }]}>
                Sign up with this invite and you both get {REFERRAL_REWARD_PICKLES} pickles
              </Text>
            </>
          )}
        </View>

        {signedIn ? (
          <View style={styles.ctas}>
            <Text style={[t.sub, styles.center]}>
              You're already signed in. Invites count for accounts made in the last 30 days, and are applied automatically.
            </Text>
            <Button title="Go to Pickleague" onPress={() => go('Home')} style={styles.btn} />
          </View>
        ) : (
          <View style={styles.ctas}>
            <Button title="Create a free account" onPress={() => go('Register')} style={styles.btn} />
            <Button title="I already have an account" variant="outline" onPress={() => go('Login')} style={styles.btn} />
            {Platform.OS === 'web' ? <GetTheAppButton from="invite_landing" style={styles.getApp} /> : null}
            <Text style={[t.sub, styles.center, styles.gap]}>
              Confirm your email after signing up and the {REFERRAL_REWARD_PICKLES} pickles land in both accounts.
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  container: { width: '100%', maxWidth: 560, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xl },
  hero: { borderRadius: RADIUS.lg, padding: SPACE.xl, alignItems: 'center' },
  spinner: { marginVertical: SPACE.xl },
  avatar: { width: 96, height: 96, borderRadius: RADIUS.pill, marginBottom: SPACE.lg },
  emojiAvatar: { alignItems: 'center', justifyContent: 'center' },
  // The referrer's own avatar emoji (user content), at half the 96 circle.
  emoji: { fontSize: 48 },
  center: { textAlign: 'center' },
  gap: { marginTop: SPACE.md },
  ctas: { marginTop: SPACE.lg, gap: SPACE.sm },
  btn: { alignSelf: 'stretch' },
  getApp: { alignSelf: 'center', marginTop: SPACE.xs },
});
