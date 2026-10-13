// The fixed chrome above a Play list (plan section 4), shared by Leagues and
// Tournaments:
//
//   [Q] Search leagues, courts, admins      x     44  always visible
//   (x 25 mi)(Mine 7)(Open to join 41)..  [Filters 2] 44  only when the list needs it
//
// It sits OUTSIDE the FlatList (no stickyHeaderIndices, which react-native-web
// renders badly), so with Play's 44px tab toggle above it the chrome is at
// most 44 + 44 + 44 = 132px.
//
// Search fires `onChangeQuery` on every keystroke (the visible text) and
// `onDebouncedQuery` 250ms after typing pauses (the filtering). It is never
// saved. The chip row: sheet filters that are on come first as removable chips
// (ActiveFilterChips in the row's `leading` slot), then the quick chips
// (multi-select, AND-ed; zero counts hidden except the pinned Mine / Saved),
// then the Filters button pinned at the right outside the scroll. On web at
// 600px and wider the row wraps instead of scrolling sideways.
import React, { type Ref } from 'react';
import { View, StyleSheet } from 'react-native';
import {
  ActiveFilterChips,
  FilterChipRow,
  FilterPill,
  FilterSearchField,
  type ActiveFilterChipGroup,
  type ActiveFilterEntry,
  type FilterChipOption,
  type FilterSearchFieldHandle,
  type FilterValues,
} from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';

export type PlayListChromeProps = {
  searchRef?: Ref<FilterSearchFieldHandle>;
  query: string;
  onChangeQuery: (text: string) => void;
  onDebouncedQuery: (text: string) => void;
  placeholder: string;
  /** Render the chip row (Discover > 6 rows, or a filter is on). */
  showChips: boolean;
  chipOptions: FilterChipOption[];
  chips: string[];
  onChangeChips: (next: string[]) => void;
  pinnedKeys: readonly string[];
  sheetValues: FilterValues;
  sheetDefaults: FilterValues;
  sheetGroups: readonly ActiveFilterChipGroup[];
  formatSheetLabel?: (entry: ActiveFilterEntry) => string | null | undefined;
  onRemoveSheetValue: (key: string, value?: string) => void;
  /** Sheet groups that are on (the Filters button count). */
  sheetCount: number;
  onOpenFilters: () => void;
};

export default function PlayListChrome(p: PlayListChromeProps) {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
      <FilterSearchField
        ref={p.searchRef}
        size="sm"
        value={p.query}
        onChangeText={p.onChangeQuery}
        onDebouncedChange={p.onDebouncedQuery}
        debounceMs={250}
        placeholder={p.placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={p.placeholder}
      />
      {p.showChips ? (
        <FilterChipRow
          multi
          size="md"
          options={p.chipOptions}
          values={p.chips}
          onChangeValues={p.onChangeChips}
          hideZero
          pinnedKeys={p.pinnedKeys}
          wrapAtWidth={600}
          leading={
            <ActiveFilterChips
              inline
              values={p.sheetValues}
              defaults={p.sheetDefaults}
              groups={p.sheetGroups}
              formatLabel={p.formatSheetLabel}
              onRemove={p.onRemoveSheetValue}
            />
          }
          trailing={
            <FilterPill
              label="Filters"
              iconName="sliders"
              count={p.sheetCount > 0 ? p.sheetCount : undefined}
              active={p.sheetCount > 0}
              onPress={p.onOpenFilters}
              accessibilityRole="button"
              accessibilityLabel={p.sheetCount > 0 ? `Filters, ${p.sheetCount} on` : 'Filters'}
            />
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: SPACE.lg,
    borderBottomWidth: HAIRLINE,
  },
});
