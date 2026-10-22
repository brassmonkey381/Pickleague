// Add or edit one routine check-in (Doggle's RoutineEditSheet): the court,
// the time, the days, and what Pickleague adds: how long you play and how
// that time splits into Closed group / Open play windows. Courts are your
// starred courts only (the user's decision 1: routines live at starred
// courts; the server refuses any other with pl:routine.not_starred).
//
// Built from the foundation's routine kit: WeekdayMaskPicker, ClockTimeField,
// DurationChips and TimeWindowsEditor. Delete asks twice in place: a second
// modal over this sheet would not show on iOS (one presented modal at a time).
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheet, Chip, ClockTimeField, DurationChips, TimeWindowsEditor, WeekdayMaskPicker } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import {
  KEEP_WINDOWS_APART,
  fitWindowsToLength,
  formatDurationMinutes,
  type TimeWindow,
} from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { PLAY_HINTS, PLAY_LENGTH_OPTIONS, PLAY_MODE_LABEL, PLAY_WINDOW_RULES, type PlayMode } from '../../lib/courtRoutineRules';
import type { CourtRoutineInput } from '../../data/courtRoutines';
import type { CourtFavorite } from '../../data/courtFavorites';
import type { FriendRow } from '../../lib/friendship';

export type RoutineDraft = CourtRoutineInput & { venueName: string };

const MAX_GROUP = 7;

export default function RoutineEditSheet({
  visible,
  initial,
  starred,
  friends,
  saving,
  deleting,
  onSave,
  onDelete,
  onClose,
}: {
  visible: boolean;
  initial: RoutineDraft | null;
  /** My starred courts: the only courts a routine can be at. */
  starred: CourtFavorite[];
  /** For a closed group (accepted friends; the server drops anyone else). */
  friends: FriendRow[];
  saving: boolean;
  deleting: boolean;
  onSave: (draft: RoutineDraft) => void;
  /** Present when editing an existing routine; called after a second tap. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [draft, setDraft] = React.useState<RoutineDraft | null>(initial);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  React.useEffect(() => {
    if (visible) setDraft(initial);
    setConfirmingDelete(false);
  }, [visible, initial]);

  const modes = React.useMemo(
    () => [
      { value: 'closed' as PlayMode, label: PLAY_MODE_LABEL.closed, color: c.warning },
      { value: 'open' as PlayMode, label: PLAY_MODE_LABEL.open, color: c.success },
    ],
    [c.warning, c.success],
  );

  if (!draft) return null;
  const set = (patch: Partial<RoutineDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const canSave = !!draft.venueId && draft.days > 0 && !saving && !deleting;
  // The court picked may no longer be starred (an edit of a dormant routine): keep it shown.
  const courts: { venue_id: string; venue_name: string }[] = starred.some((s) => s.venue_id === draft.venueId) || !draft.venueId
    ? starred
    : [{ venue_id: draft.venueId, venue_name: draft.venueName }, ...starred];

  // A split the player hasn't given two modes yet stays split (foundation 1.58);
  // the screen joins same-mode neighbours when it saves (routineWindowsToSave).
  const setLength = (lengthMin: number) =>
    set({
      lengthMin,
      windows: draft.windows.length ? fitWindowsToLength(draft.windows, lengthMin, PLAY_WINDOW_RULES, KEEP_WINDOWS_APART) : [],
    });

  return (
    <BottomSheet visible={visible} onClose={onClose} title={initial?.id ? 'Edit routine' : 'New routine'} height="90%">
      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <Text style={[t.label, S.label]}>COURT</Text>
        {courts.length === 0 ? (
          <Text style={t.hint}>
            Routines are for your starred courts. Star a court (the ☆ on Home's court card or a court's page), then add it
            here.
          </Text>
        ) : (
          <View style={S.chipRow}>
            {courts.map((f) => {
              const on = draft.venueId === f.venue_id;
              return (
                <TouchableOpacity
                  key={f.venue_id}
                  onPress={() => set({ venueId: f.venue_id, venueName: f.venue_name })}
                  style={[S.court, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primaryLight : c.surface }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[t.title, S.shrink, { color: on ? c.primary : c.text }]} numberOfLines={1}>
                    ★ {f.venue_name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={[t.label, S.label]}>TIME</Text>
        <ClockTimeField
          value={draft.localTime}
          onChange={(localTime) => set({ localTime })}
          timeZone={draft.tz ?? null}
          accessibilityLabel="Start time"
        />

        <Text style={[t.label, S.label]}>DAYS</Text>
        <WeekdayMaskPicker value={draft.days} onChange={(days) => set({ days })} />

        <Text style={[t.label, S.label]}>HOW LONG</Text>
        <DurationChips
          value={draft.lengthMin}
          onChange={setLength}
          options={PLAY_LENGTH_OPTIONS}
          format={formatDurationMinutes}
        />

        <Text style={[t.label, S.label]}>CLOSED GROUP OR OPEN PLAY</Text>
        <Text style={[t.hint, S.gap]}>
          Split your time: a closed group (friends, or a set foursome), then open play for anyone. Others see "open to
          play" only during open play.
        </Text>
        <TimeWindowsEditor<PlayMode>
          lengthMin={draft.lengthMin}
          windows={draft.windows}
          onChange={(windows: TimeWindow<PlayMode>[]) => set({ windows })}
          modes={modes}
          hints={PLAY_HINTS}
          startClock={draft.localTime}
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

        <Text style={[t.hint, S.hint]}>
          Pickleague plans this for today and tomorrow. Arriving between 30 minutes before and 30 minutes after its time
          checks you in for it, and friends see it as a planned check-in on your profile.
        </Text>

        <Button
          title={initial?.id ? 'Save changes' : 'Add to my routine'}
          iconName="check-mark"
          loading={saving}
          disabled={!canSave}
          onPress={() => onSave(draft)}
          style={S.save}
        />
        {onDelete ? (
          <Button
            title={confirmingDelete ? 'Tap again to delete' : 'Delete this routine'}
            variant={confirmingDelete ? 'danger' : 'outline'}
            loading={deleting}
            disabled={saving}
            onPress={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
            style={S.save}
          />
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  scroll: { flex: 1 },
  body: { paddingBottom: SPACE.xl },
  label: { marginTop: SPACE.md + 2, marginBottom: SPACE.sm },
  gap: { marginBottom: SPACE.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  court: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: RADIUS.md + 2,
    minHeight: 44,
    paddingHorizontal: SPACE.md,
    maxWidth: '100%',
    justifyContent: 'center',
  },
  shrink: { flexShrink: 1 },
  group: { marginTop: SPACE.sm, gap: SPACE.xs },
  hint: { marginTop: SPACE.lg },
  save: { marginTop: SPACE.md },
});
