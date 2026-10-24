import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, INPUT_MIN_FONT_WEB, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { explainRefusal } from '../lib/refusalNotices';

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
      // Same box as the date / time inputs below (webInputStyle); 16px so iOS
      // Safari doesn't zoom the page on focus.
      style: {
        fontSize: INPUT_MIN_FONT_WEB,
        padding: `${SPACE.md}px`,
        width: '100%',
        border: `${HAIRLINE}px solid ${colors.border}`,
        borderRadius: RADIUS.md,
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
    fontSize: INPUT_MIN_FONT_WEB,
    padding: `${SPACE.md}px`,
    width: '100%',
    border: `${HAIRLINE}px solid ${colors.border}`,
    borderRadius: RADIUS.md,
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
  const status = useStatusMessage();

  useEffect(() => { loadMembers(); }, []);

  async function loadMembers() {
    try {
      const data = await sbCall(() => supabase
        .from('league_members')
        .select('profile:profiles(*)')
        .eq('league_id', leagueId));
      const profiles = ((data ?? []) as any[]).map((m: any) => m.profile).filter(Boolean);
      setMembers(profiles);
    } catch (e) {
      // An empty member list makes both pickers unusable with no explanation.
      status.error(friendlySbMessage(e, "Couldn't load league members — pull down to retry."));
    }
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
    status.clear();
    if (!player1Id || !player2Id) {
      status.error('Please select both players.');
      return;
    }
    if (player1Id === player2Id) {
      status.error('Players must be different.');
      return;
    }
    setLoading(true);
    try {
      // schedule_league_match (migration_schedule_match_rpc.sql) checks the
      // league, the players and the time, and a replay of the same booking
      // returns the first one. No auto-retry all the same: a lost reply is
      // reported (the network line below), never resent behind the player.
      await sbCall(
        () => supabase.rpc('schedule_league_match', {
          p_league_id: leagueId,
          p_player1_id: player1Id,
          p_player2_id: player2Id,
          p_scheduled_at: scheduledAt.toISOString(),
        }),
        { retries: 0 },
      );
      status.success('Match has been added to the calendar.');
      setTimeout(() => navigation.goBack(), 1200);
    } catch (e) {
      status.error(explainRefusal(e, 'Could not schedule the match.', {}, {
        network: "Lost the connection, so we can't tell whether this saved. Check the calendar before scheduling it again.",
      }));
    } finally {
      setLoading(false);
    }
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
          <TouchableOpacity
            style={[S.pickBtn, S.dateBtn]}
            onPress={() => setShowDatePicker(true)}
            accessibilityRole="button"
            accessibilityLabel={`Date, ${formattedDate}`}
          >
            <Icon name="calendar" size={16} color={c.textSub} />
            <Text style={S.dateBtnText} numberOfLines={1}>{formattedDate}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.pickBtn, S.timeBtn]}
            onPress={() => setShowTimePicker(true)}
            accessibilityRole="button"
            accessibilityLabel={`Time, ${formattedTime}`}
          >
            <Icon name="clock" size={16} color={c.textSub} />
            <Text style={S.dateBtnText} numberOfLines={1}>{formattedTime}</Text>
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

      <StatusBanner status={status.value} />

      <Button
        title={loading ? 'Scheduling...' : 'Schedule Match'}
        onPress={scheduleMatch}
        loading={loading}
        disabled={loading}
        style={S.button}
      />
    </ScrollView>
  );
}

function makeStyles(c: ThemeColors) {
  const t = textStyles(c);
  return StyleSheet.create({
    container:     { padding: SPACE.lg, backgroundColor: c.bg, flexGrow: 1 },
    // The field-label preset (as TextField's label), so this form reads like the others.
    label:         { ...t.fieldLabel, marginBottom: SPACE.xs + SPACE.xxs, marginTop: SPACE.lg },
    pickerWrapper: { borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: c.surface },
    dateRow:       { flexDirection: 'row', gap: SPACE.md },
    pickBtn:       {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, minHeight: 44,
      borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, backgroundColor: c.surface,
    },
    dateBtn:       { flex: 2 },
    timeBtn:       { flex: 1 },
    dateBtnText:   { ...t.body, flexShrink: 1 },
    button:        { marginTop: SPACE.xl },
  });
}
