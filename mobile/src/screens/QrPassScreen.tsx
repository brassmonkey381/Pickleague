// One saved QR code, as big as the screen allows on white (scanners read
// dark-on-light best, in dark mode too). Opened from the QR wallet or the
// court arrival notice ('wallet/<pass id>').
import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import { getPass, getPassImage, type WalletPass } from '../lib/qrWallet';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'QrPass'>;
  route: RouteProp<RootStackParamList, 'QrPass'>;
};

export default function QrPassScreen({ navigation, route }: Props) {
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
  label: { fontSize: 16, fontWeight: FONT.weight.semibold, color: '#111' },
  all: { alignSelf: 'center' },
});
