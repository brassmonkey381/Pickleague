import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import RNDateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  visible: boolean;
  value: Date;
  minimumDate?: Date;
  onChange: (date: Date) => void;
  onClose: () => void;
};

// iOS: bottom-sheet modal with a combined date+time spinner and Cancel/Done buttons.
// Android: sequential native date dialog then time dialog (key trick forces remount between them).
export default function AppDateTimePicker({ visible, value, minimumDate, onChange, onClose }: Props) {
  const { colors: c } = useTheme();
  const styles = makeStyles(c);

  const [phase, setPhase] = useState<'date' | 'time'>('date');
  const [tempDate, setTempDate] = useState<Date>(new Date(value));
  const [iosValue, setIosValue] = useState<Date>(new Date(value));

  useEffect(() => {
    if (visible) {
      setPhase('date');
      setTempDate(new Date(value));
      setIosValue(new Date(value));
    }
  }, [visible]);

  if (!visible) return null;

  // ── iOS ──────────────────────────────────────────────────────────────
  if (Platform.OS === 'ios') {
    return (
      <Modal transparent animationType="slide" visible onRequestClose={onClose}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.cancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { onChange(iosValue); onClose(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.done}>Done</Text>
              </TouchableOpacity>
            </View>
            <RNDateTimePicker
              value={iosValue}
              mode="datetime"
              display="spinner"
              minimumDate={minimumDate}
              onChange={(_e: DateTimePickerEvent, date?: Date) => { if (date) setIosValue(date); }}
            />
          </View>
        </View>
      </Modal>
    );
  }

  // ── Android ──────────────────────────────────────────────────────────
  // Native dialog opens on mount. Using `key={phase}` forces unmount→remount
  // when switching from date to time, which opens the second native dialog.
  function handleAndroidChange(event: DateTimePickerEvent, date?: Date) {
    if (!date || event.type === 'dismissed') {
      onClose();
      return;
    }
    if (phase === 'date') {
      const merged = new Date(tempDate);
      merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
      setTempDate(merged);
      setPhase('time'); // key change → remount → time dialog opens
    } else {
      const final = new Date(tempDate);
      final.setHours(date.getHours(), date.getMinutes(), 0, 0);
      onChange(final);
      onClose();
    }
  }

  return (
    <RNDateTimePicker
      key={phase}
      value={tempDate}
      mode={phase}
      minimumDate={phase === 'date' ? minimumDate : undefined}
      onChange={handleAndroidChange}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingBottom: 32,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    cancel: { fontSize: 16, color: c.textMuted },
    done: { fontSize: 16, color: c.primary, fontWeight: '700' },
  });
}
