import React, { useMemo, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';
import {
  DrillSlot, dateLabel, dateSubLabel, slotLabel,
} from '../lib/drillTime';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSent: () => void;
  fromUserId: string;
  toUserId: string;
  toName: string;
  overlapSlots: DrillSlot[];
};

export default function DrillRequestModal({
  visible, onClose, onSent, fromUserId, toUserId, toName, overlapSlots,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lengthMinutes, setLengthMinutes] = useState<number>(60);

  const LENGTH_OPTIONS = [30, 60, 90, 120];

  // Group slots by date for display
  const groups = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const s of overlapSlots) {
      (m[s.date] = m[s.date] || []).push(s.slot);
    }
    return m;
  }, [overlapSlots]);

  function key(s: DrillSlot) { return `${s.date}|${s.slot}`; }

  function toggle(s: DrillSlot) {
    const k = key(s);
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  }

  async function send() {
    if (picked.size === 0) {
      Alert.alert('Pick at least one time', 'Tap one or more slots that work for you.');
      return;
    }
    setSending(true);
    const proposed = Array.from(picked).map(k => {
      const [date, slot] = k.split('|');
      return { date, slot: Number(slot) };
    });
    const { error } = await supabase.from('drill_requests').insert({
      from_user_id: fromUserId,
      to_user_id:   toUserId,
      proposed_slots: proposed,
      message: message.trim() || null,
      length_minutes: lengthMinutes,
    });
    setSending(false);
    if (error) {
      Alert.alert('Failed to send', error.message);
    } else {
      setPicked(new Set());
      setMessage('');
      setLengthMinutes(60);
      onSent();
      onClose();
    }
  }

  function handleClose() {
    setPicked(new Set());
    setMessage('');
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={S.root}>
        <View style={S.header}>
          <TouchableOpacity onPress={handleClose} style={S.headerBtn}>
            <Text style={S.headerCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={S.headerTitle}>Drill with {toName}</Text>
          <TouchableOpacity onPress={send} style={S.headerBtn} disabled={sending}>
            {sending
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Text style={[S.headerSend, picked.size === 0 && { opacity: 0.4 }]}>Send</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={S.scroll}>
          <Text style={S.intro}>
            Pick the times that work for you. {toName} can accept any one of them.
          </Text>

          {Object.keys(groups).length === 0 ? (
            <View style={S.emptyBox}>
              <Text style={S.emptyText}>No overlapping slots in the next 7 days. Try expanding your availability!</Text>
            </View>
          ) : (
            Object.entries(groups).map(([date, slots]) => (
              <View key={date} style={S.dateGroup}>
                <Text style={S.dateLabel}>{dateLabel(date)} · {dateSubLabel(date)}</Text>
                <View style={S.slotRow}>
                  {slots.map(slot => {
                    const k = `${date}|${slot}`;
                    const on = picked.has(k);
                    return (
                      <TouchableOpacity
                        key={slot}
                        style={[S.slotChip, on && S.slotChipOn]}
                        onPress={() => toggle({ date, slot })}
                        activeOpacity={0.7}
                      >
                        <Text style={[S.slotChipText, on && S.slotChipTextOn]}>{slotLabel(slot)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))
          )}

          <Text style={S.label}>Session length</Text>
          <View style={S.lengthRow}>
            {LENGTH_OPTIONS.map(m => {
              const on = lengthMinutes === m;
              return (
                <TouchableOpacity
                  key={m}
                  style={[S.lengthChip, on && S.lengthChipOn]}
                  onPress={() => setLengthMinutes(m)}
                  activeOpacity={0.7}
                >
                  <Text style={[S.lengthChipText, on && S.lengthChipTextOn]}>
                    {m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={S.label}>Optional message</Text>
          <TextInput
            style={S.messageInput}
            value={message}
            onChangeText={setMessage}
            placeholder={`Hey ${toName}, want to drill some dinks?`}
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={300}
            textAlignVertical="top"
          />
          <Text style={S.charCount}>{message.length}/300</Text>

          {picked.size > 0 && (
            <Text style={S.summary}>
              📨 Sending {picked.size} time slot{picked.size !== 1 ? 's' : ''} for {toName} to choose from.
            </Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface },
    headerBtn:   { minWidth: 60, alignItems: 'center' },
    headerCancel:{ fontSize: 15, color: c.textMuted },
    headerTitle: { fontSize: 17, fontWeight: '800', color: c.text, flex: 1, textAlign: 'center' },
    headerSend:  { fontSize: 15, color: c.primary, fontWeight: '700' },

    scroll:      { padding: 16, paddingBottom: 60 },
    intro:       { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 16 },

    emptyBox:    { padding: 32, backgroundColor: c.surface, borderRadius: 14, alignItems: 'center' },
    emptyText:   { fontSize: 14, color: c.textMuted, textAlign: 'center' },

    dateGroup:   { marginBottom: 16, backgroundColor: c.surface, borderRadius: 14, padding: 14, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
    dateLabel:   { fontSize: 13, fontWeight: '800', color: c.text, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
    slotRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    slotChip:    { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    slotChipOn:  { borderColor: c.primary, backgroundColor: c.primaryLight },
    slotChipText:{ fontSize: 13, color: c.textSub, fontWeight: '600' },
    slotChipTextOn:{ color: c.primary, fontWeight: '800' },

    label:       { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 12, marginBottom: 6 },
    lengthRow:   { flexDirection: 'row', gap: 8, marginBottom: 4 },
    lengthChip:  { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    lengthChipOn:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    lengthChipText:  { fontSize: 14, color: c.textSub, fontWeight: '700' },
    lengthChipTextOn:{ color: c.primary, fontWeight: '800' },
    messageInput:{ borderWidth: 1.5, borderColor: c.border, borderRadius: 12, padding: 14, fontSize: 14, color: c.text, backgroundColor: c.surface, minHeight: 80 },
    charCount:   { fontSize: 11, color: c.textMuted, textAlign: 'right', marginTop: 4 },

    summary:     { fontSize: 13, color: c.primary, textAlign: 'center', marginTop: 16, fontWeight: '600' },
  });
}
