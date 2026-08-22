import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Switch,
  TextInput, TouchableOpacity, ActivityIndicator, Linking,
} from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  sbCall,
  currentUserId,
  friendlySbMessage,
  signOutSafely,
} from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { ThemeMode } from '../lib/theme';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import { WAGERS_ENABLED } from '../lib/features';
import { removeAvatarObjects } from '../data/moderationAdmin';
import { enablePushNotifications, unregisterPushTokenAsync } from '../lib/push';
import {
  DEFAULT_PREFS,
  loadUserPreferencesResult,
  saveUserPreferences,
  type Prefs,
  type MatchType,
  type ScoreLimit,
} from '../lib/userPreferences';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'> };

// TODO: smoke-test in browser — toggle Theme (System/Light/Dark) and confirm
// the Settings body flips between light and dark with no leftover light cards.
export default function SettingsScreen({ navigation }: Props) {
  const { colors, themeMode, setThemeMode } = useTheme();
  const styles = makeStyles(colors);
  const GREEN = colors.primary;
  const [prefs, setPrefs]             = useState<Prefs>(DEFAULT_PREFS);
  // Prefs are stored as one blob, so showing DEFAULT_PREFS after a failed read
  // and then saving would overwrite everything the user had. Until a read
  // lands, the controls are read-only rather than lying about the saved state.
  const [prefsReady, setPrefsReady]   = useState(false);
  const [pushBusy, setPushBusy]       = useState(false);
  const [badgesPublic, setBadgesPublic] = useState(true);
  const [isGuest, setIsGuest]           = useState(false);
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
    const result = await loadUserPreferencesResult();
    if (result.status === 'ok') {
      setPrefs(result.prefs);
      setPrefsReady(true);
      return;
    }
    if (result.status === 'failed') {
      status.error(
        `${friendlySbMessage(result.error, "Couldn't load your notification settings.")} Pull to retry before changing them.`,
      );
    }
  }

  async function savePrefs(next: Prefs) {
    const previous = prefs;
    setPrefs(next);
    const { error } = await saveUserPreferences(next);
    if (error) {
      // Put the switch back — leaving it flipped tells the user a setting is
      // saved that isn't, and the next toggle would build on the wrong blob.
      setPrefs(previous);
      status.error(`Couldn't save preferences: ${error}`);
    }
  }

  // Master push toggle (opt-in). Turning it on triggers the OS permission
  // prompt and registers a token; we only persist pushEnabled=true if a token
  // was actually obtained, so the switch never claims "on" when the OS denied
  // permission (or on web, where push isn't supported).
  async function togglePush(val: boolean) {
    if (!val) {
      await savePrefs({ ...prefs, pushEnabled: false });
      return;
    }
    setPushBusy(true);
    try {
      const outcome = await enablePushNotifications();
      if (outcome.status === 'registered') {
        await savePrefs({ ...prefs, pushEnabled: true });
      } else if (outcome.status === 'failed') {
        // Nothing is wrong with their permissions — we just couldn't reach the
        // server. Sending them to iOS Settings to fix a granted permission is
        // a dead end, and writing pushEnabled:false would lose their choice.
        status.error(
          friendlySbMessage(outcome.error, "Couldn't turn on push just now — try again."),
        );
      } else {
        await savePrefs({ ...prefs, pushEnabled: false });
        status.error('Enable notifications for Pickleague in your device settings to receive push.');
      }
    } finally {
      setPushBusy(false);
    }
  }

  async function loadProfile() {
    // LOCAL session read — getUser() is a network call, so offline this bailed
    // and Settings rendered with a blank name/email and no godmode section.
    const uid = await currentUserId(supabase);
    if (!uid) return;
    setUserId(uid);
    try {
      const data = await sbCall(() =>
        supabase
          .from('profiles')
          .select('full_name, badges_public, is_guest')
          .eq('id', uid)
          .single(),
      );
      if (data) {
        setDisplayName(data.full_name ?? '');
        setSavedName(data.full_name ?? '');
        setBadgesPublic(data.badges_public ?? true);
        setIsGuest(!!data.is_guest);
      }
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't load your profile."));
    }
    // Email lives on the auth user, not profiles. getSession is local, so this
    // still fills in offline.
    const { data: sessionData } = await supabase.auth.getSession();
    setEmail(sessionData.session?.user.email ?? '');
  }

  async function updateDisplayName() {
    if (!userId || !displayName.trim() || displayName.trim() === savedName) return;
    setSavingName(true);
    try {
      await sbCall(() =>
        supabase.from('profiles').update({ full_name: displayName.trim() }).eq('id', userId),
      );
      setSavedName(displayName.trim());
      status.success('Display name updated.');
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't update your display name."));
    } finally {
      // Always: the old early-return path left the Save button spinning.
      setSavingName(false);
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
    if (!userId) return;
    setBadgesPublic(val);
    try {
      await sbCall(() => supabase.from('profiles').update({ badges_public: val }).eq('id', userId));
    } catch (e) {
      // A privacy switch that silently didn't save is worse than one that
      // visibly refused — snap it back and say so.
      setBadgesPublic(!val);
      status.error(friendlySbMessage(e, "Couldn't change badge visibility."));
    }
  }

  function openSignOut() {
    setSignOutOpen(true);
  }

  async function doSignOut() {
    setSigningOut(true);
    try {
      // Remove this device's push token first — the RLS delete policy needs the
      // session, so it must happen before signOut() clears auth.
      await unregisterPushTokenAsync();
      // signOutSafely, not auth.signOut: the client refuses session removal
      // while offline (so a captive portal can't log anyone out), and a
      // deliberate sign-out has to mark itself to get through that guard.
      // It also falls back to a local sign-out when the server can't be reached.
      await signOutSafely(supabase);
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

      // The profile photo lives in storage, which SQL cannot delete from, so
      // delete_my_account() can only clear the reference. Remove the object
      // itself first, while the session that owns it still exists. Best-effort:
      // a storage hiccup must not block the account deletion behind it.
      if (userId) {
        try { await removeAvatarObjects(userId); } catch { /* nothing renders it either way */ }
      }

      const { error: rpcError } = await supabase.rpc('delete_my_account');
      if (rpcError) {
        setDeleteError(rpcError.message ?? 'Failed to delete account.');
        setDeleting(false);
        return;
      }

      // auth.users row is gone — the existing session is invalid. Sign out
      // locally so the navigator flips back to Login. signOutSafely marks this
      // as deliberate, so the offline session guard doesn't refuse the removal.
      await signOutSafely(supabase, { scope: 'local' });
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

  function ToggleRow({ label, desc, value, onChange, disabled }: {
    label: string; desc?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
  }) {
    return (
      <View style={[styles.row, disabled && { opacity: 0.5 }]}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.rowLabel}>{label}</Text>
          {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
        </View>
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: colors.border, true: GREEN }}
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

  function SegmentRow<T extends string | number>({ label, options, value, onSelect, disabled }: {
    label: string;
    options: { label: string; value: T }[];
    value: T;
    onSelect: (v: T) => void;
    disabled?: boolean;
  }) {
    return (
      <View style={[styles.segmentRow, disabled && { opacity: 0.5 }]}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.segmentGroup}>
          {options.map((o) => (
            <TouchableOpacity
              key={String(o.value)}
              style={[styles.segmentBtn, value === o.value && [styles.segmentBtnActive, { backgroundColor: GREEN }]]}
              onPress={() => onSelect(o.value)}
              disabled={disabled}
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
        {isGuest && (
          <>
            <ActionRow
              label="✨ Create your account"
              desc="Add an email & password so you don't lose access"
              onPress={() => navigation.navigate('UpgradeAccount')}
            />
            <Divider />
          </>
        )}
        {/* Display name */}
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { minWidth: 110 }]}>Display name</Text>
          <TextInput
            style={styles.nameInput}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
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
        {WAGERS_ENABLED && (
          <>
            <Divider />
            <ActionRow
              label="🎲 My Wagers"
              desc="View open, won, and lost pickle wagers"
              onPress={() => navigation.navigate('MyWagers')}
            />
          </>
        )}
      </View>

      {/* ── Notifications ────────────────────── */}
      <SectionHeader title="Push Notifications" />
      <View style={styles.card}>
        {!prefsReady && (
          <>
            {/* Without a successful read these switches would show defaults, and
                saving one would overwrite every other setting with them. */}
            <ActionRow
              label="Settings not loaded"
              desc="Tap to try again — switches stay locked until they load"
              onPress={loadPrefs}
            />
            <Divider />
          </>
        )}
        <ToggleRow
          label="Push notifications"
          desc="Get these on your phone. Turning a type off keeps it in the in-app bell — it just won't push."
          value={prefs.pushEnabled}
          onChange={togglePush}
          disabled={!prefsReady || pushBusy}
        />
        <Divider />
        <ToggleRow
          label="Match results"
          desc="When a match you played is recorded"
          value={prefs.notifyMatchResults}
          onChange={(v) => savePrefs({ ...prefs, notifyMatchResults: v })}
          disabled={!prefsReady}
        />
        <Divider />
        <ToggleRow
          label="Event reminders"
          desc="Before a league event starts, and before a scheduling vote closes"
          value={prefs.notifyEventReminders}
          onChange={(v) => savePrefs({ ...prefs, notifyEventReminders: v })}
          disabled={!prefsReady}
        />
        <Divider />
        <ToggleRow
          label="League announcements"
          desc="Admin posts and league news"
          value={prefs.notifyLeagueUpdates}
          onChange={(v) => savePrefs({ ...prefs, notifyLeagueUpdates: v })}
          disabled={!prefsReady}
        />
        <Divider />
        <ToggleRow
          label="Tournament updates"
          desc="Bracket results and schedule changes"
          value={prefs.notifyTournamentUpdates}
          onChange={(v) => savePrefs({ ...prefs, notifyTournamentUpdates: v })}
          disabled={!prefsReady}
        />
        <Divider />
        <ToggleRow
          label="Match challenges"
          desc="When someone challenges you to a match"
          value={prefs.notifyChallenges}
          onChange={(v) => savePrefs({ ...prefs, notifyChallenges: v })}
          disabled={!prefsReady}
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
          disabled={!prefsReady}
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
          disabled={!prefsReady}
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
        <Divider />
        <ActionRow
          label="Blocked players"
          desc="Review or undo the players you've blocked"
          onPress={() => navigation.navigate('BlockedPlayers')}
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
        <ActionRow
          label="Privacy Policy"
          desc="What we collect, and what we don't"
          onPress={() => Linking.openURL('https://pickleague.club/privacy')}
        />
        <Divider />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowDetail}>{Constants.expoConfig?.version ?? '—'}</Text>
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
            <Divider />
            <ActionRow
              label="Review Submitted Venues"
              desc="Confirm or reject user-added courts"
              onPress={() => navigation.navigate('AdminVenueReview')}
            />
            <Divider />
            <ActionRow
              label="Reported Content"
              desc="Act on player reports within 24 hours"
              onPress={() => navigation.navigate('ModerationQueue')}
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
            placeholderTextColor={colors.textMuted}
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

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:          { backgroundColor: colors.bg },
    sectionHeader:      { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 28, marginBottom: 6, marginHorizontal: 20 },
    card:               { backgroundColor: colors.surface, marginHorizontal: 16, borderRadius: 12, overflow: 'hidden', elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 },
    row:                { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 16, minHeight: 52 },
    rowLabel:           { fontSize: 15, fontWeight: '600', color: colors.text },
    rowDesc:            { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    rowDetail:          { fontSize: 13, color: colors.textMuted, marginRight: 6 },
    chevron:            { fontSize: 22, color: colors.textMuted },
    divider:            { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },
    dangerText:         { color: colors.danger },
    nameInput:          { flex: 1, fontSize: 14, color: colors.text, textAlign: 'right', paddingHorizontal: 8 },
    saveBtn:            { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.primaryLight, borderRadius: 8 },
    saveBtnText:        { color: colors.primary, fontWeight: '700', fontSize: 13 },
    segmentRow:         { paddingVertical: 12, paddingHorizontal: 16 },
    segmentGroup:       { flexDirection: 'row', marginTop: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1.5, borderColor: colors.border },
    segmentBtn:         { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: colors.surfaceAlt },
    segmentBtnActive:   { backgroundColor: colors.primary },
    segmentText:        { fontSize: 13, fontWeight: '600', color: colors.textSub },
    segmentTextActive:  { color: '#fff' },
    passwordInput:      { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text, backgroundColor: colors.surfaceAlt, marginBottom: 6 },
  });
}
