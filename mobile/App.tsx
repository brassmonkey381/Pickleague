import 'react-native-gesture-handler';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/lib/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import EmailConfirmedBanner from './src/components/EmailConfirmedBanner';
import BadgeToast from './src/components/BadgeToast';
import { PresenceConsentHost } from './src/components/presence/ConsentSheet';
import { AppErrorBoundary } from './src/lib/StartupErrorScreen';

export default function App() {
  // Outermost so it also catches a throw from ThemeProvider itself.
  return (
    <AppErrorBoundary>
      {/* Insets for the floating play island (foundation LiveStatusIsland). */}
      <SafeAreaProvider>
      <ThemeProvider>
        <View style={{ flex: 1 }}>
          <AppNavigator />
          <EmailConfirmedBanner />
          <BadgeToast />
          {/* The one-time "who sees you at the courts" sheet (lib/presenceConsent). */}
          <PresenceConsentHost />
        </View>
      </ThemeProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
