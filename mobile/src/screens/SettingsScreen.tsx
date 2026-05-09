import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Switch, Alert,
  TextInput, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { ThemeMode } from '../lib/theme';
import { RootStackParamList } from '../types';

const PREFS_KEY = 'pickleague_prefs';

type MatchType    = 'singles' | 'doubles';
type ScoreLimit   = 11 | 15 | 21;

type Prefs = {
  notifyMatchResults:       boolean;
  notifyEventReminders:     boolean;
  notifyLeagueUpdates:      boolean;
  notifyTournamentUpdates:  boolean;
  notifyChallenges:         boolean;
  defaultMatchType:         MatchType;
  defaultScoreLimit:        ScoreLimit;
};

const DEFAULT_PREFS: Prefs = {
  notifyMatchResults:       true,
  notifyEventReminders:     true,
  notifyLeagueUpdates:      true,
  notifyTournamentUpdates:  true,
  notifyChallenges:         true,
  defaultMatchType:         'singles',
  defaultScoreLimit:        11,
};

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'> };

export default function SettingsScreen({ navigation }: Props) {
  const { colors, themeMode, setThemeMode } = useTheme();
  const GREEN = colors.primary;
  const [prefs, setPrefs]             = useState<Prefs>(DEFAULT_PREFS);
  const [badgesPublic, setBadgesPublic] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [savedName, setSavedName]     = useState('');
  const [savingName, setSavingName]   = useState(false);
  const [email, setEmail]             = useState('');
  const [resetSent, setResetSent]     = useState(false);
  const [userId, setUserId]           = useState<string | null>(null);

  useEffect(() => {
    loadPrefs();
    loadProfile();
  }, []);

  async function loadPrefs() {
    try {
      const raw = await AsyncStorage.getItem(PREFS_KEY);
      if (raw) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(raw) });
    } catch {}
  }

  async function savePrefs(next: Prefs) {
    setPrefs(next);
    try { await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
  }

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    setEmail(user.email ?? '');
    const { data } = await supabase
      .from('profiles')
      .select('full_name, badges_public')
      .eq('id', user.id)
      .single();
    if (data) {
      setDisplayName(data.full_name ?? '');
      setSavedName(data.full_name ?? '');
      setBadgesPublic(data.badges_public ?? true);
    }
  }

  async function updateDisplayName() {
    if (!userId || !displayName.trim() || displayName.trim() === savedName) return;
    setSavingName(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: displayName.trim() })
      .eq('id', userId);
    setSavingName(false);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setSavedName(displayName.trim());
      Alert.alert('Saved', 'Display name updated.');
    }
  }

  async function sendPasswordReset() {
    if (!email || resetSent) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setResetSent(true);
      Alert.alert('Email sent', `Check ${email} for a password reset link.`);
    }
  }

  async function toggleBadgesPublic(val: boolean) {
    setBadgesPublic(val);
    if (userId) {
      await supabase.from('profiles').update({ badges_public: val }).eq('id', userId);
    }
  }

  function confirmSignOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() },
    ]);
  }

  function confirmDeleteAccount() {
    Alert.alert(
      'Delete account',
      'This permanently removes your account, profile, and all match history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete my account',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Request received',
              'Account deletion requires verification. Please email support@pickleague.app with your request and we will process it within 48 hours.'
            ),
        },
      ]
    );
  }

  // ── Sub-components ──────────────────────────────────────────────

  function SectionHeader({ title }: { title: string }) {
    return <Text style={styles.sectionHeader}>{title}</Text>;
  }

  function Divider() {
    return <View style={styles.divider} />;
  }

  function ToggleRow({ label, desc, value, onChange }: {
    label: string; desc?: string; value: boolean; onChange: (v: boolean) => void;
  }) {
    return (
      <View style={styles.row}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.rowLabel}>{label}</Text>
          {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
        </View>
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ false: '#ddd', true: GREEN }}
          thumbColor="#fff"
        />
      </View>
    );
  }

  function ActionRow({ label, desc, onPress, danger, detail }: {
    label: string; desc?: string; onPress: () => void; danger?: boolean; detail?: string;
  }) {
    return (
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowLabel, danger && styles.dangerText]}>{label}</Text>
          {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
        </View>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
    );
  }

  function SegmentRow<T extends string | number>({ label, options, value, onSelect }: {
    label: string;
    options: { label: string; value: T }[];
    value: T;
    onSelect: (v: T) => void;
  }) {
    return (
      <View style={styles.segmentRow}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.segmentGroup}>
          {options.map((o) => (
            <TouchableOpacity
              key={String(o.value)}
              style={[styles.segmentBtn, value === o.value && [styles.segmentBtnActive, { backgroundColor: GREEN }]]}
              onPress={() => onSelect(o.value)}
            >
              <Text style={[styles.segmentText, value === o.value && styles.segmentTextActive]}>
                {o.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  const nameChanged = displayName.trim() !== savedName;

  return (
    <ScrollView contentContainerStyle={styles.container}>

      {/* ── Account ──────────────────────────── */}
      <SectionHeader title="Account" />
      <View style={styles.card}>
        {/* Display name */}
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { minWidth: 110 }]}>Display name</Text>
          <TextInput
            style={styles.nameInput}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            returnKeyType="done"
            onSubmitEditing={updateDisplayName}
          />
          {nameChanged && (
            <TouchableOpacity onPress={updateDisplayName} style={styles.saveBtn}>
              {savingName
                ? <ActivityIndicator size="small" color={GREEN} />
                : <Text style={[styles.saveBtnText, { color: GREEN }]}>Save</Text>}
            </TouchableOpacity>
          )}
        </View>
        <Divider />
        {/* Email (read-only) */}
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { flex: 1 }]}>Email</Text>
          <Text style={styles.rowDetail}>{email}</Text>
        </View>
        <Divider />
        {/* Password reset */}
        <ActionRow
          label={resetSent ? 'Reset email sent ✓' : 'Reset password'}
          desc="We'll email you a link to set a new password"
          onPress={sendPasswordReset}
        />
      </View>

      {/* ── Notifications ────────────────────── */}
      <SectionHeader title="Notifications" />
      <View style={styles.card}>
        <ToggleRow
          label="Match results"
          desc="When a match you played is recorded"
          value={prefs.notifyMatchResults}
          onChange={(v) => savePrefs({ ...prefs, notifyMatchResults: v })}
        />
        <Divider />
        <ToggleRow
          label="Event reminders"
          desc="24 hours before a league event starts"
          value={prefs.notifyEventReminders}
          onChange={(v) => savePrefs({ ...prefs, notifyEventReminders: v })}
        />
        <Divider />
        <ToggleRow
          label="League announcements"
          desc="Admin posts and league news"
          value={prefs.notifyLeagueUpdates}
          onChange={(v) => savePrefs({ ...prefs, notifyLeagueUpdates: v })}
        />
        <Divider />
        <ToggleRow
          label="Tournament updates"
          desc="Bracket results and schedule changes"
          value={prefs.notifyTournamentUpdates}
          onChange={(v) => savePrefs({ ...prefs, notifyTournamentUpdates: v })}
        />
        <Divider />
        <ToggleRow
          label="Match challenges"
          desc="When someone challenges you to a match"
          value={prefs.notifyChallenges}
          onChange={(v) => savePrefs({ ...prefs, notifyChallenges: v })}
        />
      </View>

      {/* ── Match Defaults ───────────────────── */}
      <SectionHeader title="Match Defaults" />
      <View style={styles.card}>
        <SegmentRow<MatchType>
          label="Default match type"
          options={[
            { label: '1v1 Singles', value: 'singles' },
            { label: '2v2 Doubles', value: 'doubles' },
          ]}
          value={prefs.defaultMatchType}
          onSelect={(v) => savePrefs({ ...prefs, defaultMatchType: v })}
        />
        <Divider />
        <SegmentRow<ScoreLimit>
          label="Default score limit"
          options={[
            { label: '11', value: 11 },
            { label: '15', value: 15 },
            { label: '21', value: 21 },
          ]}
          value={prefs.defaultScoreLimit}
          onSelect={(v) => savePrefs({ ...prefs, defaultScoreLimit: v })}
        />
      </View>

      {/* ── Privacy ──────────────────────────── */}
      <SectionHeader title="Privacy" />
      <View style={styles.card}>
        <ToggleRow
          label="Show badges publicly"
          desc="Other players can see your badges on your profile"
          value={badgesPublic}
          onChange={toggleBadgesPublic}
        />
        <Divider />
        <ActionRow
          label="Manage profile visibility"
          desc="Control what other players can see"
          onPress={() => navigation.navigate('Profile', {})}
        />
      </View>

      {/* ── About ────────────────────────────── */}
      <SectionHeader title="App" />
      <View style={styles.card}>
        <ActionRow
          label="About Pickleague"
          desc="Our mission and story"
          onPress={() => navigation.navigate('About')}
        />
        <Divider />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowDetail}>1.0.0</Text>
        </View>
      </View>

      {/* ── Appearance ───────────────────────── */}
      <SectionHeader title="Appearance" />
      <View style={styles.card}>
        <SegmentRow<ThemeMode>
          label="Theme"
          options={[
            { label: '⚙️ System', value: 'system' },
            { label: '☀️ Light',  value: 'light' },
            { label: '🌙 Dark',   value: 'dark' },
          ]}
          value={themeMode}
          onSelect={setThemeMode}
        />
      </View>

      {/* ── Danger zone ──────────────────────── */}
      <SectionHeader title="Account Actions" />
      <View style={styles.card}>
        <ActionRow label="Sign out" onPress={confirmSignOut} />
        <Divider />
        <ActionRow
          label="Delete account"
          desc="Permanently remove your account and all data"
          onPress={confirmDeleteAccount}
          danger
        />
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:          { backgroundColor: '#f5f5f5' },
  sectionHeader:      { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 28, marginBottom: 6, marginHorizontal: 20 },
  card:               { backgroundColor: '#fff', marginHorizontal: 16, borderRadius: 12, overflow: 'hidden', elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 },
  row:                { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 16, minHeight: 52 },
  rowLabel:           { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  rowDesc:            { fontSize: 12, color: '#999', marginTop: 2 },
  rowDetail:          { fontSize: 13, color: '#aaa', marginRight: 6 },
  chevron:            { fontSize: 22, color: '#ccc' },
  divider:            { height: 1, backgroundColor: '#f0f0f0', marginHorizontal: 16 },
  dangerText:         { color: '#c62828' },
  nameInput:          { flex: 1, fontSize: 14, color: '#333', textAlign: 'right', paddingHorizontal: 8 },
  saveBtn:            { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#e8f5e9', borderRadius: 8 },
  saveBtnText:        { color: '#2e7d32', fontWeight: '700', fontSize: 13 },
  segmentRow:         { paddingVertical: 12, paddingHorizontal: 16 },
  segmentGroup:       { flexDirection: 'row', marginTop: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1.5, borderColor: '#e0e0e0' },
  segmentBtn:         { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: '#fafafa' },
  segmentBtnActive:   { backgroundColor: '#2e7d32' },
  segmentText:        { fontSize: 13, fontWeight: '600', color: '#666' },
  segmentTextActive:  { color: '#fff' },
});
