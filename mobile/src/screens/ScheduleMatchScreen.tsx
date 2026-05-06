import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ScheduleMatch'>;
  route: RouteProp<RootStackParamList, 'ScheduleMatch'>;
};

export default function ScheduleMatchScreen({ navigation, route }: Props) {
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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>Player 1</Text>
      <View style={styles.pickerWrapper}>
        <Picker selectedValue={player1Id} onValueChange={setPlayer1Id}>
          <Picker.Item label="Select player..." value="" />
          {members.map((m) => <Picker.Item key={m.id} label={m.full_name} value={m.id} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Player 2</Text>
      <View style={styles.pickerWrapper}>
        <Picker selectedValue={player2Id} onValueChange={setPlayer2Id}>
          <Picker.Item label="Select player..." value="" />
          {members.map((m) => <Picker.Item key={m.id} label={m.full_name} value={m.id} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Date & Time</Text>
      <View style={styles.dateRow}>
        <TouchableOpacity style={styles.dateBtn} onPress={() => setShowDatePicker(true)}>
          <Text style={styles.dateBtnText}>{formattedDate}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.timeBtn} onPress={() => setShowTimePicker(true)}>
          <Text style={styles.dateBtnText}>{formattedTime}</Text>
        </TouchableOpacity>
      </View>

      {(showDatePicker || Platform.OS === 'ios') && showDatePicker && (
        <DateTimePicker
          value={scheduledAt}
          mode="date"
          minimumDate={new Date()}
          onChange={onDateChange}
        />
      )}
      {(showTimePicker || Platform.OS === 'ios') && showTimePicker && (
        <DateTimePicker
          value={scheduledAt}
          mode="time"
          onChange={onTimeChange}
        />
      )}

      <TouchableOpacity style={styles.button} onPress={scheduleMatch} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Scheduling...' : 'Schedule Match'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 16 },
  pickerWrapper: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, overflow: 'hidden' },
  dateRow: { flexDirection: 'row', gap: 12 },
  dateBtn: { flex: 2, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 14, alignItems: 'center' },
  timeBtn: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 14, alignItems: 'center' },
  dateBtnText: { fontSize: 15, color: '#333' },
  button: { backgroundColor: '#2e7d32', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 32 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
