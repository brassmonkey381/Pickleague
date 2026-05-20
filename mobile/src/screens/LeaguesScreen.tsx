import React, { useEffect, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Switch, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { LeagueWithStats, RootStackParamList } from '../types';
import { REGIONS, getRegionName, inRegion } from '../lib/regions';
import { displayCourtName } from '../lib/courtNickname';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { checkGodmode, countActiveAdminLeagues } from '../lib/godmode';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Leagues'>;
  route: RouteProp<RootStackParamList, 'Leagues'>;
};

type Filters = {
  openOnly: boolean;
  createdWithin: number | null;
  minPlayers: number;
  region: string | null;
};

const DEFAULT_FILTERS: Filters = { openOnly: false, createdWithin: null, minPlayers: 0, region: null };

const CREATED_WITHIN_OPTIONS = [
  { label: 'All time', value: null },
  { label: '7 days',   value: 7 },
  { label: '30 days',  value: 30 },
  { label: '90 days',  value: 90 },
];

const MIN_PLAYERS_OPTIONS = [
  { label: 'Any',  value: 0 },
  { label: '5+',   value: 5 },
  { label: '10+',  value: 10 },
  { label: '20+',  value: 20 },
];

function activeFilterCount(f: Filters): number {
  return (f.openOnly ? 1 : 0) + (f.createdWithin !== null ? 1 : 0) + (f.minPlayers > 0 ? 1 : 0) + (f.region !== null ? 1 : 0);
}

function applyFilters(leagues: LeagueWithStats[], f: Filters): LeagueWithStats[] {
  return leagues.filter((l) => {
    if (f.openOnly && !l.is_open) return false;
    if (f.minPlayers > 0 && l.memberCount < f.minPlayers) return false;
    if (f.createdWithin !== null) {
      const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86400000;
      if (ageDays > f.createdWithin) return false;
    }
    if (f.region !== null && !inRegion(l.home_court_lat ?? null, l.home_court_lng ?? null, f.region)) return false;
    return true;
  });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Short month + day for the season chip ("Apr 15 – Jul 22"). Year omitted
// unless the start year differs from the end year (then both years shown).
function fmtShort(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtShortYear(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatSeasonRange(startIso: string | null, endIso: string | null): string {
  if (!startIso && !endIso) return 'TBD';
  if (startIso && !endIso) return `Starts ${fmtShort(startIso)}`;
  if (!startIso && endIso) return `Ends ${fmtShort(endIso)}`;
  const startY = new Date(startIso! + 'T00:00:00').getFullYear();
  const endY   = new Date(endIso!   + 'T00:00:00').getFullYear();
  return startY === endY
    ? `${fmtShort(startIso!)} – ${fmtShort(endIso!)}`
    : `${fmtShortYear(startIso!)} – ${fmtShortYear(endIso!)}`;
}

export default function LeaguesScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [allLeagues, setAllLeagues]   = useState<LeagueWithStats[]>([]);
  const [loading, setLoading]         = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters]         = useState<Filters>(DEFAULT_FILTERS);

  // Join-with-code modal state
  const [showJoinCode, setShowJoinCode] = useState(false);
  const [inviteCode, setInviteCode]     = useState('');
  const [joining, setJoining]           = useState(false);
  const [joinError, setJoinError]       = useState('');

  // Create modal state
  const [showCreate, setShowCreate]   = useState(false);
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [isOpen, setIsOpen]           = useState(true);
  const [homeCourt, setHomeCourt]     = useState<CourtResult | null>(null);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating]       = useState(false);

  // Per-account create limit
  const [godmode, setGodmode]                       = useState(false);
  const [activeAdminLeagueCount, setActiveAdminLeagueCount] = useState(0);
  const [showLimitModal, setShowLimitModal] = useState(false);
  const atLeagueLimit = !godmode && activeAdminLeagueCount >= 1;

  const status = useStatusMessage();

  useEffect(() => { loadLeagues(); }, []);

  // Notification tap (or deep-link) can pre-populate an invite code and pop the
  // Join modal automatically. Consume the param so navigating back here later
  // doesn't keep re-opening the modal.
  useEffect(() => {
    const code = route.params?.prefillInviteCode;
    if (!code) return;
    setInviteCode(code);
    setShowJoinCode(true);
    navigation.setParams({ prefillInviteCode: undefined } as any);
  }, [route.params?.prefillInviteCode]);

  async function loadLeagues() {
    setLoading(true);

    const [{ data: leagueRows }, { data: { user } }, godmodeResult] = await Promise.all([
      supabase.from('leagues').select('*').eq('is_active', true).order('created_at', { ascending: false }),
      supabase.auth.getUser(),
      checkGodmode(),
    ]);
    setGodmode(godmodeResult);
    if (user?.id) {
      setActiveAdminLeagueCount(await countActiveAdminLeagues(user.id));
    }

    if (!leagueRows) { setLoading(false); return; }

    const ids = leagueRows.map((l) => l.id);
    const uid = user?.id ?? null;

    // All parallel fetches
    const [memberRes, matchRes, myMemberRes, myRequestRes, seasonRes, tournamentRes] = await Promise.all([
      supabase.from('league_members').select('league_id').in('league_id', ids),
      supabase.from('matches').select('league_id, played_at').in('league_id', ids),
      uid
        ? supabase.from('league_members').select('league_id, role').eq('user_id', uid).in('league_id', ids)
        : Promise.resolve({ data: [] }),
      uid
        ? supabase.from('league_join_requests').select('league_id').eq('user_id', uid).eq('status', 'pending').in('league_id', ids)
        : Promise.resolve({ data: [] }),
      supabase.from('league_seasons')
        .select('league_id, status, baseline_plupr, start_date, end_date')
        .in('league_id', ids)
        .in('status', ['active', 'upcoming']),
      supabase.from('tournaments')
        .select('league_id, status')
        .in('league_id', ids)
        .in('status', ['registration', 'active']),
    ]);

    const memberRows     = memberRes.data ?? [];
    const matchRows      = matchRes.data ?? [];
    const myMembers      = (myMemberRes as any).data ?? [];
    const myRequests     = (myRequestRes as any).data ?? [];
    const seasonRows     = (seasonRes.data ?? []) as { league_id: string; status: string; baseline_plupr: number | null; start_date: string; end_date: string | null }[];
    const tournamentRows = (tournamentRes.data ?? []) as { league_id: string; status: string }[];

    const leagues: LeagueWithStats[] = leagueRows.map((l) => {
      const members    = memberRows.filter((m) => m.league_id === l.id);
      const lMatches   = matchRows.filter((m) => m.league_id === l.id);
      const myMembership = myMembers.find((m: any) => m.league_id === l.id);
      const hasRequested = myRequests.some((r: any) => r.league_id === l.id);
      const distinctDays = new Set(lMatches.map((m) => (m.played_at as string).slice(0, 10))).size;

      const leagueSeasons = seasonRows.filter(s => s.league_id === l.id);
      const myActiveSeasonsOnly = leagueSeasons.filter(s => s.status === 'active');
      // Use the most-recently-started active season's baseline for display.
      const currentSeason = myActiveSeasonsOnly
        .slice()
        .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0];

      // Featured season for the chip: prefer active (latest start), else
      // upcoming (earliest start). Falls back to null → "TBD" in render.
      const upcoming = leagueSeasons
        .filter(s => s.status === 'upcoming')
        .slice()
        .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))[0];
      const featuredSeason = currentSeason ?? upcoming ?? null;
      const featuredStatus: 'active' | 'upcoming' | null = featuredSeason
        ? (featuredSeason.status === 'active' ? 'active' : 'upcoming')
        : null;
      const activeTournamentCount = tournamentRows.filter(t => t.league_id === l.id).length;

      return {
        ...l,
        is_open: l.is_open ?? true,
        memberCount: members.length,
        matchCount: lMatches.length,
        distinctPlayDays: distinctDays,
        myRole: myMembership?.role ?? null,
        hasRequested,
        activeSeasonCount: myActiveSeasonsOnly.length,
        activeTournamentCount,
        currentBaselinePlupr: currentSeason?.baseline_plupr != null ? Number(currentSeason.baseline_plupr) : null,
        featuredSeasonStatus: featuredStatus,
        featuredSeasonStart: featuredSeason?.start_date ?? null,
        featuredSeasonEnd:   featuredSeason?.end_date ?? null,
      };
    });

    setAllLeagues(leagues);
    setLoading(false);
  }

  async function createLeague() {
    setCreateError('');
    if (atLeagueLimit) {
      setCreateError("You're already running an active league. Close it first or have an admin transfer ownership before starting another.");
      return;
    }
    if (!name.trim()) { setCreateError('Please enter a league name.'); return; }
    setCreating(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: newLeague, error } = await supabase.from('leagues').insert({
      name: name.trim(),
      description: description.trim() || null,
      created_by: user!.id,
      is_open: isOpen,
      home_court:     homeCourt?.name ?? null,
      home_court_lat: homeCourt?.lat ?? null,
      home_court_lng: homeCourt?.lng ?? null,
    }).select().single();
    setCreating(false);
    if (error || !newLeague) { setCreateError(error?.message ?? 'Failed to create league.'); return; }

    // Auto-add creator as admin member
    await supabase.from('league_members').insert({
      league_id: newLeague.id,
      user_id: user!.id,
      role: 'admin',
    });

    setShowCreate(false);
    setName(''); setDescription(''); setIsOpen(true); setHomeCourt(null); setCreateError('');
    loadLeagues();
  }

  async function joinLeague(leagueId: string) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('league_members').upsert({ league_id: leagueId, user_id: user!.id, role: 'member' });
    loadLeagues();
  }

  async function requestCode(leagueId: string, leagueName: string) {
    status.clear();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('league_join_requests')
      .upsert({ league_id: leagueId, user_id: user!.id, status: 'pending' });
    if (error) status.error(error.message);
    else {
      loadLeagues(); // refreshes hasRequested flag
      status.success(`Request sent. The admins of "${leagueName}" have been notified — they'll share an invite code with you.`);
    }
  }

  async function joinWithCode() {
    setJoinError('');
    const token = inviteCode.replace(/-/g, '').toUpperCase().trim();
    if (token.length < 8) { setJoinError('Enter a valid invite code.'); return; }

    setJoining(true);
    const { data, error } = await supabase.rpc('redeem_invite_code', { p_token: token });
    setJoining(false);
    if (error) { setJoinError(error.message ?? 'Failed to redeem.'); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { setJoinError(row?.message ?? 'Invalid invite code.'); return; }

    setShowJoinCode(false);
    setInviteCode('');
    loadLeagues();
    const heading = row.scope_type === 'tournament' ? 'Joined tournament!' : 'Joined!';
    status.success(`${heading} ${row.message ?? `You've joined "${row.scope_name}".`}`);
  }

  const filtered = useMemo(() => applyFilters(allLeagues, filters), [allLeagues, filters]);
  const numActiveFilters = activeFilterCount(filters);

  function setFilter<K extends keyof Filters>(key: K, val: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: val }));
  }

  // Color the season chip by its status: green for active (running now),
  // amber for upcoming (planned but not yet started), gray for TBD (no
  // season scheduled).
  function seasonChipStyle(status: 'active' | 'upcoming' | null) {
    if (status === 'active')   return { backgroundColor: c.primaryLight, borderColor: c.primary };
    if (status === 'upcoming') return { backgroundColor: '#fff1d6',     borderColor: '#b8860b' };
    return { backgroundColor: c.surfaceAlt, borderColor: c.border };
  }
  function seasonChipLabelStyle(status: 'active' | 'upcoming' | null) {
    if (status === 'active')   return { color: c.primary };
    if (status === 'upcoming') return { color: '#8a5b00' };
    return { color: c.textMuted };
  }
  function seasonChipValueStyle(status: 'active' | 'upcoming' | null) {
    if (status === 'active')   return { color: c.text };
    if (status === 'upcoming') return { color: '#5c3d00' };
    return { color: c.textSub };
  }

  function renderLeagueCard({ item }: { item: LeagueWithStats }) {
    return (
      <TouchableOpacity
        style={S.card}
        onPress={() => navigation.navigate('LeagueDetail', { leagueId: item.id, leagueName: item.name })}
        activeOpacity={0.75}
      >
        {/* Title row */}
        <View style={S.cardTitleRow}>
          <Text style={S.leagueName} numberOfLines={1}>{item.name}</Text>
          <View style={[S.openBadge, !item.is_open && S.privateBadge]}>
            <Text style={[S.openBadgeText, !item.is_open && S.privateBadgeText]}>
              {item.is_open ? 'Open' : 'Private'}
            </Text>
          </View>
        </View>

        {item.description ? (
          <Text style={S.description} numberOfLines={2}>{item.description}</Text>
        ) : null}

        {/* Home court */}
        {item.home_court ? (
          <View style={S.homeCourtRow}>
            <Text style={S.homeCourtPin}>📍</Text>
            <Text style={S.homeCourtText} numberOfLines={1}>{displayCourtName(item.home_court)}</Text>
            {getRegionName(item.home_court_lat ?? null, item.home_court_lng ?? null) && (
              <View style={S.regionChip}>
                <Text style={S.regionChipText}>
                  {getRegionName(item.home_court_lat ?? null, item.home_court_lng ?? null)}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <Text style={S.noCourtText}>📍 No home court set</Text>
        )}

        {/* Stats row */}
        <View style={S.statsRow}>
          <View style={S.statItem}>
            <Text style={S.statValue}>{item.memberCount}</Text>
            <Text style={S.statLabel}>Players</Text>
          </View>
          <View style={S.statDivider} />
          <View style={S.statItem}>
            <Text style={S.statValue}>{item.matchCount}</Text>
            <Text style={S.statLabel}>Matches</Text>
          </View>
          <View style={S.statDivider} />
          <View style={S.statItem}>
            <Text style={S.statValue}>{item.distinctPlayDays}</Text>
            <Text style={S.statLabel}>Play Days</Text>
          </View>
        </View>

        {/* Activity row: baseline PLUPR + featured season window + active tournaments */}
        <View style={S.activityRow}>
          {item.currentBaselinePlupr != null && (
            <View style={S.activityChip}>
              <Text style={S.activityChipLabel}>Baseline PLUPR</Text>
              <Text style={S.activityChipValue}>{item.currentBaselinePlupr.toFixed(2)}</Text>
            </View>
          )}
          <View style={[S.activityChip, seasonChipStyle(item.featuredSeasonStatus)]}>
            <Text style={[S.activityChipLabel, seasonChipLabelStyle(item.featuredSeasonStatus)]}>
              {item.featuredSeasonStatus === 'upcoming' ? 'Upcoming season' : 'Season'}
            </Text>
            <Text style={[S.activityChipValue, seasonChipValueStyle(item.featuredSeasonStatus)]}>
              {formatSeasonRange(item.featuredSeasonStart, item.featuredSeasonEnd)}
            </Text>
          </View>
          {item.activeTournamentCount > 0 && (
            <View style={S.activityChip}>
              <Text style={S.activityChipLabel}>Active tournaments</Text>
              <Text style={S.activityChipValue}>{item.activeTournamentCount}</Text>
            </View>
          )}
        </View>

        {/* Footer: created date + role/join status */}
        <View style={S.cardFooter}>
          <Text style={S.createdText}>Created {fmtDate(item.created_at)}</Text>
        </View>

        {/* Role / membership row */}
        <View style={S.membershipRow}>
          <Text style={[
            S.roleStatusText,
            item.myRole ? S.roleStatusJoined : S.roleStatusNot,
          ]}>
            {item.myRole
              ? `Your Role: ${item.myRole.charAt(0).toUpperCase() + item.myRole.slice(1).replace('-', '-')}`
              : 'Your Role: Not Joined Yet'}
          </Text>

          {/* Open league — show Join if not a member */}
          {!item.myRole && item.is_open && (
            <TouchableOpacity
              style={S.joinBtn}
              onPress={(e) => { e.stopPropagation?.(); joinLeague(item.id); }}
            >
              <Text style={S.joinText}>Join</Text>
            </TouchableOpacity>
          )}

          {/* Private league — show Request Code if not a member */}
          {!item.myRole && !item.is_open && (
            item.hasRequested ? (
              <View style={S.requestedBadge}>
                <Text style={S.requestedText}>Requested</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={S.requestBtn}
                onPress={(e) => { e.stopPropagation?.(); requestCode(item.id, item.name); }}
              >
                <Text style={S.requestText}>Request Code</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={S.container}>
      {/* Filter bar */}
      <View style={S.filterBar}>
        <Text style={S.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'league' : 'leagues'}
        </Text>
        <TouchableOpacity
          style={[S.filterBtn, numActiveFilters > 0 && S.filterBtnActive]}
          onPress={() => setShowFilters((v) => !v)}
        >
          <Text style={[S.filterBtnText, numActiveFilters > 0 && S.filterBtnTextActive]}>
            Filters{numActiveFilters > 0 ? ` (${numActiveFilters})` : ''}
          </Text>
        </TouchableOpacity>
        {numActiveFilters > 0 && (
          <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)} style={S.clearBtn}>
            <Text style={S.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Collapsible filter panel */}
      {showFilters && (
        <View style={S.filterPanel}>
          {/* Open only */}
          <View style={S.filterRow}>
            <Text style={S.filterLabel}>Open leagues only</Text>
            <Switch
              value={filters.openOnly}
              onValueChange={(v) => setFilter('openOnly', v)}
              trackColor={{ true: c.primary }}
              thumbColor={c.surface}
            />
          </View>

          {/* Created within */}
          <Text style={S.filterLabel}>Created within</Text>
          <View style={S.pillRow}>
            {CREATED_WITHIN_OPTIONS.map((o) => (
              <TouchableOpacity
                key={String(o.value)}
                style={[S.pill, filters.createdWithin === o.value && S.pillActive]}
                onPress={() => setFilter('createdWithin', o.value)}
              >
                <Text style={[S.pillText, filters.createdWithin === o.value && S.pillTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Min players */}
          <Text style={S.filterLabel}>Minimum players</Text>
          <View style={S.pillRow}>
            {MIN_PLAYERS_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.value}
                style={[S.pill, filters.minPlayers === o.value && S.pillActive]}
                onPress={() => setFilter('minPlayers', o.value)}
              >
                <Text style={[S.pillText, filters.minPlayers === o.value && S.pillTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Region */}
          <Text style={S.filterLabel}>Region</Text>
          <View style={S.pillRow}>
            <TouchableOpacity
              style={[S.pill, filters.region === null && S.pillActive]}
              onPress={() => setFilter('region', null)}
            >
              <Text style={[S.pillText, filters.region === null && S.pillTextActive]}>All</Text>
            </TouchableOpacity>
            {REGIONS.map((r) => (
              <TouchableOpacity
                key={r.name}
                style={[S.pill, filters.region === r.name && S.pillActive]}
                onPress={() => setFilter('region', r.name)}
              >
                <Text style={[S.pillText, filters.region === r.name && S.pillTextActive]}>
                  {r.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderLeagueCard}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        ListHeaderComponent={
          status.value ? <StatusBanner status={status.value} style={{ marginBottom: 8 }} /> : null
        }
        ListEmptyComponent={
          <Text style={S.empty}>
            {loading ? 'Loading...' : allLeagues.length === 0 ? 'No leagues yet. Create one!' : 'No leagues match your filters.'}
          </Text>
        }
      />

      <View style={S.fabRow}>
        <TouchableOpacity style={S.fabSecondary} onPress={() => setShowJoinCode(true)}>
          <Text style={S.fabSecondaryText}>Enter Code</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.fab, atLeagueLimit && S.fabDisabled]}
          onPress={() => {
            if (atLeagueLimit) {
              setShowLimitModal(true);
              return;
            }
            setShowCreate(true);
          }}
          activeOpacity={0.8}
        >
          <Text style={[S.fabText, atLeagueLimit && S.fabTextDisabled]}>
            {atLeagueLimit ? '+ New League (limit reached)' : '+ New League'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Join with Code modal */}
      <Modal visible={showJoinCode} animationType="slide" presentationStyle="pageSheet">
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={S.modalTitle}>Join with Invite Code</Text>
          <Text style={S.modalHint}>
            Enter the invite code shared with you for a league or tournament. Codes look like{' '}
            <Text style={{ fontWeight: '700' }}>3F7A-B2C9-D1E4</Text>.
          </Text>
          <TextInput
            style={[S.input, S.codeInput]}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={c.textMuted}
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {joinError ? (
            <View style={S.errorBox}>
              <Text style={S.errorText}>{joinError}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={[S.button, joining && { backgroundColor: c.primaryLight }]}
            onPress={joinWithCode}
            disabled={joining}
          >
            <Text style={S.buttonText}>{joining ? 'Joining...' : 'Redeem Code'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowJoinCode(false); setInviteCode(''); setJoinError(''); }}>
            <Text style={S.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* Create modal */}
      <Modal visible={showCreate} animationType="slide" presentationStyle="pageSheet">
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={S.modalTitle}>Create League</Text>

          <Text style={S.modalLabel}>League Name</Text>
          <TextInput
            style={S.input}
            placeholder="e.g. Tuesday Night Rec"
            placeholderTextColor={c.textMuted}
            value={name}
            onChangeText={setName}
          />

          <Text style={S.modalLabel}>Description (optional)</Text>
          <TextInput
            style={[S.input, { height: 72, textAlignVertical: 'top' }]}
            placeholder="Skill level, location, notes..."
            placeholderTextColor={c.textMuted}
            value={description}
            onChangeText={setDescription}
            multiline
          />

          <View style={S.toggleRow}>
            <View>
              <Text style={S.modalLabel}>Open to join</Text>
              <Text style={S.toggleHint}>
                {isOpen ? 'Anyone can join this league.' : 'Players must be invited.'}
              </Text>
            </View>
            <Switch
              value={isOpen}
              onValueChange={setIsOpen}
              trackColor={{ true: c.primary }}
              thumbColor={c.surface}
            />
          </View>

          {/* Home court */}
          <Text style={S.modalLabel}>Home Court</Text>
          <CourtPicker
            value={homeCourt}
            onSelect={setHomeCourt}
            showNoneOption
            active={showCreate}
            placeholder="Search for your home court..."
          />
          {!homeCourt && (
            <View style={S.courtWarning}>
              <Text style={S.courtWarningText}>
                Without a home court, every match entry will require a location to be entered manually.
              </Text>
            </View>
          )}

          {createError ? (
            <View style={S.errorBox}>
              <Text style={S.errorText}>{createError}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[S.button, creating && { backgroundColor: c.primaryLight }]}
            onPress={createLeague}
            disabled={creating}
          >
            <Text style={S.buttonText}>{creating ? 'Creating...' : 'Create League'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => { setShowCreate(false); setCreateError(''); }}>
            <Text style={S.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      <ConfirmModal
        visible={showLimitModal}
        title="Active league limit reached"
        body="You're already running an active league. You can only be admin of one active league at a time. Close it first (or have an admin transfer ownership) before starting another."
        primaryLabel="OK"
        cancelLabel="Close"
        onConfirm={() => setShowLimitModal(false)}
        onClose={() => setShowLimitModal(false)}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },

    // Filter bar
    filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    resultCount: { flex: 1, fontSize: 13, color: c.textMuted },
    filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: c.border },
    filterBtnActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    filterBtnText: { fontSize: 13, fontWeight: '600', color: c.textSub },
    filterBtnTextActive: { color: c.primary },
    clearBtn: { paddingHorizontal: 10, paddingVertical: 7 },
    clearBtnText: { fontSize: 13, color: c.danger, fontWeight: '600' },

    // Filter panel
    filterPanel: { backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border, gap: 10 },
    filterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    filterLabel: { fontSize: 13, fontWeight: '700', color: c.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
    pill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    pillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    pillText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
    pillTextActive: { color: c.primary, fontWeight: '700' },

    // League card
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    leagueName: { fontSize: 17, fontWeight: '800', color: c.text, flex: 1, marginRight: 8 },
    openBadge: { backgroundColor: c.primaryLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    privateBadge: { backgroundColor: c.bg },
    openBadgeText: { fontSize: 11, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
    privateBadgeText: { color: c.textMuted },
    description: { fontSize: 13, color: c.textSub, marginBottom: 12 },

    // Stats
    statsRow: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 10 },
    statItem: { flex: 1, alignItems: 'center' },
    statValue: { fontSize: 20, fontWeight: '800', color: c.text },
    statLabel: { fontSize: 11, color: c.textMuted, marginTop: 1, textTransform: 'uppercase', letterSpacing: 0.4 },
    statDivider: { width: 1, backgroundColor: c.border, marginVertical: 2 },
    activityRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
    activityChip:       { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.primaryLight, borderWidth: 1, borderColor: c.primary, alignItems: 'flex-start' },
    activityChipLabel:  { fontSize: 10, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.4 },
    activityChipValue:  { fontSize: 14, fontWeight: '800', color: c.text, marginTop: 1 },

    // Card footer
    cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    homeCourtRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 10 },
    homeCourtPin: { fontSize: 12 },
    homeCourtText: { fontSize: 12, color: c.textSub, fontWeight: '500', flex: 1 },
    regionChip: { backgroundColor: c.primaryLight, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
    regionChipText: { fontSize: 10, color: c.primary, fontWeight: '700' },
    noCourtText: { fontSize: 12, color: c.textMuted, marginBottom: 10 },
    createdText: { fontSize: 12, color: c.textMuted },
    membershipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border },
    roleStatusText: { fontSize: 13, fontWeight: '600' },
    roleStatusJoined: { color: c.primary },
    roleStatusNot: { color: c.textMuted },
    joinBtn: { backgroundColor: c.primaryLight, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
    joinText: { color: c.primary, fontWeight: '700', fontSize: 13 },
    requestBtn: { backgroundColor: '#fff8e1', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#ffe082' },
    requestText: { color: '#b8860b', fontWeight: '700', fontSize: 13 },
    requestedBadge: { backgroundColor: c.bg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
    requestedText: { color: c.textMuted, fontWeight: '600', fontSize: 13 },

    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15, lineHeight: 22 },
    fabRow: { position: 'absolute', bottom: 24, right: 16, flexDirection: 'row', gap: 10, alignItems: 'center' },
    fab: { backgroundColor: c.primary, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
    fabDisabled: { backgroundColor: c.border, elevation: 0 },
    fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    fabTextDisabled: { color: c.textMuted },
    fabSecondary: { backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 30, elevation: 3, borderWidth: 1.5, borderColor: c.primary },
    fabSecondaryText: { color: c.primary, fontWeight: '700', fontSize: 14 },

    // Create modal
    modal: { padding: 24, paddingTop: 48, flexGrow: 1, backgroundColor: c.surface },
    modalTitle: { fontSize: 26, fontWeight: '800', color: c.text, marginBottom: 24 },
    modalLabel: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 6, marginTop: 16 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 14, fontSize: 16, color: c.text, backgroundColor: c.surface },
    toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, backgroundColor: c.surfaceAlt, padding: 14, borderRadius: 10 },
    toggleHint: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    errorBox: { backgroundColor: '#ffebee', borderRadius: 8, padding: 12, marginTop: 12 },
    errorText: { color: c.danger, fontSize: 14, fontWeight: '600' },
    button: { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 20 },
    buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
    cancelText: { textAlign: 'center', color: c.textMuted, marginTop: 16, fontSize: 15 },
    modalHint: { fontSize: 14, color: c.textSub, marginBottom: 16, lineHeight: 20 },
    codeInput: { fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: 4, textTransform: 'uppercase' },
    courtWarning: { backgroundColor: '#fff8e1', borderRadius: 8, padding: 10, marginTop: 8, borderWidth: 1, borderColor: '#ffe082' },
    courtWarningText: { fontSize: 13, color: '#b8860b', lineHeight: 18 },
  });
}
