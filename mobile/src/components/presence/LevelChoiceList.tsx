// The radio list behind "Who sees me at the courts" and "Who sees my planned
// games": one row per level (label, one-line meaning, a check on the current one).
// Used by the Settings sheets and by the consent sheet's "Change".
//
// Not the kit PrivacySettingsPanel: it hard-codes four levels with its own
// labels ("Groups and Friends") and a "Private profile" master switch, and the
// plans row needs three levels (kit follow-up: allowed levels + label
// overrides).
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SPACE, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import type { LevelOption } from '../../lib/presencePrivacy';

type Props<L extends string> = {
  options: LevelOption<L>[];
  value: L;
  onPick: (level: L) => void;
  /** The level being saved: shows a spinner on its row. */
  saving?: L | null;
  disabled?: boolean;
};

export default function LevelChoiceList<L extends string>({ options, value, onPick, saving, disabled }: Props<L>) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <View accessibilityRole="radiogroup">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <TouchableOpacity
            key={o.value}
            style={[S.row, i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}
            onPress={() => onPick(o.value)}
            disabled={disabled || on}
            activeOpacity={0.7}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: !!disabled }}
            accessibilityLabel={o.label}
            accessibilityHint={o.desc}
          >
            <View style={S.text}>
              <Text style={[t.title, on && { color: c.primary }]}>{o.label}</Text>
              <Text style={[t.sub, S.desc]}>{o.desc}</Text>
            </View>
            {saving === o.value ? (
              <ActivityIndicator color={c.primary} />
            ) : on ? (
              <Icon name="check-mark" size={18} color={c.primary} />
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const S = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  desc: { marginTop: SPACE.xxs },
});
