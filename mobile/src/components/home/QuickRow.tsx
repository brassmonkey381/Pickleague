// Home's quick actions, one row of 5 tiles under the stat card (the redesign's
// layout B with action set 2, the user's pick 2026-11-04):
//   Record (league members) or Join (everyone else) · Leagues · Events · Standings · History
// Play, Discover and Saved are gone from here: the bottom bar has all three.
// Shop is the stat card's pickles, My Place its own cell there, and Drills a
// link at the foot of the feed. Join (the key, "Join with a code") takes
// Record's slot for an account in no league. HomeScreen.onQuick routes them.
// Events (the center tile) opens the Events page (outside events, Brian
// 2026-11-06); its dot says there are events I haven't seen.
import React from 'react';
import { ShortcutGrid, type ShortcutItem } from '@just-messin-around/expo-foundation/ui';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';

export type QuickTarget = 'record' | 'join' | 'leagues' | 'events' | 'standings' | 'history';

type Tile = { key: QuickTarget; label: string; a11y?: string; iconName: IconName; dot?: boolean };

type Props = {
  /** Record shows only for league members; everyone else gets Join in its place. */
  showRecord: boolean;
  /** Events I haven't seen yet: a dot on the Events tile. */
  newEvents?: number;
  onPress: (target: QuickTarget, position: number) => void;
};

export default function QuickRow({ showRecord, newEvents = 0, onPress }: Props) {
  const { colors: c } = useTheme();
  const tiles: Tile[] = [
    showRecord
      ? { key: 'record', label: 'Record', a11y: 'Record a match', iconName: 'edit' }
      : { key: 'join', label: 'Join', a11y: 'Join with a code', iconName: 'key' },
    { key: 'leagues', label: 'Leagues', a11y: 'My leagues', iconName: 'group' },
    {
      key: 'events',
      label: 'Events',
      a11y: newEvents > 0 ? `Events, ${newEvents} new` : 'Events near you',
      iconName: 'calendar-event',
      dot: newEvents > 0,
    },
    { key: 'standings', label: 'Standings', iconName: 'chart' },
    { key: 'history', label: 'History', a11y: 'Match history', iconName: 'clipboard' },
  ];

  const items: ShortcutItem[] = tiles.map((tile, i) => ({
    key: tile.key,
    label: tile.label,
    a11y: tile.a11y ?? tile.label,
    iconName: tile.iconName,
    dot: tile.dot,
    onPress: () => onPress(tile.key, i),
  }));

  // Labels shrink to fit rather than clip at 5 across on a narrow phone.
  return <ShortcutGrid items={items} columns={tiles.length} gap={8} fitLabels tileRadius={c.radiusButton ?? 12} />;
}
