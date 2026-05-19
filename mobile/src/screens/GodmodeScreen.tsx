import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { setClipboard } from '../lib/clipboard';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Godmode'> };

type CreatedAccount = {
  user_id: string;
  email: string;
  password: string;
  username: string;
  full_name: string;
};

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
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAccount[]>([]);
  const [invites, setInvites] = useState<ActiveInvite[] | null>(null);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [acceptingCodeId, setAcceptingCodeId] = useState<string | null>(null);
  const [acceptingAll, setAcceptingAll] = useState(false);
  const status = useStatusMessage();

  useFocusEffect(useCallback(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const ok = isGodmodeUserId(user?.id);
      setAuthorized(ok);
      if (ok) loadInvites();
    })();
  }, []));

  async function loadInvites() {
    setLoadingInvites(true);
    const { data, error } = await supabase.rpc('godmode_list_active_invites');
    setLoadingInvites(false);
    if (error) { status.error(`Couldn't load invites: ${error.message}`); return; }
    setInvites((data ?? []) as ActiveInvite[]);
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

  const { first, last } = splitName(fullName);
  const previewEmail = first && last ? `${slug(first)}.${slug(last)}@pickleague.test` : '';
  const previewUsername = first && last ? `${slug(first)}${slug(last)}` : '';
  const canSubmit = !!first && !!last && !creating;

  async function createAccount() {
    if (!canSubmit) return;
    status.clear();
    setCreating(true);
    const { data, error } = await supabase.functions.invoke<CreatedAccount>(
      'godmode-create-user',
      { body: { first_name: first, last_name: last } },
    );
    setCreating(false);
    if (error) { status.error(error.message); return; }
    if (!data?.user_id) { status.error('Edge function returned no user_id'); return; }
    setCreated(prev => [data, ...prev].slice(0, 10));
    setFullName('');
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
        <Text style={S.gatedTitle}>🚫 Godmode only</Text>
        <Text style={S.gatedBody}>This area is restricted.</Text>
      </View>
    );
  }
  if (authorized === null) return null;

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.hint}>
        Admin-only utilities. Anything risky should go behind a confirm. Feel free
        to keep stacking sections here as needs come up.
      </Text>

      <StatusBanner status={status.value} style={S.banner} />

      <Text style={S.sectionHeader}>Quick-create test account</Text>
      <View style={S.card}>
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

        {previewEmail ? (
          <View style={S.previewBox}>
            <PreviewRow label="Email"    value={previewEmail}    colors={c} />
            <PreviewRow label="Username" value={previewUsername} colors={c} />
            <PreviewRow label="Password" value="Pickle123!"      colors={c} />
            <Text style={S.previewNote}>Email is pre-confirmed — usable on first sign-in.</Text>
          </View>
        ) : (
          <Text style={S.placeholderHint}>Enter a first and last name to preview.</Text>
        )}

        <TouchableOpacity
          style={[S.primaryBtn, !canSubmit && S.primaryBtnDim]}
          onPress={createAccount}
          disabled={!canSubmit}
        >
          {creating
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={S.primaryBtnText}>Create account</Text>}
        </TouchableOpacity>
      </View>

      {created.length > 0 && (
        <>
          <Text style={S.sectionHeader}>Recently created (this session)</Text>
          <View style={S.card}>
            {created.map((acct, i) => (
              <View key={acct.user_id} style={[S.acctRow, i === created.length - 1 && S.acctRowLast]}>
                <Text style={S.acctName}>{acct.full_name}</Text>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>{acct.email}</Text>
                  <TouchableOpacity onPress={() => copy(acct.email, 'Email')} style={S.copyBtn}>
                    <Text style={S.copyBtnText}>Copy</Text>
                  </TouchableOpacity>
                </View>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>Password: {acct.password}</Text>
                  <TouchableOpacity onPress={() => copy(acct.password, 'Password')} style={S.copyBtn}>
                    <Text style={S.copyBtnText}>Copy</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </>
      )}

      <View style={S.inviteHeaderRow}>
        <Text style={S.sectionHeader}>Active invites</Text>
        <TouchableOpacity onPress={loadInvites} disabled={loadingInvites}>
          <Text style={S.refreshLink}>{loadingInvites ? 'Refreshing…' : 'Refresh'}</Text>
        </TouchableOpacity>
      </View>
      <View style={S.card}>
        {invites === null || loadingInvites ? (
          <ActivityIndicator color={c.primary} />
        ) : invites.length === 0 ? (
          <Text style={S.tbdText}>No active invite codes in the system.</Text>
        ) : (
          <>
            {(() => {
              const eligible = invites.filter(i => !i.already_member);
              return (
                <TouchableOpacity
                  style={[S.primaryBtn, (eligible.length === 0 || acceptingAll) && S.primaryBtnDim, { marginBottom: 12, marginTop: 0 }]}
                  onPress={acceptAllEligible}
                  disabled={eligible.length === 0 || acceptingAll}
                >
                  {acceptingAll
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={S.primaryBtnText}>
                        Force-accept all eligible{eligible.length > 0 ? ` (${eligible.length})` : ''}
                      </Text>}
                </TouchableOpacity>
              );
            })()}
            {invites.map((inv, i) => (
              <View key={inv.code_id} style={[S.inviteRow, i === invites.length - 1 && S.inviteRowLast]}>
                <View style={S.inviteHeaderInline}>
                  <View style={[S.scopeBadge, inv.scope_type === 'tournament' ? S.scopeBadgeTournament : S.scopeBadgeLeague]}>
                    <Text style={S.scopeBadgeText}>
                      {inv.scope_type === 'tournament' ? '🏆 tournament' : '🎾 league'}
                    </Text>
                  </View>
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
                  <Text style={S.alreadyJoined}>✓ Already a member</Text>
                ) : (
                  <TouchableOpacity
                    style={[S.acceptBtn, acceptingCodeId === inv.code_id && S.primaryBtnDim]}
                    onPress={() => forceAccept(inv)}
                    disabled={acceptingCodeId === inv.code_id}
                  >
                    {acceptingCodeId === inv.code_id
                      ? <ActivityIndicator color={c.primary} size="small" />
                      : <Text style={S.acceptBtnText}>Force accept</Text>}
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </>
        )}
      </View>

      <Text style={S.sectionHeader}>Coming soon</Text>
      <View style={[S.card, S.tbdCard]}>
        <Text style={S.tbdText}>
          More admin utilities can land here. Suggestions: bulk-create accounts,
          impersonate user, reset PLUPR, force-close a tournament, dump DB stats.
        </Text>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function PreviewRow({
  label, value, colors,
}: { label: string; value: string; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: colors.textSub, fontSize: 13, fontWeight: '600', width: 88 }}>{label}</Text>
      <Text style={{ flex: 1, color: colors.text, fontSize: 13, fontFamily: 'monospace' }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:        { padding: 16, backgroundColor: c.bg, flexGrow: 1 },
    hint:             { color: c.textMuted, fontSize: 13, marginBottom: 12, lineHeight: 18 },
    banner:           { marginBottom: 12 },
    sectionHeader:    { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginBottom: 8 },
    card:             { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16, marginBottom: 16 },
    label:            { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 6 },
    input:            { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, backgroundColor: c.bg, color: c.text },
    previewBox:       { marginTop: 12, padding: 12, backgroundColor: c.bg, borderRadius: 10, borderWidth: 1, borderColor: c.border },
    previewNote:      { color: c.textMuted, fontSize: 12, marginTop: 8, fontStyle: 'italic' },
    placeholderHint:  { color: c.textMuted, fontSize: 13, marginTop: 12, fontStyle: 'italic' },
    primaryBtn:       { marginTop: 14, backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    primaryBtnDim:    { opacity: 0.5 },
    primaryBtnText:   { color: '#fff', fontSize: 15, fontWeight: '700' },
    acctRow:          { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
    acctRowLast:      { borderBottomWidth: 0 },
    acctName:         { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 4 },
    acctMetaRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
    acctMeta:         { flex: 1, fontSize: 13, color: c.textSub, fontFamily: 'monospace' },
    copyBtn:          { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
    copyBtnText:      { fontSize: 12, fontWeight: '700', color: c.primary },
    tbdCard:          { borderStyle: 'dashed' },
    tbdText:          { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    gated:            { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: c.bg },
    gatedTitle:       { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 8 },
    gatedBody:        { color: c.textMuted, fontSize: 14 },

    inviteHeaderRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8, marginBottom: 8 },
    refreshLink:          { color: c.primary, fontSize: 13, fontWeight: '700' },
    inviteRow:            { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border, gap: 4 },
    inviteRowLast:        { borderBottomWidth: 0 },
    inviteHeaderInline:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
    scopeBadge:           { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
    scopeBadgeLeague:     { backgroundColor: c.primaryLight },
    scopeBadgeTournament: { backgroundColor: '#fff1d6' },
    scopeBadgeText:       { fontSize: 11, fontWeight: '700', color: c.text },
    inviteScopeName:      { flex: 1, fontSize: 15, fontWeight: '700', color: c.text },
    inviteMetaRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    inviteToken:          { fontSize: 13, fontFamily: 'monospace', color: c.textSub, fontWeight: '700' },
    inviteMeta:           { fontSize: 12, color: c.textMuted },
    alreadyJoined:        { fontSize: 13, fontWeight: '700', color: c.primary, marginTop: 4 },
    acceptBtn:            { alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.primary, backgroundColor: c.surface },
    acceptBtnText:        { color: c.primary, fontSize: 13, fontWeight: '700' },
  });
}
