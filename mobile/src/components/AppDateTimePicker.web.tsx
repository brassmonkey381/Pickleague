import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';

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
  const [temp, setTemp] = useState(toInputString(value));

  useEffect(() => {
    if (visible) setTemp(toInputString(value));
  }, [visible]);

  if (!visible) return null;

  const input = React.createElement('input', {
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
      backgroundColor: '#fff',
      boxSizing: 'border-box',
      color: '#1a1a1a',
      cursor: 'pointer',
    },
  });

  return (
    // position:'fixed' in RN Web maps to CSS position:fixed — escapes scroll containers
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Select Date & Time</Text>
          <TouchableOpacity
            onPress={() => { onChange(new Date(temp)); onClose(); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.done}>Done</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.inputWrapper}>
          {input}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: '#fff',
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
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  cancel: {
    fontSize: 16,
    color: '#888',
  },
  done: {
    fontSize: 16,
    color: '#2e7d32',
    fontWeight: '700',
  },
  inputWrapper: {
    paddingVertical: 8,
  },
});
