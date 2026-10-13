// One static TournamentDetail section (Schedule, Standings, Stages, Playoff
// bracket): a Panel with a SectionHeader (label, count, trailing text action)
// and the section's content. The collapsible sections (Pairs/Teams, Playoff,
// Players, Pot, Wager) are `CollapsibleSection compact`, like Manage.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Panel, SectionHeader, type SectionHeaderAction } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';

export type SectionCardProps = {
  title: string;
  count?: number | string;
  action?: SectionHeaderAction;
  children?: React.ReactNode;
};

export default function SectionCard({ title, count, action, children }: SectionCardProps) {
  return (
    <Panel padded={false} radius={RADIUS.lg}>
      <View style={styles.header}>
        <SectionHeader title={title} count={count} action={action} />
      </View>
      <View style={styles.body}>{children}</View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: SPACE.md },
  body: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md },
});
