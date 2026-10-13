import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  sbCall,
  currentUserId as sessionUserId,
  friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import {
  FilterChipRow, FilterPill, FilterSearchField, FilterSheet, SingleSelectModal,
  type FilterChipOption, type FilterSheetGroup,
} from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
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

type ChipKey = 'mine' | 'completed' | 'pending';

/** The sheet's applied values: rarer filters (match type, doubles category). */
type SheetValues = { type: string | null; category: string | null };
const SHEET_DEFAULTS: SheetValues = { type: null, category: null };

// TournamentMatchHistory, UI compaction P5b. Compact rows (56-72, one line of
// meta under the title), an always-visible player search, quick chips
// Mine / Played / Not played, a Round pill, and a Filters sheet for match type
// and doubles category. The round label on each row ships with the Round pill
// (the match-history filter-pill convention, plan section 9). Doubles rows
// name their category only when it is known: "Unspecified" is never shown
// (plan section 6, content rules); the sheet calls that bucket "Other".
export default function TournamentMatchHistoryScreen({ route }: Props) {
  const { tournamentId } = route.params;
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);

  const [matches, setMatches]             = useState<TMatch[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState<string | null>(null);

  const [statusFilter, setStatusFilter]   = useState<StatusFilter>('all');
  const [playerSearch, setPlayerSearch]   = useState('');
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [roundId, setRoundId]             = useState<string | null>(null);
  const [roundPickerOpen, setRoundPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen]         = useState(false);
  const [sheet, setSheet]                 = useState<SheetValues>(SHEET_DEFAULTS);
  const matchType = (sheet.type ?? 'all') as TypeFilter;
  const doublesCategory = (sheet.category ?? 'all') as DoublesCategoryFilter;

  const refresh = useRefresh(load);

  useEffect(() => {
    // LOCAL session read — getUser() is a network call, so offline the
    // "my matches only" filter silently matched nothing.
    sessionUserId(supabase).then(setCurrentUserId);
    load();
  }, []);

  async function load() {
    try {
      const data = await sbCall(() => supabase
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
        .order('match_order'));

      setMatches((data ?? []) as TMatch[]);
      setLoadError(null);
    } catch (e) {
      // Was a discarded error rendering as "no matches played yet".
      setLoadError(friendlySbMessage(e, "Couldn't load the match history."));
    } finally {
      setLoading(false);
    }
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

  // Rounds, in order, for the Round pill.
  const rounds = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; round_number: number }>();
    for (const m of matches) if (m.round && !byId.has(m.round.id)) byId.set(m.round.id, m.round);
    return [...byId.values()].sort((a, b) => a.round_number - b.round_number);
  }, [matches]);
  const selectedRound = roundId ? rounds.find(r => r.id === roundId) ?? null : null;

  // A one-day tournament (every scheduled match on the same calendar day)
  // shows the time alone: the date would repeat on every row, and the time is
  // what tells players when they're on. Otherwise date and time.
  const oneDay = useMemo(() => {
    const days = new Set(matches
      .filter(m => m.scheduled_at)
      .map(m => new Date(m.scheduled_at!).toDateString()));
    return days.size <= 1;
  }, [matches]);

  function renderMatch({ item }: { item: TMatch }) {
    const isDoubles  = item.match_type === 'doubles';
    const team1Name  = teamName(item.team1p1, item.team1p2);
    const team2Name  = teamName(item.team2p1, item.team2p2);
    const team1Won   = item.winner_team === 'team1';
    const completed  = item.status === 'completed' && item.winner_team != null;
    const cat: DoublesCategory | null = isDoubles
      ? classifyDoubles(item.team1p1, item.team1p2, item.team2p1, item.team2p2)
      : null;
    // Content rule: an unknown category is left out, never shown as "Unspecified".
    const typeLabel = isDoubles
      ? (cat === 'gendered' ? 'Gendered doubles' : cat === 'mixed' ? 'Mixed doubles' : 'Doubles')
      : 'Singles';

    const dateStr = item.scheduled_at
      ? oneDay
        ? new Date(item.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : new Date(item.scheduled_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : null;

    // Player-perspective view if logged-in user is in this match
    const viewAs = currentUserId && involvesUser(item, currentUserId) ? currentUserId : null;

    let badge: { text: string; bg: string; fg: string };
    let title: string;
    let score: string;
    let meta: (string | null | undefined)[];
    if (viewAs && completed) {
      const onTeam1  = isOnTeam1(item, viewAs);
      const won      = onTeam1 ? team1Won : !team1Won;
      const myScore  = onTeam1 ? item.team1_score : item.team2_score;
      const oppScore = onTeam1 ? item.team2_score : item.team1_score;
      const myPartner = onTeam1
        ? item.team1p1?.id === viewAs ? item.team1p2 : item.team1p1
        : item.team2p1?.id === viewAs ? item.team2p2 : item.team2p1;
      badge = won ? { text: 'W', bg: c.primary, fg: c.textInverse } : { text: 'L', bg: c.danger, fg: c.textInverse };
      title = `vs ${onTeam1 ? team2Name : team1Name}`;
      score = `${myScore} – ${oppScore}`;
      meta = [item.round?.label, isDoubles && myPartner?.full_name ? `with ${myPartner.full_name}` : null, dateStr, typeLabel];
    } else {
      badge = completed
        ? { text: team1Won ? 'W' : 'L', bg: team1Won ? c.primary : c.danger, fg: c.textInverse }
        : { text: '·', bg: c.surfaceAlt, fg: c.textMuted };
      title = `${team1Name} vs ${team2Name}`;
      score = completed ? `${item.team1_score} – ${item.team2_score}` : 'Not played';
      meta = [item.round?.label, dateStr, typeLabel];
    }

    return (
      <View style={S.card}>
        <View style={[S.badge, { backgroundColor: badge.bg }]}>
          <Text style={[S.badgeText, { color: badge.fg }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{badge.text}</Text>
        </View>
        <View style={S.cardText}>
          <Text style={t.title} numberOfLines={1}>{title}</Text>
          <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {meta.filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Text style={[t.sub, completed ? S.score : S.pendingScore]} numberOfLines={1}>{score}</Text>
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
      if (roundId && m.round?.id !== roundId) return false;

      if (doublesCategory !== 'all') {
        if (m.match_type !== 'doubles') return false;
        const cat = classifyDoubles(m.team1p1, m.team1p2, m.team2p1, m.team2p2);
        if (cat !== doublesCategory) return false;
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
  }, [matches, matchType, statusFilter, myMatchesOnly, currentUserId, playerSearch, doublesCategory, roundId]);

  const myCount = currentUserId ? matches.filter(m => involvesUser(m, currentUserId)).length : 0;
  const sheetCount = (sheet.type ? 1 : 0) + (sheet.category ? 1 : 0);
  const activeFilterCount =
    sheetCount +
    (statusFilter !== 'all' ? 1 : 0) +
    (myMatchesOnly ? 1 : 0) +
    (playerSearch.trim() ? 1 : 0) +
    (roundId ? 1 : 0);
  function clearAll() {
    setStatusFilter('all'); setMyMatchesOnly(false); setPlayerSearch(''); setRoundId(null); setSheet(SHEET_DEFAULTS);
  }

  // Quick chips: Mine (only when you played) and Played / Not played (exclusive).
  const chipOptions: FilterChipOption<ChipKey>[] = [];
  if (myCount > 0) chipOptions.push({ value: 'mine', label: 'Mine', count: myCount });
  chipOptions.push({ value: 'completed', label: 'Played' }, { value: 'pending', label: 'Not played' });
  const chipValues: ChipKey[] = [];
  if (myMatchesOnly) chipValues.push('mine');
  if (statusFilter !== 'all') chipValues.push(statusFilter);
  function onChips(next: ChipKey[]) {
    const added = next.find(v => !chipValues.includes(v));
    setMyMatchesOnly(next.includes('mine'));
    if (next.includes('completed') && next.includes('pending')) setStatusFilter(added === 'pending' ? 'pending' : 'completed');
    else if (next.includes('completed')) setStatusFilter('completed');
    else if (next.includes('pending')) setStatusFilter('pending');
    else setStatusFilter('all');
  }

  const sheetGroups: FilterSheetGroup[] = [
    {
      key: 'type', title: 'Match type', kind: 'single',
      options: [{ value: 'singles', label: 'Singles' }, { value: 'doubles', label: 'Doubles' }],
    },
    {
      key: 'category', title: 'Doubles category', kind: 'single',
      hint: 'From the players\' genders. "Other" is a match where one isn\'t set.',
      options: [
        { value: 'gendered', label: 'Gendered' },
        { value: 'mixed', label: 'Mixed' },
        { value: 'unspecified', label: 'Other' },
      ],
    },
  ];

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;

  if (loadError && matches.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <EmptyState
          icon="📡"
          title="Couldn't load match history"
          subtitle={loadError}
          actionLabel="Try again"
          onAction={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  return (
    <View style={S.container}>
      {/* Filter bar: fixed chrome outside the list (no sticky headers on web) */}
      <View style={S.filterBar}>
        <FilterSearchField
          size="sm"
          value={playerSearch}
          onChangeText={setPlayerSearch}
          placeholder="Search by player name"
          autoCorrect={false}
          autoCapitalize="words"
          returnKeyType="search"
          clearAccessibilityLabel="Clear player search"
        />
        <FilterChipRow
          size="md"
          multi
          options={chipOptions}
          values={chipValues}
          onChangeValues={onChips}
          wrapAtWidth={600}
          trailing={
            <View style={S.trailing}>
              {rounds.length > 1 && (
                <FilterPill
                  label={selectedRound?.label ?? 'Round'}
                  active={!!selectedRound}
                  trailingIconName="chevron-down"
                  onPress={() => setRoundPickerOpen(true)}
                  accessibilityLabel={selectedRound ? `Round: ${selectedRound.label}. Change round` : 'Filter by round'}
                />
              )}
              <FilterPill
                label={sheetCount > 0 ? `Filters (${sheetCount})` : 'Filters'}
                active={sheetCount > 0}
                onPress={() => setSheetOpen(true)}
              />
            </View>
          }
        />
        <View style={S.countRow}>
          <Text style={[t.meta, { flex: 1 }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {filtered.length} match{filtered.length !== 1 ? 'es' : ''}
          </Text>
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={clearAll} style={S.clearBox} accessibilityRole="button" accessibilityLabel="Clear all filters">
              <Text style={[t.meta, { color: c.danger }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderMatch}
        contentContainerStyle={S.list}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListEmptyComponent={
          activeFilterCount > 0
            ? <EmptyState icon="🔍" title="No matches match these filters" actionLabel="Clear filters" onAction={clearAll} />
            : <EmptyState icon="🎾" title="No matches yet" subtitle="No tournament matches yet." />
        }
      />

      <SingleSelectModal
        visible={roundPickerOpen}
        title="Round"
        items={rounds.map(r => ({ id: r.id, name: r.label ?? `Round ${r.round_number}` }))}
        selectedId={roundId}
        noneLabel="All rounds"
        onPick={(id) => { setRoundId(id); setRoundPickerOpen(false); }}
        onClose={() => setRoundPickerOpen(false)}
      />

      <FilterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        groups={sheetGroups}
        values={sheet}
        defaults={SHEET_DEFAULTS}
        onApply={(next) => setSheet({
          type: (next.type as string | null) ?? null,
          category: (next.category as string | null) ?? null,
        })}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    filterBar: {
      paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, gap: SPACE.xs,
      backgroundColor: c.surface, borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    countRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center' },
    clearBox: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
    list: { padding: SPACE.lg },
    // The Compact variant (plan section 6): radius 10, padding 10/12 (the
    // spec's own row padding, as in ListCard), margin 8, hairline border, no
    // shadow, 56 min. One meta line keeps a card under the 72 cap at default
    // text size; it is a minHeight, so large text grows the card, never clips.
    card: {
      minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
      paddingVertical: 10, paddingHorizontal: SPACE.md, marginBottom: SPACE.sm,
      borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surface,
    },
    badge: { width: 28, height: 28, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    badgeText: { fontSize: FONT.size.sm, fontWeight: FONT.weight.heavy },
    cardText: { flex: 1, minWidth: 0, gap: SPACE.xxs },
    score: { fontWeight: FONT.weight.bold, color: c.textSub },
    pendingScore: { fontStyle: 'italic', color: c.textMuted },
  });
}
