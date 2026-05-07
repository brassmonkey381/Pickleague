import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Profile, PlayerLocationRating, RootStackParamList } from '../types';
import BadgeDisplay, { BadgeItem } from '../components/BadgeDisplay';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PlayerProfile'>;
  route: RouteProp<RootStackParamList, 'PlayerProfile'>;
};

export default function PlayerProfileScreen({ navigation, route }: Props) {
  const { userId } = route.params;
  const [profile, setProfile]             = useState<Profile | null>(null);
  const [badges, setBadges]               = useState<BadgeItem[]>([]);
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [matchCount, setMatchCount]       = useState(0);
  const [loading, setLoading]             = useState(true);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const [profileRes, badgesRes, locRes, matchRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('player_badges')
        .select('*, badge:badges(*), league:leagues(name)')
        .eq('user_id', userId)
        .eq('is_hidden', false)   // only show public badges
        .order('earned_at'),
      supabase.from('player_location_ratings')
        .select('*').eq('user_id', userId)
        .order('rating', { ascending: false })
        .limit(6),
      supabase.from('matches')
        .select('id', { count: 'exact', head: true })
        .or(`player1_id.eq.${userId},player2_id.eq.${userId},partner1_id.eq.${userId},partner2_id.eq.${userId}`),
    ]);

    setProfile(profileRes.data as Profile);
    setBadges((badgesRes.data ?? []) as BadgeItem[]);
    setLocationRatings((locRes.data ?? []) as PlayerLocationRating[]);
    setMatchCount(matchRes.count ?? 0);
    setLoading(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;
  if (!profile) return <Text style={styles.error}>Player not found.</Text>;

  const initials = profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
  const profileBadges = badges.filter(b => b.badge.category === 'profile');
  const leagueBadges  = badges.filter(b => b.badge.category === 'league');

  const locationGroups: Record<string, { singles?: PlayerLocationRating; doubles?: PlayerLocationRating }> = {};
  for (const r of locationRatings) {
    if (!locationGroups[r.location_name]) locationGroups[r.location_name] = {};
    locationGroups[r.location_name][r.match_type] = r;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </View>
        <Text style={styles.fullName}>{profile.full_name}</Text>
        <Text style={styles.username}>@{profile.username}</Text>
        <Text style={styles.matchCount}>{matchCount} matches played</Text>
      </View>

      {/* ELO strip */}
      <View style={styles.eloCard}>
        <View style={styles.eloItem}>
          <Text style={styles.eloValue}>{profile.rating}</Text>
          <Text style={styles.eloLabel}>Overall</Text>
        </View>
        <View style={styles.eloDivider} />
        <View style={styles.eloItem}>
          <Text style={styles.eloValue}>{profile.singles_rating ?? profile.rating}</Text>
          <Text style={styles.eloLabel}>Singles</Text>
        </View>
        <View style={styles.eloDivider} />
        <View style={styles.eloItem}>
          <Text style={styles.eloValue}>{profile.doubles_rating ?? profile.rating}</Text>
          <Text style={styles.eloLabel}>Doubles</Text>
        </View>
      </View>

      {/* Badges */}
      {profile.badges_public !== false && badges.length > 0 && (
        <>
          {profileBadges.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Profile Badges</Text>
              <View style={styles.badgeGrid}>
                {profileBadges.map(b => <BadgeDisplay key={b.id} badge={b} />)}
              </View>
            </View>
          )}
          {leagueBadges.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>League Badges</Text>
              <View style={styles.badgeGrid}>
                {leagueBadges.map(b => <BadgeDisplay key={b.id} badge={b} />)}
              </View>
            </View>
          )}
        </>
      )}
      {profile.badges_public === false && (
        <View style={styles.privateBox}>
          <Text style={styles.privateText}>🔒  This player's badges are private.</Text>
        </View>
      )}

      {/* Court ratings */}
      {Object.keys(locationGroups).length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Court Ratings</Text>
          {Object.entries(locationGroups).map(([loc, r]) => (
            <View key={loc} style={styles.locRow}>
              <Text style={styles.locName} numberOfLines={1}>📍 {loc}</Text>
              <View style={styles.locRatings}>
                {r.singles && (
                  <View style={styles.locPill}>
                    <Text style={styles.locVal}>{r.singles.rating}</Text>
                    <Text style={styles.locType}>1v1 · {r.singles.wins}W-{r.singles.losses}L</Text>
                  </View>
                )}
                {r.doubles && (
                  <View style={[styles.locPill, styles.locPillD]}>
                    <Text style={styles.locVal}>{r.doubles.rating}</Text>
                    <Text style={styles.locType}>2v2 · {r.doubles.wins}W-{r.doubles.losses}L</Text>
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Actions */}
      <TouchableOpacity
        style={styles.actionBtn}
        onPress={() => navigation.navigate('MatchHistory', { userId, title: `${profile.full_name}'s History` })}
      >
        <Text style={styles.actionBtnText}>📜  View Match History</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#f5f5f5', flexGrow: 1 },
  error: { textAlign: 'center', marginTop: 60, color: '#999' },
  header: { alignItems: 'center', marginBottom: 16 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  avatarInitials: { fontSize: 30, fontWeight: '800', color: GREEN },
  fullName: { fontSize: 22, fontWeight: '800', color: '#1a1a1a' },
  username: { fontSize: 14, color: '#888', marginTop: 2 },
  matchCount: { fontSize: 13, color: '#aaa', marginTop: 4 },
  eloCard: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 14, elevation: 1 },
  eloItem: { flex: 1, alignItems: 'center' },
  eloValue: { fontSize: 24, fontWeight: '800', color: GREEN },
  eloLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  eloDivider: { width: 1, height: 32, backgroundColor: '#eee' },
  section: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', margin: -4 },
  privateBox: { backgroundColor: '#f9f9f9', borderRadius: 10, padding: 16, alignItems: 'center', marginBottom: 12 },
  privateText: { color: '#aaa', fontSize: 14 },
  locRow: { marginBottom: 10 },
  locName: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 4 },
  locRatings: { flexDirection: 'row', gap: 8 },
  locPill: { backgroundColor: '#e8f5e9', borderRadius: 8, padding: 8, alignItems: 'center', minWidth: 80 },
  locPillD: { backgroundColor: '#e3f2fd' },
  locVal: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  locType: { fontSize: 10, color: '#666', marginTop: 2 },
  actionBtn: { backgroundColor: '#fff', borderRadius: 10, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#ddd', marginTop: 4 },
  actionBtnText: { fontSize: 15, fontWeight: '600', color: '#555' },
});
