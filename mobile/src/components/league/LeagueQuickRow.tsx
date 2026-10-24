// LeagueDetail's quick row (plan section 5, slot 2): four labelled 64px tiles,
//
//   [ + Record ] [ Standings ] [ Events ] [ Members ]
//
// replacing the seven 72px option cards that pushed Record to y≈700. Record is
// the one filled (primary) tile and carries the 'leagues' tour's final step
// ('record'): the ref sits on the tile's own TouchableOpacity, which the tour
// measures with measureInWindow. The row is near the top of the screen, so the
// step needs no scroll host.
//
// Non-members get [Standings] [Events] [Members] (the LeagueJoinCard above the
// row is their action). The Standings tile is disabled with "No season yet"
// when the league has never run a season.
//
// Four tiles on a 390pt phone leave about 73pt of text width each, so nothing
// here may truncate: the label shrinks a little on native rather than ellipsize
// at the 1.3x cap ("Standi…"), and the "No season yet" note is its own line
// that wraps to two. The tiles are minHeight 64, so the row grows instead.
//
// Glyphs (2026-10-24): each tile draws its glyph (plus, trophy, calendar,
// group) at 24 in the brand colour over the label, through the foundation
// ShortcutGrid that draws Home's quick tiles (1.66 added the filled tile, the
// disabled tile with a note and per-tile onLayout this row needs), so the two
// rows are one component.
import React from 'react';
import { type View } from 'react-native';
import { ShortcutGrid, type ShortcutItem } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';

export type LeagueQuickRowProps = {
  /** Show the Record tile (members, and viewers whose role read failed). */
  showRecord: boolean;
  onRecord: () => void;
  /** Tour anchor for the Record tile (measured with measureInWindow). */
  recordRef?: React.RefObject<View | null> | React.MutableRefObject<any>;
  /** Called when the Record tile lays out (register the tour anchor then). */
  onRecordLayout?: () => void;
  /** null = no season at all: the tile is disabled and says "No season yet". */
  onStandings: (() => void) | null;
  onEvents: () => void;
  onMembers: () => void;
};

const noop = () => {};

export default function LeagueQuickRow({
  showRecord,
  onRecord,
  recordRef,
  onRecordLayout,
  onStandings,
  onEvents,
  onMembers,
}: LeagueQuickRowProps) {
  const items: ShortcutItem[] = [
    ...(showRecord
      ? [{
          key: 'record',
          iconName: 'plus' as const,
          label: 'Record',
          a11y: 'Record a match',
          onPress: onRecord,
          filled: true,
          anchorRef: recordRef,
          onLayout: onRecordLayout,
        }]
      : []),
    {
      key: 'standings',
      iconName: 'trophy',
      label: 'Standings',
      note: onStandings ? undefined : 'No season yet',
      disabled: !onStandings,
      onPress: onStandings ?? noop,
      a11y: onStandings ? 'Season standings' : 'Standings, no season yet',
    },
    { key: 'events', iconName: 'calendar', label: 'Events', onPress: onEvents, a11y: 'Events' },
    { key: 'members', iconName: 'group', label: 'Members', onPress: onMembers, a11y: 'Members' },
  ];

  // One row: as many columns as tiles (4 for members, 3 otherwise). 64 tall
  // (plan section 6: a tile row is 64), growing with large text.
  return (
    <ShortcutGrid
      items={items}
      columns={items.length}
      tileRadius={RADIUS.lg}
      tileMinHeight={64}
      fitLabels
      maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
    />
  );
}
