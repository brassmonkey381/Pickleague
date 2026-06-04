import React from 'react';
import { RefreshControl } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// Themed RefreshControl so every screen's pull-to-refresh spinner matches the
// app palette. Pair with the useRefresh() hook:
//   const refresh = useRefresh(load);
//   <ScrollView refreshControl={<AppRefreshControl {...refresh} />}>
export default function AppRefreshControl({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { colors } = useTheme();
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.primary}       // iOS
      colors={[colors.primary]}        // Android
      progressBackgroundColor={colors.surface}
    />
  );
}
