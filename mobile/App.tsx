import 'react-native-gesture-handler';
import React from 'react';
import { View } from 'react-native';
import { ThemeProvider } from './src/lib/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import EmailConfirmedBanner from './src/components/EmailConfirmedBanner';
import BadgeToast from './src/components/BadgeToast';
import { AppErrorBoundary } from './src/lib/StartupErrorScreen';

export default function App() {
  // Outermost so it also catches a throw from ThemeProvider itself.
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <View style={{ flex: 1 }}>
          <AppNavigator />
          <EmailConfirmedBanner />
          <BadgeToast />
        </View>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
