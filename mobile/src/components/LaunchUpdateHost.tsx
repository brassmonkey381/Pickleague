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
// The still is the splash's last frame: its colours and styles come from the
// splash itself (brand art, theme-invariant), so the two cannot drift apart.
import { SPLASH, splashStyles } from './SplashScreen';
import { playSession } from '../lib/playSession';

// Just under components/SplashScreen (its container sits at zIndex 999).
const UNDER_SPLASH = 998;
// Ball 72 + 24 gap + title ~44 + 12 gap + tagline ~18.
const MARK_HEIGHT = 170;

const canApply = () => playSession.get().status === 'idle';

function SplashStill() {
  return (
    <View style={styles.mark}>
      <View style={splashStyles.ball}>
        <BallIcon size={72} />
      </View>
      <Text style={splashStyles.title}>PICKLEAGUE</Text>
      <Text style={splashStyles.tagline}>More fun. More frequent. More fair.</Text>
    </View>
  );
}

export default function LaunchUpdateHost() {
  return (
    <LaunchUpdateGate
      backgroundColor={SPLASH.green}
      mark={<SplashStill />}
      markHeight={MARK_HEIGHT}
      zIndex={UNDER_SPLASH}
      textColor={SPLASH.status}
      canApply={canApply}
    />
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center' },
});
