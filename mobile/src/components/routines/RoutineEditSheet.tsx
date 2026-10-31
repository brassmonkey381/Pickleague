// Add or edit one routine check-in (Doggle's RoutineEditSheet): the court,
// the time, the days, and what Pickleague adds: how long you play and how
// that time splits into Closed group / Open play / Drill windows
// (PlayPlanFields, shared with a one-off plan's PlanEditSheet). Courts are
// your starred courts only (the user's decision 1: routines live at starred
// courts; the server refuses any other with pl:routine.not_starred).
//
// Built from the foundation's routine kit: WeekdayMaskPicker, ClockTimeField,
// DurationChips and TimeWindowsEditor. Delete asks twice in place: a second
// modal over this sheet would not show on iOS (one presented modal at a time).
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheet, ClockTimeField, WeekdayMaskPicker } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import type { CourtRoutineInput } from '../../data/courtRoutines';
import type { CourtFavorite } from '../../data/courtFavorites';
import type { FriendRow } from '../../lib/friendship';
import PlayPlanFields from './PlayPlanFields';

export type RoutineDraft = CourtRoutineInput & { venueName: string };

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

  if (!draft) return null;
  const set = (patch: Partial<RoutineDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const canSave = !!draft.venueId && draft.days > 0 && !saving && !deleting;
  // The court picked may no longer be starred (an edit of a dormant routine): keep it shown.
  const courts: { venue_id: string; venue_name: string }[] = starred.some((s) => s.venue_id === draft.venueId) || !draft.venueId
    ? starred
    : [{ venue_id: draft.venueId, venue_name: draft.venueName }, ...starred];

  return (
    <BottomSheet visible={visible} onClose={onClose} title={initial?.id ? 'Edit routine' : 'New routine'} height="90%">
      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <Text style={[t.label, S.label]}>COURT</Text>
        {courts.length === 0 ? (
          <Text style={t.hint}>Star a court first.</Text>
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
                  <Icon name="star" size={16} color={c.primary} />
                  <Text style={[t.title, S.shrink, { color: on ? c.primary : c.text }]} numberOfLines={1}>
                    {f.venue_name}
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

        <PlayPlanFields
          lengthMin={draft.lengthMin}
          windows={draft.windows}
          onChange={set}
          startClock={draft.localTime}
          friends={friends}
        />

        <Button
          title={initial?.id ? 'Save' : 'Add routine'}
          iconName="check-mark"
          loading={saving}
          disabled={!canSave}
          onPress={() => onSave(draft)}
          style={S.save}
        />
        {onDelete ? (
          <Button
            title={confirmingDelete ? 'Tap again to delete' : 'Delete'}
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  court: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    borderWidth: 1.5,
    borderRadius: RADIUS.md,
    minHeight: 44,
    paddingHorizontal: SPACE.md,
    maxWidth: '100%',
    justifyContent: 'center',
  },
  shrink: { flexShrink: 1 },
  save: { marginTop: SPACE.md, minHeight: 48 },
});
