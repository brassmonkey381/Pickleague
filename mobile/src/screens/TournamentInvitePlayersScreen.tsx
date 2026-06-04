import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { AVATARS } from '../data/profileCustomization';
import { formatPlupr } from '../lib/plupr';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentInvitePlayers'>;
  route: RouteProp<RootStackParamList, 'TournamentInvitePlayers'>;
};

type Candidate = {
  id: string;
  full_name: string;
  username: string;
  rating: number;
  total_matches_played: number;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  ratingDiff: number;       // |rating - tournament avg|
  invitedNow: boolean;      // local optimistic flag
  inviteError: string | null;
};

export default function TournamentInvitePlayersScreen({ navigation, route }: Props) {
  const { tournamentId, tournamentName } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [loading, setLoading]       = useState(true);
  const [busy, setBusy]             = useState<string | null>(null);
  const [query, setQuery]           = useState('');
  const [tournamentAvg, setTournamentAvg] = useState<number>(3.25);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [excluded, setExcluded]     = useState<Set<string>>(new Set());

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, [tournamentId]));

  async function load() {
    setLoading(true);

    // 1. Existing tournament registrations (any status) — exclude these.
    const regsRes = await supabase
      .from('tournament_registrations')
      .select('user_id, status, profile:profiles!tournament_registrations_user_id_fkey(rating)')
      .eq('tournament_id', tournamentId);

    const regs = (regsRes.data ?? []) as any[];
    const excludeIds = new Set<string>(regs.map(r => r.user_id));
    setExcluded(excludeIds);

    // 2. Tournament average rating (use approved registrants only; fall back to overall).
    const approvedRatings = regs
      .filter(r => r.status === 'approved' && typeof r.profile?.rating === 'number')
      .map(r => r.profile.rating as number);
    const avg = approvedRatings.length
      ? approvedRatings.reduce((a, b) => a + b, 0) / approvedRatings.length
      : 3.25;
    setTournamentAvg(avg);

    // 3. Pull all profiles in a wide rating band around the tournament avg
    //    (+/- 1.5 PLUPR) so the recommendation list isn't huge.
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, full_name, username, rating, total_matches_played, avatar_id, avatar_emoji, avatar_bg_color')
      .gte('rating', avg - 1.5)
      .lte('rating', avg + 1.5)
      .order('full_name')
      .limit(500);

    const list: Candidate[] = ((profs ?? []) as any[])
      .filter(p => !excludeIds.has(p.id))
      .map(p => ({
        id: p.id,
        full_name: p.full_name,
        username: p.username,
        rating: p.rating,
        total_matches_played: p.total_matches_played ?? 0,
        avatar_id: p.avatar_id,
        avatar_emoji: p.avatar_emoji,
        avatar_bg_color: p.avatar_bg_color,
        ratingDiff: Math.abs(p.rating - avg),
        invitedNow: false,
        inviteError: null,
      }))
      .sort((a, b) => a.ratingDiff - b.ratingDiff);

    setCandidates(list);
    setLoading(false);
  }

  async function invite(c: Candidate) {
    setBusy(c.id);
    // Clear any prior error on this row before retrying.
    setCandidates(prev => prev.map(p => p.id === c.id ? { ...p, inviteError: null } : p));

    const { data, error } = await supabase.rpc('tournament_invite_player', {
      p_tournament_id: tournamentId,
      p_user_id:       c.id,
    });
    setBusy(null);

    // Surface the failure inline next to the row instead of via Alert —
    // Alert.alert occasionally collapses silently on web in some focus states.
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[tournament_invite_player]', error);
      const msg = error.message ?? 'Unknown error';
      const friendlier = /only.*has.*🥒|ante is/i.test(msg)
        ? 'They don\'t have enough 🥒 for the entry ante.'
        : msg;
      setCandidates(prev => prev.map(p => p.id === c.id ? { ...p, inviteError: friendlier } : p));
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      setCandidates(prev => prev.map(p => p.id === c.id ? { ...p, inviteError: row?.message ?? 'Could not invite.' } : p));
      return;
    }
    setCandidates(prev => prev.map(p => p.id === c.id ? { ...p, invitedNow: true, inviteError: null } : p));
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c =>
      c.full_name.toLowerCase().includes(q) || c.username.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <SkeletonList rows={6} />
      </View>
    );
  }

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.headerTitle}>Invite Players</Text>
        <Text style={S.headerSub}>to {tournamentName}</Text>
        <View style={S.infoPills}>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>Avg PLUPR</Text>
            <Text style={S.infoPillValue}>{tournamentAvg.toFixed(2)}</Text>
          </View>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>Already in</Text>
            <Text style={S.infoPillValue}>{excluded.size}</Text>
          </View>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>Eligible</Text>
            <Text style={S.infoPillValue}>{candidates.length}</Text>
          </View>
        </View>
      </View>

      <View style={S.searchRow}>
        <TextInput
          style={S.searchInput}
          placeholder="Search by name or @username…"
          placeholderTextColor={c.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity
            style={S.clearBtn}
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Text style={S.clearBtnText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={S.hint}>
        Sorted by closest PLUPR to the tournament average. Players already registered or pending are filtered out.
      </Text>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        renderItem={({ item }) => {
          const cartoon = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
          const emoji   = item.avatar_emoji ?? cartoon.emoji;
          const bg      = item.avatar_bg_color ?? cartoon.bgColor;
          const ratingDeltaTxt = item.ratingDiff < 0.005
            ? 'same PLUPR'
            : (item.rating - tournamentAvg > 0 ? '+' : '') + (item.rating - tournamentAvg).toFixed(2) + ' vs avg';

          return (
            <View style={S.rowWrap}>
              <View style={S.row}>
                <View style={[S.avatar, { backgroundColor: bg }]}>
                  <Text style={S.avatarEmoji}>{emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.name} numberOfLines={1}>{item.full_name}</Text>
                  <Text style={S.sub} numberOfLines={1}>
                    @{item.username} · {formatPlupr(item.rating, item.total_matches_played)} PLUPR · {ratingDeltaTxt}
                  </Text>
                </View>
                {item.invitedNow ? (
                  <View style={[S.btn, S.btnDone]}>
                    <Text style={S.btnDoneText}>✓ Invited</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[S.btn, S.btnPrimary, busy === item.id && S.btnDim]}
                    onPress={() => invite(item)}
                    disabled={busy === item.id}
                  >
                    {busy === item.id
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={S.btnPrimaryText}>Invite</Text>}
                  </TouchableOpacity>
                )}
              </View>
              {item.inviteError && (
                <Text style={S.rowError}>⚠ {item.inviteError}</Text>
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          query
            ? <EmptyState icon="🔍" title="No matches" subtitle="No players match that search." />
            : <EmptyState icon="🏓" title="No eligible players" subtitle="No eligible players found in the PLUPR band ±1.5 of the tournament average." />
        }
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<AppRefreshControl {...refresh} />}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    loadingRoot: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' },
    root:        { flex: 1, backgroundColor: c.bg },

    header:      { backgroundColor: c.surface, padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
    headerTitle: { fontSize: 22, fontWeight: '900', color: c.text },
    headerSub:   { fontSize: 13, color: c.textSub, marginTop: 2 },
    infoPills:   { flexDirection: 'row', gap: 8, marginTop: 12 },
    infoPill:    { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
    infoPillLabel: { fontSize: 10, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
    infoPillValue: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 2 },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    clearBtn:    { paddingHorizontal: 12, paddingVertical: 8 },
    clearBtnText:{ fontSize: 16, color: c.textMuted, fontWeight: '700' },

    hint: { fontSize: 11, color: c.textMuted, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, lineHeight: 15 },

    rowWrap:     { borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface },
    row:         { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
    rowError:    { backgroundColor: '#ffe5e5', color: '#8a1414', fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingBottom: 10, paddingTop: 0 },
    avatar:      { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 22 },
    name:        { fontSize: 15, fontWeight: '700', color: c.text },
    sub:         { fontSize: 12, color: c.textMuted, marginTop: 1 },

    btn:         { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, minWidth: 80, alignItems: 'center' },
    btnPrimary:  { backgroundColor: c.primary },
    btnPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 13 },
    btnDone:     { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    btnDoneText: { color: c.textMuted, fontWeight: '700', fontSize: 13 },
    btnDim:      { opacity: 0.6 },

    empty:       { textAlign: 'center', color: c.textMuted, padding: 32, fontSize: 14 },
  });
}
