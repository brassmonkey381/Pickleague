import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { ErrorBoundary } from '@just-messin-around/expo-foundation/ui';
import { WarningGlyph } from '@just-messin-around/expo-foundation/icons';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';

/**
 * Moved to @just-messin-around/expo-foundation/ui (which ships a friendly
 * "Try again" default fallback). This adapter keeps Pickleague's original
 * debug-oriented fallback — full error + component stack on a dark screen,
 * with hardcoded colors so it renders even if a provider is what broke — and
 * the original console.error logging, so existing imports
 * (`../components/ErrorBoundary`) keep working unchanged.
 *
 * The crash glyph is the raw WarningGlyph (an SVG that takes its colour as a
 * prop), not <Icon>: Icon reads the theme, and the theme may be what broke.
 * FONT and SPACE are plain constants, so they are safe here too.
 */
type Props = { children: React.ReactNode };

// The crash screen's own fixed palette (no theme on purpose, see above).
const CRASH = {
  bg: '#1c1c1c',
  title: '#ff6b6b',
  text: '#ffffff',
  stack: '#bbbbbb',
  componentStack: '#888888',
} as const;

export default function PickleagueErrorBoundary({ children }: Props) {
  const [componentStack, setComponentStack] = useState<string | null>(null);

  const onError = useCallback((error: Error, info: React.ErrorInfo) => {
    // Also log so it shows in the Metro terminal / browser console.
    console.error('[ErrorBoundary] render crash:', error, info?.componentStack);
    setComponentStack(info?.componentStack ?? null);
  }, []);

  return (
    <ErrorBoundary
      onError={onError}
      fallback={error => <CrashScreen error={error} stack={componentStack} />}
    >
      {children}
    </ErrorBoundary>
  );
}

function CrashScreen({ error, stack }: { error: Error; stack: string | null }) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: CRASH.bg }}
      // 60 on top clears the status bar / notch without the safe-area context.
      contentContainerStyle={{ padding: SPACE.lg, paddingTop: 60 }}
    >
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.md }}
        accessibilityRole="header"
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <WarningGlyph size={20} color={CRASH.title} />
        </View>
        <Text style={{ color: CRASH.title, fontSize: FONT.size.xl, fontWeight: FONT.weight.heavy }}>
          Something crashed
        </Text>
      </View>
      <Text selectable style={{ color: CRASH.text, fontSize: FONT.size.md, fontWeight: FONT.weight.bold, marginBottom: SPACE.sm }}>
        {error.name}: {error.message}
      </Text>
      {error.stack ? (
        <Text selectable style={{ color: CRASH.stack, fontSize: FONT.size.xs, marginBottom: SPACE.lg }}>
          {error.stack}
        </Text>
      ) : null}
      {stack ? (
        <Text selectable style={{ color: CRASH.componentStack, fontSize: FONT.size.xs }}>
          Component stack:{stack}
        </Text>
      ) : null}
    </ScrollView>
  );
}
