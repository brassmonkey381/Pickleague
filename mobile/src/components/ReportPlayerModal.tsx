// "Report this player" sheet. One reason, an optional note, and a promise we
// can keep: reports land in content_reports, which the moderator queue in
// Godmode reads (App Store guideline 1.2 asks for action within 24 hours).
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Platform, Pressable, ActivityIndicator,
} from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import {
  REPORT_REASONS, ReportReason, ReportSubjectType, submitReport, SUPPORT_EMAIL,
} from '../lib/moderation';

const IS_WEB = Platform.OS === 'web';

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

  useEffect(() => {
    if (!IS_WEB || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, busy, onClose]);

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
              <Text style={S.doneIcon}>✅</Text>
              <Text style={S.title}>Report sent</Text>
              <Text style={S.doneBody}>
                Thanks — we review every report and act within 24 hours, removing content and
                removing accounts where needed. You can also block {subjectName} so you stop
                seeing each other entirely.
              </Text>
              <Text style={S.support}>Questions? {SUPPORT_EMAIL}</Text>
              <TouchableOpacity style={S.primaryBtn} onPress={onClose}>
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
                    >
                      <View style={[S.radio, on && S.radioOn]}>
                        {on && <View style={S.radioDot} />}
                      </View>
                      <View style={{ flex: 1 }}>
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
                <TouchableOpacity style={S.cancelBtn} onPress={onClose} disabled={busy}>
                  <Text style={S.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.primaryBtn, (!reason || busy) && S.primaryBtnOff]}
                  onPress={send}
                  disabled={!reason || busy}
                >
                  {busy
                    ? <ActivityIndicator color="#fff" />
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

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
    card:       { width: '100%', maxWidth: 460, maxHeight: '86%', backgroundColor: c.surface, borderRadius: 16, padding: 20 },
    title:      { fontSize: 19, fontWeight: '800', color: c.text, marginBottom: 4 },
    subtitle:   { fontSize: 13, color: c.textMuted, marginBottom: 12 },
    reasons:    { marginBottom: 4 },
    reasonRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: c.border, marginBottom: 8 },
    reasonRowOn:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    radio:      { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    radioOn:    { borderColor: c.primary },
    radioDot:   { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary },
    reasonLabel:{ fontSize: 15, fontWeight: '700', color: c.text },
    reasonLabelOn: { color: c.primary },
    reasonHint: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    fieldLabel: { fontSize: 13, fontWeight: '700', color: c.textSub, marginTop: 6, marginBottom: 6 },
    input:      { borderWidth: 1.5, borderColor: c.border, borderRadius: 12, padding: 12, minHeight: 80, color: c.text, backgroundColor: c.bg, textAlignVertical: 'top' },
    error:      { color: c.danger, fontSize: 13, marginTop: 10 },
    btnRow:     { flexDirection: 'row', gap: 10, marginTop: 14 },
    cancelBtn:  { flex: 1, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: c.border, alignItems: 'center' },
    cancelBtnText: { color: c.textSub, fontWeight: '700', fontSize: 15 },
    primaryBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center' },
    primaryBtnOff: { opacity: 0.45 },
    primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    doneBox:    { alignItems: 'center', paddingVertical: 8 },
    doneIcon:   { fontSize: 40, marginBottom: 8 },
    doneBody:   { fontSize: 14, color: c.textSub, textAlign: 'center', lineHeight: 20, marginTop: 6 },
    support:    { fontSize: 12, color: c.textMuted, marginTop: 10, marginBottom: 14 },
  });
}
