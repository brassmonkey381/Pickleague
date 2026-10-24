// "Weekdays around 9 AM at Lakeside? You checked in there on 4 days lately.
// Make it a routine?" (Doggle's RoutineSuggestionCard), on Home under the
// court card. One tap adds it (the habit's usual length, nothing said about
// closed or open; editable in My routine). Shows the strongest habit not yet
// a routine and not dismissed, else nothing. Only from location-confirmed
// check-ins at starred courts (suggest_court_routines).
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { hapticSuccess } from '@just-messin-around/expo-foundation/platform';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { formatClockTime, formatWeekdayMask } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { ROUTINES_ENABLED } from '../../lib/features';
import type { RoutineSuggestion } from '../../lib/courtRoutineRules';
import { loadRoutineSuggestions, saveCourtRoutine } from '../../data/courtRoutines';

/** Shared with My routine: "Not now" in either place hides it in both. */
export const ROUTINE_DISMISSED_KEY = 'pickleague_routine_suggestions_dismissed_v1';
export const routineSuggestionKey = (s: RoutineSuggestion) => `${s.venueId}|${s.days}|${s.localTime}`;

export default function RoutineSuggestionCard({ onOpenRoutines }: { onOpenRoutines: () => void }) {
  return ROUTINES_ENABLED ? <SuggestionCard onOpenRoutines={onOpenRoutines} /> : null;
}

function SuggestionCard({ onOpenRoutines }: { onOpenRoutines: () => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const focused = useIsFocused();
  const [suggestion, setSuggestion] = React.useState<RoutineSuggestion | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!focused) return;
    let on = true;
    (async () => {
      try {
        const [list, raw] = await Promise.all([
          loadRoutineSuggestions(),
          AsyncStorage.getItem(ROUTINE_DISMISSED_KEY).catch(() => null),
        ]);
        const dismissed = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
        if (on) setSuggestion(list.find((s) => !dismissed.has(routineSuggestionKey(s))) ?? null);
      } catch {
        // A suggestion is a nicety: nothing shows when it can't load.
      }
    })();
    return () => {
      on = false;
    };
  }, [focused]);

  if (!suggestion) return null;
  const s = suggestion;

  async function add() {
    if (busy) return;
    setBusy(true);
    try {
      await saveCourtRoutine({ venueId: s.venueId, localTime: s.localTime, days: s.days, lengthMin: s.lengthMin, windows: [] });
      hapticSuccess();
      toast.success(`${s.venueName} is in your routine. Friends see it as a planned check-in.`);
      setSuggestion(null);
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't add that routine. Try again.", { venueName: s.venueName }));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setSuggestion(null);
    try {
      const raw = await AsyncStorage.getItem(ROUTINE_DISMISSED_KEY);
      const list = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
      list.add(routineSuggestionKey(s));
      await AsyncStorage.setItem(ROUTINE_DISMISSED_KEY, JSON.stringify([...list]));
    } catch {
      // Hidden for this session either way.
    }
  }

  return (
    <View style={[S.card, { borderColor: c.primary, backgroundColor: c.primaryLight }]}>
      <View style={S.titleRow}>
        <Icon name="calendar-event" size={16} color={c.primaryDark} style={S.titleGlyph} />
        <Text style={[t.title, S.shrink, { color: c.primaryDark }]}>
          {formatWeekdayMask(s.days)} around {formatClockTime(s.localTime)} at {s.venueName}?
        </Text>
      </View>
      <Text style={[t.meta, { color: c.textSub }]}>
        You checked in there on {s.visits} days lately. Make it a routine and Pickleague checks you in when you arrive.
      </Text>
      <View style={S.actions}>
        <Button title="Make it a routine" size="sm" loading={busy} onPress={() => void add()} />
        <Button title="Not now" size="sm" variant="outline" disabled={busy} onPress={() => void dismiss()} />
        <Button title="My routine" size="sm" variant="outline" disabled={busy} onPress={onOpenRoutines} />
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
  shrink: { flexShrink: 1 },
  // Centred on the first line of a wrapping title.
  titleGlyph: { marginTop: SPACE.xxs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm },
});
