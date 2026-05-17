import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ScheduleMatch'>;
  route: RouteProp<RootStackParamList, 'ScheduleMatch'>;
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateInputString = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toTimeInputString = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

type ThemeColors = ReturnType<typeof useTheme>['colors'];

function WebPlayerSelect({
  value, onChange, members, colors,
}: {
  value: string;
  onChange: (v: string) => void;
  members: Profile[];
  colors: ThemeColors;
}) {
  return React.createElement(
    'select',
    {
      value,
      onChange: (e: any) => onChange(e.target.value),
      style: {
        fontSize: 15,
        padding: '11px 12px',
        width: '100%',
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        backgroundColor: colors.surface,
        color: value ? colors.text : colors.textMuted,
        outline: 'none',
        cursor: 'pointer',
        boxSizing: 'border-box',
      },
    },
    [
      React.createElement('option', { key: '', value: '' }, 'Select player...'),
      ...members.map((m) =>
        React.createElement('option', { key: m.id, value: m.id }, m.full_name)
      ),
    ]
  );
}

function webInputStyle(colors: ThemeColors) {
  return {
    fontSize: 15,
    padding: '13px 14px',
    width: '100%',
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.text,
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

export default function ScheduleMatchScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const { leagueId } = route.params;
  const [members, setMembers] = useState<Profile[]>([]);
  const [player1Id, setPlayer1Id] = useState('');
  const [player2Id, setPlayer2Id] = useState('');
  const [scheduledAt, setScheduledAt] = useState(new Date(Date.now() + 60 * 60 * 1000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadMembers(); }, []);

  async function loadMembers() {
    const { data } = await supabase
      .from('league_members')
      .select('profile:profiles(*)')
      .eq('league_id', leagueId);
    const profiles = (data ?? []).map((m: any) => m.profile).filter(Boolean);
    setMembers(profiles);
  }

  function onDateChange(_event: DateTimePickerEvent, date?: Date) {
    setShowDatePicker(false);
    if (date) {
      const merged = new Date(scheduledAt);
      merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
      setScheduledAt(merged);
      if (Platform.OS === 'android') setShowTimePicker(true);
    }
  }

  function onTimeChange(_event: DateTimePickerEvent, date?: Date) {
    setShowTimePicker(false);
    if (date) {
      const merged = new Date(scheduledAt);
      merged.setHours(date.getHours(), date.getMinutes());
      setScheduledAt(merged);
    }
  }

  async function scheduleMatch() {
    if (!player1Id || !player2Id) {
      Alert.alert('Error', 'Please select both players.');
      return;
    }
    if (player1Id === player2Id) {
      Alert.alert('Error', 'Players must be different.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.from('matches').insert({
      league_id: leagueId,
      player1_id: player1Id,
      player2_id: player2Id,
      status: 'scheduled',
      scheduled_at: scheduledAt.toISOString(),
    });
    setLoading(false);
    if (error) Alert.alert('Error', error.message);
    else { Alert.alert('Scheduled!', 'Match has been added to the calendar.'); navigation.goBack(); }
  }

  const formattedDate = scheduledAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const formattedTime = scheduledAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const isWeb = Platform.OS === 'web';

  const dateInput = isWeb
    ? React.createElement('input', {
        type: 'date',
        value: toDateInputString(scheduledAt),
        min: toDateInputString(new Date()),
        onChange: (e: any) => {
          const v: string = e.target.value;
          if (!v) return;
          const [y, mo, d] = v.split('-').map((n) => parseInt(n, 10));
          const merged = new Date(scheduledAt);
          merged.setFullYear(y, (mo || 1) - 1, d || 1);
          setScheduledAt(merged);
        },
        style: webInputStyle(c),
      })
    : null;

  const timeInput = isWeb
    ? React.createElement('input', {
        type: 'time',
        value: toTimeInputString(scheduledAt),
        onChange: (e: any) => {
          const v: string = e.target.value;
          if (!v) return;
          const [h, mi] = v.split(':').map((n) => parseInt(n, 10));
          const merged = new Date(scheduledAt);
          merged.setHours(h || 0, mi || 0, 0, 0);
          setScheduledAt(merged);
        },
        style: webInputStyle(c),
      })
    : null;

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.label}>Player 1</Text>
      {isWeb ? (
        <WebPlayerSelect value={player1Id} onChange={setPlayer1Id} members={members} colors={c} />
      ) : (
        <View style={S.pickerWrapper}>
          <Picker selectedValue={player1Id} onValueChange={setPlayer1Id}>
            <Picker.Item label="Select player..." value="" />
            {members.map((m) => <Picker.Item key={m.id} label={m.full_name} value={m.id} />)}
          </Picker>
        </View>
      )}

      <Text style={S.label}>Player 2</Text>
      {isWeb ? (
        <WebPlayerSelect value={player2Id} onChange={setPlayer2Id} members={members} colors={c} />
      ) : (
        <View style={S.pickerWrapper}>
          <Picker selectedValue={player2Id} onValueChange={setPlayer2Id}>
            <Picker.Item label="Select player..." value="" />
            {members.map((m) => <Picker.Item key={m.id} label={m.full_name} value={m.id} />)}
          </Picker>
        </View>
      )}

      <Text style={S.label}>Date & Time</Text>
      {isWeb ? (
        <View style={S.dateRow}>
          <View style={{ flex: 2 }}>{dateInput}</View>
          <View style={{ flex: 1 }}>{timeInput}</View>
        </View>
      ) : (
        <View style={S.dateRow}>
          <TouchableOpacity style={S.dateBtn} onPress={() => setShowDatePicker(true)}>
            <Text style={S.dateBtnText}>{formattedDate}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.timeBtn} onPress={() => setShowTimePicker(true)}>
            <Text style={S.dateBtnText}>{formattedTime}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!isWeb && (showDatePicker || Platform.OS === 'ios') && showDatePicker && (
        <DateTimePicker
          value={scheduledAt}
          mode="date"
          minimumDate={new Date()}
          onChange={onDateChange}
        />
      )}
      {!isWeb && (showTimePicker || Platform.OS === 'ios') && showTimePicker && (
        <DateTimePicker
          value={scheduledAt}
          mode="time"
          onChange={onTimeChange}
        />
      )}

      <TouchableOpacity style={S.button} onPress={scheduleMatch} disabled={loading}>
        <Text style={S.buttonText}>{loading ? 'Scheduling...' : 'Schedule Match'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    container:     { padding: 24, backgroundColor: c.bg, flexGrow: 1 },
    label:         { fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 6, marginTop: 16 },
    pickerWrapper: { borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: 'hidden', backgroundColor: c.surface },
    dateRow:       { flexDirection: 'row', gap: 12 },
    dateBtn:       { flex: 2, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 14, alignItems: 'center', backgroundColor: c.surface },
    timeBtn:       { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 14, alignItems: 'center', backgroundColor: c.surface },
    dateBtnText:   { fontSize: 15, color: c.text },
    button:        { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 32 },
    buttonText:    { color: '#fff', fontSize: 16, fontWeight: '600' },
  });
}
