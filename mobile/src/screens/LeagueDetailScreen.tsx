import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet, View, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole, roleLabel, roleBadgeColor } from '../lib/leagueRole';
import { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueDetail'>;
  route: RouteProp<RootStackParamList, 'LeagueDetail'>;
};

type Option = { icon: string; label: string; sub: string; onPress: () => void; adminOnly?: boolean };

export default function LeagueDetailScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const [myRole, setMyRole] = useState<LeagueRole>(null);
  const [league, setLeague] = useState<{ is_open: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    React.useCallback(() => {
      Promise.all([
        getLeagueRole(leagueId),
        supabase.from('leagues').select('is_open').eq('id', leagueId).single(),
      ]).then(([role, { data }]) => {
        setMyRole(role);
        setLeague(data);
        setLoading(false);
      });
    }, [leagueId])
  );

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  const privileged = isPrivileged(myRole);

  const options: Option[] = [
    {
      icon: '🗳️',
      label: 'Schedule & Events',
      sub: privileged ? 'Propose play sessions, vote on availability' : 'View upcoming events and vote',
      onPress: () => navigation.navigate('Events', { leagueId, leagueName }),
    },
    {
      icon: '📊',
      label: 'Standings',
      sub: 'Player rankings and ELO ratings',
      onPress: () => navigation.navigate('Standings', { leagueId }),
    },
    {
      icon: '🏓',
      label: 'Record Match',
      sub: 'Enter a singles or doubles result',
      onPress: () => navigation.navigate('MatchEntry', { leagueId }),
    },
    {
      icon: '📜',
      label: 'Match History',
      sub: 'All completed matches with dates & scores',
      onPress: () => navigation.navigate('MatchHistory', { leagueId, title: `${leagueName} History` }),
    },
    {
      icon: '🗓️',
      label: 'Calendar Analytics',
      sub: 'W-L records and ELO changes by day',
      onPress: () => navigation.navigate('CalendarAnalytics', { leagueId, title: `${leagueName} Calendar` }),
    },
    {
      icon: '👥',
      label: 'Members',
      sub: privileged ? 'View members and manage roles' : 'View league members',
      onPress: () => navigation.navigate('LeagueMembers', { leagueId, leagueName }),
    },
    // Admin/co-admin only: invite players to private leagues (or any league)
    ...(privileged ? [{
      icon: '✉️',
      label: 'Invite Players',
      sub: !league?.is_open ? 'League is private — share invite codes' : 'Share invite codes with players',
      onPress: () => navigation.navigate('Invite', { leagueId, leagueName }),
      adminOnly: true,
    }] : []),
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
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
          <Text style={styles.icon}>{opt.icon}</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 10 },
  roleBanner: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 4 },
  roleText: { fontSize: 13, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, flexDirection: 'row', alignItems: 'center' },
  icon: { fontSize: 26, marginRight: 14 },
  cardText: { flex: 1 },
  label: { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#666', marginTop: 2 },
  adminTag: { backgroundColor: '#fff8e1', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: '#ffe082' },
  adminTagText: { fontSize: 11, fontWeight: '700', color: '#b8860b' },
});
