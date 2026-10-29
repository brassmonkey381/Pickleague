// How long you play and how that time splits into Closed group / Open play /
// Drill windows: the part a routine (RoutineEditSheet) and a one-off planned
// check-in (PlanEditSheet) share. Built from the foundation's DurationChips
// and TimeWindowsEditor; a closed window can name friends (up to 7).
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Chip, DurationChips, TimeWindowsEditor } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import {
  KEEP_WINDOWS_APART,
  fitWindowsToLength,
  formatDurationMinutes,
  type TimeWindow,
} from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { PLAY_HINTS, PLAY_LENGTH_OPTIONS, PLAY_WINDOW_RULES, type PlayMode } from '../../lib/courtRoutineRules';
import type { FriendRow } from '../../lib/friendship';
import { playModeOptions } from './playModeOptions';

const MAX_GROUP = 7;

export default function PlayPlanFields({
  lengthMin,
  windows,
  onChange,
  startClock,
  friends,
}: {
  lengthMin: number;
  windows: TimeWindow<PlayMode>[];
  /** Both together: a new length refits the windows. */
  onChange: (next: { lengthMin: number; windows: TimeWindow<PlayMode>[] }) => void;
  /** "HH:MM", for the editor's clock labels. */
  startClock: string;
  /** For a closed group (accepted friends; the server drops anyone else). */
  friends: FriendRow[];
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const modes = React.useMemo(() => playModeOptions(c), [c]);

  // A split the player hasn't given two modes yet stays split (foundation 1.58);
  // the screen joins same-mode neighbours when it saves (routineWindowsToSave).
  const setLength = (next: number) =>
    onChange({
      lengthMin: next,
      windows: windows.length ? fitWindowsToLength(windows, next, PLAY_WINDOW_RULES, KEEP_WINDOWS_APART) : [],
    });

  return (
    <>
      <Text style={[t.label, S.label]}>HOW LONG</Text>
      <DurationChips value={lengthMin} onChange={setLength} options={PLAY_LENGTH_OPTIONS} format={formatDurationMinutes} />

      <Text style={[t.label, S.label]}>HOW YOU'LL PLAY</Text>
      <Text style={[t.hint, S.gap]}>
        Split your time: a closed group (friends, or a set foursome), drills, then open play for anyone. Others see
        "open to play" only during open play.
      </Text>
      <TimeWindowsEditor<PlayMode>
        lengthMin={lengthMin}
        windows={windows}
        onChange={(next: TimeWindow<PlayMode>[]) => onChange({ lengthMin, windows: next })}
        modes={modes}
        hints={PLAY_HINTS}
        startClock={startClock}
        rules={{ stepMin: 15, minWindowMin: 15, maxWindows: 6, maxGroup: MAX_GROUP }}
        renderGroup={
          friends.length
            ? ({ window, setGroup }) =>
                window.mode === 'closed' ? (
                  <View style={S.group}>
                    <Text style={[t.meta, { color: c.textSub }]}>With (optional, up to {MAX_GROUP}):</Text>
                    <View style={S.chipRow}>
                      {friends.map((f) => {
                        const ids = window.group ?? [];
                        const on = ids.includes(f.user_id);
                        return (
                          <Chip
                            key={f.user_id}
                            label={f.full_name?.trim() || 'Friend'}
                            selected={on}
                            onPress={() =>
                              setGroup(on ? ids.filter((x) => x !== f.user_id) : ids.length < MAX_GROUP ? [...ids, f.user_id] : ids)
                            }
                          />
                        );
                      })}
                    </View>
                  </View>
                ) : null
            : undefined
        }
        unsaidColor={c.border}
      />
    </>
  );
}

const S = StyleSheet.create({
  label: { marginTop: SPACE.md + 2, marginBottom: SPACE.sm },
  gap: { marginBottom: SPACE.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  group: { marginTop: SPACE.sm, gap: SPACE.xs },
});
