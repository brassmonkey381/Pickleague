import React, { useEffect, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Switch, ScrollView, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { LeagueWithStats, RootStackParamList } from '../types';
import { REGIONS, getRegionName, inRegion } from '../lib/regions';
import CourtPicker, { CourtResult } from '../components/CourtPicker';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Leagues'> };

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

export default function LeaguesScreen({ navigation }: Props) {
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

  useEffect(() => { loadLeagues(); }, []);

  async function loadLeagues() {
    setLoading(true);

    const [{ data: leagueRows }, { data: { user } }] = await Promise.all([
      supabase.from('leagues').select('*').eq('is_active', true).order('created_at', { ascending: false }),
      supabase.auth.getUser(),
    ]);

    if (!leagueRows) { setLoading(false); return; }

    const ids = leagueRows.map((l) => l.id);
    const uid = user?.id ?? null;

    // All parallel fetches
    const [memberRes, matchRes, myMemberRes, myRequestRes] = await Promise.all([
      supabase.from('league_members').select('league_id').in('league_id', ids),
      supabase.from('matches').select('league_id, played_at').in('league_id', ids),
      uid
        ? supabase.from('league_members').select('league_id, role').eq('user_id', uid).in('league_id', ids)
        : Promise.resolve({ data: [] }),
      uid
        ? supabase.from('league_join_requests').select('league_id').eq('user_id', uid).eq('status', 'pending').in('league_id', ids)
        : Promise.resolve({ data: [] }),
    ]);

    const memberRows   = memberRes.data ?? [];
    const matchRows    = matchRes.data ?? [];
    const myMembers    = (myMemberRes as any).data ?? [];
    const myRequests   = (myRequestRes as any).data ?? [];

    const leagues: LeagueWithStats[] = leagueRows.map((l) => {
      const members    = memberRows.filter((m) => m.league_id === l.id);
      const lMatches   = matchRows.filter((m) => m.league_id === l.id);
      const myMembership = myMembers.find((m: any) => m.league_id === l.id);
      const hasRequested = myRequests.some((r: any) => r.league_id === l.id);
      const distinctDays = new Set(lMatches.map((m) => (m.played_at as string).slice(0, 10))).size;
      return {
        ...l,
        is_open: l.is_open ?? true,
        memberCount: members.length,
        matchCount: lMatches.length,
        distinctPlayDays: distinctDays,
        myRole: myMembership?.role ?? null,
        hasRequested,
      };
    });

    setAllLeagues(leagues);
    setLoading(false);
  }

  async function createLeague() {
    setCreateError('');
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
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('league_join_requests')
      .upsert({ league_id: leagueId, user_id: user!.id, status: 'pending' });
    if (error) Alert.alert('Error', error.message);
    else {
      loadLeagues(); // refreshes hasRequested flag
      Alert.alert('Request Sent', `The admins of "${leagueName}" have been notified. They'll share an invite code with you.`);
    }
  }

  async function joinWithCode() {
    setJoinError('');
    const token = inviteCode.replace(/-/g, '').toUpperCase().trim();
    if (token.length < 8) { setJoinError('Enter a valid invite code.'); return; }

    setJoining(true);
    const { data: invite, error } = await supabase
      .from('league_invites')
      .select('*, league:leagues(id, name)')
      .eq('token', token)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !invite) {
      setJoinError('Invalid or expired invite code. Please check and try again.');
      setJoining(false);
      return;
    }
    if (invite.max_uses != null && invite.used_count >= invite.max_uses) {
      setJoinError('This invite code has reached its maximum uses.');
      setJoining(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    const { error: joinErr } = await supabase
      .from('league_members')
      .upsert({ league_id: invite.league_id, user_id: user!.id, role: 'member' });

    if (joinErr) { setJoinError(joinErr.message); setJoining(false); return; }

    // Increment usage count
    await supabase.from('league_invites').update({ used_count: invite.used_count + 1 }).eq('id', invite.id);

    setJoining(false);
    setShowJoinCode(false);
    setInviteCode('');
    loadLeagues();
    Alert.alert('Joined!', `You've joined "${invite.league?.name}".`);
  }

  const filtered = useMemo(() => applyFilters(allLeagues, filters), [allLeagues, filters]);
  const numActiveFilters = activeFilterCount(filters);

  function setFilter<K extends keyof Filters>(key: K, val: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: val }));
  }

  function renderLeagueCard({ item }: { item: LeagueWithStats }) {
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('LeagueDetail', { leagueId: item.id, leagueName: item.name })}
        activeOpacity={0.75}
      >
        {/* Title row */}
        <View style={styles.cardTitleRow}>
          <Text style={styles.leagueName} numberOfLines={1}>{item.name}</Text>
          <View style={[styles.openBadge, !item.is_open && styles.privateBadge]}>
            <Text style={[styles.openBadgeText, !item.is_open && styles.privateBadgeText]}>
              {item.is_open ? 'Open' : 'Private'}
            </Text>
          </View>
        </View>

        {item.description ? (
          <Text style={styles.description} numberOfLines={2}>{item.description}</Text>
        ) : null}

        {/* Home court */}
        {item.home_court ? (
          <View style={styles.homeCourtRow}>
            <Text style={styles.homeCourtPin}>📍</Text>
            <Text style={styles.homeCourtText} numberOfLines={1}>{item.home_court}</Text>
            {getRegionName(item.home_court_lat ?? null, item.home_court_lng ?? null) && (
              <View style={styles.regionChip}>
                <Text style={styles.regionChipText}>
                  {getRegionName(item.home_court_lat ?? null, item.home_court_lng ?? null)}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <Text style={styles.noCourtText}>📍 No home court set</Text>
        )}

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{item.memberCount}</Text>
            <Text style={styles.statLabel}>Players</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{item.matchCount}</Text>
            <Text style={styles.statLabel}>Matches</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{item.distinctPlayDays}</Text>
            <Text style={styles.statLabel}>Play Days</Text>
          </View>
        </View>

        {/* Footer: created date + role/join status */}
        <View style={styles.cardFooter}>
          <Text style={styles.createdText}>Created {fmtDate(item.created_at)}</Text>
        </View>

        {/* Role / membership row */}
        <View style={styles.membershipRow}>
          <Text style={[
            styles.roleStatusText,
            item.myRole ? styles.roleStatusJoined : styles.roleStatusNot,
          ]}>
            {item.myRole
              ? `Your Role: ${item.myRole.charAt(0).toUpperCase() + item.myRole.slice(1).replace('-', '-')}`
              : 'Your Role: Not Joined Yet'}
          </Text>

          {/* Open league — show Join if not a member */}
          {!item.myRole && item.is_open && (
            <TouchableOpacity
              style={styles.joinBtn}
              onPress={(e) => { e.stopPropagation?.(); joinLeague(item.id); }}
            >
              <Text style={styles.joinText}>Join</Text>
            </TouchableOpacity>
          )}

          {/* Private league — show Request Code if not a member */}
          {!item.myRole && !item.is_open && (
            item.hasRequested ? (
              <View style={styles.requestedBadge}>
                <Text style={styles.requestedText}>Requested</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.requestBtn}
                onPress={(e) => { e.stopPropagation?.(); requestCode(item.id, item.name); }}
              >
                <Text style={styles.requestText}>Request Code</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        <Text style={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'league' : 'leagues'}
        </Text>
        <TouchableOpacity
          style={[styles.filterBtn, numActiveFilters > 0 && styles.filterBtnActive]}
          onPress={() => setShowFilters((v) => !v)}
        >
          <Text style={[styles.filterBtnText, numActiveFilters > 0 && styles.filterBtnTextActive]}>
            Filters{numActiveFilters > 0 ? ` (${numActiveFilters})` : ''}
          </Text>
        </TouchableOpacity>
        {numActiveFilters > 0 && (
          <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Collapsible filter panel */}
      {showFilters && (
        <View style={styles.filterPanel}>
          {/* Open only */}
          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Open leagues only</Text>
            <Switch
              value={filters.openOnly}
              onValueChange={(v) => setFilter('openOnly', v)}
              trackColor={{ true: GREEN }}
              thumbColor="#fff"
            />
          </View>

          {/* Created within */}
          <Text style={styles.filterLabel}>Created within</Text>
          <View style={styles.pillRow}>
            {CREATED_WITHIN_OPTIONS.map((o) => (
              <TouchableOpacity
                key={String(o.value)}
                style={[styles.pill, filters.createdWithin === o.value && styles.pillActive]}
                onPress={() => setFilter('createdWithin', o.value)}
              >
                <Text style={[styles.pillText, filters.createdWithin === o.value && styles.pillTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Min players */}
          <Text style={styles.filterLabel}>Minimum players</Text>
          <View style={styles.pillRow}>
            {MIN_PLAYERS_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.value}
                style={[styles.pill, filters.minPlayers === o.value && styles.pillActive]}
                onPress={() => setFilter('minPlayers', o.value)}
              >
                <Text style={[styles.pillText, filters.minPlayers === o.value && styles.pillTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Region */}
          <Text style={styles.filterLabel}>Region</Text>
          <View style={styles.pillRow}>
            <TouchableOpacity
              style={[styles.pill, filters.region === null && styles.pillActive]}
              onPress={() => setFilter('region', null)}
            >
              <Text style={[styles.pillText, filters.region === null && styles.pillTextActive]}>All</Text>
            </TouchableOpacity>
            {REGIONS.map((r) => (
              <TouchableOpacity
                key={r.name}
                style={[styles.pill, filters.region === r.name && styles.pillActive]}
                onPress={() => setFilter('region', r.name)}
              >
                <Text style={[styles.pillText, filters.region === r.name && styles.pillTextActive]}>
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
        ListEmptyComponent={
          <Text style={styles.empty}>
            {loading ? 'Loading...' : allLeagues.length === 0 ? 'No leagues yet. Create one!' : 'No leagues match your filters.'}
          </Text>
        }
      />

      <View style={styles.fabRow}>
        <TouchableOpacity style={styles.fabSecondary} onPress={() => setShowJoinCode(true)}>
          <Text style={styles.fabSecondaryText}>Enter Code</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.fab} onPress={() => setShowCreate(true)}>
          <Text style={styles.fabText}>+ New League</Text>
        </TouchableOpacity>
      </View>

      {/* Join with Code modal */}
      <Modal visible={showJoinCode} animationType="slide" presentationStyle="pageSheet">
        <ScrollView contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled">
          <Text style={styles.modalTitle}>Join with Invite Code</Text>
          <Text style={styles.modalHint}>
            Enter the invite code shared with you. Codes look like{' '}
            <Text style={{ fontWeight: '700' }}>3F7A-B2C9-D1E4</Text>.
          </Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            placeholder="XXXX-XXXX-XXXX"
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {joinError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{joinError}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.button, joining && { backgroundColor: '#a5d6a7' }]}
            onPress={joinWithCode}
            disabled={joining}
          >
            <Text style={styles.buttonText}>{joining ? 'Joining...' : 'Join League'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowJoinCode(false); setInviteCode(''); setJoinError(''); }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* Create modal */}
      <Modal visible={showCreate} animationType="slide" presentationStyle="pageSheet">
        <ScrollView contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled">
          <Text style={styles.modalTitle}>Create League</Text>

          <Text style={styles.modalLabel}>League Name</Text>
          <TextInput style={styles.input} placeholder="e.g. Tuesday Night Rec" value={name} onChangeText={setName} />

          <Text style={styles.modalLabel}>Description (optional)</Text>
          <TextInput
            style={[styles.input, { height: 72, textAlignVertical: 'top' }]}
            placeholder="Skill level, location, notes..."
            value={description}
            onChangeText={setDescription}
            multiline
          />

          <View style={styles.toggleRow}>
            <View>
              <Text style={styles.modalLabel}>Open to join</Text>
              <Text style={styles.toggleHint}>
                {isOpen ? 'Anyone can join this league.' : 'Players must be invited.'}
              </Text>
            </View>
            <Switch
              value={isOpen}
              onValueChange={setIsOpen}
              trackColor={{ true: GREEN }}
              thumbColor="#fff"
            />
          </View>

          {/* Home court */}
          <Text style={styles.modalLabel}>Home Court</Text>
          <CourtPicker
            value={homeCourt}
            onSelect={setHomeCourt}
            showNoneOption
            active={showCreate}
            placeholder="Search for your home court..."
          />
          {!homeCourt && (
            <View style={styles.courtWarning}>
              <Text style={styles.courtWarningText}>
                ⚠️  Without a home court, every match entry will require a location to be entered manually.
              </Text>
            </View>
          )}

          {createError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{createError}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.button, creating && { backgroundColor: '#a5d6a7' }]}
            onPress={createLeague}
            disabled={creating}
          >
            <Text style={styles.buttonText}>{creating ? 'Creating...' : 'Create League'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => { setShowCreate(false); setCreateError(''); }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>
    </View>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0' },

  // Filter bar
  filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee', gap: 8 },
  resultCount: { flex: 1, fontSize: 13, color: '#888' },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd' },
  filterBtnActive: { borderColor: GREEN, backgroundColor: '#e8f5e9' },
  filterBtnText: { fontSize: 13, fontWeight: '600', color: '#666' },
  filterBtnTextActive: { color: GREEN },
  clearBtn: { paddingHorizontal: 10, paddingVertical: 7 },
  clearBtnText: { fontSize: 13, color: '#c62828', fontWeight: '600' },

  // Filter panel
  filterPanel: { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#eee', gap: 10 },
  filterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filterLabel: { fontSize: 13, fontWeight: '700', color: '#444', marginBottom: 6 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd', backgroundColor: '#fafafa' },
  pillActive: { borderColor: GREEN, backgroundColor: '#e8f5e9' },
  pillText: { fontSize: 13, color: '#666', fontWeight: '500' },
  pillTextActive: { color: GREEN, fontWeight: '700' },

  // League card
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  leagueName: { fontSize: 17, fontWeight: '800', color: '#1a1a1a', flex: 1, marginRight: 8 },
  openBadge: { backgroundColor: '#e8f5e9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  privateBadge: { backgroundColor: '#f5f5f5' },
  openBadgeText: { fontSize: 11, fontWeight: '700', color: GREEN, textTransform: 'uppercase', letterSpacing: 0.5 },
  privateBadgeText: { color: '#999' },
  description: { fontSize: 13, color: '#777', marginBottom: 12 },

  // Stats
  statsRow: { flexDirection: 'row', backgroundColor: '#f8f8f8', borderRadius: 10, padding: 12, marginBottom: 10 },
  statItem: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', color: '#1a1a1a' },
  statLabel: { fontSize: 11, color: '#999', marginTop: 1, textTransform: 'uppercase', letterSpacing: 0.4 },
  statDivider: { width: 1, backgroundColor: '#e5e5e5', marginVertical: 2 },

  // Card footer
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  homeCourtRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 10 },
  homeCourtPin: { fontSize: 12 },
  homeCourtText: { fontSize: 12, color: '#555', fontWeight: '500', flex: 1 },
  regionChip: { backgroundColor: '#e8f5e9', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  regionChipText: { fontSize: 10, color: '#2e7d32', fontWeight: '700' },
  noCourtText: { fontSize: 12, color: '#ccc', marginBottom: 10 },
  createdText: { fontSize: 12, color: '#aaa' },
  membershipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  roleStatusText: { fontSize: 13, fontWeight: '600' },
  roleStatusJoined: { color: GREEN },
  roleStatusNot: { color: '#aaa' },
  joinBtn: { backgroundColor: '#e8f5e9', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  joinText: { color: GREEN, fontWeight: '700', fontSize: 13 },
  requestBtn: { backgroundColor: '#fff8e1', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#ffe082' },
  requestText: { color: '#b8860b', fontWeight: '700', fontSize: 13 },
  requestedBadge: { backgroundColor: '#f5f5f5', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  requestedText: { color: '#aaa', fontWeight: '600', fontSize: 13 },

  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 15, lineHeight: 22 },
  fabRow: { position: 'absolute', bottom: 24, right: 16, flexDirection: 'row', gap: 10, alignItems: 'center' },
  fab: { backgroundColor: GREEN, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  fabSecondary: { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 13, borderRadius: 30, elevation: 3, borderWidth: 1.5, borderColor: GREEN },
  fabSecondaryText: { color: GREEN, fontWeight: '700', fontSize: 14 },

  // Create modal
  modal: { padding: 24, paddingTop: 48, flexGrow: 1, backgroundColor: '#fff' },
  modalTitle: { fontSize: 26, fontWeight: '800', color: '#1a1a1a', marginBottom: 24 },
  modalLabel: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 16 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 14, fontSize: 16 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, backgroundColor: '#f9f9f9', padding: 14, borderRadius: 10 },
  toggleHint: { fontSize: 12, color: '#aaa', marginTop: 2 },
  errorBox: { backgroundColor: '#ffebee', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#c62828', fontSize: 14, fontWeight: '600' },
  button: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancelText: { textAlign: 'center', color: '#999', marginTop: 16, fontSize: 15 },
  modalHint: { fontSize: 14, color: '#666', marginBottom: 16, lineHeight: 20 },
  codeInput: { fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: 4, textTransform: 'uppercase' },
  courtWarning: { backgroundColor: '#fff8e1', borderRadius: 8, padding: 10, marginTop: 8, borderWidth: 1, borderColor: '#ffe082' },
  courtWarningText: { fontSize: 13, color: '#b8860b', lineHeight: 18 },
  errorBox: { backgroundColor: '#ffebee', borderRadius: 8, padding: 12, marginBottom: 8 },
  errorText: { color: '#c62828', fontSize: 14, fontWeight: '600' },
});
