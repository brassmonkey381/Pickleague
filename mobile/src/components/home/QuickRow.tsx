// Home's quick tiles (plan section 3): labelled tiles, rows of 3, above the feed.
//   Discover · Record (league members) or Join (everyone else) · Play · Drill · Shop · History
// Drawn by the foundation's ShortcutGrid (Doggle's HomeShortcuts, hoisted):
// every tile a 24px glyph in the brand colour over a caption, radius
// RADIUS.lg like the Panels around it (glyphs-ui-plan.md 5.5). Join (the key,
// "Join with a code") takes Record's slot for an account in no league, so
// both layouts are two full rows of three.
// Discover (its Places tab: the courts near you, list or map) shows while
// COURT_DISCOVERY_ENABLED is on, first, as Doggle's Home shortcuts put
// Discover first. Play opens the Play sheet with the bottom bar on
// (PLAY_NAV_ENABLED, state/feed-discover-play-plan.md P1: Play starts a
// session, like Doggle's WALK), else Discover's Leagues tab (the old Play
// hub). HomeScreen.onQuick routes them all.
// The old About tile is gone (About lives at Settings > App > About) and
// Profile moved to the greeting's avatar. The Wagers tile stays gated by
// WAGERS_ENABLED: the MyWagers screen isn't registered while it's false.
import React from 'react';
import { ShortcutGrid, type ShortcutItem } from '@just-messin-around/expo-foundation/ui';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { RADIUS } from '@just-messin-around/expo-foundation/styles';
import { COURT_DISCOVERY_ENABLED, WAGERS_ENABLED } from '../../lib/features';

export type QuickTarget = 'record' | 'join' | 'play' | 'courts' | 'drill' | 'shop' | 'history' | 'wagers';

type Tile = { key: QuickTarget; label: string; a11y?: string; iconName: IconName };

type Props = {
  /** Record shows only for league members; everyone else gets Join in its place. */
  showRecord: boolean;
  onPress: (target: QuickTarget, position: number) => void;
};

const PER_ROW = 3;

export default function QuickRow({ showRecord, onPress }: Props) {
  const tiles: Tile[] = [
    ...(COURT_DISCOVERY_ENABLED ? [{ key: 'courts' as const, label: 'Discover', a11y: 'Discover courts', iconName: 'search' as const }] : []),
    showRecord
      ? { key: 'record', label: 'Record', a11y: 'Record a match', iconName: 'edit' }
      : { key: 'join', label: 'Join', a11y: 'Join with a code', iconName: 'key' },
    // The bottom bar's centre Play glyph (2026-10-24); pickleball stays for leagues.
    { key: 'play', label: 'Play', iconName: 'play' },
    { key: 'drill', label: 'Drill', iconName: 'paddle' },
    { key: 'shop', label: 'Shop', a11y: 'Pickle Shop', iconName: 'cart' },
    ...(WAGERS_ENABLED ? [{ key: 'wagers' as const, label: 'Wagers', iconName: 'dice' as const }] : []),
    { key: 'history', label: 'History', a11y: 'Match history', iconName: 'clipboard' },
  ];

  const items: ShortcutItem[] = tiles.map((tile, i) => ({
    key: tile.key,
    label: tile.label,
    a11y: tile.a11y ?? tile.label,
    iconName: tile.iconName,
    onPress: () => onPress(tile.key, i),
  }));

  // Rows of 3 (the user, 2026-10-22: "two rows of 3, above the home feed").
  return <ShortcutGrid items={items} columns={PER_ROW} tileRadius={RADIUS.lg} />;
}
