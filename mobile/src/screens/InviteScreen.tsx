import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Share, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { LeagueInvite, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import ConfirmModal from '../components/ConfirmModal';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Invite'>;
  route: RouteProp<RootStackParamList, 'Invite'>;
};

function formatToken(token: string): string {
  // Format 12-char hex as XXXX-XXXX-XXXX
  const t = token.toUpperCase();
  return `${t.slice(0,4)}-${t.slice(4,8)}-${t.slice(8,12)}`;
}

function daysLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const d = Math.ceil(diff / 86400000);
  return `${d} day${d !== 1 ? 's' : ''} left`;
}

export default function InviteScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const { leagueId, leagueName } = route.params;
  const [invite, setInvite] = useState<LeagueInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useFocusEffect(useCallback(() => { loadInvite(); }, []));

  async function loadInvite() {
    setLoading(true);
    const { data } = await supabase
      .from('league_invites')
      .select('*')
      .eq('league_id', leagueId)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setInvite(data as LeagueInvite | null);
    setLoading(false);
  }

  async function generateInvite() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('league_invites')
      .insert({ league_id: leagueId, created_by: user!.id })
      .select()
      .single();
    if (error) Alert.alert('Error', error.message);
    else setInvite(data as LeagueInvite);
  }

  function revokeInvite() {
    if (!invite) return;
    setShowRevokeConfirm(true);
  }
  async function confirmRevoke() {
    if (!invite) return;
    setRevoking(true);
    await supabase.from('league_invites').update({ is_active: false }).eq('id', invite.id);
    setRevoking(false);
    setShowRevokeConfirm(false);
    setInvite(null);
  }

  async function copyCode() {
    if (!invite) return;
    await Clipboard.setStringAsync(formatToken(invite.token));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function share() {
    if (!invite) return;
    const code = formatToken(invite.token);
    await Share.share({
      message:
        `You're invited to join "${leagueName}" on Pickleague! 🏓\n\n` +
        `Use invite code: ${code}\n\n` +
        `Open the app → Leagues → "Join with Code" and enter this code.`,
    });
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.subtitle}>
        Share this code with players you want to invite to{' '}
        <Text style={S.leagueName}>{leagueName}</Text>.
      </Text>

      {invite ? (
        <>
          {/* Code display */}
          <View style={S.codeCard}>
            <Text style={S.codeLabel}>Invite Code</Text>
            <Text style={S.code}>{formatToken(invite.token)}</Text>
            <Text style={S.expiry}>
              {daysLeft(invite.expires_at)}
              {invite.max_uses != null
                ? `  ·  ${invite.used_count} / ${invite.max_uses} uses`
                : `  ·  ${invite.used_count} use${invite.used_count !== 1 ? 's' : ''}`}
            </Text>
          </View>

          {/* Actions */}
          <TouchableOpacity style={S.primaryBtn} onPress={share}>
            <Text style={S.primaryBtnText}>📤  Share via Text / Email</Text>
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

          <TouchableOpacity style={S.primaryBtn} onPress={generateInvite}>
            <Text style={S.primaryBtnText}>Generate Invite Code</Text>
          </TouchableOpacity>
        </>
      )}

      <View style={S.infoBox}>
        <Text style={S.infoText}>
          Recipients open the app, go to Leagues, tap "Join with Code", and enter this code.
          {'\n\n'}
          Codes expire after 7 days. You can revoke and regenerate at any time.
        </Text>
      </View>

      <ConfirmModal
        visible={showRevokeConfirm}
        title="Revoke invite?"
        body="The current code will stop working."
        primaryLabel="Revoke"
        variant="danger"
        busy={revoking}
        onConfirm={confirmRevoke}
        onClose={() => setShowRevokeConfirm(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:      { padding: 24, flexGrow: 1, backgroundColor: c.bg },
    subtitle:       { fontSize: 15, color: c.textSub, lineHeight: 22, marginBottom: 24 },
    leagueName:     { fontWeight: '700', color: c.text },
    codeCard: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 14,
      padding: 28,
      alignItems: 'center',
      marginBottom: 20,
      borderWidth: 1.5,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    codeLabel:      { fontSize: 12, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
    code:           { fontSize: 34, fontWeight: '800', color: c.text, letterSpacing: 6, fontVariant: ['tabular-nums'] as any },
    expiry:         { fontSize: 13, color: c.textMuted, marginTop: 10 },
    primaryBtn:     { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    secondaryBtn:   { borderWidth: 1.5, borderColor: c.primary, padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
    secondaryBtnText:{ color: c.primary, fontSize: 15, fontWeight: '600' },
    dangerBtn:      { padding: 14, alignItems: 'center', marginBottom: 8 },
    dangerBtnText:  { color: c.danger, fontSize: 14 },
    emptyCard: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 14,
      padding: 36,
      alignItems: 'center',
      marginBottom: 24,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    emptyIcon:      { fontSize: 40, marginBottom: 12 },
    emptyText:      { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 4 },
    emptyHint:      { fontSize: 14, color: c.textMuted },
    infoBox:        { backgroundColor: c.bg, borderRadius: 10, padding: 14, marginTop: 8, borderWidth: 1, borderColor: c.border },
    infoText:       { fontSize: 13, color: c.textSub, lineHeight: 20 },
  });
}
