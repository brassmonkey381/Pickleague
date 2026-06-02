import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import AppDateTimePicker from '../components/AppDateTimePicker';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'CreateEvent'>;
  route: RouteProp<RootStackParamList, 'CreateEvent'>;
};

type SlotDraft = { startsAt: Date; endsAt: Date };

type ActivePicker = {
  value: Date;
  minimumDate?: Date;
  onPick: (date: Date) => void;
};

const DEADLINE_PRESETS = [
  { label: '12 hours', hours: 12 },
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
];

function addHours(h: number): Date {
  return new Date(Date.now() + h * 3600 * 1000);
}

function defaultSlot(offsetDays: number): SlotDraft {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start);
  end.setHours(20, 0, 0, 0);
  return { startsAt: start, endsAt: end };
}

function fmtDate(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function CreateEventScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadlinePreset, setDeadlinePreset] = useState<number>(24);
  const [customDeadline, setCustomDeadline] = useState<Date | null>(null);
  const [slots, setSlots] = useState<SlotDraft[]>([defaultSlot(1), defaultSlot(2)]);

  // Single shared picker state
  const [activePicker, setActivePicker] = useState<ActivePicker | null>(null);

  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const voteEndsAt = customDeadline ?? addHours(deadlinePreset);

  function openPicker(value: Date, minimumDate: Date | undefined, onPick: (d: Date) => void) {
    setActivePicker({ value, minimumDate, onPick });
  }

  function editSlot(slotIndex: number, field: 'start' | 'end') {
    const current = field === 'start' ? slots[slotIndex].startsAt : slots[slotIndex].endsAt;
    openPicker(current, field === 'start' ? new Date() : undefined, (picked) => {
      setSlots((prev) =>
        prev.map((s, i) => {
          if (i !== slotIndex) return s;
          if (field === 'end') return { ...s, endsAt: picked };
          // Moving the start: if it lands at/past the current end, carry the end
          // forward by the original duration so the slot keeps its length
          // (e.g. a 16h slot pushed 7 days out stays 16h long). Otherwise leave
          // the end where the user put it.
          const durationMs = s.endsAt.getTime() - s.startsAt.getTime();
          if (picked.getTime() >= s.endsAt.getTime()) {
            return { ...s, startsAt: picked, endsAt: new Date(picked.getTime() + durationMs) };
          }
          return { ...s, startsAt: picked };
        })
      );
      setActivePicker(null);
    });
  }

  function editDeadline() {
    const current = customDeadline ?? addHours(deadlinePreset);
    setCustomDeadline(current); // highlight button immediately on click
    openPicker(current, new Date(), (picked) => {
      setCustomDeadline(picked);
      setActivePicker(null);
    });
  }

  function addSlot() {
    if (slots.length >= 6) return;
    setSlots([...slots, defaultSlot(slots.length + 1)]);
  }

  function removeSlot(index: number) {
    if (slots.length <= 2) return;
    setSlots(slots.filter((_, i) => i !== index));
  }

  async function submit() {
    setStatusMsg(null);

    if (!title.trim()) {
      setStatusMsg({ text: 'Please enter an event title.', isError: true });
      return;
    }
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].endsAt <= slots[i].startsAt) {
        setStatusMsg({ text: `Option ${i + 1}: end time must be after start time.`, isError: true });
        return;
      }
    }
    if (voteEndsAt <= new Date()) {
      setStatusMsg({ text: 'Vote deadline must be in the future.', isError: true });
      return;
    }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();

    const { data: event, error: eventErr } = await supabase
      .from('league_events')
      .insert({
        league_id: leagueId,
        title: title.trim(),
        description: description.trim() || null,
        created_by: user!.id,
        vote_ends_at: voteEndsAt.toISOString(),
      })
      .select()
      .single();

    if (eventErr || !event) {
      setStatusMsg({ text: eventErr?.message ?? 'Failed to create event. Please try again.', isError: true });
      setLoading(false);
      return;
    }

    const { error: slotsErr } = await supabase.from('event_slots').insert(
      slots.map((s) => ({
        event_id: event.id,
        starts_at: s.startsAt.toISOString(),
        ends_at: s.endsAt.toISOString(),
      }))
    );

    setLoading(false);

    if (slotsErr) {
      setStatusMsg({ text: slotsErr.message, isError: true });
      return;
    }

    setStatusMsg({ text: 'Event created! Voting is now open.', isError: false });
    setTimeout(() => navigation.goBack(), 1200);
  }

  return (
    <>
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        {/* Title */}
        <Text style={S.label}>Event Title</Text>
        <TextInput
          style={S.input}
          placeholder="e.g. May League Night"
          placeholderTextColor={colors.textMuted}
          value={title}
          onChangeText={setTitle}
        />

        <Text style={S.label}>Description (optional)</Text>
        <TextInput
          style={[S.input, S.multiline]}
          placeholder="Location, notes..."
          placeholderTextColor={colors.textMuted}
          value={description}
          onChangeText={setDescription}
          multiline
        />

        {/* Vote deadline */}
        <Text style={S.sectionHeader}>Vote Deadline</Text>
        <Text style={S.hint}>Players have until this time to mark their availability.</Text>

        <View style={S.presetRow}>
          {DEADLINE_PRESETS.map((p) => (
            <TouchableOpacity
              key={p.hours}
              style={[S.presetBtn, deadlinePreset === p.hours && !customDeadline && S.presetBtnActive]}
              onPress={() => { setDeadlinePreset(p.hours); setCustomDeadline(null); }}
            >
              <Text style={[S.presetBtnText, deadlinePreset === p.hours && !customDeadline && S.presetBtnTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[S.presetBtn, !!customDeadline && S.presetBtnActive]}
            onPress={editDeadline}
          >
            <Text style={[S.presetBtnText, !!customDeadline && S.presetBtnTextActive]}>Custom</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={S.deadlineDisplay} onPress={editDeadline}>
          <Text style={S.deadlineLabel}>Closes</Text>
          <Text style={S.deadlineValue}>
            {voteEndsAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            {'  '}
            {voteEndsAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </TouchableOpacity>

        {/* Proposed slots */}
        <Text style={S.sectionHeader}>Proposed Time Options</Text>
        <Text style={S.hint}>Add 2–6 options. Players vote for the ones they can attend.</Text>

        {slots.map((slot, i) => (
          <View key={i} style={S.slotCard}>
            <View style={S.slotHeader}>
              <Text style={S.slotNum}>Option {i + 1}</Text>
              {slots.length > 2 && (
                <TouchableOpacity onPress={() => removeSlot(i)}>
                  <Text style={S.removeBtn}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={S.slotRow}>
              <TouchableOpacity style={S.timeBtn} onPress={() => editSlot(i, 'start')}>
                <Text style={S.timeBtnLabel}>Start</Text>
                <Text style={S.timeBtnDate}>{fmtDate(slot.startsAt)}</Text>
                <Text style={S.timeBtnTime}>{fmtTime(slot.startsAt)}</Text>
              </TouchableOpacity>
              <Text style={S.arrow}>→</Text>
              <TouchableOpacity style={S.timeBtn} onPress={() => editSlot(i, 'end')}>
                <Text style={S.timeBtnLabel}>End</Text>
                <Text style={S.timeBtnDate}>{fmtDate(slot.endsAt)}</Text>
                <Text style={S.timeBtnTime}>{fmtTime(slot.endsAt)}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        {slots.length < 6 && (
          <TouchableOpacity style={S.addSlotBtn} onPress={addSlot}>
            <Text style={S.addSlotText}>+ Add another time option</Text>
          </TouchableOpacity>
        )}

        {/* Status message */}
        {statusMsg && (
          <View style={[S.statusBox, statusMsg.isError ? S.statusError : S.statusSuccess]}>
            <Text style={[S.statusText, statusMsg.isError ? S.statusTextError : S.statusTextSuccess]}>
              {statusMsg.isError ? '✕  ' : '✓  '}{statusMsg.text}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[S.submitBtn, loading && S.submitBtnDisabled]}
          onPress={submit}
          disabled={loading}
        >
          <Text style={S.submitText}>
            {loading ? 'Creating...' : 'Create Event & Open Voting'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Picker rendered outside ScrollView so it's not clipped */}
      <AppDateTimePicker
        visible={activePicker !== null}
        value={activePicker?.value ?? new Date()}
        minimumDate={activePicker?.minimumDate}
        onChange={(date) => activePicker?.onPick(date)}
        onClose={() => setActivePicker(null)}
      />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 20, backgroundColor: c.surface, flexGrow: 1, paddingBottom: 40 },
    label: { fontSize: 14, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 16 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, fontSize: 16, backgroundColor: c.surface, color: c.text },
    multiline: { height: 72, textAlignVertical: 'top' },
    sectionHeader: { fontSize: 16, fontWeight: '700', color: c.text, marginTop: 28, marginBottom: 4 },
    hint: { fontSize: 13, color: c.textMuted, marginBottom: 12 },
    presetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
    presetBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: c.border },
    presetBtnActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    presetBtnText: { fontSize: 14, color: c.textSub, fontWeight: '500' },
    presetBtnTextActive: { color: c.primary, fontWeight: '700' },
    deadlineDisplay: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.bg, borderRadius: 8, padding: 12, marginBottom: 4 },
    deadlineLabel: { fontSize: 12, color: c.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    deadlineValue: { fontSize: 14, color: c.text, fontWeight: '600' },
    slotCard: { backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    slotHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
    slotNum: { fontSize: 14, fontWeight: '700', color: c.text },
    removeBtn: { fontSize: 13, color: c.danger },
    slotRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    timeBtn: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, backgroundColor: c.surface, alignItems: 'center' },
    timeBtnLabel: { fontSize: 10, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
    timeBtnDate: { fontSize: 13, fontWeight: '600', color: c.text },
    timeBtnTime: { fontSize: 12, color: c.primary, marginTop: 2, fontWeight: '600' },
    arrow: { fontSize: 18, color: c.border },
    addSlotBtn: { borderWidth: 1.5, borderColor: c.primary, borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 8, borderStyle: 'dashed' },
    addSlotText: { color: c.primary, fontWeight: '600', fontSize: 15 },
    statusBox: { borderRadius: 8, padding: 14, marginTop: 12, marginBottom: 4 },
    statusError: { backgroundColor: '#ffebee' },
    statusSuccess: { backgroundColor: c.primaryLight },
    statusText: { fontSize: 14, fontWeight: '600' },
    statusTextError: { color: c.danger },
    statusTextSuccess: { color: c.primary },
    submitBtn: { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 16 },
    submitBtnDisabled: { backgroundColor: c.primary + '80' },
    submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
