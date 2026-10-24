// "Report this player" sheet. One reason, an optional note, and a promise we
// can keep: reports land in content_reports, which the moderator queue in
// Godmode reads (App Store guideline 1.2 asks for action within 24 hours).
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import {
  REPORT_REASONS, ReportReason, ReportSubjectType, submitReport, SUPPORT_EMAIL,
} from '../lib/moderation';

type Props = {
  visible:       boolean;
  subjectUserId: string;
  subjectName:   string;
  subjectType?:  ReportSubjectType;
  subjectId?:    string | null;
  /** Copied into the report so the queue still has it if the author edits it. */
  snapshot?:     Record<string, unknown> | null;
  onClose:       () => void;
  /** Fired after a successful submit, so the caller can offer to block too. */
  onSubmitted?:  () => void;
};

export default function ReportPlayerModal({
  visible, subjectUserId, subjectName, subjectType = 'profile', subjectId = null,
  snapshot = null, onClose, onSubmitted,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [reason, setReason]   = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [done, setDone]       = useState(false);

  // Reopening the sheet for a different player must not inherit the last one's
  // reason, note, or "thanks" state.
  useEffect(() => {
    if (visible) { setReason(null); setDetails(''); setError(null); setDone(false); }
  }, [visible, subjectUserId]);

  async function send() {
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitReport({
        subjectUserId, subjectType, subjectId, reason,
        details, snapshot,
      });
      setDone(true);
      onSubmitted?.();
    } catch (e) {
      setError(friendlySbMessage(e, "We couldn't send that report. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
      <Pressable
        style={S.backdrop}
        onPress={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <View style={S.card}>
          {done ? (
            <View style={S.doneBox}>
              <Icon name="check" size={48} color={colors.success} style={S.doneIcon} />
              <Text style={S.title}>Report sent</Text>
              <Text style={S.doneBody}>
                Thanks — we review every report and act within 24 hours, removing content and
                removing accounts where needed. You can also block {subjectName} so you stop
                seeing each other entirely.
              </Text>
              <Text style={S.support}>Questions? {SUPPORT_EMAIL}</Text>
              <TouchableOpacity style={[S.primaryBtn, S.doneBtn]} onPress={onClose} accessibilityRole="button">
                <Text style={S.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={S.title}>Report {subjectName}</Text>
              <Text style={S.subtitle}>What's going on? This is not shared with them.</Text>

              <ScrollView style={S.reasons} keyboardShouldPersistTaps="handled">
                {REPORT_REASONS.map(r => {
                  const on = reason === r.key;
                  return (
                    <TouchableOpacity
                      key={r.key}
                      style={[S.reasonRow, on && S.reasonRowOn]}
                      onPress={() => setReason(r.key)}
                      activeOpacity={0.8}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      aria-checked={on}
                    >
                      <View style={[S.radio, on && S.radioOn]}>
                        {on && <View style={S.radioDot} />}
                      </View>
                      <View style={S.flex}>
                        <Text style={[S.reasonLabel, on && S.reasonLabelOn]}>{r.label}</Text>
                        <Text style={S.reasonHint}>{r.hint}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}

                <Text style={S.fieldLabel}>Anything else? (optional)</Text>
                <TextInput
                  style={S.input}
                  value={details}
                  onChangeText={setDetails}
                  placeholder="What happened, and where"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={2000}
                  editable={!busy}
                />
              </ScrollView>

              {error && <Text style={S.error}>{error}</Text>}

              <View style={S.btnRow}>
                <TouchableOpacity style={S.cancelBtn} onPress={onClose} disabled={busy} accessibilityRole="button">
                  <Text style={S.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.primaryBtn, (!reason || busy) && S.primaryBtnOff]}
                  onPress={send}
                  disabled={!reason || busy}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !reason || busy, busy }}
                >
                  {busy
                    ? <ActivityIndicator color={colors.textInverse} />
                    : <Text style={S.primaryBtnText}>Send report</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

// The radio mark: a 20 ring with a 10 dot, centred on the label's first line.
const RADIO = 20;

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    backdrop:   { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.lg },
    card:       { width: '100%', maxWidth: 460, maxHeight: '86%', backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg },
    flex:       { flex: 1 },
    title:      { ...t.h3, marginBottom: SPACE.xs },
    subtitle:   { ...t.hint, marginBottom: SPACE.md },
    reasons:    { marginBottom: SPACE.xs },
    reasonRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, marginBottom: SPACE.sm },
    reasonRowOn:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    radio:      { width: RADIO, height: RADIO, borderRadius: RADIUS.pill, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginTop: SPACE.xxs / 2 },
    radioOn:    { borderColor: c.primary },
    radioDot:   { width: RADIO / 2, height: RADIO / 2, borderRadius: RADIUS.pill, backgroundColor: c.primary },
    reasonLabel:t.title,
    reasonLabelOn: { color: c.primary },
    reasonHint: { ...t.hint, marginTop: SPACE.xxs },
    fieldLabel: { ...t.fieldLabel, marginTop: SPACE.sm, marginBottom: SPACE.xs },
    input:      { borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, minHeight: 80, fontSize: FONT.size.md, color: c.text, backgroundColor: c.surfaceAlt, textAlignVertical: 'top' },
    error:      { ...t.sub, color: c.danger, marginTop: SPACE.sm },
    btnRow:     { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
    cancelBtn:  { flex: 1, minHeight: 44, paddingVertical: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    cancelBtnText: { ...t.title, color: c.textSub },
    primaryBtn: { flex: 1, minHeight: 44, paddingVertical: SPACE.md, borderRadius: RADIUS.md, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center' },
    // The done state's single button: full width of the centred box.
    doneBtn:    { alignSelf: 'stretch', flex: 0 },
    primaryBtnOff: { opacity: 0.5 },
    primaryBtnText: { ...t.title, color: c.textInverse },
    doneBox:    { alignItems: 'center', paddingVertical: SPACE.sm },
    doneIcon:   { marginBottom: SPACE.sm },
    doneBody:   { ...t.bodySub, textAlign: 'center', marginTop: SPACE.xs },
    support:    { ...t.hint, marginTop: SPACE.sm, marginBottom: SPACE.md },
  });
}
