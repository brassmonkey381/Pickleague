import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { DoublesCategory, Gender, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type TypeFilter   = 'all' | 'singles' | 'doubles';
type StatusFilter = 'all' | 'completed' | 'pending';
type DoublesCategoryFilter = 'all' | 'gendered' | 'mixed' | 'unspecified';

type Profile = { id: string; full_name: string; gender: Gender | null };

function classifyDoubles(
  p1: Profile | null | undefined,
  p2: Profile | null | undefined,
  p3: Profile | null | undefined,
  p4: Profile | null | undefined,
): DoublesCategory {
  const profs = [p1, p2, p3, p4];
  if (profs.some(p => !p)) return 'unspecified';
  const genders = profs.map(p => p!.gender);
  if (genders.some(g => g == null || g === 'prefer-not-to-say')) return 'unspecified';
  return new Set(genders).size === 1 ? 'gendered' : 'mixed';
}

type TMatch = {
  id: string;
  match_type: 'singles' | 'doubles';
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_team: 'team1' | 'team2' | null;
  status: 'pending' | 'in_progress' | 'completed';
  scheduled_at: string | null;
  match_order: number;
  team1p1?: Profile | null;
  team1p2?: Profile | null;
  team2p1?: Profile | null;
  team2p2?: Profile | null;
  round?: { id: string; label: string; round_number: number } | null;
};

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentMatchHistory'>;
  route:      RouteProp<RootStackParamList, 'TournamentMatchHistory'>;
};

export default function TournamentMatchHistoryScreen({ route }: Props) {
  const { tournamentId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [matches, setMatches]             = useState<TMatch[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]             = useState(true);

  const [showFilters, setShowFilters]     = useState(false);
  const [matchType, setMatchType]         = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter]   = useState<StatusFilter>('all');
  const [playerSearch, setPlayerSearch]   = useState('');
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [doublesCategory, setDoublesCategory] = useState<DoublesCategoryFilter>('all');

  const refresh = useRefresh(load);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setCurrentUserId(user?.id ?? null);
    });
    load();
  }, []);

  async function load() {
    const { data } = await supabase
      .from('tournament_matches')
      .select(`
        *,
        team1p1:profiles!tournament_matches_team1_player1_fkey(id, full_name, gender),
        team1p2:profiles!tournament_matches_team1_player2_fkey(id, full_name, gender),
        team2p1:profiles!tournament_matches_team2_player1_fkey(id, full_name, gender),
        team2p2:profiles!tournament_matches_team2_player2_fkey(id, full_name, gender),
        round:tournament_rounds(id, label, round_number)
      `)
      .eq('tournament_id', tournamentId)
      .order('match_order');

    setMatches((data ?? []) as TMatch[]);
    setLoading(false);
  }

  const involvesUser = (m: TMatch, uid: string) =>
    m.team1_player1 === uid || m.team1_player2 === uid ||
    m.team2_player1 === uid || m.team2_player2 === uid;

  const isOnTeam1 = (m: TMatch, uid: string) =>
    m.team1_player1 === uid || m.team1_player2 === uid;

  function teamName(p1: Profile | null | undefined, p2: Profile | null | undefined) {
    const n1 = p1?.full_name;
    const n2 = p2?.full_name;
    if (n1 && n2) return `${n1} & ${n2}`;
    return n1 ?? n2 ?? '—';
  }

  function renderMatch({ item }: { item: TMatch }) {
    const isDoubles  = item.match_type === 'doubles';
    const team1Name  = teamName(item.team1p1, item.team1p2);
    const team2Name  = teamName(item.team2p1, item.team2p2);
    const team1Won   = item.winner_team === 'team1';
    const completed  = item.status === 'completed' && item.winner_team != null;
    const cat: DoublesCategory | null = isDoubles
      ? classifyDoubles(item.team1p1, item.team1p2, item.team2p1, item.team2p2)
      : null;
    const categoryBadge = cat ? (
      <View style={[
        S.catBadge,
        cat === 'gendered' ? S.catGenderedBg :
        cat === 'mixed'    ? S.catMixedBg    : S.catUnspecBg,
      ]}>
        <Text style={[
          S.catText,
          cat === 'gendered' ? S.catGenderedColor :
          cat === 'mixed'    ? S.catMixedColor    : S.catUnspecColor,
        ]}>
          {cat === 'gendered' ? 'Gendered Doubles' :
           cat === 'mixed'    ? 'Mixed Doubles'    : 'Unspecified Doubles'}
        </Text>
      </View>
    ) : null;

    const dateStr = item.scheduled_at
      ? new Date(item.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
    const timeStr = item.scheduled_at
      ? new Date(item.scheduled_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;

    // Player-perspective view if logged-in user is in this match
    const viewAs = currentUserId && involvesUser(item, currentUserId) ? currentUserId : null;

    if (viewAs && completed) {
      const onTeam1  = isOnTeam1(item, viewAs);
      const won      = onTeam1 ? team1Won : !team1Won;
      const myScore  = onTeam1 ? item.team1_score : item.team2_score;
      const oppScore = onTeam1 ? item.team2_score : item.team1_score;
      const oppName  = onTeam1 ? team2Name : team1Name;
      const myPartner = onTeam1
        ? item.team1p1?.id === viewAs ? item.team1p2 : item.team1p1
        : item.team2p1?.id === viewAs ? item.team2p2 : item.team2p1;

      return (
        <View style={[S.card, won ? S.win : S.loss]}>
          <View style={S.cardHeader}>
            <Text style={[S.result, won ? S.winText : S.lossText]}>{won ? 'W' : 'L'}</Text>
            <View style={S.cardInfo}>
              <Text style={S.opponent} numberOfLines={1}>vs {oppName}</Text>
              {isDoubles && myPartner?.full_name && (
                <Text style={S.partnerText}>🤝 {myPartner.full_name}</Text>
              )}
              {item.round?.label && <Text style={S.roundText}>{item.round.label}</Text>}
              {dateStr && <Text style={S.dateText}>{dateStr}{timeStr ? ` at ${timeStr}` : ''}</Text>}
            </View>
            <View style={S.cardRight}>
              <Text style={S.score}>{myScore} – {oppScore}</Text>
              <Text style={S.typeTag}>{isDoubles ? 'Doubles' : 'Singles'}</Text>
              {categoryBadge}
            </View>
          </View>
        </View>
      );
    }

    // Tournament-wide view (or pending matches)
    return (
      <View style={[S.card, completed ? (team1Won ? S.win : S.loss) : S.pending]}>
        <View style={S.leagueRow}>
          {completed ? (
            <View style={[S.resultMini, team1Won ? S.resultMiniWin : S.resultMiniLoss]}>
              <Text style={S.resultMiniText}>{team1Won ? 'W' : 'L'}</Text>
            </View>
          ) : (
            <View style={[S.resultMini, S.resultMiniPending]}>
              <Text style={S.resultMiniText}>·</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={[S.matchup, completed && team1Won && S.matchupWinner]} numberOfLines={1}>
              {team1Name}
            </Text>
            <Text style={[S.matchup, completed && !team1Won && S.matchupWinner]} numberOfLines={1}>
              vs {team2Name}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            {completed ? (
              <Text style={S.score}>{item.team1_score} – {item.team2_score}</Text>
            ) : (
              <Text style={S.pendingTag}>Not played</Text>
            )}
            <Text style={S.typeTag}>{isDoubles ? 'Doubles' : 'Singles'}</Text>
            {categoryBadge}
          </View>
        </View>
        {item.round?.label && <Text style={S.roundText}>{item.round.label}</Text>}
        {dateStr && <Text style={S.dateText}>{dateStr}{timeStr ? ` at ${timeStr}` : ''}</Text>}
      </View>
    );
  }

  const filtered = useMemo(() => {
    const searchLower = playerSearch.trim().toLowerCase();

    return matches.filter((m) => {
      if (matchType !== 'all' && m.match_type !== matchType) return false;
      if (statusFilter === 'completed' && m.status !== 'completed') return false;
      if (statusFilter === 'pending'   && m.status === 'completed') return false;

      if (myMatchesOnly && currentUserId && !involvesUser(m, currentUserId)) return false;

      if (doublesCategory !== 'all') {
        if (m.match_type !== 'doubles') return false;
        const c = classifyDoubles(m.team1p1, m.team1p2, m.team2p1, m.team2p2);
        if (c !== doublesCategory) return false;
      }

      if (searchLower) {
        const names = [
          m.team1p1?.full_name,
          m.team1p2?.full_name,
          m.team2p1?.full_name,
          m.team2p2?.full_name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!names.includes(searchLower)) return false;
      }

      return true;
    });
  }, [matches, matchType, statusFilter, myMatchesOnly, currentUserId, playerSearch, doublesCategory]);

  const activeFilterCount =
    (matchType !== 'all' ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (myMatchesOnly ? 1 : 0) +
    (playerSearch.trim() ? 1 : 0) +
    (doublesCategory !== 'all' ? 1 : 0);

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;

  return (
    <View style={S.container}>
      {/* Filter bar */}
      <View style={S.filterBar}>
        <Text style={S.countText}>{filtered.length} match{filtered.length !== 1 ? 'es' : ''}</Text>
        <TouchableOpacity
          style={[S.filterBtn, activeFilterCount > 0 && S.filterBtnActive]}
          onPress={() => setShowFilters(v => !v)}
        >
          <Text style={[S.filterBtnText, activeFilterCount > 0 && S.filterBtnTextActive]}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.filterBtn, myMatchesOnly && S.filterBtnActive]}
          onPress={() => setMyMatchesOnly(v => !v)}
        >
          <Text style={[S.filterBtnText, myMatchesOnly && S.filterBtnTextActive]}>👤 Mine</Text>
        </TouchableOpacity>
        {activeFilterCount > 0 && (
          <TouchableOpacity onPress={() => { setMatchType('all'); setStatusFilter('all'); setMyMatchesOnly(false); setPlayerSearch(''); setDoublesCategory('all'); }}>
            <Text style={S.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter panel */}
      {showFilters && (
        <View style={S.filterPanel}>
          <Text style={S.filterLabel}>Player Name</Text>
          <View style={S.searchRow}>
            <TextInput
              style={S.searchInput}
              placeholder="Search by player name..."
              placeholderTextColor={c.textMuted}
              value={playerSearch}
              onChangeText={setPlayerSearch}
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
            />
            {playerSearch.length > 0 && (
              <TouchableOpacity
                style={S.clearSearch}
                onPress={() => setPlayerSearch('')}
                accessibilityRole="button"
                accessibilityLabel="Clear player search"
              >
                <Text style={S.clearSearchText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={S.filterLabel}>Status</Text>
          <View style={S.pillRow}>
            {(['all', 'completed', 'pending'] as StatusFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[S.pill, statusFilter === v && S.pillActive]} onPress={() => setStatusFilter(v)}>
                <Text style={[S.pillText, statusFilter === v && S.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'completed' ? 'Completed' : 'Not played'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={S.filterLabel}>Match Type</Text>
          <View style={S.pillRow}>
            {(['all', 'singles', 'doubles'] as TypeFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[S.pill, matchType === v && S.pillActive]} onPress={() => setMatchType(v)}>
                <Text style={[S.pillText, matchType === v && S.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'singles' ? 'Singles' : 'Doubles'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={S.filterLabel}>Doubles Category</Text>
          <View style={S.pillRow}>
            {([
              { v: 'all',         label: 'All' },
              { v: 'gendered',    label: 'Gendered Doubles' },
              { v: 'mixed',       label: 'Mixed Doubles' },
              { v: 'unspecified', label: 'Unspecified Doubles' },
            ] as { v: DoublesCategoryFilter; label: string }[]).map(({ v, label }) => (
              <TouchableOpacity key={v} style={[S.pill, doublesCategory === v && S.pillActive]} onPress={() => setDoublesCategory(v)}>
                <Text style={[S.pillText, doublesCategory === v && S.pillTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderMatch}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListEmptyComponent={<EmptyState icon="🎾" title="No matches yet" subtitle="No tournament matches yet." />}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: c.border, elevation: 3, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 6 },
    win:  { borderLeftColor: c.primary },
    loss: { borderLeftColor: c.danger },
    pending: { borderLeftColor: c.border },
    leagueRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    typeTag: { fontSize: 11, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase' },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    result: { fontSize: 22, fontWeight: '800', width: 28 },
    winText:  { color: c.primary },
    lossText: { color: c.danger },
    cardInfo: { flex: 1, marginLeft: 10 },
    opponent: { fontSize: 15, fontWeight: '600', color: c.text },
    dateText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    roundText: { fontSize: 11, color: c.textSub, fontWeight: '600', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
    partnerText: { fontSize: 12, color: c.primary, marginTop: 1 },
    cardRight: { alignItems: 'flex-end' },
    matchup: { fontSize: 14, fontWeight: '600', color: c.text },
    matchupWinner: { fontWeight: '800', color: c.text },
    score: { fontSize: 15, fontWeight: '700', color: c.textSub },
    pendingTag: { fontSize: 12, color: c.textMuted, fontStyle: 'italic' },
    resultMini: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    resultMiniWin:     { backgroundColor: c.primary },
    resultMiniLoss:    { backgroundColor: c.danger },
    resultMiniPending: { backgroundColor: c.border },
    resultMiniText: { color: '#fff', fontSize: 12, fontWeight: '800' },

    filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    countText: { flex: 1, fontSize: 13, color: c.textMuted },
    filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: c.border },
    filterBtnActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    filterBtnText: { fontSize: 13, fontWeight: '600', color: c.textSub },
    filterBtnTextActive: { color: c.primary },
    clearText: { fontSize: 13, color: c.danger, fontWeight: '600' },
    filterPanel: { backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    filterLabel: { fontSize: 12, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
    pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    pillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    pillText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
    pillTextActive: { color: c.primary, fontWeight: '700' },
    searchRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    searchInput: {
      flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 8, fontSize: 14,
      backgroundColor: c.surface, color: c.text,
    },
    clearSearch: { paddingHorizontal: 10, paddingVertical: 8 },
    clearSearchText: { fontSize: 14, color: c.textMuted, fontWeight: '600' },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },

    catBadge:        { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, marginTop: 2 },
    catGenderedBg:   { backgroundColor: c.primaryLight },
    catMixedBg:      { backgroundColor: '#f3e5f5' },
    catUnspecBg:     { backgroundColor: c.bg },
    catText:         { fontSize: 11, fontWeight: '700' },
    catGenderedColor:{ color: c.primary },
    catMixedColor:   { color: '#8e24aa' },
    catUnspecColor:  { color: c.textMuted },
  });
}
