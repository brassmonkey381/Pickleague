import React, { useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable, Platform } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// Replacement for Alert.alert with 3+ buttons, which silently collapses to
// a single OK on web. Use this anywhere you'd reach for an action sheet
// (kebab menus, "what do you want to do with this row" prompts).

export type ActionSheetAction = {
  label:    string;
  style?:   'default' | 'destructive';
  onPress:  () => void;
};

type Props = {
  visible:    boolean;
  title?:     string;
  subtitle?:  string;
  actions:    ActionSheetAction[];
  onClose:    () => void;
  cancelLabel?: string;
};

export default function ActionSheetModal({
  visible, title, subtitle, actions, onClose, cancelLabel = 'Cancel',
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={S.backdrop} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <View style={S.card}>
          {title && <Text style={S.title}>{title}</Text>}
          {subtitle && <Text style={S.subtitle}>{subtitle}</Text>}
          <View style={S.actions}>
            {actions.map(a => {
              const danger = a.style === 'destructive';
              return (
                <TouchableOpacity
                  key={a.label}
                  style={[S.actionBtn, danger && S.actionBtnDanger]}
                  onPress={() => { a.onPress(); onClose(); }}
                >
                  <Text style={[S.actionText, danger && S.actionTextDanger]}>{a.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={S.cancelBtn} onPress={onClose}>
            <Text style={S.cancelText}>{cancelLabel}</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
    card:            { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: 14, padding: 18 },
    title:           { fontSize: 17, fontWeight: '800', color: c.text, marginBottom: 4 },
    subtitle:        { fontSize: 13, color: c.textMuted, marginBottom: 14 },
    actions:         { gap: 8 },
    actionBtn:       { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
    actionBtnDanger: { backgroundColor: '#ffebee', borderColor: '#ef9a9a' },
    actionText:      { fontSize: 14, fontWeight: '700', color: c.text },
    actionTextDanger:{ color: '#c62828' },
    cancelBtn:       { paddingVertical: 12, alignItems: 'center', marginTop: 10, borderTopWidth: 1, borderTopColor: c.border },
    cancelText:      { fontSize: 14, fontWeight: '700', color: c.textMuted },
  });
}
