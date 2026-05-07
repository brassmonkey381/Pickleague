import React, { useState } from 'react';
import {
  ScrollView, Text, TouchableOpacity, StyleSheet,
  View, ActivityIndicator, Modal, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole, roleLabel, roleBadgeColor } from '../lib/leagueRole';
import { getRegionName } from '../lib/regions';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { League, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueDetail'>;
  route: RouteProp<RootStackParamList, 'LeagueDetail'>;
};

type Option = { icon: string; label: string; sub: string; onPress: () => void; adminOnly?: boolean };

export default function LeagueDetailScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const [myRole, setMyRole]       = useState<LeagueRole>(null);
  const [league, setLeague]       = useState<League | null>(null);
  const [loading, setLoading]     = useState(true);

  // Home court edit modal (admin only)
  const [editVisible, setEditVisible]   = useState(false);
  const [pendingCourt, setPendingCourt] = useState<CourtResult | null>(null);
  const [saving, setSaving]             = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      Promise.all([
        getLeagueRole(leagueId),
        supabase.from('leagues').select('*').eq('id', leagueId).single(),
      ]).then(([role, { data }]) => {
        setMyRole(role);
        setLeague(data as League);
        setLoading(false);
      });
    }, [leagueId])
  );

  async function saveHomeCourt() {
    setSaving(true);
    const newCourtName = pendingCourt?.name ?? null;

    const { error } = await supabase.from('leagues').update({
      home_court:     newCourtName,
      home_court_lat: pendingCourt?.lat ?? null,
      home_court_lng: pendingCourt?.lng ?? null,
    }).eq('id', leagueId);

    if (error) { Alert.alert('Error', error.message); setSaving(false); return; }

    // Cascade: update is_home_court on all matches in this league
    // (DB trigger handles this, but we also do it in-app as a reliable fallback)
    const { data: allMatches } = await supabase
      .from('matches').select('id, location_name').eq('league_id', leagueId);
    if (allMatches && allMatches.length > 0) {
      for (const m of allMatches) {
        const isHome = !!(m.location_name && newCourtName && m.location_name === newCourtName);
        await supabase.from('matches').update({ is_home_court: isHome }).eq('id', m.id);
      }
    }

    setSaving(false);
    setEditVisible(false);
    const { data } = await supabase.from('leagues').select('*').eq('id', leagueId).single();
    setLeague(data as League);
  }

  function openEdit() {
    setPendingCourt(
      league?.home_court
        ? { name: league.home_court, address: '', lat: league.home_court_lat ?? 0, lng: league.home_court_lng ?? 0, placeId: '' }
        : null
    );
    setEditVisible(true);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  const privileged = isPrivileged(myRole);
  const isAdmin    = myRole === 'admin';
  const region     = getRegionName(league?.home_court_lat ?? null, league?.home_court_lng ?? null);

  const options: Option[] = [
    {
      icon: '🗳️', label: 'Schedule & Events',
      sub: privileged ? 'Propose play sessions, vote on availability' : 'View upcoming events and vote',
      onPress: () => navigation.navigate('Events', { leagueId, leagueName }),
    },
    {
      icon: '📊', label: 'Standings',
      sub: 'Player rankings and ELO ratings',
      onPress: () => navigation.navigate('Standings', { leagueId }),
    },
    {
      icon: '🏓', label: 'Record Match',
      sub: 'Enter a singles or doubles result',
      onPress: () => navigation.navigate('MatchEntry', { leagueId }),
    },
    {
      icon: '📜', label: 'Match History',
      sub: 'All completed matches with dates & scores',
      onPress: () => navigation.navigate('MatchHistory', { leagueId, title: `${leagueName} History` }),
    },
    {
      icon: '🗓️', label: 'Calendar Analytics',
      sub: 'W-L records and ELO changes by day',
      onPress: () => navigation.navigate('CalendarAnalytics', { leagueId, title: `${leagueName} Calendar` }),
    },
    {
      icon: '👥', label: 'Members',
      sub: privileged ? 'View members and manage roles' : 'View league members',
      onPress: () => navigation.navigate('LeagueMembers', { leagueId, leagueName }),
    },
    {
      icon: '🎾', label: 'Tournaments',
      sub: 'Create and manage rec tournaments for this league',
      onPress: () => navigation.navigate('Tournaments', { leagueId, leagueName }),
    },
    ...(privileged ? [{
      icon: '✉️', label: 'Invite Players',
      sub: !league?.is_open ? 'League is private — share invite codes' : 'Share invite codes with players',
      onPress: () => navigation.navigate('Invite', { leagueId, leagueName }),
      adminOnly: true,
    }] : []),
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Home court banner */}
      <View style={styles.courtBanner}>
        <Text style={styles.courtIcon}>📍</Text>
        <View style={styles.courtInfo}>
          <Text style={styles.courtLabel}>Home Court</Text>
          <Text style={styles.courtName} numberOfLines={1}>
            {league?.home_court ?? 'Not set'}
          </Text>
          {region && <Text style={styles.courtRegion}>{region}</Text>}
        </View>
        {isAdmin && (
          <TouchableOpacity style={styles.editCourtBtn} onPress={openEdit}>
            <Text style={styles.editCourtText}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Role badge */}
      {myRole && (
        <View style={[styles.roleBanner, { backgroundColor: roleBadgeColor(myRole) + '18', borderColor: roleBadgeColor(myRole) + '44' }]}>
          <Text style={[styles.roleText, { color: roleBadgeColor(myRole) }]}>
            Your role: {roleLabel(myRole)}
          </Text>
        </View>
      )}

      {options.map((opt) => (
        <TouchableOpacity key={opt.label} style={styles.card} onPress={opt.onPress}>
          <Text style={styles.cardIcon}>{opt.icon}</Text>
          <View style={styles.cardText}>
            <Text style={styles.label}>{opt.label}</Text>
            <Text style={styles.sub}>{opt.sub}</Text>
          </View>
          {opt.adminOnly && (
            <View style={styles.adminTag}>
              <Text style={styles.adminTagText}>Admin</Text>
            </View>
          )}
        </TouchableOpacity>
      ))}

      {/* Admin — edit home court modal */}
      <Modal visible={editVisible} animationType="slide" presentationStyle="pageSheet">
        <ScrollView contentContainerStyle={styles.editModal} keyboardShouldPersistTaps="handled">
          <Text style={styles.editTitle}>Edit Home Court</Text>
          <Text style={styles.editHint}>
            The home court is pre-filled when recording matches. Changing it will update the
            Home/Away status of all past matches in this league.
          </Text>
          <CourtPicker
            value={pendingCourt}
            onSelect={setPendingCourt}
            active={editVisible}
            showNoneOption
            placeholder="Search for the new home court..."
          />
          {!pendingCourt && (
            <View style={styles.noneWarning}>
              <Text style={styles.noneWarningText}>
                ⚠️  Without a home court, every match entry will require a location.
              </Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={saveHomeCourt}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save Home Court'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditVisible(false)}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 16, gap: 10 },

  courtBanner: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: '#e8f5e9',
    elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4,
  },
  courtIcon: { fontSize: 24 },
  courtInfo: { flex: 1 },
  courtLabel: { fontSize: 11, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5 },
  courtName: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginTop: 1 },
  courtRegion: { fontSize: 12, color: '#888', marginTop: 1 },
  editCourtBtn: { borderWidth: 1, borderColor: GREEN, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
  editCourtText: { fontSize: 13, color: GREEN, fontWeight: '600' },

  roleBanner: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  roleText: { fontSize: 13, fontWeight: '700' },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6,
    flexDirection: 'row', alignItems: 'center',
  },
  cardIcon: { fontSize: 26, marginRight: 14 },
  cardText: { flex: 1 },
  label: { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#666', marginTop: 2 },
  adminTag: { backgroundColor: '#fff8e1', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: '#ffe082' },
  adminTagText: { fontSize: 11, fontWeight: '700', color: '#b8860b' },

  // Edit modal
  editModal: { padding: 24, paddingTop: 48, flexGrow: 1, backgroundColor: '#fff' },
  editTitle: { fontSize: 22, fontWeight: '800', color: '#1a1a1a', marginBottom: 8 },
  editHint: { fontSize: 14, color: '#666', lineHeight: 20, marginBottom: 20 },
  noneWarning: { backgroundColor: '#fff8e1', borderRadius: 8, padding: 10, marginTop: 10, borderWidth: 1, borderColor: '#ffe082' },
  noneWarningText: { fontSize: 13, color: '#b8860b' },
  saveBtn: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 24 },
  saveBtnDisabled: { backgroundColor: '#a5d6a7' },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cancelBtn: { padding: 14, alignItems: 'center' },
  cancelBtnText: { color: '#aaa', fontSize: 15 },
});
