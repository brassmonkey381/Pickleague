// The Court Pass entry under Home's greeting (and under the room in My Place):
// "Court Pass · Tier 7 · 22 to next", with a red dot while a reward is new.
// Between passes it names the next start ("Court Pass · starts December 1").
// Ported from Doggle's ParkPassChip (docs/court-pass.md).
//
// Renders nothing while loading, on an error (the server half may not be live
// yet) or when no pass is seeded, so it never holds up the screen around it.
import React from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import { courtPassChipA11y, courtPassChipLabel, type CourtPassSummary } from '../../lib/courtPassCopy';

type Props = {
  summary: CourtPassSummary | null;
  onPress: () => void;
};

export default function CourtPassChip({ summary, onPress }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  if (!summary) return null;
  const fresh = summary.kind === 'running' && summary.newCount > 0;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.chip, { borderColor: c.border, backgroundColor: c.surface }]}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={courtPassChipA11y(summary)}
    >
      <Icon name="pickleball" size={14} color={c.primary} />
      <Text style={[t.meta, styles.label, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {courtPassChipLabel(summary)}
      </Text>
      {fresh ? <View style={[styles.dot, { backgroundColor: c.danger, borderColor: c.surface }]} /> : null}
      <Icon name="chevron-right" size={12} color={c.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: SPACE.xs + 2,
    minHeight: 32,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs,
    borderRadius: RADIUS.pill,
    borderWidth: HAIRLINE,
  },
  label: { flexShrink: 1, letterSpacing: 0 },
  dot: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5 },
});
