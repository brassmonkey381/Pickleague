// LeagueDetail's reference links (plan section 5, slot 5): one 44px line,
//
//   History · Calendar · Tournaments · Past (2)
//
// replacing three full option cards and the past-seasons card. The visible
// labels are short so the line fits one row down to a 320pt screen at default
// text; each link's a11yLabel keeps the full name ("Match history", "Past
// seasons (2)"). Each link is its own 44-tall box (react-native-web ignores
// hitSlop). The line wraps only at large text, rather than truncating a link.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type LeagueMoreLink = { key: string; label: string; a11yLabel?: string; onPress: () => void };

export default function LeagueMoreLinks({ links }: { links: LeagueMoreLink[] }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  if (links.length === 0) return null;
  return (
    <View style={styles.line}>
      {links.map((l, i) => (
        <React.Fragment key={l.key}>
          {i > 0 ? (
            <Text style={[t.sub, { color: c.textMuted }]} accessibilityElementsHidden importantForAccessibility="no">
              ·
            </Text>
          ) : null}
          <TouchableOpacity
            onPress={l.onPress}
            activeOpacity={0.7}
            accessibilityRole="link"
            accessibilityLabel={l.a11yLabel ?? l.label}
            style={styles.link}
          >
            <Text style={[t.sub, { color: c.primary, fontWeight: '600' }]} numberOfLines={1}>{l.label}</Text>
          </TouchableOpacity>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm },
  link: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
});
