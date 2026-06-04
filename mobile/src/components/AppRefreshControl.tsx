import React from 'react';
import { Platform, RefreshControl, View, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// Themed RefreshControl so every screen's pull-to-refresh spinner matches the
// app palette. Pair with the useRefresh() hook:
//   const refresh = useRefresh(load);
//   <ScrollView refreshControl={<AppRefreshControl {...refresh} />}>
//
// WEB NOTE: react-native-web's ScrollView/FlatList implement `refreshControl`
// by cloning the element and passing the ENTIRE scroll content as its children
// (cloneElement(refreshControl, { style }, scrollView)). So on web this
// component must render those children, or the whole screen goes blank. There's
// no pull-to-refresh gesture on web anyway, so we just render the content
// (with the ScrollView's style) and skip the native RefreshControl.
export default function AppRefreshControl({
  refreshing,
  onRefresh,
  children,
  style,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  children?: React.ReactNode;       // web only: the ScrollView content RNW injects
  style?: StyleProp<ViewStyle>;     // web only: the ScrollView style RNW injects
}) {
  const { colors } = useTheme();

  if (Platform.OS === 'web') {
    return <View style={style}>{children}</View>;
  }

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
