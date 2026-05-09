import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing } from 'react-native';

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
      <Animated.Text style={[styles.ball, { transform: [{ translateY: bounce }] }]}>
        🎾
      </Animated.Text>
      <Animated.Text
        style={[styles.title, { opacity: titleOpacity, transform: [{ scale: titleScale }] }]}
      >
        PICKLEAGUE
      </Animated.Text>
      <Animated.Text style={[styles.tagline, { opacity: tagOpacity }]}>
        More fun. More frequent. More fair.
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1b5e20',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  ball:    { fontSize: 72, marginBottom: 24 },
  title:   { fontSize: 36, fontWeight: '900', color: '#ffffff', letterSpacing: 6, textTransform: 'uppercase' },
  tagline: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 12, letterSpacing: 1 },
});
