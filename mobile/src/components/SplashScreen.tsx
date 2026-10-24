import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Easing } from 'react-native';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { BallIcon } from './PickleIcons';

// The splash is designed brand art, the same in light and dark (like the
// chartreuse BallIcon on it), so its colours are fixed rather than theme
// tokens. LaunchUpdateHost draws a still of this screen's last frame, so it
// imports these instead of keeping a copy that has to match.
export const SPLASH = {
  green: '#1b5e20',
  text: '#ffffff',
  tagline: 'rgba(255,255,255,0.7)',
  /** LaunchUpdateGate's "Looking for updates…" line. */
  status: 'rgba(255,255,255,0.85)',
} as const;

/** Ball, title and tagline, shared with LaunchUpdateHost's still. */
export const splashStyles = StyleSheet.create({
  ball:    { marginBottom: SPACE.xl },
  // The wordmark: a logo size, deliberately off the type scale.
  title:   { fontSize: 36, fontWeight: FONT.weight.black, color: SPLASH.text, letterSpacing: 6, textTransform: 'uppercase' },
  tagline: { fontSize: FONT.size.md, color: SPLASH.tagline, marginTop: SPACE.md, letterSpacing: 1 },
});

type Props = { onDone: () => void; minMs: number };

export default function SplashScreen({ onDone, minMs }: Props) {
  const bounce        = useRef(new Animated.Value(0)).current;
  const titleOpacity  = useRef(new Animated.Value(0)).current;
  const titleScale    = useRef(new Animated.Value(0.85)).current;
  const tagOpacity    = useRef(new Animated.Value(0)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Ball bounce loop
    Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: -28,
          duration: 420,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: 380,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    ).start();

    // Title fade+scale in
    Animated.parallel([
      Animated.timing(titleOpacity, {
        toValue: 1,
        duration: 500,
        delay: 250,
        useNativeDriver: true,
      }),
      Animated.timing(titleScale, {
        toValue: 1,
        duration: 500,
        delay: 250,
        easing: Easing.out(Easing.back(1.5)),
        useNativeDriver: true,
      }),
    ]).start();

    // Tagline fades in after title
    Animated.timing(tagOpacity, {
      toValue: 1,
      duration: 450,
      delay: 750,
      useNativeDriver: true,
    }).start();

    // After minMs, fade out screen and call onDone
    const timer = setTimeout(() => {
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start(() => onDone());
    }, minMs);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: screenOpacity }]}>
      <Animated.View style={[splashStyles.ball, { transform: [{ translateY: bounce }] }]}>
        <BallIcon size={72} />
      </Animated.View>
      <Animated.Text
        style={[splashStyles.title, { opacity: titleOpacity, transform: [{ scale: titleScale }] }]}
      >
        PICKLEAGUE
      </Animated.Text>
      <Animated.Text style={[splashStyles.tagline, { opacity: tagOpacity }]}>
        More fun. More frequent. More fair.
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: SPLASH.green,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
});
