// Animated name-style sub-components, used by FlairName in HERO mode only.
// LIST mode degrades animated recipes to their `base` color via
// `degradeForList()` in lib/nameStyles.ts, so these components should never
// be mounted for list rendering.
//
// Restraint policy:
// - Pulse opacity stays in [0.6, 1.0] — visible but not strobing.
// - Rainbow cycles slowly (~4s period).
// - Sparkle uses 2-3 small ✨ glyphs at low max opacity around the name.
// - Typewriter reveals at ~50ms/letter, then locks at full text.
// - Holographic shifts through cyan → magenta → yellow → cyan over ~3s.
//
// All timers and Animated loops are cleaned up on unmount.

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleProp, Text, TextStyle, View } from 'react-native';

type CommonProps = {
  name: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
};

// ── Pulse ──────────────────────────────────────────────────────────────
// Opacity loop 1.0 → 0.6 → 1.0 over ~1.6s. Uses native driver.
// TODO: smoke-test in browser
export function PulseName({
  name,
  color,
  style,
  numberOfLines,
}: CommonProps & { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.6,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity]);

  return (
    <Animated.Text
      style={[style, { color, opacity }]}
      numberOfLines={numberOfLines}
    >
      {name}
    </Animated.Text>
  );
}

// ── Rainbow ────────────────────────────────────────────────────────────
// Color cycles through a hue wheel via setInterval (color isn't natively
// animatable on the UI thread, so we step through stops instead).
// Period ~4s, 6 stops → ~666ms per stop.
// TODO: smoke-test in browser
const RAINBOW_STOPS = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#a855f7', // purple
];

export function RainbowName({ name, style, numberOfLines }: CommonProps) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % RAINBOW_STOPS.length);
    }, 666);
    return () => clearInterval(id);
  }, []);

  return (
    <Text style={[style, { color: RAINBOW_STOPS[idx] }]} numberOfLines={numberOfLines}>
      {name}
    </Text>
  );
}

// ── Sparkle ────────────────────────────────────────────────────────────
// Static name + 3 twinkling ✨ glyphs positioned absolutely around it.
// Each glyph has its own opacity loop at a different phase. Max opacity
// 0.9 so the sparkles don't dominate the name.
// TODO: smoke-test in browser
type SparklePhase = { top: number; left: number | string; delay: number; size: number };
const SPARKLE_PHASES: SparklePhase[] = [
  { top: -6, left: -10, delay: 0,   size: 10 },
  { top: -2, left: '100%', delay: 600, size: 8 },
  { top: 10, left: '50%', delay: 1200, size: 9 },
];

function SparkleGlyph({ phase }: { phase: SparklePhase }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(phase.delay),
        Animated.timing(opacity, {
          toValue: 0.9,
          duration: 500,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 700,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(600),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, phase.delay]);

  return (
    <Animated.Text
      style={{
        position: 'absolute',
        top: phase.top,
        left: phase.left as any,
        fontSize: phase.size,
        opacity,
        // Don't intercept touches — the sparkle is decorative only.
        pointerEvents: 'none',
      }}
    >
      ✨
    </Animated.Text>
  );
}

export function SparkleName({
  name,
  color,
  style,
  numberOfLines,
}: CommonProps & { color: string }) {
  return (
    <View style={{ position: 'relative', alignSelf: 'flex-start' }}>
      <Text style={[style, { color }]} numberOfLines={numberOfLines}>
        {name}
      </Text>
      {SPARKLE_PHASES.map((p, i) => (
        <SparkleGlyph key={i} phase={p} />
      ))}
    </View>
  );
}

// ── Typewriter ─────────────────────────────────────────────────────────
// Reveal letters one-by-one on mount (~50ms/letter), then stays at full.
// Re-mounting replays. Uses setInterval which is cleared on unmount or
// when the full name has been revealed.
// TODO: smoke-test in browser
export function TypewriterName({
  name,
  color,
  style,
  numberOfLines,
}: CommonProps & { color: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(0);
    if (!name) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= name.length) {
        clearInterval(id);
      }
    }, 50);
    return () => clearInterval(id);
  }, [name]);

  // Render the full name's width to avoid layout jitter; mask via color of
  // un-revealed tail to transparent.
  const revealed = name.slice(0, count);
  const remaining = name.slice(count);

  return (
    <Text style={[style, { color }]} numberOfLines={numberOfLines}>
      {revealed}
      <Text style={{ color: 'transparent' }}>{remaining}</Text>
    </Text>
  );
}

// ── Holographic ────────────────────────────────────────────────────────
// Animates the text color through cyan → magenta → yellow → cyan over
// ~3s. Implemented via setInterval stepping through a palette since color
// isn't natively animatable. baseColor is currently unused (the palette
// is intentionally fixed for the holographic look) but kept in the API
// so callers can pass the recipe's `base` without special-casing.
// TODO: smoke-test in browser
const HOLO_PALETTE = [
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#ec4899', // magenta
  '#fbbf24', // yellow
  '#ec4899', // magenta
  '#a78bfa', // violet
];

export function HolographicName({
  name,
  baseColor: _baseColor,
  style,
  numberOfLines,
}: CommonProps & { baseColor: string }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % HOLO_PALETTE.length);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <Text
      style={[
        style,
        {
          color: HOLO_PALETTE[idx],
          textShadowColor: HOLO_PALETTE[(idx + 2) % HOLO_PALETTE.length],
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 4,
        },
      ]}
      numberOfLines={numberOfLines}
    >
      {name}
    </Text>
  );
}
