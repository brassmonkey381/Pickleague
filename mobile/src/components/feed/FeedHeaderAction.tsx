// A feed card header's text action: "Check in ▾", "On my way ▾", "Plan ▾".
// Title-size text in the primary colour with a chevron when it opens a sheet
// first, "…" while it runs. Doggle's FeedParkCard textAction, markup for
// markup (components/doggleFeed/FeedParkCard.tsx:123-144).
//
// FOUNDATION FOLLOW-UP: this is generic (no court, no pickleball) and both
// apps carry the same markup, so it belongs in the foundation's ui/feed as
// FeedHeaderAction (an additive minor release). Kept app-side until then; swap
// the import for '@just-messin-around/expo-foundation/ui/feed' and delete this.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';

export type FeedHeaderActionProps = {
  label: string;
  onPress: () => void;
  /** It opens a sheet or picker before anything happens: a trailing chevron. */
  options?: boolean;
  /** Its action is running: "…" in place of the label. */
  busy?: boolean;
  /** Another action is running. */
  disabled?: boolean;
  /** Secondary text colour instead of the primary. */
  muted?: boolean;
  accessibilityLabel?: string;
};

export default function FeedHeaderAction({
  label,
  onPress,
  options,
  busy = false,
  disabled = false,
  muted = false,
  accessibilityLabel,
}: FeedHeaderActionProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const color = muted ? c.textSub : c.primary;
  const off = busy || disabled;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={off}
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy, disabled: off }}
      style={[styles.action, off && styles.dim]}
    >
      <Text style={[t.title, { color }]}>{busy ? '…' : label}</Text>
      {options && !busy ? <Icon name="chevron-down" size={14} color={color} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  action: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  dim: { opacity: 0.55 },
});
