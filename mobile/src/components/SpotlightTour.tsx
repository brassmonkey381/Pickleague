import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { SpotlightTourBase } from '../lib/TourContext';

// Full-screen spotlight overlay. Rendered once at the app root by TourProvider's
// host (AppNavigator). It dims the page, cuts a highlight ring around the
// current step's measured target, and shows a tooltip with Next / Done.
//
// The engine + overlay now come from @just-messin-around/expo-foundation/tour;
// this file is the Pickleague skin. Behavior options (non-blocking overlay,
// backdrop-dismiss, anchored 280px bubble, ...) are set once on the factory in
// lib/TourContext.tsx; the styles below are passed as props because they need
// the live palette.
//
// Every value the previous hand-rolled overlay set is passed explicitly: the
// kit merges these ON TOP of its own base styles (theme typography presets for
// the title/body/counter, and an 18px card padding), so anything not listed
// here would silently fall back to the kit's defaults rather than Pickleague's.

export default function SpotlightTour() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);

  return (
    <SpotlightTourBase
      ringStyle={S.ring}
      cardStyle={S.card}
      counterStyle={S.counter}
      titleStyle={S.title}
      bodyStyle={S.body}
      skipStyle={S.skip}
      nextButtonStyle={S.nextBtn}
      nextButtonTextStyle={S.nextBtnText}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Kit base: borderWidth 2 / borderRadius 12.
    ring: {
      borderWidth: 3,
      borderRadius: 14,
      borderColor: c.primary,
    },
    // Kit base: padding 18, no border, no shadow. Width comes from the
    // factory's cardWidth: 280.
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    // Kit base: the `meta` type preset (13px/600, letterSpacing 0.4).
    counter: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    // Kit base: the `h3` preset (17px/700, letterSpacing 0.2).
    title: {
      fontSize: 16,
      fontWeight: '800',
      color: c.text,
      letterSpacing: 0,
      marginBottom: 6,
    },
    // Kit base: the `bodySub` preset (14px, lineHeight 20).
    body: {
      fontSize: 13,
      color: c.textSub,
      lineHeight: 19,
    },
    // Kit base: 14px/700.
    skip: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    // Kit base: borderRadius 8, paddingHorizontal 20.
    nextBtn: {
      backgroundColor: c.primary,
      paddingHorizontal: 18,
      paddingVertical: 9,
      borderRadius: 20,
    },
    nextBtnText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '800',
    },
  });
}
