// LeagueDetail's "Coming up" (plan section 5, slot 4): the league's events and
// tournaments merged into one list, needs-you rows (votes) first and then by
// date, at most 3 rows, then "Show N more"
// inline. It replaces the separate "Upcoming tournaments" and "Upcoming events"
// cards, which each rendered an empty "No upcoming ..." card (about 170px) in
// every prod league. When there is nothing to show, nothing renders.
//
// The latest tournament champion rides along as the last row, and only when
// one exists.
//
// Rows are the shared EntityRow (layout='row' inside a Panel), so they match
// Home's Up next / Yours rows: 56 tall, one-line subtitle, at most 2 chips.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import EntityRow, { type EntityRowChip } from '../EntityRow';
import type { EntityKind } from '../../lib/entityGlyph';

export type LeagueComingUpItem = {
  key: string;
  kind: Extract<EntityKind, 'tournament' | 'event' | 'vote'>;
  title: string;
  /** One-line subtitle: "Sat, Oct 18, 9:00 AM" / "Voting ends Thu 6 PM". */
  when: string;
  /** Sort key (ms). */
  whenMs: number;
  chip?: EntityRowChip | null;
  onPress: () => void;
};

export type LeagueChampion = {
  tournamentName: string;
  /** null for a non-team winner (badge row without team_name). */
  teamName: string | null;
  /** Winner display names. */
  winners: string[];
  /** "12-4" or null. */
  record: string | null;
  onPress: () => void;
};

export type LeagueComingUpProps = {
  /** Already merged and sorted (needs-you first, then date). */
  items: LeagueComingUpItem[];
  champion: LeagueChampion | null;
};

const CAP = 3;

/** "Alice", "Alice and Bob", "Alice, Bob, and Cara" (the old champion card's wording). */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export default function LeagueComingUp({ items, champion }: LeagueComingUpProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0 && !champion) return null;

  const shown = expanded ? items : items.slice(0, CAP);
  const hidden = items.length - shown.length;
  const championSub = champion
    // Without a team name the tournament is already the title, so it isn't repeated here.
    ? [champion.teamName ? champion.tournamentName : null, champion.record, joinNames(champion.winners)].filter(Boolean).join(' · ')
    : '';

  return (
    <View style={styles.wrap}>
      <SectionHeader title="Coming up" count={items.length > 0 ? items.length : undefined} />
      <Panel padded={false}>
        {shown.map((item, i) => (
          <EntityRow
            key={item.key}
            kind={item.kind}
            layout="row"
            title={item.title}
            subtitle={item.when}
            chips={[item.chip]}
            onPress={item.onPress}
            lastRow={i === shown.length - 1 && hidden === 0 && !champion}
          />
        ))}
        {hidden > 0 ? (
          <TouchableOpacity
            onPress={() => setExpanded(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            style={[styles.more, { borderBottomColor: c.border }, !champion && styles.noDivider]}
          >
            <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Show {hidden} more
            </Text>
          </TouchableOpacity>
        ) : null}
        {champion ? (
          <EntityRow
            kind="tournament"
            layout="row"
            title={champion.teamName ? `Champions: ${champion.teamName}` : `${champion.tournamentName} champions`}
            subtitle={championSub}
            onPress={champion.onPress}
            lastRow
          />
        ) : null}
      </Panel>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACE.xs },
  more: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACE.md,
    borderBottomWidth: HAIRLINE,
  },
  noDivider: { borderBottomWidth: 0 },
});
