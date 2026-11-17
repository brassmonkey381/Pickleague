import React, { useCallback, useState } from 'react';
import { CommonActions } from '@react-navigation/native';
import { ErrorBoundary, CrashScreen } from '@just-messin-around/expo-foundation/ui';
import { navigationRef } from '../lib/navigationRef';
import { CRASH_BODY, CRASH_TITLE, CRASH_TITLE_FONT, PICKLEAGUE_CRASH_PALETTE } from '../lib/crashPalette';

/**
 * Pickleague's render-crash screen: the kit's friendly CrashScreen ("That one
 * hit the net", your data is safe, Try again, Go to Home, details for support)
 * in Rally's colours as plain hex, so it renders even if a provider is what
 * broke. The error and its stack still go to the console, and the details hold
 * the message (plus the stack and component stack in development builds).
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
      fallback={(error, reset) => (
        <CrashScreen
          error={error}
          onRetry={reset}
          onHome={() => {
            // Signed out there is no Home route: Try again's reset is enough.
            if (navigationRef.isReady() && navigationRef.getRootState()?.routeNames?.includes('Home')) {
              navigationRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' }] }));
            }
            reset();
          }}
          title={CRASH_TITLE}
          body={CRASH_BODY}
          palette={PICKLEAGUE_CRASH_PALETTE}
          titleFontFamily={CRASH_TITLE_FONT}
          extraDetails={__DEV__ && componentStack ? `Component stack:${componentStack}` : null}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
