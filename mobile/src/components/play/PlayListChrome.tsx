// The fixed chrome above a Play list (plan section 4), shared by Leagues and
// Tournaments, now the foundation's ListFilterChrome (hoisted from this file in
// 1.51; Courts uses it too):
//
//   [Q] Search leagues, courts, admins      x     44  always visible
//   (x 25 mi)(Mine 7)(Open to join 41)..  [Filters 2] 44  only when the list needs it
//
// It sits OUTSIDE the FlatList (no stickyHeaderIndices, which react-native-web
// renders badly), so with Play's 44px tab toggle above it the chrome is at
// most 44 + 44 + 44 = 132px. Search fires `onChangeQuery` on every keystroke
// and `onDebouncedQuery` 250ms after typing pauses; it is never saved.
import React from 'react';
import { ListFilterChrome, type ListFilterChromeProps } from '@just-messin-around/expo-foundation/ui';

/** Play's lists always pass the whole sheet (the kit makes these optional). */
export type PlayListChromeProps = ListFilterChromeProps &
  Required<
    Pick<
      ListFilterChromeProps,
      | 'showChips'
      | 'chipOptions'
      | 'chips'
      | 'onChangeChips'
      | 'pinnedKeys'
      | 'sheetValues'
      | 'sheetDefaults'
      | 'sheetGroups'
      | 'onRemoveSheetValue'
      | 'sheetCount'
      | 'onOpenFilters'
    >
  >;

export default function PlayListChrome(p: PlayListChromeProps) {
  return <ListFilterChrome {...p} />;
}
