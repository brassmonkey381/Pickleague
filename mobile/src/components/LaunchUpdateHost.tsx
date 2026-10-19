// Applies over-the-air updates on its own (foundation 1.49 LaunchUpdateGate),
// replacing the "A Pickleague update is ready. Restart?" banner. The check
// starts on the first frame, behind the animated splash; if it is still going
// when the splash fades, the splash dissolves into this still of its last frame
// with "Looking for updates…" under it. Capped at 5 s (check) and 30 s
// (download); offline or slow, Pickleague opens on what it has. After 30+ min
// away a resume checks again, but never during a play session: a reload then
// would interrupt the session on screen.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LaunchUpdateGate } from '@just-messin-around/expo-foundation/ui';
import { BallIcon } from './PickleIcons';
import { playSession } from '../lib/playSession';

// MUST MATCH components/SplashScreen (its container sits at zIndex 999).
const SPLASH_GREEN = '#1b5e20';
const UNDER_SPLASH = 998;
// Ball 72 + 24 gap + title ~44 + 12 gap + tagline ~18.
const MARK_HEIGHT = 170;

const canApply = () => playSession.get().status === 'idle';

function SplashStill() {
  return (
    <View style={styles.mark}>
      <View style={styles.ball}>
        <BallIcon size={72} />
      </View>
      <Text style={styles.title}>PICKLEAGUE</Text>
      <Text style={styles.tagline}>More fun. More frequent. More fair.</Text>
    </View>
  );
}

export default function LaunchUpdateHost() {
  return (
    <LaunchUpdateGate
      backgroundColor={SPLASH_GREEN}
      mark={<SplashStill />}
      markHeight={MARK_HEIGHT}
      zIndex={UNDER_SPLASH}
      textColor="rgba(255,255,255,0.85)"
      canApply={canApply}
    />
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center' },
  ball: { marginBottom: 24 },
  title: { fontSize: 36, fontWeight: '900', color: '#ffffff', letterSpacing: 6, textTransform: 'uppercase' },
  tagline: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 12, letterSpacing: 1 },
});
