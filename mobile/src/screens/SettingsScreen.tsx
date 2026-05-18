import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Switch,
  TextInput, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { ThemeMode } from '../lib/theme';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import {
  DEFAULT_PREFS,
  loadUserPreferences,
  saveUserPreferences,
  type Prefs,
  type MatchType,
  type ScoreLimit,
} from '../lib/userPreferences';

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

  const [signOutOpen, setSignOutOpen]   = useState(false);
  const [signingOut, setSigningOut]     = useState(false);

  const [deleteOpen, setDeleteOpen]     = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError]   = useState('');
  const [deleting, setDeleting]         = useState(false);

  const status = useStatusMessage();

  useEffect(() => {
    loadPrefs();
    loadProfile();
  }, []);

  async function loadPrefs() {
    const loaded = await loadUserPreferences();
    setPrefs(loaded);
  }

  async function savePrefs(next: Prefs) {
    setPrefs(next);
    const { error } = await saveUserPreferences(next);
    if (error) status.error(`Couldn't save preferences: ${error}`);
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
      status.error(error.message);
    } else {
      setSavedName(displayName.trim());
      status.success('Display name updated.');
    }
  }

  async function sendPasswordReset() {
    if (!email || resetSent) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      status.error(error.message);
    } else {
      setResetSent(true);
      status.success(`Email sent — check ${email} for a password reset link.`);
    }
  }

  async function toggleBadgesPublic(val: boolean) {
    setBadgesPublic(val);
    if (userId) {
      await supabase.from('profiles').update({ badges_public: val }).eq('id', userId);
    }
  }

  function openSignOut() {
    setSignOutOpen(true);
  }

  async function doSignOut() {
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
      setSignOutOpen(false);
    }
  }

  function openDeleteAccount() {
    setDeletePassword('');
    setDeleteError('');
    setDeleteOpen(true);
  }

  function closeDeleteAccount() {
    if (deleting) return;
    setDeleteOpen(false);
    setDeletePassword('');
    setDeleteError('');
  }

  async function doDeleteAccount() {
    setDeleteError('');
    if (!email) {
      setDeleteError('Email missing — try reloading the page.');
      return;
    }
    if (!deletePassword) {
      setDeleteError('Enter your current password to confirm.');
      return;
    }
    setDeleting(true);
    try {
      // Re-verify password by signing in with it. signInWithPassword returns
      // a fresh session for the same user — no harmful side effects.
      const verify = await supabase.auth.signInWithPassword({
        email,
        password: deletePassword,
      });
      if (verify.error) {
        setDeleteError(verify.error.message ?? 'Password is incorrect.');
        setDeleting(false);
        return;
      }

      const { error: rpcError } = await supabase.rpc('delete_my_account');
      if (rpcError) {
        setDeleteError(rpcError.message ?? 'Failed to delete account.');
        setDeleting(false);
        return;
      }

      // auth.users row is gone — the existing session is invalid. Sign out
      // locally so the navigator flips back to Login.
      await supabase.auth.signOut();
    } catch (e: any) {
      setDeleteError(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
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

      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />

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
            { label: 'Singles', value: 'singles' },
            { label: 'Doubles', value: 'doubles' },
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
        <ActionRow
          label="Scoring Algo"
          desc="How PLUPR is calculated"
          onPress={() => navigation.navigate('ScoringAlgo')}
        />
        <Divider />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowDetail}>1.0.0</Text>
        </View>
      </View>

      {/* ── Godmode (only shown to godmode user) ─────── */}
      {isGodmodeUserId(userId) && (
        <>
          <SectionHeader title="🛠️ Godmode" />
          <View style={styles.card}>
            <ActionRow
              label="Godmode Console"
              desc="Admin utilities (create test accounts, etc.)"
              onPress={() => navigation.navigate('Godmode')}
            />
            <Divider />
            <ActionRow
              label="Gift Pickles"
              desc="Send pickles to any user"
              onPress={() => navigation.navigate('GiftPickles')}
            />
          </View>
        </>
      )}

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
        <ActionRow label="Sign out" onPress={openSignOut} />
        <Divider />
        <ActionRow
          label="Delete account"
          desc="Permanently remove your account and all data"
          onPress={openDeleteAccount}
          danger
        />
      </View>

      <View style={{ height: 48 }} />

      <ConfirmModal
        visible={signOutOpen}
        title="Sign out?"
        body="You'll need to sign back in to use Pickleague."
        primaryLabel="Sign out"
        variant="primary"
        busy={signingOut}
        onConfirm={doSignOut}
        onClose={() => setSignOutOpen(false)}
      />

      <ConfirmModal
        visible={deleteOpen}
        title="Delete account"
        body="This permanently removes your account, profile, ratings, match history, pickles, and everything else tied to it. This cannot be undone. Enter your password to confirm."
        primaryLabel="Delete my account"
        variant="danger"
        busy={deleting}
        error={deleteError || null}
        primaryDisabled={!deletePassword}
        extraField={
          <TextInput
            style={styles.passwordInput}
            value={deletePassword}
            onChangeText={(t) => { setDeletePassword(t); setDeleteError(''); }}
            placeholder="Current password"
            placeholderTextColor="#aaa"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            editable={!deleting}
          />
        }
        onConfirm={doDeleteAccount}
        onClose={closeDeleteAccount}
      />
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
  modalBackdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard:          { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 14, padding: 22 },
  modalTitle:         { fontSize: 18, fontWeight: '800', color: '#1a1a1a', marginBottom: 10 },
  modalBody:          { fontSize: 14, color: '#444', lineHeight: 20, marginBottom: 12 },
  modalError:         { color: '#c62828', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  passwordInput:      { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#1a1a1a', backgroundColor: '#fafafa', marginBottom: 6 },
  modalActions:       { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  modalBtn:           { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, minWidth: 96, alignItems: 'center', justifyContent: 'center' },
  modalBtnGhost:      { backgroundColor: '#f0f0f0' },
  modalBtnGhostText:  { color: '#444', fontSize: 14, fontWeight: '700' },
  modalBtnPrimary:    { backgroundColor: '#2e7d32' },
  modalBtnDanger:     { backgroundColor: '#c62828' },
  modalBtnPrimaryText:{ color: '#fff', fontSize: 14, fontWeight: '700' },
});
