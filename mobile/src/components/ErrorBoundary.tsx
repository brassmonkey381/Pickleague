import React, { useCallback, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { ErrorBoundary } from '@just-messin-around/expo-foundation/ui';

/**
 * Moved to @just-messin-around/expo-foundation/ui (which ships a friendly
 * "Try again" default fallback). This adapter keeps Pickleague's original
 * debug-oriented fallback — full error + component stack on a dark screen,
 * with hardcoded colors so it renders even if a provider is what broke — and
 * the original console.error logging, so existing imports
 * (`../components/ErrorBoundary`) keep working unchanged.
 */
type Props = { children: React.ReactNode };

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
      style={{ flex: 1, backgroundColor: '#1c1c1c' }}
      contentContainerStyle={{ padding: 20, paddingTop: 60 }}
    >
      <Text style={{ color: '#ff6b6b', fontSize: 18, fontWeight: '800', marginBottom: 12 }}>
        💥 Something crashed
      </Text>
      <Text selectable style={{ color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 10 }}>
        {error.name}: {error.message}
      </Text>
      {error.stack ? (
        <Text selectable style={{ color: '#bbbbbb', fontSize: 11, marginBottom: 16 }}>
          {error.stack}
        </Text>
      ) : null}
      {stack ? (
        <Text selectable style={{ color: '#888888', fontSize: 11 }}>
          Component stack:{stack}
        </Text>
      ) : null}
    </ScrollView>
  );
}
