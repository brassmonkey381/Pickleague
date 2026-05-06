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
          return field === 'start' ? { ...s, startsAt: picked } : { ...s, endsAt: picked };
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
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/* Title */}
        <Text style={styles.label}>Event Title</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. May League Night"
          value={title}
          onChangeText={setTitle}
        />

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Location, notes..."
          value={description}
          onChangeText={setDescription}
          multiline
        />

        {/* Vote deadline */}
        <Text style={styles.sectionHeader}>Vote Deadline</Text>
        <Text style={styles.hint}>Players have until this time to mark their availability.</Text>

        <View style={styles.presetRow}>
          {DEADLINE_PRESETS.map((p) => (
            <TouchableOpacity
              key={p.hours}
              style={[styles.presetBtn, deadlinePreset === p.hours && !customDeadline && styles.presetBtnActive]}
              onPress={() => { setDeadlinePreset(p.hours); setCustomDeadline(null); }}
            >
              <Text style={[styles.presetBtnText, deadlinePreset === p.hours && !customDeadline && styles.presetBtnTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.presetBtn, !!customDeadline && styles.presetBtnActive]}
            onPress={editDeadline}
          >
            <Text style={[styles.presetBtnText, !!customDeadline && styles.presetBtnTextActive]}>Custom</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.deadlineDisplay} onPress={editDeadline}>
          <Text style={styles.deadlineLabel}>Closes</Text>
          <Text style={styles.deadlineValue}>
            {voteEndsAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            {'  '}
            {voteEndsAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </TouchableOpacity>

        {/* Proposed slots */}
        <Text style={styles.sectionHeader}>Proposed Time Options</Text>
        <Text style={styles.hint}>Add 2–6 options. Players vote for the ones they can attend.</Text>

        {slots.map((slot, i) => (
          <View key={i} style={styles.slotCard}>
            <View style={styles.slotHeader}>
              <Text style={styles.slotNum}>Option {i + 1}</Text>
              {slots.length > 2 && (
                <TouchableOpacity onPress={() => removeSlot(i)}>
                  <Text style={styles.removeBtn}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.slotRow}>
              <TouchableOpacity style={styles.timeBtn} onPress={() => editSlot(i, 'start')}>
                <Text style={styles.timeBtnLabel}>Start</Text>
                <Text style={styles.timeBtnDate}>{fmtDate(slot.startsAt)}</Text>
                <Text style={styles.timeBtnTime}>{fmtTime(slot.startsAt)}</Text>
              </TouchableOpacity>
              <Text style={styles.arrow}>→</Text>
              <TouchableOpacity style={styles.timeBtn} onPress={() => editSlot(i, 'end')}>
                <Text style={styles.timeBtnLabel}>End</Text>
                <Text style={styles.timeBtnDate}>{fmtDate(slot.endsAt)}</Text>
                <Text style={styles.timeBtnTime}>{fmtTime(slot.endsAt)}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        {slots.length < 6 && (
          <TouchableOpacity style={styles.addSlotBtn} onPress={addSlot}>
            <Text style={styles.addSlotText}>+ Add another time option</Text>
          </TouchableOpacity>
        )}

        {/* Status message */}
        {statusMsg && (
          <View style={[styles.statusBox, statusMsg.isError ? styles.statusError : styles.statusSuccess]}>
            <Text style={[styles.statusText, statusMsg.isError ? styles.statusTextError : styles.statusTextSuccess]}>
              {statusMsg.isError ? '✕  ' : '✓  '}{statusMsg.text}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={submit}
          disabled={loading}
        >
          <Text style={styles.submitText}>
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

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#fff', flexGrow: 1, paddingBottom: 40 },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 16 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 14, fontSize: 16 },
  multiline: { height: 72, textAlignVertical: 'top' },
  sectionHeader: { fontSize: 16, fontWeight: '700', color: '#1a1a1a', marginTop: 28, marginBottom: 4 },
  hint: { fontSize: 13, color: '#888', marginBottom: 12 },
  presetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  presetBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd' },
  presetBtnActive: { borderColor: GREEN, backgroundColor: '#e8f5e9' },
  presetBtnText: { fontSize: 14, color: '#666', fontWeight: '500' },
  presetBtnTextActive: { color: GREEN, fontWeight: '700' },
  deadlineDisplay: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#f5f5f5', borderRadius: 8, padding: 12, marginBottom: 4 },
  deadlineLabel: { fontSize: 12, color: '#888', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  deadlineValue: { fontSize: 14, color: '#333', fontWeight: '600' },
  slotCard: { backgroundColor: '#f9f9f9', borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#eee' },
  slotHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  slotNum: { fontSize: 14, fontWeight: '700', color: '#333' },
  removeBtn: { fontSize: 13, color: '#c62828' },
  slotRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeBtn: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, backgroundColor: '#fff', alignItems: 'center' },
  timeBtnLabel: { fontSize: 10, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  timeBtnDate: { fontSize: 13, fontWeight: '600', color: '#333' },
  timeBtnTime: { fontSize: 12, color: GREEN, marginTop: 2, fontWeight: '600' },
  arrow: { fontSize: 18, color: '#bbb' },
  addSlotBtn: { borderWidth: 1.5, borderColor: GREEN, borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 8, borderStyle: 'dashed' },
  addSlotText: { color: GREEN, fontWeight: '600', fontSize: 15 },
  statusBox: { borderRadius: 8, padding: 14, marginTop: 12, marginBottom: 4 },
  statusError: { backgroundColor: '#ffebee' },
  statusSuccess: { backgroundColor: '#e8f5e9' },
  statusText: { fontSize: 14, fontWeight: '600' },
  statusTextError: { color: '#c62828' },
  statusTextSuccess: { color: GREEN },
  submitBtn: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 16 },
  submitBtnDisabled: { backgroundColor: '#a5d6a7' },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
