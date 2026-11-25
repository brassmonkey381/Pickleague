// One static TournamentDetail section (Schedule, Standings, Stages, Playoff
// bracket): a Panel with a SectionHeader (label, count, trailing text action)
// and the section's content. The collapsible sections (Pairs/Teams, Playoff,
// Players, Pot, Wager) are `CollapsibleSection compact`, like Manage.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Panel, SectionHeader, type SectionHeaderAction } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type SectionCardProps = {
  title: string;
  count?: number | string;
  action?: SectionHeaderAction;
  /** A small stamp next to the title, e.g. "Final" once a tournament ends (PKL-085). */
  stamp?: string;
  children?: React.ReactNode;
};

export default function SectionCard({ title, count, action, stamp, children }: SectionCardProps) {
  const { colors: c } = useTheme();
  return (
    <Panel padded={false} radius={RADIUS.lg}>
      <View style={[styles.header, stamp ? styles.stampRow : null]}>
        <SectionHeader title={title} count={count} action={action} style={stamp ? styles.shrink : undefined} />
        {stamp ? (
          <View style={[styles.stamp, { borderColor: c.primary }]} accessibilityLabel={stamp}>
            <Text style={[styles.stampText, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{stamp.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.body}>{children}</View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: SPACE.md },
  stampRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  shrink: { flexShrink: 1 },
  stamp: { borderWidth: 1.5, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 },
  stampText: { fontSize: FONT.size.xs, fontWeight: '800', letterSpacing: 1 },
  body: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md },
});
