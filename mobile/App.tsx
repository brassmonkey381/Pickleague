import 'react-native-gesture-handler';
import React from 'react';
import { View } from 'react-native';
import { ThemeProvider } from './src/lib/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import EmailConfirmedBanner from './src/components/EmailConfirmedBanner';
import BadgeToast from './src/components/BadgeToast';

export default function App() {
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}>
        <AppNavigator />
        <EmailConfirmedBanner />
        <BadgeToast />
      </View>
    </ThemeProvider>
  );
}
