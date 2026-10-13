// One TournamentDetail section: a Panel with a SectionHeader (label, count,
// trailing text action) and the section's content. With `onToggle` it
// collapses like CollapsibleSection, but it can also show a NODE while closed
// (the Players section's AvatarPile), which CollapsibleSection can't.
//
// FOUNDATION-TODO: CollapsibleSection's `summary` takes a string only; accept
// a ReactNode (or add a `collapsedContent` slot) so a collapsed section can
// show an AvatarPile, then replace this adapter with it.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Panel, SectionHeader, type SectionHeaderAction } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';

export type SectionCardProps = {
  title: string;
  count?: number | string;
  action?: SectionHeaderAction;
  /** Collapsible when set; `open` is then the state. */
  onToggle?: () => void;
  open?: boolean;
  /** Shown under the header while collapsed (requires onToggle). */
  collapsedContent?: React.ReactNode;
  /** Keep children mounted while collapsed (hidden), e.g. for an anchor. */
  keepMounted?: boolean;
  children?: React.ReactNode;
};

export default function SectionCard({
  title, count, action, onToggle, open = true, collapsedContent, keepMounted, children,
}: SectionCardProps) {
  const collapsible = !!onToggle;
  const showBody = !collapsible || open;
  return (
    <Panel padded={false} radius={RADIUS.lg}>
      <View style={styles.header}>
        <SectionHeader title={title} count={count} action={action} onToggle={onToggle} open={open} />
      </View>
      {collapsible && !open && collapsedContent ? <View style={styles.body}>{collapsedContent}</View> : null}
      {showBody || keepMounted ? (
        <View style={[styles.body, !showBody && styles.hidden]}>{children}</View>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: SPACE.md },
  body: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md },
  hidden: { display: 'none' },
});
