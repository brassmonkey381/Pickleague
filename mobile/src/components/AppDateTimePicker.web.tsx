import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  visible: boolean;
  value: Date;
  minimumDate?: Date;
  onChange: (date: Date) => void;
  onClose: () => void;
};

function toInputString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AppDateTimePicker({ visible, value, minimumDate, onChange, onClose }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [temp, setTemp] = useState(toInputString(value));
  const inputRef = useRef<any>(null);

  useEffect(() => {
    if (visible) setTemp(toInputString(value));
  }, [visible]);

  // Auto-open the browser's native date/time picker as soon as the sheet
  // becomes visible. showPicker() requires a recent browser (Chrome 99+,
  // Safari 16.4+, Firefox 101+) and must be called from a user-gesture
  // stack; the click on the field that triggered visibility qualifies.
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => {
      const el = inputRef.current as HTMLInputElement | null;
      if (!el) return;
      try {
        el.focus();
        if (typeof (el as any).showPicker === 'function') {
          (el as any).showPicker();
        }
      } catch {
        // Older browsers or detached input — fall back to manual click.
      }
    }, 50);
    return () => clearTimeout(id);
  }, [visible]);

  if (!visible) return null;

  const input = React.createElement('input', {
    ref: inputRef,
    type: 'datetime-local',
    value: temp,
    min: minimumDate ? toInputString(minimumDate) : undefined,
    onChange: (e: any) => setTemp(e.target.value),
    style: {
      fontSize: 18,
      padding: '20px',
      width: '100%',
      border: 'none',
      outline: 'none',
      backgroundColor: colors.surface,
      boxSizing: 'border-box',
      color: colors.text,
      cursor: 'pointer',
    },
  });

  return (
    <View style={S.overlay}>
      <Pressable style={S.backdrop} onPress={onClose} />
      <View style={S.sheet}>
        <View style={S.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={S.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={S.title}>Select Date & Time</Text>
          <TouchableOpacity
            onPress={() => { onChange(new Date(temp)); onClose(); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={S.done}>Done</Text>
          </TouchableOpacity>
        </View>
        <View style={S.inputWrapper}>
          {input}
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay: {
      // @ts-ignore — 'fixed' is valid in RN Web but not in RN ViewStyle types
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
      zIndex: 9999,
    },
    backdrop: {
      flex: 1,
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: 40,
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 20,
      elevation: 10,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: {
      fontSize: 15,
      fontWeight: '600',
      color: c.text,
    },
    cancel: {
      fontSize: 16,
      color: c.textMuted,
    },
    done: {
      fontSize: 16,
      color: c.primary,
      fontWeight: '700',
    },
    inputWrapper: {
      paddingVertical: 8,
    },
  });
}
