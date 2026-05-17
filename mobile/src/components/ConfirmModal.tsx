import React, { ReactNode, useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Pressable } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

/**
 * Reusable "Are you sure?" Modal.
 *
 * Replaces the hand-rolled Modal + Cancel/Action button row that lived in
 * ~8 places (Delete Tournament, Lock-In Bracket, Disband/Leave team flows,
 * Sign Out, Delete Account, etc.) plus the multi-button Alert.alert calls
 * that silently OK-collapsed on web.
 *
 * Variants:
 *   - variant='primary'  → green primary button (default)
 *   - variant='danger'   → red destructive button
 *
 * Optional knobs:
 *   - body: paragraph below the title
 *   - extraField: anything (e.g., a password TextInput) rendered between body
 *     and buttons. Used by Delete Account.
 *   - error: inline error message rendered above the buttons in red.
 *   - busy: shows a spinner in the primary button + disables onRequestClose
 *     so the backdrop tap can't dismiss mid-action.
 *   - primaryDisabled: external gate (e.g., require non-empty password).
 */
export type ConfirmModalProps = {
  visible: boolean;
  title: string;
  body?: string | ReactNode;
  primaryLabel: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  busy?: boolean;
  error?: string | null;
  extraField?: ReactNode;
  primaryDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function ConfirmModal({
  visible, title, body, primaryLabel, cancelLabel = 'Cancel',
  variant = 'primary', busy = false, error = null, extraField,
  primaryDisabled = false, onConfirm, onClose,
}: ConfirmModalProps) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const isDanger = variant === 'danger';

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!busy && e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, busy, onClose]);

  const isWeb = Platform.OS === 'web';

  const card = (
    <View style={S.card}>
      <Text style={[S.title, isDanger && { color: c.danger }]}>{title}</Text>
      {body != null && (
        typeof body === 'string'
          ? <Text style={S.body}>{body}</Text>
          : body
      )}
      {extraField}
      {error ? <Text style={S.error}>{error}</Text> : null}
      <View style={S.btnRow}>
        <TouchableOpacity
          style={[S.btn, S.btnSecondary]}
          onPress={onClose}
          disabled={busy}
        >
          <Text style={S.btnSecondaryText}>{cancelLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            S.btn,
            isDanger ? S.btnDanger : S.btnPrimary,
            (busy || primaryDisabled) && S.btnDim,
          ]}
          onPress={onConfirm}
          disabled={busy || primaryDisabled}
        >
          {busy
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={S.btnPrimaryText}>{primaryLabel}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => (busy ? null : onClose())}
    >
      {isWeb ? (
        <Pressable
          style={S.backdrop}
          onPress={(e: any) => {
            if (busy) return;
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {card}
        </Pressable>
      ) : (
        <View style={S.backdrop}>{card}</View>
      )}
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
    card:            { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: 14, padding: 22 },
    title:           { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 10 },
    body:            { fontSize: 14, color: c.textSub, lineHeight: 20, marginBottom: 12 },
    error:           { color: '#c62828', fontSize: 13, fontWeight: '600', marginBottom: 10 },
    btnRow:          { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
    btn:             { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, minWidth: 96, alignItems: 'center', justifyContent: 'center' },
    btnSecondary:    { backgroundColor: c.surfaceAlt },
    btnSecondaryText:{ color: c.textSub, fontWeight: '700' },
    btnPrimary:      { backgroundColor: c.primary },
    btnDanger:       { backgroundColor: '#c62828' },
    btnPrimaryText:  { color: '#fff', fontWeight: '800' },
    btnDim:          { opacity: 0.5 },
  });
}
