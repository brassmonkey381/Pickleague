// One saved QR code, as big as the screen allows on white (scanners read
// dark-on-light best, in dark mode too). Opened from the QR wallet or the
// court arrival notice ('wallet/<pass id>'). 'invite' is my invite link,
// drawn as a QR code rather than a saved image.
import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { QrCode } from '@just-messin-around/expo-foundation/ui';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import ShareLinkButton from '../components/ShareLinkButton';
import { supabase } from '../lib/supabase';
import { getPass, getPassImage, INVITE_PASS_ID, inviteUrl, type WalletPass } from '../lib/qrWallet';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'QrPass'>;
  route: RouteProp<RootStackParamList, 'QrPass'>;
};

export default function QrPassScreen({ navigation, route }: Props) {
  return route.params.passId === INVITE_PASS_ID ? <InvitePass navigation={navigation} /> : <SavedPass navigation={navigation} route={route} />;
}

function InvitePass({ navigation }: Pick<Props, 'navigation'>) {
  const { width, height } = useWindowDimensions();
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'My Pickleague invite' });
    void currentUserId(supabase).catch(() => null).then(setMeId);
  }, [navigation]);

  const side = Math.min(width - SPACE.lg * 2, height * 0.5, 420);
  const url = inviteUrl(meId);
  return (
    <View style={styles.screen}>
      <QrCode value={url} size={side} color="#000" backgroundColor="#fff" />
      <Text style={styles.label}>Scan to see my profile and join Pickleague</Text>
      <ShareLinkButton
        url={url}
        title="Join me on Pickleague"
        message="I'm on Pickleague. Add me as a friend so we can see when we're at the courts:"
      />
      <Button title="All QR codes" variant="outline" size="sm" onPress={() => navigation.navigate('QrWallet')} style={styles.all} />
    </View>
  );
}

function SavedPass({ navigation, route }: Props) {
  const { passId } = route.params;
  const { width, height } = useWindowDimensions();
  const [pass, setPass] = useState<WalletPass | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [p, img] = await Promise.all([getPass(passId), getPassImage(passId)]);
      if (!live) return;
      setPass(p);
      setImage(img);
      setLoaded(true);
      if (p) navigation.setOptions({ title: p.venueName });
    })();
    return () => { live = false; };
  }, [passId, navigation]);

  if (loaded && (!pass || !image)) {
    return (
      <View style={styles.missing}>
        <EmptyState
          icon="🎟️"
          title="This QR code isn't on this phone"
          subtitle="It was removed, or saved while signed in to another account."
          actionLabel="Open QR wallet"
          onAction={() => navigation.replace('QrWallet')}
        />
      </View>
    );
  }

  const side = Math.min(width - SPACE.lg * 2, height * 0.6, 520);
  return (
    <View style={styles.screen}>
      {image ? <Image source={{ uri: image }} style={{ width: side, height: side }} resizeMode="contain" accessibilityLabel={pass ? `${pass.label} QR code` : 'QR code'} /> : null}
      {pass ? <Text style={styles.label}>{pass.label}</Text> : null}
      <Button title="All QR codes" variant="outline" size="sm" onPress={() => navigation.navigate('QrWallet')} style={styles.all} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', padding: SPACE.lg, gap: SPACE.lg },
  missing: { flex: 1, justifyContent: 'center', padding: SPACE.lg },
  label: { fontSize: 16, fontWeight: FONT.weight.semibold, color: '#111', textAlign: 'center' },
  all: { alignSelf: 'center' },
});
