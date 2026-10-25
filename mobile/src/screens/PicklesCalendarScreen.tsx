// Pickle calendar (kit 1.73 PointsCalendar): a month of daily pickle totals,
// opened from the pickles viewer's "Calendar" (Home balance). Cells show the
// first two non-zero of earned "+120", gold bonus "★+50" and spent "-30";
// a day lists its rows below the grid. Starting balance, refunds, adjustments
// and take-backs are listed muted and counted in no total.
//
// No daily cap in the legend: Pickleague caps only the play streak (200 a
// day), not a day's earned total.
import React, { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { DAY_MS } from '@just-messin-around/expo-foundation/cache';
import { PointsCalendar } from '@just-messin-around/expo-foundation/gamification/points';
import { useTheme } from '../lib/ThemeContext';
import { listPickleLedgerRange, PICKLE_CALENDAR_CACHE_KEY } from '../data/pickleLedger';
import { PICKLES_COPY, PICKLES_UNIT } from '../components/home/PicklesViewer';

export default function PicklesCalendarScreen() {
  const { colors: c } = useTheme();
  // Back from the Shop (or a match): the visible month again.
  const [reloadKey, setReloadKey] = useState(0);
  const firstFocus = React.useRef(true);
  useFocusEffect(useCallback(() => {
    if (firstFocus.current) { firstFocus.current = false; return; }
    setReloadKey(n => n + 1);
  }, []));

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <PointsCalendar
        fetchRange={listPickleLedgerRange}
        unit={PICKLES_UNIT}
        cacheKey={PICKLE_CALENDAR_CACHE_KEY}
        cachePersistMs={DAY_MS}
        reloadKey={reloadKey}
        copy={PICKLES_COPY}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
