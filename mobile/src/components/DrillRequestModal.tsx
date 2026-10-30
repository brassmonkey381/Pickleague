import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator,
  Platform, Pressable,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';
import {
  DateSlot, dateLabel, dateSubLabel, slotLabel,
} from '../lib/drillTime';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Chip, Panel, SegmentedToggle } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { ToastOutlet } from '@just-messin-around/expo-foundation/toast';

const IS_WEB = Platform.OS === 'web';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSent: () => void;
  fromUserId: string;
  toUserId: string;
  toName: string;
  overlapSlots: DateSlot[];
};

export default function DrillRequestModal({
  visible, onClose, onSent, fromUserId, toUserId, toName, overlapSlots,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const t = textStyles(colors);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lengthMinutes, setLengthMinutes] = useState<number>(60);
  // Alert.alert renders nothing on react-native-web, so on the web build both
  // "pick a time" and "failed to send" were invisible.
  const status = useStatusMessage();
  const inFlight = useRef(false);

  const LENGTH_OPTIONS = [30, 60, 90, 120];

  // Group slots by date for display
  const groups = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const s of overlapSlots) {
      (m[s.date] = m[s.date] || []).push(s.slot);
    }
    return m;
  }, [overlapSlots]);

  function key(s: DateSlot) { return `${s.date}|${s.slot}`; }

  function toggle(s: DateSlot) {
    const k = key(s);
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  }

  async function send() {
    if (inFlight.current) return;
    if (picked.size === 0) {
      status.error('Tap one or more slots that work for you.');
      return;
    }
    inFlight.current = true;
    setSending(true);
    status.clear();
    const proposed = Array.from(picked).map(k => {
      const [date, slot] = k.split('|');
      return { date, slot: Number(slot) };
    });
    try {
      // Not retried: nothing dedupes drill_requests, so a retry after a lost
      // reply sends the same person two invitations.
      await sbCall(() => supabase.from('drill_requests').insert({
        from_user_id: fromUserId,
        to_user_id:   toUserId,
        proposed_slots: proposed,
        message: message.trim() || null,
        length_minutes: lengthMinutes,
      }), { retries: 0 });
      setPicked(new Set());
      setMessage('');
      setLengthMinutes(60);
      onSent();
      onClose();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Failed to send the request.'));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const handleClose = useCallback(() => {
    setPicked(new Set());
    setMessage('');
    onClose();
  }, [onClose]);

  const content = (
    <View style={S.root}>
        <View style={S.header}>
          <TouchableOpacity onPress={handleClose} style={S.headerBtn} disabled={sending} accessibilityRole="button">
            <Text style={[S.headerCancel, sending && S.dim]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[t.h3, S.headerTitle]} numberOfLines={1}>Drill with {toName}</Text>
          <TouchableOpacity onPress={send} style={S.headerBtn} disabled={sending} accessibilityRole="button" accessibilityLabel="Send drill request">
            {sending
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Text style={[S.headerSend, picked.size === 0 && S.dim]}>Send</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={S.scroll}>
          <Text style={[t.sub, S.intro]}>
            Pick the times that work for you. {toName} can accept any one of them.
          </Text>

          <StatusBanner status={status.value} />

          {Object.keys(groups).length === 0 ? (
            <Panel style={S.emptyBox}>
              <Text style={[t.hint, S.center]}>No overlapping slots in the next 7 days. Try expanding your availability!</Text>
            </Panel>
          ) : (
            Object.entries(groups).map(([date, slots]) => (
              <Panel key={date} style={S.dateGroup}>
                <Text style={[t.label, S.dateLabel]}>{dateLabel(date)} · {dateSubLabel(date)}</Text>
                <View style={S.slotRow}>
                  {slots.map(slot => {
                    const k = `${date}|${slot}`;
                    const on = picked.has(k);
                    return (
                      <Chip
                        key={slot}
                        label={slotLabel(slot)}
                        iconName={on ? 'check-mark' : undefined}
                        tone={on ? 'brand' : 'neutral'}
                        selected={on}
                        onPress={() => toggle({ date, slot })}
                        accessibilityRole="button"
                      />
                    );
                  })}
                </View>
              </Panel>
            ))
          )}

          <Text style={[t.fieldLabel, S.label]}>Session length</Text>
          <SegmentedToggle<number>
            size="lg"
            fullWidth
            value={lengthMinutes}
            onChange={setLengthMinutes}
            options={LENGTH_OPTIONS.map(m => ({
              value: m,
              label: m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`,
            }))}
            style={S.lengthRow}
          />

          <Text style={[t.fieldLabel, S.label]}>Optional message</Text>
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
          <Text style={[t.caption, S.charCount]}>{message.length}/300</Text>

          {picked.size > 0 && (
            <View style={S.summary}>
              <Icon name="mail" size={14} color={colors.primary} />
              <Text style={[t.sub, S.summaryText]}>
                Sending {picked.size} time slot{picked.size !== 1 ? 's' : ''} for {toName} to choose from.
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={IS_WEB ? 'fade' : 'slide'}
      transparent={IS_WEB}
      presentationStyle={IS_WEB ? undefined : 'pageSheet'}
      onRequestClose={handleClose}
    >
      {IS_WEB ? (
        <Pressable
          style={S.backdrop}
          onPress={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <View style={S.card}>{content}</View>
        </Pressable>
      ) : content}
      {/* Toasts and the pickle rain show above this Modal. */}
      <ToastOutlet />
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:    { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.xl },
    card:        { width: '100%', maxWidth: 560, maxHeight: '90%', backgroundColor: c.bg, borderRadius: RADIUS.lg, overflow: 'hidden' },
    root:        { flex: 1, backgroundColor: c.bg },
    header:      {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border, backgroundColor: c.surface,
    },
    headerBtn:   { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    headerCancel:{ fontSize: FONT.size.lg, color: c.textSub },
    headerTitle: { flex: 1, textAlign: 'center' },
    headerSend:  { fontSize: FONT.size.lg, color: c.primary, fontWeight: FONT.weight.bold },
    dim:         { opacity: 0.5 },
    center:      { textAlign: 'center' },

    // Clears the home indicator / keyboard edge.
    scroll:      { padding: SPACE.lg, paddingBottom: SPACE.xl * 2 + SPACE.md },
    intro:       { marginBottom: SPACE.lg },

    emptyBox:    { padding: SPACE.xl, alignItems: 'center' },

    dateGroup:   { marginBottom: SPACE.md },
    dateLabel:   { marginBottom: SPACE.sm },
    slotRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },

    label:       { marginTop: SPACE.md, marginBottom: SPACE.sm },
    lengthRow:   { marginBottom: SPACE.xs },
    messageInput:{
      borderWidth: 1.5, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md,
      fontSize: FONT.size.md, color: c.text, backgroundColor: c.surface, minHeight: 80,
    },
    charCount:   { textAlign: 'right', marginTop: SPACE.xs },

    summary:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, marginTop: SPACE.lg },
    summaryText: { color: c.primary, fontWeight: FONT.weight.semibold, flexShrink: 1, textAlign: 'center' },
  });
}
