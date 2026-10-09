import 'react-native-gesture-handler';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/lib/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import EmailConfirmedBanner from './src/components/EmailConfirmedBanner';
import BadgeToast from './src/components/BadgeToast';
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
        </View>
      </ThemeProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
