// Home's quick actions, one row of 5 tiles under the stat card (the redesign's
// layout B with action set 2, the user's pick 2026-11-04):
//   Record (league members) or Join (everyone else) · Leagues · Tournaments · Standings · History
// Play, Discover and Saved are gone from here: the bottom bar has all three.
// Shop is the stat card's pickles, My Place its own cell there, and Drills a
// link at the foot of the feed. Join (the key, "Join with a code") takes
// Record's slot for an account in no league. HomeScreen.onQuick routes them.
import React from 'react';
import { ShortcutGrid, type ShortcutItem } from '@just-messin-around/expo-foundation/ui';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';

export type QuickTarget = 'record' | 'join' | 'leagues' | 'tournaments' | 'standings' | 'history';

type Tile = { key: QuickTarget; label: string; a11y?: string; iconName: IconName };

type Props = {
  /** Record shows only for league members; everyone else gets Join in its place. */
  showRecord: boolean;
  onPress: (target: QuickTarget, position: number) => void;
};

export default function QuickRow({ showRecord, onPress }: Props) {
  const { colors: c } = useTheme();
  const tiles: Tile[] = [
    showRecord
      ? { key: 'record', label: 'Record', a11y: 'Record a match', iconName: 'edit' }
      : { key: 'join', label: 'Join', a11y: 'Join with a code', iconName: 'key' },
    { key: 'leagues', label: 'Leagues', a11y: 'My leagues', iconName: 'group' },
    { key: 'tournaments', label: 'Events', a11y: 'My tournaments', iconName: 'bracket' },
    { key: 'standings', label: 'Standings', iconName: 'chart' },
    { key: 'history', label: 'History', a11y: 'Match history', iconName: 'clipboard' },
  ];

  const items: ShortcutItem[] = tiles.map((tile, i) => ({
    key: tile.key,
    label: tile.label,
    a11y: tile.a11y ?? tile.label,
    iconName: tile.iconName,
    onPress: () => onPress(tile.key, i),
  }));

  // Labels shrink to fit rather than clip at 5 across on a narrow phone.
  return <ShortcutGrid items={items} columns={tiles.length} gap={8} fitLabels tileRadius={c.radiusButton ?? 12} />;
}
