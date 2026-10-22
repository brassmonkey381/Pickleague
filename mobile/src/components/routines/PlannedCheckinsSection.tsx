// A player's routine check-ins on their profile ("Weekdays · 9 AM · 3 h ·
// Lakeside", and when they said so "9 AM–10:30 AM Closed group · 10:30 AM–12
// PM Open play"), so friends know when and where to find them (Doggle's
// PlannedCheckinsSection). The server applies their "Who sees my planned
// games" (plans_level, default friends), blocks and hide-froms, and never
// names a closed group's members to anyone else; nothing renders when there
// is nothing to show. Copy rule: these are "planned check-ins", never a
// "usual" anything or "<name>'s schedule".
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused, useNavigation, type NavigationProp } from '@react-navigation/native';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { formatClockTime, formatWeekdayMask, zoneSuffix } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { formatDurationMinutes } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { COURT_DISCOVERY_ENABLED, ROUTINES_ENABLED } from '../../lib/features';
import { routineWindowsLine, type ProfileRoutine } from '../../lib/courtRoutineRules';
import { loadProfileRoutines } from '../../data/courtRoutines';
import type { RootStackParamList } from '../../types';

export default function PlannedCheckinsSection({ profileId }: { profileId: string }) {
  return ROUTINES_ENABLED ? <Section profileId={profileId} /> : null;
}

function Section({ profileId }: { profileId: string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const focused = useIsFocused();
  const [stops, setStops] = React.useState<ProfileRoutine[]>([]);

  React.useEffect(() => {
    if (!focused) return;
    let on = true;
    loadProfileRoutines(profileId)
      .then((list) => on && setStops(list))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [profileId, focused]);

  if (stops.length === 0) return null;
  return (
    <View style={S.wrap}>
      <Text style={[t.label, S.label]}>PLANNED CHECK-INS</Text>
      <View style={[S.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        {stops.map((s, i) => {
          const windows = routineWindowsLine(s);
          const head = `${formatClockTime(s.localTime)}${zoneSuffix(s.tz)} · ${s.venueName}`;
          const sub = `${formatWeekdayMask(s.days)} · ${formatDurationMinutes(s.lengthMin)}`;
          const body = (
            <>
              <Text style={t.title} numberOfLines={1}>
                📅 {head}
              </Text>
              <Text style={[t.meta, { color: c.textSub }]}>{sub}</Text>
              {windows ? (
                <Text style={[t.meta, { color: c.textSub }]} numberOfLines={2}>
                  {windows}
                </Text>
              ) : null}
            </>
          );
          const rowStyle = [S.row, i > 0 && { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth }];
          // The court's page, once court discovery is on; else just the line.
          return COURT_DISCOVERY_ENABLED ? (
            <TouchableOpacity
              key={`${s.venueId}|${s.localTime}|${s.days}`}
              style={rowStyle}
              onPress={() => navigation.navigate('CourtDetail', { venueId: s.venueId })}
              accessibilityRole="button"
              accessibilityLabel={`${sub}, ${head}. Open court`}
            >
              {body}
            </TouchableOpacity>
          ) : (
            <View key={`${s.venueId}|${s.localTime}|${s.days}`} style={rowStyle} accessible accessibilityLabel={`${sub}, ${head}`}>
              {body}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  wrap: { width: '100%' },
  label: { marginTop: 20, marginBottom: 10 },
  card: { borderWidth: 1, borderRadius: RADIUS.md + 2 },
  row: { paddingVertical: 10, paddingHorizontal: SPACE.md, minHeight: 44, gap: 2 },
});
