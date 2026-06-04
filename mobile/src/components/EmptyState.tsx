import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// Shared empty-state: a centered emoji + title + optional subtitle + optional
// call-to-action. Replaces ad-hoc "No X yet" <Text> blocks scattered across
// list screens so empty views look consistent.
type Props = {
  icon?: string;          // emoji, e.g. '🔍'
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
};

export default function EmptyState({ icon, title, subtitle, actionLabel, onAction }: Props) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.wrap}>
      {icon ? <Text style={s.icon}>{icon}</Text> : null}
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity
          style={s.btn}
          onPress={onAction}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={s.btnText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap:     { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 32 },
    icon:     { fontSize: 44, marginBottom: 12 },
    title:    { fontSize: 16, fontWeight: '800', color: c.text, textAlign: 'center' },
    subtitle: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19, marginTop: 6 },
    btn:      { marginTop: 16, backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
    btnText:  { color: '#fff', fontSize: 14, fontWeight: '700' },
  });
}
