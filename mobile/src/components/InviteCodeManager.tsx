import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  Share, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from './ConfirmModal';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import MultiUserPickerModal, { MultiPickedUser } from './MultiUserPickerModal';

export type InviteScope = 'league' | 'tournament';

export type InviteCode = {
  id: string;
  scope_type: InviteScope;
  scope_id: string;
  created_by: string | null;
  token: string;
  expires_at: string;
  max_uses: number | null;
  used_count: number;
  is_active: boolean;
  pickle_subsidy: number;
  created_at: string;
};

type Props = {
  scopeType: InviteScope;
  scopeId: string;
  scopeName: string;
  /** Tournament-only: shown next to the subsidy field so creators see the discount math. */
  tournamentAnte?: number;
};

function formatToken(token: string): string {
  const t = token.toUpperCase();
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}`;
}

function daysLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const d = Math.ceil(diff / 86400000);
  return `${d} day${d !== 1 ? 's' : ''} left`;
}

export default function InviteCodeManager({ scopeType, scopeId, scopeName, tournamentAnte }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const status = useStatusMessage();
  const navigation = useNavigation();

  const [invite, setInvite] = useState<InviteCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied]   = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Create-flow state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating]     = useState(false);
  const [maxUsesInput, setMaxUsesInput] = useState<string>('');
  const [subsidyInput, setSubsidyInput] = useState<string>('');
  const [createError, setCreateError]   = useState<string | null>(null);

  // In-app broadcast state
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [broadcasting, setBroadcasting]   = useState(false);
  const [existingMemberIds, setExistingMemberIds] = useState<string[]>([]);

  useFocusEffect(useCallback(() => { void load(); /* eslint-disable-next-line */ }, [scopeId, scopeType]));

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('invite_codes')
      .select('*')
      .eq('scope_type', scopeType)
      .eq('scope_id', scopeId)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setInvite((data as InviteCode) ?? null);
    setLoading(false);
  }

  function openCreate() {
    setMaxUsesInput('');
    setSubsidyInput('');
    setCreateError(null);
    setShowCreate(true);
  }

  async function submitCreate() {
    setCreateError(null);
    const maxUses = maxUsesInput.trim() ? parseInt(maxUsesInput, 10) : null;
    const subsidy = subsidyInput.trim() ? parseInt(subsidyInput, 10) : 0;
    if (maxUsesInput.trim() && (!Number.isFinite(maxUses!) || maxUses! < 1)) {
      setCreateError('Max uses must be a positive number, or leave blank for unlimited.');
      return;
    }
    if (!Number.isFinite(subsidy) || subsidy < 0) {
      setCreateError('Subsidy must be 0 or higher.');
      return;
    }
    if (subsidy > 0 && scopeType !== 'tournament') {
      setCreateError('Subsidies only apply to tournament codes.');
      return;
    }
    if (subsidy > 0 && (maxUses == null || maxUses < 1)) {
      setCreateError('Subsidized codes need a max-uses limit so you know your max spend.');
      return;
    }
    setCreating(true);
    const { data, error } = await supabase.rpc('create_invite_code', {
      p_scope_type:     scopeType,
      p_scope_id:       scopeId,
      p_max_uses:       maxUses,
      p_expires_days:   7,
      p_pickle_subsidy: subsidy,
    });
    setCreating(false);
    if (error) {
      setCreateError(error.message ?? 'Failed to create code.');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setInvite(row as InviteCode);
    setShowCreate(false);
    status.success('Invite code created.');
  }

  function revokeInvite() {
    if (!invite) return;
    setShowRevokeConfirm(true);
  }
  async function confirmRevoke() {
    if (!invite) return;
    setRevoking(true);
    const { error } = await supabase.rpc('revoke_invite_code', { p_code_id: invite.id });
    setRevoking(false);
    setShowRevokeConfirm(false);
    if (error) {
      status.error(error.message ?? 'Failed to revoke.');
      return;
    }
    status.success('Code revoked.');
    setInvite(null);
  }

  async function copyCode() {
    if (!invite) return;
    await Clipboard.setStringAsync(formatToken(invite.token));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function openBroadcast() {
    if (!invite) return;
    // Fetch existing scope members so they don't appear in the picker.
    const ids: string[] = [];
    const { data: me } = await supabase.auth.getUser();
    if (me?.user?.id) ids.push(me.user.id);
    if (scopeType === 'league') {
      const { data } = await supabase.from('league_members')
        .select('user_id').eq('league_id', scopeId);
      (data ?? []).forEach((r: any) => ids.push(r.user_id));
    } else {
      const { data } = await supabase.from('tournament_registrations')
        .select('user_id').eq('tournament_id', scopeId).eq('status', 'approved');
      (data ?? []).forEach((r: any) => ids.push(r.user_id));
    }
    setExistingMemberIds(ids);
    setShowBroadcast(true);
  }

  async function sendBroadcast(users: MultiPickedUser[]) {
    if (!invite || users.length === 0) return;
    setBroadcasting(true);
    const { data, error } = await supabase.rpc('send_invite_code_to_users', {
      p_code_id:  invite.id,
      p_user_ids: users.map(u => u.id),
    });
    setBroadcasting(false);
    if (error) {
      status.error(error.message ?? 'Failed to send.');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      status.error(row?.message ?? 'Failed to send.');
      return;
    }
    setShowBroadcast(false);
    status.success(row.message ?? 'Invites sent.');
  }

  async function share() {
    if (!invite) return;
    const code = formatToken(invite.token);
    const subsidyLine = invite.pickle_subsidy > 0
      ? `\n\n💸 I'll cover ${invite.pickle_subsidy} 🥒 of your entry fee!`
      : '';
    const target = scopeType === 'league' ? 'league' : 'tournament';
    const where = scopeType === 'league' ? 'Leagues → "Join with Code"' : 'Tournaments → "Join with Code"';
    await Share.share({
      message:
        `You're invited to join the ${target} "${scopeName}" on Pickleague! 🏓\n\n` +
        `Use invite code: ${code}${subsidyLine}\n\n` +
        `Open the app → ${where} and enter this code.`,
    });
  }

  if (loading) return <ActivityIndicator style={{ marginVertical: 30 }} size="large" color={c.primary} />;

  const subsidyPreview = (() => {
    const n = parseInt(subsidyInput, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const uses = parseInt(maxUsesInput, 10);
    const maxSpend = Number.isFinite(uses) && uses > 0 ? uses * n : null;
    return { each: n, maxSpend };
  })();

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.subtitle}>
        Share this code with people you want to invite to{' '}
        <Text style={S.scopeName}>{scopeName}</Text>.
      </Text>

      <StatusBanner status={status.value} />

      {invite ? (
        <>
          <View style={S.codeCard}>
            <Text style={S.codeLabel}>Invite Code</Text>
            <Text style={S.code}>{formatToken(invite.token)}</Text>
            <Text style={S.expiry}>
              {daysLeft(invite.expires_at)}
              {invite.max_uses != null
                ? `  ·  ${invite.used_count} / ${invite.max_uses} uses`
                : `  ·  ${invite.used_count} use${invite.used_count !== 1 ? 's' : ''}`}
            </Text>
            {invite.pickle_subsidy > 0 && (
              <View style={S.subsidyBadge}>
                <Text style={S.subsidyBadgeText}>
                  💸 Subsidizing {invite.pickle_subsidy} 🥒 per redemption
                </Text>
              </View>
            )}
          </View>

          <TouchableOpacity style={S.primaryBtn} onPress={openBroadcast}>
            <Text style={S.primaryBtnText}>💬  Invite Players In-App</Text>
          </TouchableOpacity>

          <TouchableOpacity style={S.secondaryBtn} onPress={share}>
            <Text style={S.secondaryBtnText}>📤  Share via Text / Email</Text>
          </TouchableOpacity>

          <TouchableOpacity style={S.secondaryBtn} onPress={copyCode}>
            <Text style={S.secondaryBtnText}>{copied ? '✓  Copied!' : '📋  Copy Code'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={S.dangerBtn} onPress={revokeInvite}>
            <Text style={S.dangerBtnText}>Revoke & Generate New Code</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={S.emptyCard}>
            <Text style={S.emptyIcon}>🔒</Text>
            <Text style={S.emptyText}>No active invite code.</Text>
            <Text style={S.emptyHint}>Generate one to start inviting players.</Text>
          </View>

          <TouchableOpacity style={S.primaryBtn} onPress={openCreate}>
            <Text style={S.primaryBtnText}>Generate Invite Code</Text>
          </TouchableOpacity>
        </>
      )}

      <View style={S.infoBox}>
        <Text style={S.infoText}>
          Recipients open the app, go to {scopeType === 'league' ? 'Leagues' : 'Tournaments'}, tap "Join with Code", and enter this code.
          {'\n\n'}
          Codes expire after 7 days. You can revoke and regenerate at any time.
        </Text>
      </View>

      {/* ── Create / configure modal ─────────────────────────────────── */}
      <ConfirmModal
        visible={showCreate}
        title="Configure invite code"
        body={
          <View>
            <Text style={S.modalLabel}>Max uses</Text>
            <Text style={S.modalHint}>Leave blank for unlimited. Subsidized codes require a limit.</Text>
            <TextInput
              style={S.input}
              keyboardType="number-pad"
              placeholder="unlimited"
              placeholderTextColor={c.textMuted}
              value={maxUsesInput}
              onChangeText={setMaxUsesInput}
            />

            {scopeType === 'tournament' && (
              <>
                <Text style={[S.modalLabel, { marginTop: 14 }]}>Pickle subsidy per redemption</Text>
                <Text style={S.modalHint}>
                  You pay this much 🥒 to discount each redeemer's entry fee.
                  {tournamentAnte != null && tournamentAnte > 0
                    ? ` Tournament ante is ${tournamentAnte} 🥒.`
                    : ' This tournament has no entry fee, so subsidies have no effect.'}
                </Text>
                <TextInput
                  style={S.input}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={c.textMuted}
                  value={subsidyInput}
                  onChangeText={setSubsidyInput}
                />
                {subsidyPreview && (
                  <View style={S.previewBox}>
                    <Text style={S.previewLine}>
                      Each redeemer saves: 🥒 {subsidyPreview.each}
                    </Text>
                    {subsidyPreview.maxSpend != null && (
                      <Text style={S.previewLineBold}>
                        Your max spend: 🥒 {subsidyPreview.maxSpend}
                      </Text>
                    )}
                  </View>
                )}
              </>
            )}
          </View>
        }
        primaryLabel="Generate"
        busy={creating}
        error={createError}
        onConfirm={submitCreate}
        onClose={() => setShowCreate(false)}
      />

      <ConfirmModal
        visible={showRevokeConfirm}
        title="Revoke invite?"
        body="The current code will stop working. You can generate a new one any time."
        primaryLabel="Revoke"
        variant="danger"
        busy={revoking}
        onConfirm={confirmRevoke}
        onClose={() => setShowRevokeConfirm(false)}
      />

      <MultiUserPickerModal
        visible={showBroadcast}
        title={`Invite players to ${scopeName}`}
        excludeUserIds={existingMemberIds}
        busy={broadcasting}
        onConfirm={sendBroadcast}
        onClose={() => setShowBroadcast(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:      { padding: 24, flexGrow: 1, backgroundColor: c.bg },
    subtitle:       { fontSize: 15, color: c.textSub, lineHeight: 22, marginBottom: 16 },
    scopeName:      { fontWeight: '700', color: c.text },

    codeCard: {
      backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 28,
      alignItems: 'center', marginBottom: 20, marginTop: 8,
      borderWidth: 1.5, borderColor: c.border,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    codeLabel:      { fontSize: 12, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
    code:           { fontSize: 34, fontWeight: '800', color: c.text, letterSpacing: 6, fontVariant: ['tabular-nums'] as any },
    expiry:         { fontSize: 13, color: c.textMuted, marginTop: 10 },

    subsidyBadge:    { marginTop: 12, backgroundColor: '#fff8e1', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#e6c875' },
    subsidyBadgeText:{ fontSize: 13, fontWeight: '700', color: '#8a6d00' },

    primaryBtn:     { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    secondaryBtn:   { borderWidth: 1.5, borderColor: c.primary, padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
    secondaryBtnText:{ color: c.primary, fontSize: 15, fontWeight: '600' },
    dangerBtn:      { padding: 14, alignItems: 'center', marginBottom: 8 },
    dangerBtnText:  { color: c.danger, fontSize: 14 },

    emptyCard: {
      backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 36, alignItems: 'center', marginBottom: 24, marginTop: 8,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    emptyIcon:      { fontSize: 40, marginBottom: 12 },
    emptyText:      { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 4 },
    emptyHint:      { fontSize: 14, color: c.textMuted },

    infoBox:        { backgroundColor: c.bg, borderRadius: 10, padding: 14, marginTop: 8, borderWidth: 1, borderColor: c.border },
    infoText:       { fontSize: 13, color: c.textSub, lineHeight: 20 },

    modalLabel:     { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    modalHint:      { fontSize: 12, color: c.textMuted, lineHeight: 16, marginBottom: 6 },
    input:          { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, color: c.text, backgroundColor: c.surface },
    previewBox:     { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12, marginTop: 12 },
    previewLine:    { fontSize: 13, color: c.textSub, marginVertical: 1 },
    previewLineBold:{ fontSize: 14, color: c.primary, fontWeight: '800', marginTop: 4 },
  });
}
