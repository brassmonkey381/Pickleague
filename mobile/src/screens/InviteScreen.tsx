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
  const { leagueId, leagueName } = route.params;
  const [invite, setInvite] = useState<LeagueInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

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

  async function revokeInvite() {
    if (!invite) return;
    Alert.alert('Revoke invite?', 'The current code will stop working.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: async () => {
          await supabase.from('league_invites').update({ is_active: false }).eq('id', invite.id);
          setInvite(null);
        },
      },
    ]);
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

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.subtitle}>
        Share this code with players you want to invite to{' '}
        <Text style={styles.leagueName}>{leagueName}</Text>.
      </Text>

      {invite ? (
        <>
          {/* Code display */}
          <View style={styles.codeCard}>
            <Text style={styles.codeLabel}>Invite Code</Text>
            <Text style={styles.code}>{formatToken(invite.token)}</Text>
            <Text style={styles.expiry}>
              {daysLeft(invite.expires_at)}
              {invite.max_uses != null
                ? `  ·  ${invite.used_count} / ${invite.max_uses} uses`
                : `  ·  ${invite.used_count} use${invite.used_count !== 1 ? 's' : ''}`}
            </Text>
          </View>

          {/* Actions */}
          <TouchableOpacity style={styles.primaryBtn} onPress={share}>
            <Text style={styles.primaryBtnText}>📤  Share via Text / Email</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={copyCode}>
            <Text style={styles.secondaryBtnText}>{copied ? '✓  Copied!' : '📋  Copy Code'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.dangerBtn} onPress={revokeInvite}>
            <Text style={styles.dangerBtnText}>Revoke & Generate New Code</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>🔒</Text>
            <Text style={styles.emptyText}>No active invite code.</Text>
            <Text style={styles.emptyHint}>Generate one to start inviting players.</Text>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={generateInvite}>
            <Text style={styles.primaryBtnText}>Generate Invite Code</Text>
          </TouchableOpacity>
        </>
      )}

      <View style={styles.infoBox}>
        <Text style={styles.infoText}>
          Recipients open the app, go to Leagues, tap "Join with Code", and enter this code.
          {'\n\n'}
          Codes expire after 7 days. You can revoke and regenerate at any time.
        </Text>
      </View>
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 24, flexGrow: 1, backgroundColor: '#fff' },
  subtitle: { fontSize: 15, color: '#555', lineHeight: 22, marginBottom: 24 },
  leagueName: { fontWeight: '700', color: '#1a1a1a' },
  codeCard: { backgroundColor: '#f9f9f9', borderRadius: 16, padding: 28, alignItems: 'center', marginBottom: 20, borderWidth: 1.5, borderColor: '#eee' },
  codeLabel: { fontSize: 12, color: '#aaa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  code: { fontSize: 34, fontWeight: '800', color: '#1a1a1a', letterSpacing: 6, fontVariant: ['tabular-nums'] as any },
  expiry: { fontSize: 13, color: '#888', marginTop: 10 },
  primaryBtn: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryBtn: { borderWidth: 1.5, borderColor: GREEN, padding: 14, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
  secondaryBtnText: { color: GREEN, fontSize: 15, fontWeight: '600' },
  dangerBtn: { padding: 14, alignItems: 'center', marginBottom: 8 },
  dangerBtnText: { color: '#c62828', fontSize: 14 },
  emptyCard: { backgroundColor: '#f9f9f9', borderRadius: 16, padding: 36, alignItems: 'center', marginBottom: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 17, fontWeight: '700', color: '#333', marginBottom: 4 },
  emptyHint: { fontSize: 14, color: '#aaa' },
  infoBox: { backgroundColor: '#f0f0f0', borderRadius: 10, padding: 14, marginTop: 8 },
  infoText: { fontSize: 13, color: '#666', lineHeight: 20 },
});
