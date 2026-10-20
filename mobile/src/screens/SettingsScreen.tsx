import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  TextInput, TouchableOpacity, Linking,
} from 'react-native';
import Constants from 'expo-constants';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  sbCall,
  currentUserId,
  friendlySbMessage,
  signOutSafely,
} from '@just-messin-around/expo-foundation/supabase';
import {
  Panel,
  SectionHeader,
  CollapsibleSection,
  SegmentedToggle,
  SettingSwitchRow,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { ThemeMode } from '../lib/theme';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import { FRIENDS_AT_COURTS_ENABLED, WAGERS_ENABLED } from '../lib/features';
import { removeAvatarObjects } from '../data/moderationAdmin';
import PresencePrivacyRows from '../components/presence/PresencePrivacyRows';
import { enablePushNotifications, unregisterPushTokenAsync } from '../lib/push';
import CourtArrivalSettingsPanel from '../components/CourtArrivalSettingsPanel';
import { clearArrivalTrace, readArrivalTrace, type ArrivalTraceEvent } from '../lib/courtArrivalTrace';
import { endPresenceForSignOut } from '../lib/signOutPresence';
import { trackSectionToggle } from '../lib/analytics';
import {
  DEFAULT_PREFS,
  loadUserPreferencesResult,
  saveUserPreferences,
  type Prefs,
} from '../lib/userPreferences';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

type Colors = ReturnType<typeof useTheme>['colors'];
type Styles = ReturnType<typeof makeStyles>;

// The per-type push switches. One list drives both the collapsed section's
// "n of N on" summary and the rows, so adding a type can't skew the count.
// (The old "Match Defaults" section is gone: defaultMatchType /
// defaultScoreLimit were written here and read nowhere — MatchEntry starts
// from its route prefill or doubles, and no SQL reads the keys. They stay in
// the prefs blob untouched.)
type PushTypeKey =
  | 'notifyMatchResults'
  | 'notifyMatchConfirms'
  | 'notifyEventReminders'
  | 'notifyLeagueUpdates'
  | 'notifyTournamentUpdates'
  | 'notifyChallenges'
  | 'notifyDrillRequests'
  | 'notifyAutoCheckins'
  | 'notifyCheckinPrompts'
  | 'notifyFriendRequests';

const PUSH_TYPES: { key: PushTypeKey; label: string; desc: string }[] = [
  { key: 'notifyMatchResults', label: 'Match results', desc: 'When a match you played is recorded' },
  // Its own switch, not folded into "Match results", because the consequence
  // of muting it is different in kind: unconfirmed matches are deleted after
  // an hour, so a missed confirm request loses a game you actually played.
  // The copy says so plainly, and short enough that the rows' 2-line clamp
  // (hintLines) never cuts the consequence off.
  { key: 'notifyMatchConfirms', label: 'Match confirmations', desc: 'Score confirm requests. Unconfirmed matches are dropped after an hour' },
  { key: 'notifyEventReminders', label: 'Event reminders', desc: 'Before a league event starts, and before a scheduling vote closes' },
  { key: 'notifyLeagueUpdates', label: 'League announcements', desc: 'Admin posts and league news' },
  { key: 'notifyTournamentUpdates', label: 'Tournament updates', desc: 'Bracket results and schedule changes' },
  { key: 'notifyChallenges', label: 'Match challenges', desc: 'When someone challenges you to a match' },
  { key: 'notifyDrillRequests', label: 'Drilling', desc: 'Drill requests, answers and session reminders' },
  // Court arrival (Check-in automation below). These gate the server's
  // pushes; when it can't push to the phone (no token, push off), the phone
  // shows its own "Checked in" / "Still at" and "Check in nearby?" (decision
  // D3, lib/courtArrival), but never for a type switched off here. "Auto
  // check-ins" also carries "👋 Checked out" when any check-in runs out
  // (manual ones included), so its line says so.
  { key: 'notifyAutoCheckins', label: 'Auto check-ins', desc: 'At your starred courts, and when a check-in ends' },
  { key: 'notifyCheckinPrompts', label: 'Check-in prompts', desc: 'Near courts, when the app is open or you arrive' },
  ...(FRIENDS_AT_COURTS_ENABLED
    ? [{ key: 'notifyFriendRequests' as const, label: 'Friend requests', desc: 'When someone wants to be friends, and when they accept' }]
    : []),
];

// ── Rows ──────────────────────────────────────────────────────────────
// Module-level (not declared inside the screen) so a state change re-renders
// them instead of remounting them: a remounted Switch drops its animation and
// a remounted row loses its press feedback mid-tap.

function Divider({ S }: { S: Styles }) {
  return <View style={S.divider} />;
}

// The switch rows are the foundation's SettingSwitchRow (this screen's old
// ToggleRow, hoisted in 1.50). Every hint here is written to fit 2 lines at
// phone width (~80 chars) and passed hintLines={2}, so keep new ones that short.

/** One trace event on one line: local time, kind, then its details. Never a coordinate (there are none). */
function traceLine(e: ArrivalTraceEvent): string {
  const d = new Date(e.at);
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const detail = e.detail
    ? Object.entries(e.detail)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  return `${when}  ${e.kind}${detail ? `  ${detail}` : ''}`;
}

function ActionRow({ S, label, desc, onPress, danger, detail }: {
  S: Styles;
  label: string; desc?: string; onPress: () => void; danger?: boolean; detail?: string;
}) {
  return (
    <TouchableOpacity style={S.row} onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
      <View style={S.rowText}>
        <Text style={[S.rowLabel, danger && S.dangerText]} numberOfLines={1}>{label}</Text>
        {desc ? <Text style={S.rowDesc} numberOfLines={1}>{desc}</Text> : null}
      </View>
      {detail ? <Text style={S.rowDetail} numberOfLines={1}>{detail}</Text> : null}
      <Text style={S.chevron}>›</Text>
    </TouchableOpacity>
  );
}

// TODO: smoke-test in browser — toggle Theme (System/Light/Dark) and confirm
// the Settings body flips between light and dark with no leftover light cards.
export default function SettingsScreen({ navigation, route }: Props) {
  const { colors, themeMode, setThemeMode } = useTheme();
  const S = makeStyles(colors);
  const [prefs, setPrefs]             = useState<Prefs>(DEFAULT_PREFS);
  // Prefs are stored as one blob, so showing DEFAULT_PREFS after a failed read
  // and then saving would overwrite everything the user had. Until a read
  // lands, the controls are read-only rather than lying about the saved state.
  const [prefsReady, setPrefsReady]   = useState(false);
  const [pushBusy, setPushBusy]       = useState(false);
  const [isGuest, setIsGuest]           = useState(false);
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

  // "Check-in automation" starts collapsed; settings/checkins (the Not here
  // notices) opens it and brings it into view, also when Settings is already
  // open. The section's y is known only after layout, so a scroll asked for
  // before then waits for onLayout.
  const focusCheckins = route.params?.focus === 'checkins';
  const [checkinsOpen, setCheckinsOpen] = useState(focusCheckins);
  const scrollRef = useRef<ScrollView>(null);
  const checkinsY = useRef<number | null>(null);
  const scrollPending = useRef(false);
  const scrollToCheckins = () => {
    if (checkinsY.current == null) {
      scrollPending.current = true;
      return;
    }
    scrollPending.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, checkinsY.current - SPACE.md), animated: true });
  };
  useEffect(() => {
    if (!focusCheckins) return;
    setCheckinsOpen(true);
    scrollToCheckins();
    // route.params: the same link followed again is a new params object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCheckins, route.params]);

  // Godmode: this phone's court arrival trace (lib/courtArrivalTrace), for the
  // device tests. null = closed.
  const [trace, setTrace] = useState<string | null>(null);
  async function toggleTrace() {
    if (trace !== null) {
      setTrace(null);
      return;
    }
    const events = await readArrivalTrace();
    // Newest first: the run just made is what a device test looks at.
    setTrace(events.length ? events.slice().reverse().map(traceLine).join('\n') : 'No arrival events on this phone yet.');
  }
  async function clearTrace() {
    await clearArrivalTrace();
    setTrace('No arrival events on this phone yet.');
  }

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
    // and Settings rendered with a blank email and no godmode section.
    const uid = await currentUserId(supabase);
    if (!uid) return;
    setUserId(uid);
    try {
      // The display name and badge visibility moved to Profile's Edit sheet
      // (one Save for every profile field), so this screen no longer reads or
      // writes full_name or badges_public.
      const data = await sbCall(() =>
        supabase
          .from('profiles')
          .select('is_guest')
          .eq('id', uid)
          .single(),
      );
      if (data) {
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

  function openSignOut() {
    setSignOutOpen(true);
  }

  async function doSignOut() {
    setSigningOut(true);
    try {
      // Stop showing me at the courts (check-out + end the session, 3 s max,
      // never throws). Like the push token below, it needs the session.
      await endPresenceForSignOut();
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

  const pushTypesOn = PUSH_TYPES.filter((p) => prefs[p.key]).length;
  // Collapsed, the section still says what it holds. Before the read lands the
  // switches show defaults, so the summary says so instead of a fake count.
  const pushTypesSummary = !prefsReady
    ? 'Not loaded yet'
    : pushTypesOn === PUSH_TYPES.length
      ? 'All on'
      : pushTypesOn === 0
        ? 'All off'
        : `${pushTypesOn} of ${PUSH_TYPES.length} on`;

  return (
    <ScrollView ref={scrollRef} style={S.screen} contentContainerStyle={S.container}>

      <StatusBanner status={status.value} style={{ marginBottom: SPACE.sm }} />

      {/* ── Account ──────────────────────────── */}
      <SectionHeader title="Account" />
      <Panel padded={false} style={S.card}>
        {isGuest && (
          <>
            <ActionRow
              S={S}
              label="✨ Create your account"
              desc="Add an email & password so you don't lose access"
              onPress={() => navigation.navigate('UpgradeAccount')}
            />
            <Divider S={S} />
          </>
        )}
        {/* The display name is edited on Profile now (its Edit sheet saves
            name, username, tagline and avatar together); this is the pointer. */}
        <ActionRow
          S={S}
          label="Edit your name on your profile"
          onPress={() => navigation.navigate('Profile', {})}
        />
        <Divider S={S} />
        {/* Email (read-only) */}
        <View style={S.row}>
          <Text style={[S.rowLabel, S.rowText]}>Email</Text>
          <Text style={S.rowDetail} numberOfLines={1}>{email}</Text>
        </View>
        <Divider S={S} />
        {/* Password reset */}
        <ActionRow
          S={S}
          label={resetSent ? 'Reset email sent ✓' : 'Reset password'}
          desc="We'll email you a link to set a new password"
          onPress={sendPasswordReset}
        />
        {WAGERS_ENABLED && (
          <>
            <Divider S={S} />
            <ActionRow
              S={S}
              label="🎲 My Wagers"
              desc="View open, won, and lost pickle wagers"
              onPress={() => navigation.navigate('MyWagers')}
            />
          </>
        )}
      </Panel>

      {/* ── Notifications ────────────────────── */}
      <SectionHeader title="Push notifications" />
      <Panel padded={false} style={S.cardTight}>
        {!prefsReady && (
          <>
            {/* Without a successful read these switches would show defaults, and
                saving one would overwrite every other setting with them. */}
            <ActionRow
              S={S}
              label="Settings not loaded"
              desc="Tap to retry; switches stay locked"
              onPress={loadPrefs}
            />
            <Divider S={S} />
          </>
        )}
        <SettingSwitchRow
          label="Push notifications"
          hint="Phone alerts. A type turned off still shows in the in-app bell."
          hintLines={2}
          value={prefs.pushEnabled}
          onChange={togglePush}
          disabled={!prefsReady || pushBusy}
        />
      </Panel>
      {/* The per-type switches are reference settings most people set
          once, so they sit collapsed under one line that still says how many
          are on. Children unmount on close (nothing inside keeps state). */}
      <CollapsibleSection
        compact
        title="Notification types"
        summary={pushTypesSummary}
        onToggle={(open) => trackSectionToggle({ screen: 'Settings', section: 'push_types', open })}
      >
        {PUSH_TYPES.map((p, i) => (
          <React.Fragment key={p.key}>
            {i > 0 ? <View style={S.dividerFlush} /> : null}
            <SettingSwitchRow
              inset={false}
              label={p.label}
              hint={p.desc}
              hintLines={2}
              value={prefs[p.key]}
              onChange={(v) => savePrefs({ ...prefs, [p.key]: v })}
              disabled={!prefsReady}
            />
          </React.Fragment>
        ))}
      </CollapsibleSection>

      {/* ── Check-in automation ─────────────── */}
      {/* Starred courts, arrival check-ins and prompts (section F of the court
          arrival plan). All platforms: the settings are per account, and web
          says which ones apply on the phone. Children unmount on close. */}
      <View
        onLayout={(e) => {
          checkinsY.current = e.nativeEvent.layout.y;
          if (scrollPending.current) scrollToCheckins();
        }}
      >
        <CollapsibleSection
          compact
          title="Check-in automation"
          open={checkinsOpen}
          onToggle={(open) => {
            setCheckinsOpen(open);
            trackSectionToggle({ screen: 'Settings', section: 'checkin_automation', open });
          }}
        >
          <CourtArrivalSettingsPanel />
        </CollapsibleSection>
      </View>

      {/* ── Privacy ──────────────────────────── */}
      <SectionHeader title="Privacy" />
      <Panel padded={false} style={S.card}>
        {/* Badge visibility lives in Profile's Edit sheet (one Save for every
            profile field), like the display name. */}
        <ActionRow
          S={S}
          label="Manage profile visibility"
          desc="Badge visibility and what other players can see"
          onPress={() => navigation.navigate('Profile', {})}
        />
        <Divider S={S} />
        <ActionRow
          S={S}
          label="Blocked players"
          desc="Review or undo the players you've blocked"
          onPress={() => navigation.navigate('BlockedPlayers')}
        />
        {/* Who sees me at the courts / Hidden from (shipped with location-
            confirmed check-ins, not behind FRIENDS_AT_COURTS_ENABLED). */}
        <PresencePrivacyRows />
      </Panel>

      {/* ── About ────────────────────────────── */}
      <SectionHeader title="App" />
      <Panel padded={false} style={S.card}>
        <ActionRow
          S={S}
          label="About Pickleague"
          desc="Our mission and story"
          onPress={() => navigation.navigate('About')}
        />
        <Divider S={S} />
        <ActionRow
          S={S}
          label="Scoring Algo"
          desc="How PLUPR is calculated"
          onPress={() => navigation.navigate('ScoringAlgo')}
        />
        <Divider S={S} />
        <ActionRow
          S={S}
          label="Privacy Policy"
          desc="What we collect, and what we don't"
          onPress={() => Linking.openURL('https://www.pickleague.club/privacy')}
        />
        <Divider S={S} />
        <View style={S.row}>
          <Text style={[S.rowLabel, S.rowText]}>Version</Text>
          <Text style={S.rowDetail}>{Constants.expoConfig?.version ?? '—'}</Text>
        </View>
      </Panel>

      {/* ── Godmode (only shown to godmode user) ─────── */}
      {isGodmodeUserId(userId) && (
        <>
          <SectionHeader title="🛠️ Godmode" />
          <Panel padded={false} style={S.card}>
            <ActionRow
              S={S}
              label="Godmode Console"
              desc="Admin utilities (create test accounts, etc.)"
              onPress={() => navigation.navigate('Godmode')}
            />
            <Divider S={S} />
            <ActionRow
              S={S}
              label="Gift Pickles"
              desc="Send pickles to any user"
              onPress={() => navigation.navigate('GiftPickles')}
            />
            <Divider S={S} />
            <ActionRow
              S={S}
              label="Review Submitted Venues"
              desc="Confirm or reject user-added courts"
              onPress={() => navigation.navigate('AdminVenueReview')}
            />
            <Divider S={S} />
            <ActionRow
              S={S}
              label="Court Outlines"
              desc="Draw a building outline so check-ins pass anywhere inside"
              onPress={() => navigation.navigate('AdminBoundaries')}
            />
            <Divider S={S} />
            <ActionRow
              S={S}
              label="Reported Content"
              desc="Act on player reports within 24 hours"
              onPress={() => navigation.navigate('ModerationQueue')}
            />
            <Divider S={S} />
            {/* Device-only: read from this phone, never uploaded. */}
            <ActionRow
              S={S}
              label="Court arrival trace"
              desc="This phone's last 200 arrival events"
              detail={trace !== null ? 'Hide' : undefined}
              onPress={() => void toggleTrace()}
            />
            {trace !== null ? (
              <View style={S.traceBox}>
                <Text style={S.traceText} selectable>{trace}</Text>
                <Button title="Clear the trace" size="sm" variant="outline" onPress={() => void clearTrace()} style={S.hug} />
              </View>
            ) : null}
          </Panel>
        </>
      )}

      {/* ── Appearance ───────────────────────── */}
      <SectionHeader title="Appearance" />
      <Panel padded={false} style={S.card}>
        {/* The underline strip: 44-tall tabs, tablist/tab roles on web. */}
        <SegmentedToggle<ThemeMode>
          variant="underline"
          size="sm"
          options={[
            { label: 'System', icon: '⚙️', value: 'system' },
            { label: 'Light',  icon: '☀️', value: 'light' },
            { label: 'Dark',   icon: '🌙', value: 'dark' },
          ]}
          value={themeMode}
          onChange={setThemeMode}
          style={S.themeTabs}
        />
      </Panel>

      {/* ── Danger zone ──────────────────────── */}
      <SectionHeader title="Account actions" />
      <Panel padded={false} style={S.card}>
        <ActionRow S={S} label="Sign out" onPress={openSignOut} />
        <Divider S={S} />
        <ActionRow
          S={S}
          label="Delete account"
          desc="Permanently remove your account and all data"
          onPress={openDeleteAccount}
          danger
        />
      </Panel>

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
            style={[S.passwordInput, webInputFontFloor(S.passwordInput)]}
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

function makeStyles(c: Colors) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen:        { flex: 1, backgroundColor: c.bg },
    // 16 gutter on every screen; 48 of bottom room so the last card clears the
    // home indicator / browser chrome.
    container:     { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xl * 2 },
    card:          { marginBottom: SPACE.md, overflow: 'hidden' },
    // The master push card sits right on top of its collapsed types section.
    cardTight:     { marginBottom: SPACE.sm, overflow: 'hidden' },
    // A one-line row is 44; a row with a description lands at 56 on its own.
    row:           { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 44 },
    rowText:       { flex: 1, minWidth: 0 },
    rowLabel:      t.title,
    rowDesc:       { ...t.sub, marginTop: SPACE.xxs },
    rowDetail:     { ...t.sub, color: c.textMuted, flexShrink: 1 },
    chevron:       { fontSize: FONT.size.h2, color: c.textMuted },
    divider:       { height: HAIRLINE, backgroundColor: c.border, marginHorizontal: SPACE.md },
    dividerFlush:  { height: HAIRLINE, backgroundColor: c.border },
    dangerText:    { color: c.danger },
    themeTabs:     { borderBottomWidth: 0 },
    hug:           { alignSelf: 'flex-start' },
    traceBox:      { paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm, gap: SPACE.xs },
    traceText:     t.meta,
    passwordInput: { borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, minHeight: 44, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surfaceAlt, marginBottom: SPACE.xs },
  });
}
