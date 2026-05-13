import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import type { StatusMessage } from '../lib/useStatusMessage';

/**
 * Renders a success (green) or error (red) banner. Paired with
 * useStatusMessage hook. Returns null when status is null, so the
 * caller can drop <StatusBanner status={status.value} /> wherever
 * without conditional rendering.
 */
export default function StatusBanner({
  status,
  style,
}: {
  status: StatusMessage;
  style?: ViewStyle;
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  if (!status) return null;
  const isError = status.kind === 'error';
  return (
    <View style={[S.banner, isError ? S.bannerError : S.bannerSuccess, style]}>
      <Text style={[S.text, isError ? S.errorText : S.successText]}>
        {status.text}
      </Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    banner:        { borderRadius: 10, padding: 12, marginVertical: 8 },
    bannerSuccess: { backgroundColor: c.primaryLight },
    bannerError:   { backgroundColor: '#ffe5e5', borderLeftWidth: 4, borderLeftColor: '#c62828' },
    text:          { fontSize: 13, fontWeight: '600', lineHeight: 18 },
    successText:   { color: c.primary },
    errorText:     { color: '#8a1414' },
  });
}
