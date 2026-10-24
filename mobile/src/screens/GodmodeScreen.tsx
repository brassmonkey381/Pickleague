import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import EmptyState from '../components/EmptyState';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { setClipboard } from '../lib/clipboard';
import UserPickerModal, { PickedUser } from '../components/UserPickerModal';
import { verifyTournament, CheckResult } from '../lib/bracketVerification';
import { HideTestAccountsSwitch } from '../components/TestAccountSwitches';
import { entityIcon } from '../lib/entityGlyph';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Chip, FilterPill, Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Godmode'> };

type CreatedAccount = {
  user_id: string;
  email: string;
  password: string;
  username: string;
  full_name: string;
};

type PendingInvitee = { user_id: string; user_name: string };

type ActiveInvite = {
  code_id: string;
  scope_type: 'league' | 'tournament';
  scope_id: string;
  scope_name: string | null;
  token: string;
  expires_at: string;
  used_count: number;
  max_uses: number | null;
  already_member: boolean;
  pending_invitees: PendingInvitee[];
};

function daysUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(ms / 86400000);
  if (days <= 0) return 'expired';
  if (days === 1) return '1 day';
  return `${days} days`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export default function GodmodeScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [fullName, setFullName] = useState('');
  const [genderChoice, setGenderChoice] = useState<GenderChoice>('random');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAccount[]>([]);
  const [invites, setInvites] = useState<ActiveInvite[] | null>(null);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [acceptingCodeId, setAcceptingCodeId] = useState<string | null>(null);
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [acceptingInviteeKey, setAcceptingInviteeKey] = useState<string | null>(null);
  const [bulkAcceptingCodeId, setBulkAcceptingCodeId] = useState<string | null>(null);

  const [pluprPickerOpen, setPluprPickerOpen] = useState(false);
  const [pluprTarget, setPluprTarget] = useState<PickedUser | null>(null);
  const [pluprOverall, setPluprOverall] = useState('');
  const [pluprSingles, setPluprSingles] = useState('');
  const [pluprDoubles, setPluprDoubles] = useState('');
  const [pluprMixed,   setPluprMixed]   = useState('');
  const [pluprLoading, setPluprLoading] = useState(false);
  const [pluprSaving,  setPluprSaving]  = useState(false);

  const [verifyId, setVerifyId] = useState('');
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [verifyResults, setVerifyResults] = useState<CheckResult[] | null>(null);

  async function runVerify() {
    const id = verifyId.trim();
    if (!id) return;
    setVerifyRunning(true);
    try {
      const results = await verifyTournament(id);
      setVerifyResults(results);
    } catch (err) {
      setVerifyResults([{ ok: false, label: 'Verification crashed', detail: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setVerifyRunning(false);
    }
  }

  const status = useStatusMessage();
  const refresh = useRefresh(loadInvites);

  useFocusEffect(useCallback(() => {
    (async () => {
      // LOCAL session read: getUser() is a network call, so offline the
      // godmode account failed its own access check and saw the denial screen.
      const uid = await currentUserId(supabase);
      const ok = isGodmodeUserId(uid);
      setAuthorized(ok);
      if (ok) loadInvites();
    })();
  }, []));

  async function loadInvites() {
    setLoadingInvites(true);
    try {
      const data = await sbCall(() => supabase.rpc('godmode_list_active_invites'));
      setInvites((data ?? []) as ActiveInvite[]);
    } catch (e) {
      status.error(`Couldn't load invites: ${friendlySbMessage(e)}`);
    } finally {
      setLoadingInvites(false);
    }
  }

  async function acceptInvite(invite: ActiveInvite): Promise<{ ok: boolean; message: string }> {
    const { data, error } = await supabase.rpc('redeem_invite_code', { p_token: invite.token });
    if (error) return { ok: false, message: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) return { ok: false, message: row?.message ?? 'Redeem failed' };
    return { ok: true, message: row.message ?? 'Joined' };
  }

  async function forceAccept(invite: ActiveInvite) {
    setAcceptingCodeId(invite.code_id);
    const result = await acceptInvite(invite);
    setAcceptingCodeId(null);
    if (result.ok) {
      status.success(`Joined ${invite.scope_name ?? invite.scope_type}`);
      loadInvites();
    } else {
      status.error(result.message);
    }
  }

  async function acceptAllEligible() {
    if (!invites) return;
    const eligible = invites.filter(i => !i.already_member);
    if (eligible.length === 0) return;
    setAcceptingAll(true);
    let joined = 0;
    let failed = 0;
    for (const inv of eligible) {
      const r = await acceptInvite(inv);
      if (r.ok) joined++; else failed++;
    }
    setAcceptingAll(false);
    if (failed === 0) {
      status.success(`Force-accepted ${joined} invite${joined === 1 ? '' : 's'}`);
    } else {
      status.error(`Joined ${joined}, ${failed} failed`);
    }
    loadInvites();
  }

  async function forceAcceptInvitee(invite: ActiveInvite, invitee: PendingInvitee): Promise<{ ok: boolean; message: string }> {
    const { data, error } = await supabase.rpc('godmode_force_accept_invitee', {
      p_code_id: invite.code_id,
      p_user_id: invitee.user_id,
    });
    if (error) return { ok: false, message: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) return { ok: false, message: row?.message ?? 'Force-accept failed' };
    return { ok: true, message: row.message ?? 'Accepted' };
  }

  async function forceAcceptOneInvitee(invite: ActiveInvite, invitee: PendingInvitee) {
    const key = `${invite.code_id}:${invitee.user_id}`;
    setAcceptingInviteeKey(key);
    const r = await forceAcceptInvitee(invite, invitee);
    setAcceptingInviteeKey(null);
    if (r.ok) {
      status.success(`Added ${invitee.user_name} to ${invite.scope_name ?? invite.scope_type}`);
      loadInvites();
    } else {
      status.error(`${invitee.user_name}: ${r.message}`);
    }
  }

  async function pickPluprTarget(u: PickedUser) {
    setPluprPickerOpen(false);
    setPluprTarget(u);
    setPluprLoading(true);
    const { data } = await supabase
      .from('profiles')
      .select('rating, singles_rating, doubles_rating, mixed_doubles_rating')
      .eq('id', u.id)
      .single();
    setPluprLoading(false);
    setPluprOverall(data?.rating != null         ? String(data.rating)              : '');
    setPluprSingles(data?.singles_rating != null ? String(data.singles_rating)      : '');
    setPluprDoubles(data?.doubles_rating != null ? String(data.doubles_rating)      : '');
    setPluprMixed(  data?.mixed_doubles_rating != null ? String(data.mixed_doubles_rating) : '');
  }

  async function savePlupr() {
    if (!pluprTarget) return;
    const parse = (s: string): number | null => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    setPluprSaving(true);
    const { data, error } = await supabase.rpc('godmode_set_plupr', {
      p_user_id: pluprTarget.id,
      p_overall: parse(pluprOverall),
      p_singles: parse(pluprSingles),
      p_doubles: parse(pluprDoubles),
      p_mixed:   parse(pluprMixed),
    });
    setPluprSaving(false);
    if (error) { status.error(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      setPluprOverall(row.rating != null              ? String(row.rating)              : '');
      setPluprSingles(row.singles_rating != null      ? String(row.singles_rating)      : '');
      setPluprDoubles(row.doubles_rating != null      ? String(row.doubles_rating)      : '');
      setPluprMixed(  row.mixed_doubles_rating != null ? String(row.mixed_doubles_rating): '');
    }
    status.success(`Saved PLUPR for ${pluprTarget.full_name}`);
  }

  async function forceAcceptAllInvitees(invite: ActiveInvite) {
    if (invite.pending_invitees.length === 0) return;
    setBulkAcceptingCodeId(invite.code_id);
    let ok = 0;
    let fail = 0;
    for (const inv of invite.pending_invitees) {
      const r = await forceAcceptInvitee(invite, inv);
      if (r.ok) ok++; else fail++;
    }
    setBulkAcceptingCodeId(null);
    if (fail === 0) {
      status.success(`Force-accepted ${ok} invitee${ok === 1 ? '' : 's'} into ${invite.scope_name ?? invite.scope_type}`);
    } else {
      status.error(`Accepted ${ok}, ${fail} failed`);
    }
    loadInvites();
  }

  const { first, last } = splitName(fullName);
  const previewEmail = first && last ? `${slug(first)}.${slug(last)}@pickleague.test` : '';
  const previewUsername = first && last ? `${slug(first)}${slug(last)}` : '';
  const canSubmit = !!first && !!last && !creating;

  async function createAccount() {
    if (!canSubmit) return;
    status.clear();
    setCreating(true);
    const body: { first_name: string; last_name: string; gender?: string } = {
      first_name: first,
      last_name: last,
    };
    if (genderChoice !== 'random') body.gender = genderChoice;
    const { data, error } = await supabase.functions.invoke<CreatedAccount>(
      'godmode-create-user',
      { body },
    );
    setCreating(false);
    if (error) { status.error(error.message); return; }
    if (!data?.user_id) { status.error('Edge function returned no user_id'); return; }
    setCreated(prev => [data, ...prev].slice(0, 10));
    setFullName('');
    setGenderChoice('random');
    status.success(`Created ${data.full_name} (${data.email})`);
  }

  async function copy(text: string, label: string) {
    try {
      await setClipboard(text);
      status.success(`${label} copied`);
    } catch (err) {
      status.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (authorized === false) {
    return (
      <View style={S.gated}>
        <EmptyState iconName="block" title="Godmode only" subtitle="This area is restricted." />
      </View>
    );
  }
  if (authorized === null) return null;

  const eligibleCount = (invites ?? []).filter(i => !i.already_member).length;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.container} refreshControl={<AppRefreshControl {...refresh} />}>
      <Text style={S.hint}>
        Admin-only utilities. Anything risky should go behind a confirm. Feel free
        to keep stacking sections here as needs come up.
      </Text>

      <StatusBanner status={status.value} style={S.banner} />

      <SectionHeader title="Test accounts" />
      <Panel style={S.card}>
        <HideTestAccountsSwitch />
        <Text style={S.previewNote}>
          Seeded, SIM, QA and review accounts are test accounts, and so is every account made
          below. Mark or unmark anyone else from their profile.
        </Text>
      </Panel>

      <SectionHeader title="Quick-create test account" />
      <Panel style={S.card}>
        <Text style={S.label}>Full name</Text>
        <TextInput
          style={S.input}
          placeholder="e.g. Justin Lucas"
          placeholderTextColor={c.textMuted}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          autoCorrect={false}
        />

        <Text style={[S.label, S.labelGap]}>Gender</Text>
        <View style={S.genderRow}>
          {GENDER_CHOICES.map(g => (
            <FilterPill
              key={g.value}
              label={g.label}
              iconName={g.value === 'random' ? 'dice' : undefined}
              active={genderChoice === g.value}
              onPress={() => setGenderChoice(g.value)}
            />
          ))}
        </View>

        {previewEmail ? (
          <View style={S.previewBox}>
            <PreviewRow label="Email"    value={previewEmail}    S={S} />
            <PreviewRow label="Username" value={previewUsername} S={S} />
            <PreviewRow label="Password" value="Pickle123!"      S={S} />
            <PreviewRow label="Gender"   value={genderLabel(genderChoice)} S={S} />
            <Text style={S.previewNote}>Email is pre-confirmed — usable on first sign-in.</Text>
          </View>
        ) : (
          <Text style={S.placeholderHint}>Enter a first and last name to preview.</Text>
        )}

        <Button
          title="Create account"
          onPress={createAccount}
          loading={creating}
          disabled={!canSubmit}
          style={S.primaryBtn}
        />
      </Panel>

      {created.length > 0 && (
        <>
          <SectionHeader title="Recently created (this session)" />
          <Panel padded={false} style={S.card}>
            {created.map((acct, i) => (
              <View key={acct.user_id} style={[S.acctRow, i === created.length - 1 && S.acctRowLast]}>
                <Text style={S.acctName}>{acct.full_name}</Text>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>{acct.email}</Text>
                  <Button
                    title="Copy"
                    size="sm"
                    variant="outline"
                    onPress={() => copy(acct.email, 'Email')}
                    accessibilityLabel={`Copy email ${acct.email}`}
                  />
                </View>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>Password: {acct.password}</Text>
                  <Button
                    title="Copy"
                    size="sm"
                    variant="outline"
                    onPress={() => copy(acct.password, 'Password')}
                    accessibilityLabel={`Copy password for ${acct.full_name}`}
                  />
                </View>
              </View>
            ))}
          </Panel>
        </>
      )}

      <SectionHeader
        title="Active invites"
        action={{
          label: loadingInvites ? 'Refreshing…' : 'Refresh',
          onPress: () => { if (!loadingInvites) void loadInvites(); },
        }}
      />
      <Panel style={S.card}>
        {invites === null || loadingInvites ? (
          <ActivityIndicator color={c.primary} />
        ) : invites.length === 0 ? (
          <EmptyState compact iconName="mail" title="No active invites" subtitle="No active invite codes in the system." />
        ) : (
          <>
            <Button
              title={`Force-accept all eligible${eligibleCount > 0 ? ` (${eligibleCount})` : ''}`}
              onPress={acceptAllEligible}
              loading={acceptingAll}
              disabled={eligibleCount === 0}
              style={S.acceptAllBtn}
            />
            {invites.map((inv, i) => (
              <View key={inv.code_id} style={[S.inviteRow, i === invites.length - 1 && S.inviteRowLast]}>
                <View style={S.inviteHeaderInline}>
                  {inv.scope_type === 'tournament'
                    ? <Chip size="sm" tone="warning" iconName={entityIcon('tournament')} label="tournament" align="center" />
                    : <Chip size="sm" tone="brand" iconName={entityIcon('league')} label="league" align="center" />}
                  <Text style={S.inviteScopeName} numberOfLines={1}>
                    {inv.scope_name ?? '(unknown scope)'}
                  </Text>
                </View>
                <View style={S.inviteMetaRow}>
                  <Text style={S.inviteToken}>{inv.token}</Text>
                  <Text style={S.inviteMeta}>
                    {daysUntil(inv.expires_at)}
                    {inv.max_uses != null ? ` · ${inv.used_count}/${inv.max_uses} used` : ` · ${inv.used_count} used`}
                  </Text>
                </View>
                {inv.already_member ? (
                  <View style={S.alreadyJoined}>
                    <Icon name="check-mark" size={14} color={c.success} />
                    <Text style={S.alreadyJoinedText}>You're a member</Text>
                  </View>
                ) : (
                  <Button
                    title="Join me"
                    size="sm"
                    variant="outline"
                    onPress={() => forceAccept(inv)}
                    loading={acceptingCodeId === inv.code_id}
                    style={S.hug}
                  />
                )}

                {inv.pending_invitees.length > 0 && (
                  <View style={S.inviteeBlock}>
                    <View style={S.inviteeHeader}>
                      <Text style={S.inviteeHeaderText}>
                        {inv.pending_invitees.length} pending invitee{inv.pending_invitees.length === 1 ? '' : 's'}
                      </Text>
                      {inv.pending_invitees.length > 1 && (
                        <Button
                          title="Accept all"
                          size="sm"
                          variant="outline"
                          onPress={() => forceAcceptAllInvitees(inv)}
                          loading={bulkAcceptingCodeId === inv.code_id}
                        />
                      )}
                    </View>
                    {inv.pending_invitees.map(invitee => {
                      const key = `${inv.code_id}:${invitee.user_id}`;
                      const busy = acceptingInviteeKey === key || bulkAcceptingCodeId === inv.code_id;
                      return (
                        <View key={invitee.user_id} style={S.inviteeRow}>
                          <Text style={S.inviteeName} numberOfLines={1}>{invitee.user_name}</Text>
                          <Button
                            title="Force accept"
                            size="sm"
                            variant="outline"
                            onPress={() => forceAcceptOneInvitee(inv, invitee)}
                            loading={acceptingInviteeKey === key}
                            disabled={busy}
                            accessibilityLabel={`Force accept ${invitee.user_name}`}
                          />
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            ))}
          </>
        )}
      </Panel>

      <SectionHeader title="Player PLUPR" />
      <Panel style={S.card}>
        <Text style={S.tbdText}>
          Manually set any player's PLUPR values. Match history is left
          untouched — values here will be re-affected on the next match insert.
        </Text>
        <Button
          title={pluprTarget ? `Picked: ${pluprTarget.full_name} — change` : 'Pick a player'}
          size="sm"
          variant="outline"
          onPress={() => setPluprPickerOpen(true)}
          style={[S.hug, S.gapTop]}
        />

        {pluprTarget && (
          pluprLoading ? (
            <ActivityIndicator color={c.primary} style={S.gapTop} />
          ) : (
            <>
              {([
                ['Overall', pluprOverall, setPluprOverall],
                ['Singles', pluprSingles, setPluprSingles],
                ['Doubles', pluprDoubles, setPluprDoubles],
                ['Mixed',   pluprMixed,   setPluprMixed],
              ] as const).map(([label, value, set]) => (
                <View key={label} style={S.pluprRow}>
                  <Text style={S.pluprLabel}>{label}</Text>
                  <TextInput
                    style={S.pluprInput}
                    keyboardType="decimal-pad"
                    value={value}
                    onChangeText={set}
                    placeholder="—"
                    placeholderTextColor={c.textMuted}
                    accessibilityLabel={`${label} PLUPR`}
                  />
                </View>
              ))}
              <Text style={S.previewNote}>Leave a field blank to keep its current value.</Text>
              <Button title="Save PLUPR" onPress={savePlupr} loading={pluprSaving} style={S.primaryBtn} />
            </>
          )
        )}
      </Panel>

      <SectionHeader title="Verify bracket structure" />
      <Panel style={S.card}>
        <Text style={S.tbdText}>
          Read-only check: loads a tournament's rounds and matches, then compares
          against the expected formulas for its format (RR, SE, Pool Play). Does
          not modify any data.
        </Text>
        <TextInput
          style={[S.input, S.inputGap]}
          placeholder="Tournament ID (uuid)"
          placeholderTextColor={c.textMuted}
          value={verifyId}
          onChangeText={setVerifyId}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          title="Verify"
          onPress={runVerify}
          loading={verifyRunning}
          disabled={!verifyId.trim()}
          style={S.primaryBtn}
        />

        {verifyResults && verifyResults.length > 0 && (
          <View style={S.gapTop}>
            {verifyResults.map((r, i) => {
              const mark = r.ok === 'info'
                ? { icon: 'info' as const, color: c.textMuted, label: 'Info' }
                : r.ok
                  ? { icon: 'check-mark' as const, color: c.success, label: 'Passed' }
                  : { icon: 'close' as const, color: c.danger, label: 'Failed' };
              return (
                <View key={i} style={S.verifyRow}>
                  <Icon name={mark.icon} size={16} color={mark.color} accessibilityLabel={mark.label} style={S.verifyMark} />
                  <View style={S.verifyText}>
                    <Text style={[S.verifyLabel, { color: mark.color }]}>{r.label}</Text>
                    {r.detail ? <Text style={S.verifyDetail}>{r.detail}</Text> : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </Panel>

      <SectionHeader title="Coming soon" />
      <Panel style={[S.card, S.tbdCard]}>
        <Text style={S.tbdText}>
          More admin utilities can land here. Suggestions: bulk-create accounts,
          impersonate user, force-close a tournament, dump DB stats.
        </Text>
      </Panel>

      <UserPickerModal
        visible={pluprPickerOpen}
        title="Pick a player"
        onPick={pickPluprTarget}
        onClose={() => setPluprPickerOpen(false)}
      />
    </ScrollView>
  );
}

type GenderChoice = 'random' | 'male' | 'female' | 'other' | 'prefer-not-to-say';

const GENDER_CHOICES: { value: GenderChoice; label: string }[] = [
  { value: 'random', label: 'random' },
  { value: 'female', label: 'female' },
  { value: 'male', label: 'male' },
  { value: 'other', label: 'other' },
  { value: 'prefer-not-to-say', label: 'N/A' },
];

const genderLabel = (g: GenderChoice) => GENDER_CHOICES.find(x => x.value === g)?.label ?? g;

function PreviewRow({ label, value, S }: { label: string; value: string; S: ReturnType<typeof makeStyles> }) {
  return (
    <View style={S.previewRow}>
      <Text style={S.previewLabel}>{label}</Text>
      <Text style={S.previewValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen:           { flex: 1, backgroundColor: c.bg },
    container:        { padding: SPACE.lg, paddingBottom: SPACE.xl * 2, flexGrow: 1 },
    hint:             { ...t.hint, marginBottom: SPACE.md },
    banner:           { marginBottom: SPACE.md },
    card:             { marginBottom: SPACE.lg },
    label:            { ...t.fieldLabel, marginBottom: SPACE.xs },
    labelGap:         { marginTop: SPACE.md },
    input:            { borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, minHeight: 44, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, backgroundColor: c.surfaceAlt, color: c.text },
    inputGap:         { marginTop: SPACE.sm },
    previewBox:       { marginTop: SPACE.md, padding: SPACE.md, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border },
    previewRow:       { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: SPACE.xs },
    previewLabel:     { ...t.sub, fontWeight: FONT.weight.semibold, width: 88 },
    previewValue:     { ...t.sub, flex: 1, color: c.text, fontFamily: 'monospace' },
    previewNote:      { ...t.hint, marginTop: SPACE.sm, fontStyle: 'italic' },
    placeholderHint:  { ...t.hint, marginTop: SPACE.md, fontStyle: 'italic' },
    primaryBtn:       { marginTop: SPACE.md },
    acceptAllBtn:     { marginBottom: SPACE.md },
    hug:              { alignSelf: 'flex-start' },
    gapTop:           { marginTop: SPACE.md },
    genderRow:        { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.xs },
    acctRow:          { paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    acctRowLast:      { borderBottomWidth: 0 },
    acctName:         { ...t.title, marginBottom: SPACE.xxs },
    acctMetaRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    acctMeta:         { ...t.sub, flex: 1, fontFamily: 'monospace' },
    tbdCard:          { borderStyle: 'dashed' },
    tbdText:          t.hint,
    gated:            { flex: 1, justifyContent: 'center', backgroundColor: c.bg },

    inviteRow:            { paddingVertical: SPACE.sm, borderBottomWidth: HAIRLINE, borderBottomColor: c.border, gap: SPACE.xs },
    inviteRowLast:        { borderBottomWidth: 0 },
    inviteHeaderInline:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    inviteScopeName:      { ...t.title, flex: 1 },
    inviteMetaRow:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
    inviteToken:          { ...t.sub, fontFamily: 'monospace', fontWeight: FONT.weight.bold },
    inviteMeta:           t.hint,
    alreadyJoined:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
    alreadyJoinedText:    { ...t.sub, fontWeight: FONT.weight.bold, color: c.success },

    inviteeBlock:         { marginTop: SPACE.sm, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    inviteeHeader:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    inviteeHeaderText:    t.fieldLabel,
    inviteeRow:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
    inviteeName:          { ...t.bodySub, flex: 1, color: c.text },

    pluprRow:             { flexDirection: 'row', alignItems: 'center', marginTop: SPACE.sm, gap: SPACE.md },
    pluprLabel:           { ...t.sub, width: 80, fontWeight: FONT.weight.bold },
    pluprInput:           { flex: 1, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surfaceAlt },

    verifyRow:            { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, paddingVertical: SPACE.xs },
    // Centres the 16 glyph on the label's first line.
    verifyMark:           { marginTop: SPACE.xxs },
    verifyText:           { flex: 1, minWidth: 0 },
    verifyLabel:          { ...t.bodySub, fontWeight: FONT.weight.semibold },
    verifyDetail:         { ...t.hint, marginTop: SPACE.xxs },
  });
}
