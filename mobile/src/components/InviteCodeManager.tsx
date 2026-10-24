import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { setClipboard } from '../lib/clipboard';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { shareInvite } from '../lib/share';
import { sendSmsInvite } from '../lib/sms';
import ConfirmModal from './ConfirmModal';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import MultiUserPickerModal, { MultiPickedUser } from './MultiUserPickerModal';
import { DISCOVER_ENABLED } from '../lib/features';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { shadowColor } from '@just-messin-around/expo-foundation/theme';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { PickleAmount, picklesLabel } from './PickleAmount';

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
    try {
      const data = await sbCall(() => supabase
        .from('invite_codes')
        .select('*')
        .eq('scope_type', scopeType)
        .eq('scope_id', scopeId)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle());
      setInvite((data as InviteCode) ?? null);
    } catch (e) {
      // Don't clear `invite`: a failed read used to show "no active code",
      // and the admin would create a second one that supersedes the code
      // they'd already sent everybody.
      status.error(friendlySbMessage(e, "Couldn't check for an active invite code."));
    } finally {
      setLoading(false);
    }
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
    try {
      // No auto-retry: each call mints a NEW code, so a retried request that
      // already landed would leave two live codes for the same scope.
      const data = await sbCall(
        () => supabase.rpc('create_invite_code', {
          p_scope_type:     scopeType,
          p_scope_id:       scopeId,
          p_max_uses:       maxUses,
          p_expires_days:   7,
          p_pickle_subsidy: subsidy,
        }),
        { retries: 0 },
      );
      const row = Array.isArray(data) ? data[0] : data;
      setInvite(row as InviteCode);
      setShowCreate(false);
      status.success('Invite code created.');
    } catch (e) {
      setCreateError(friendlySbMessage(e, 'Failed to create code.'));
    } finally {
      setCreating(false);
    }
  }

  function revokeInvite() {
    if (!invite) return;
    setShowRevokeConfirm(true);
  }
  async function confirmRevoke() {
    if (!invite) return;
    setRevoking(true);
    try {
      // Idempotent (revoking an already-revoked code is a no-op), so retrying
      // through a flaky connection is safe — and leaving a code the admin
      // believes is dead still live is the failure that matters here.
      await sbCall(() => supabase.rpc('revoke_invite_code', { p_code_id: invite.id }));
      status.success('Code revoked.');
      setInvite(null);
      setShowRevokeConfirm(false);
    } catch (e) {
      status.error(friendlySbMessage(e, 'Failed to revoke.'));
    } finally {
      setRevoking(false);
    }
  }

  // Builds the friendly multi-line invite message (code + subsidy + join link)
  // shared by both the "Copy Code" and "Share" actions.
  function buildInviteMessage(): string {
    if (!invite) return '';
    const code = formatToken(invite.token);
    const subsidyLine = invite.pickle_subsidy > 0
      ? `\n💸 I'll cover ${invite.pickle_subsidy} 🥒 of your entry fee!`
      : '';
    const target = scopeType === 'league' ? 'league' : 'tournament';
    // Both kinds: code entry is on the leagues list (one code table,
    // redeem_invite_code), and the link opens it with the code filled in
    // (/leagues is Discover › Leagues while Discover is on).
    const joinUrl = `https://www.pickleague.club/leagues?prefillInviteCode=${encodeURIComponent(code)}`;
    return (
      `You're invited to join the ${target} "${scopeName}" on Pickleague! 🥒\n` +
      `Use invite code: ${code}${subsidyLine}\n\n` +
      `Join here: ${joinUrl} (or open Leagues, tap + then "Enter code")`
    );
  }

  async function copyCode() {
    if (!invite) return;
    try {
      await setClipboard(buildInviteMessage());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      status.error(err instanceof Error ? err.message : 'Failed to copy code.');
    }
  }

  async function openBroadcast() {
    if (!invite) return;
    // Fetch existing scope members so they don't appear in the picker.
    const ids: string[] = [];
    // LOCAL session read (getUser() is a network call that fails offline).
    const uid = await currentUserId(supabase);
    if (uid) ids.push(uid);
    try {
      // A discarded error here left the exclusion list empty, so the picker
      // offered to re-invite everyone who is already in the league.
      const rows = scopeType === 'league'
        ? await sbCall(() => supabase.from('league_members').select('user_id').eq('league_id', scopeId))
        : await sbCall(() => supabase.from('tournament_registrations')
            .select('user_id').eq('tournament_id', scopeId).eq('status', 'approved'));
      ((rows ?? []) as any[]).forEach((r: any) => ids.push(r.user_id));
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't load the current roster — try again."));
      return;
    }
    setExistingMemberIds(ids);
    setShowBroadcast(true);
  }

  async function sendBroadcast(users: MultiPickedUser[]) {
    if (!invite || users.length === 0) return;
    setBroadcasting(true);
    try {
      // No auto-retry: each call sends notifications, and a retried request
      // that already landed double-notifies everyone picked.
      const data = await sbCall(
        () => supabase.rpc('send_invite_code_to_users', {
          p_code_id:  invite.id,
          p_user_ids: users.map(u => u.id),
        }),
        { retries: 0 },
      );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.success) {
        status.error(row?.message ?? 'Failed to send.');
        return;
      }
      setShowBroadcast(false);
      status.success(row.message ?? 'Invites sent.');
    } catch (e) {
      status.error(friendlySbMessage(e, 'Failed to send.'));
    } finally {
      setBroadcasting(false);
    }
  }

  async function share() {
    if (!invite) return;
    // TODO: smoke-test in browser
    const result = await shareInvite({
      title: `Join ${scopeName} on Pickleague`,
      message: buildInviteMessage(),
    });
    if (result.copied) {
      status.success('Invite copied to clipboard');
    }
  }

  async function textInvite() {
    if (!invite) return;
    const result = await sendSmsInvite({ message: buildInviteMessage() });
    if (result.copied) {
      // No SMS handler (e.g. desktop browser) — we copied instead.
      status.success('No texting app found — invite copied to clipboard');
    }
  }

  if (loading) return <ActivityIndicator style={{ marginVertical: SPACE.xl }} size="large" color={c.primary} />;

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
              <View
                style={S.subsidyBadge}
                accessible
                accessibilityLabel={`Subsidizing ${picklesLabel(invite.pickle_subsidy)} per redemption`}
              >
                <Icon name="gift" size={14} color={c.warning} />
                <Text style={S.subsidyBadgeText}>Subsidizing</Text>
                <PickleAmount amount={invite.pickle_subsidy} preset="sub" color={c.warning} textStyle={S.subsidyAmount} />
                <Text style={S.subsidyBadgeText}>per redemption</Text>
              </View>
            )}
          </View>

          <Button iconName="chat" title="Invite Players In-App" onPress={openBroadcast} style={S.actionBtn} />
          <Button iconName="phone" variant="outline" title="Invite via Text" onPress={textInvite} style={S.actionBtn} />
          <Button iconName="outbox" variant="outline" title="Share via Text / Email" onPress={share} style={S.actionBtn} />
          <Button
            iconName={copied ? 'check-mark' : 'clipboard'}
            variant="outline"
            title={copied ? 'Copied!' : 'Copy Code'}
            onPress={copyCode}
            style={S.actionBtn}
          />

          <TouchableOpacity style={S.dangerBtn} onPress={revokeInvite} accessibilityRole="button">
            <Text style={S.dangerBtnText}>Revoke & Generate New Code</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={S.emptyCard}>
            <Icon name="lock" size={40} color={c.textMuted} style={S.emptyIcon} />
            <Text style={S.emptyText}>No active invite code.</Text>
            <Text style={S.emptyHint}>Generate one to start inviting players.</Text>
          </View>

          <Button title="Generate Invite Code" onPress={openCreate} style={S.actionBtn} />
        </>
      )}

      <View style={S.infoBox}>
        <Text style={S.infoText}>
          {/* One code table (redeem_invite_code): Enter code on Leagues takes a tournament's code too. */}
          Recipients open the app, go to {DISCOVER_ENABLED ? 'Discover › Leagues' : 'Play › Leagues'}, tap + then "Enter code", and enter this code.
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
                <Text style={[S.modalLabel, { marginTop: SPACE.md }]}>Pickle subsidy per redemption</Text>
                <Text style={S.modalHint}>
                  You pay this many pickles to discount each redeemer's entry fee.
                  {tournamentAnte != null && tournamentAnte > 0
                    ? ` Tournament ante is ${picklesLabel(tournamentAnte)}.`
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
                    <View style={S.previewRow}>
                      <Text style={S.previewLine}>Each redeemer saves:</Text>
                      <PickleAmount amount={subsidyPreview.each} preset="sub" color={c.textSub} />
                    </View>
                    {subsidyPreview.maxSpend != null && (
                      <View style={[S.previewRow, S.previewRowBold]}>
                        <Text style={S.previewLineBold}>Your max spend:</Text>
                        <PickleAmount amount={subsidyPreview.maxSpend} preset="bodySub" textStyle={S.previewLineBold} />
                      </View>
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
        nearScope={{ type: scopeType, id: scopeId }}
        busy={broadcasting}
        onConfirm={sendBroadcast}
        onClose={() => setShowBroadcast(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container:      { padding: SPACE.xl, flexGrow: 1, backgroundColor: c.bg },
    subtitle:       { ...t.body, color: c.textSub, marginBottom: SPACE.lg },
    scopeName:      { fontWeight: FONT.weight.bold, color: c.text },

    codeCard: {
      backgroundColor: c.surfaceAlt, borderRadius: RADIUS.lg, padding: SPACE.xl,
      alignItems: 'center', marginBottom: SPACE.lg, marginTop: SPACE.sm,
      borderWidth: 1.5, borderColor: c.border,
      shadowColor: shadowColor(c), shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    codeLabel:      { ...t.fieldLabel, letterSpacing: 1, marginBottom: SPACE.sm },
    code:           { fontSize: FONT.size.display, fontWeight: FONT.weight.heavy, color: c.text, letterSpacing: 6, fontVariant: ['tabular-nums'] as any },
    expiry:         { ...t.hint, marginTop: SPACE.sm },

    subsidyBadge:    { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, marginTop: SPACE.md, backgroundColor: c.warningLight, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderWidth: HAIRLINE, borderColor: c.warning },
    subsidyBadgeText:{ fontSize: FONT.size.base, fontWeight: FONT.weight.bold, color: c.warning },
    subsidyAmount:   { fontWeight: FONT.weight.bold },

    actionBtn:      { marginBottom: SPACE.md },
    dangerBtn:      { minHeight: 44, padding: SPACE.md, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
    dangerBtnText:  { color: c.danger, fontSize: FONT.size.md },

    emptyCard: {
      backgroundColor: c.surfaceAlt, borderRadius: RADIUS.lg, padding: SPACE.xl, alignItems: 'center', marginBottom: SPACE.xl, marginTop: SPACE.sm,
      shadowColor: shadowColor(c), shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    emptyIcon:      { marginBottom: SPACE.md },
    emptyText:      { ...t.h3, marginBottom: SPACE.xs },
    emptyHint:      { ...t.bodySub, color: c.textMuted },

    infoBox:        { backgroundColor: c.bg, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    infoText:       { ...t.sub, lineHeight: FONT.line.normal },

    modalLabel:     { ...t.sub, fontWeight: FONT.weight.bold, marginBottom: SPACE.xs },
    modalHint:      { ...t.hint, fontSize: FONT.size.sm, lineHeight: 16, marginBottom: SPACE.xs },
    input:          { borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },
    previewBox:     { backgroundColor: c.primaryLight, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
    previewRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm, marginVertical: SPACE.xxs },
    previewRowBold: { marginTop: SPACE.xs },
    previewLine:    { fontSize: FONT.size.base, color: c.textSub },
    previewLineBold:{ fontSize: FONT.size.md, color: c.primary, fontWeight: FONT.weight.heavy },
  });
}
