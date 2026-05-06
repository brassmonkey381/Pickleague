import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, roleBadgeColor, roleLabel, LeagueRole } from '../lib/leagueRole';
import { LeagueMember, LeagueJoinRequest, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueMembers'>;
  route: RouteProp<RootStackParamList, 'LeagueMembers'>;
};

export default function LeagueMembersScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [requests, setRequests] = useState<LeagueJoinRequest[]>([]);
  const [myRole, setMyRole] = useState<LeagueRole>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const [{ data: { user } }, role] = await Promise.all([
      supabase.auth.getUser(),
      getLeagueRole(leagueId),
    ]);
    setMyUserId(user?.id ?? null);
    setMyRole(role);

    const [membersRes, requestsRes] = await Promise.all([
      supabase
        .from('league_members')
        .select('*, profile:profiles(id, full_name, rating)')
        .eq('league_id', leagueId)
        .order('role'),
      isPrivileged(role)
        ? supabase
            .from('league_join_requests')
            .select('*, profile:profiles(id, full_name)')
            .eq('league_id', leagueId)
            .eq('status', 'pending')
            .order('created_at')
        : Promise.resolve({ data: [] }),
    ]);

    setMembers((membersRes.data ?? []) as LeagueMember[]);
    setRequests(((requestsRes as any).data ?? []) as LeagueJoinRequest[]);
    setLoading(false);
  }

  function canManage(target: LeagueMember): boolean {
    // Admin can manage co-admins and members (but not themselves)
    // Co-admins cannot change other roles
    if (myRole !== 'admin') return false;
    if (target.user_id === myUserId) return false;
    if (target.role === 'admin') return false; // can't touch other admins
    return true;
  }

  function showOptions(member: LeagueMember) {
    if (!canManage(member)) return;
    const options: string[] = [];
    if (member.role === 'member')    options.push('Promote to Co-Admin');
    if (member.role === 'co-admin')  options.push('Demote to Member');
    options.push('Remove from League');
    options.push('Cancel');

    Alert.alert(
      member.profile?.full_name ?? 'Member',
      `Current role: ${roleLabel(member.role as LeagueRole)}`,
      options.map((o) => ({
        text: o,
        style: o === 'Remove from League' ? 'destructive' : o === 'Cancel' ? 'cancel' : 'default',
        onPress: o !== 'Cancel' ? () => handleAction(member, o) : undefined,
      }))
    );
  }

  async function handleAction(member: LeagueMember, action: string) {
    if (action === 'Promote to Co-Admin') {
      await supabase.from('league_members')
        .update({ role: 'co-admin' })
        .eq('id', member.id);
    } else if (action === 'Demote to Member') {
      await supabase.from('league_members')
        .update({ role: 'member' })
        .eq('id', member.id);
    } else if (action === 'Remove from League') {
      await supabase.from('league_members').delete().eq('id', member.id);
    }
    load();
  }

  async function denyRequest(request: LeagueJoinRequest) {
    await supabase.from('league_join_requests').update({ status: 'denied' }).eq('id', request.id);
    load();
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <FlatList
      data={members}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        <>
          {/* Pending join requests — visible to admin/co-admin only */}
          {isPrivileged(myRole) && requests.length > 0 && (
            <View style={styles.requestsSection}>
              <Text style={styles.requestsTitle}>
                🔔  {requests.length} Pending Request{requests.length !== 1 ? 's' : ''}
              </Text>
              {requests.map((req) => (
                <View key={req.id} style={styles.requestRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(req.profile?.full_name ?? '?')[0].toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.requestName} numberOfLines={1}>
                    {req.profile?.full_name ?? 'Unknown'} wants to join
                  </Text>
                  <View style={styles.requestActions}>
                    <TouchableOpacity
                      style={styles.approveBtn}
                      onPress={() => navigation.navigate('Invite', { leagueId, leagueName })}
                    >
                      <Text style={styles.approveBtnText}>Send Code</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.denyBtn}
                      onPress={() => denyRequest(req)}
                    >
                      <Text style={styles.denyBtnText}>Deny</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.count}>{members.length} member{members.length !== 1 ? 's' : ''}</Text>
        </>
      }
      renderItem={({ item }) => {
        const role = item.role as LeagueRole;
        const badgeColor = roleBadgeColor(role);
        const manageable = canManage(item);

        return (
          <TouchableOpacity
            style={styles.row}
            onPress={() => showOptions(item)}
            activeOpacity={manageable ? 0.7 : 1}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(item.profile?.full_name ?? '?')[0].toUpperCase()}
              </Text>
            </View>
            <View style={styles.info}>
              <Text style={styles.name}>{item.profile?.full_name ?? 'Unknown'}</Text>
              <Text style={styles.rating}>{item.profile?.rating ?? 1000} ELO</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}>
              <Text style={[styles.badgeText, { color: badgeColor }]}>{roleLabel(role)}</Text>
            </View>
            {manageable && <Text style={styles.chevron}>›</Text>}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={styles.empty}>No members yet.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  requestsSection: { backgroundColor: '#fff8e1', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#ffe082' },
  requestsTitle: { fontSize: 14, fontWeight: '700', color: '#b8860b', marginBottom: 10 },
  requestRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  requestName: { flex: 1, fontSize: 14, fontWeight: '500', color: '#333' },
  requestActions: { flexDirection: 'row', gap: 6 },
  approveBtn: { backgroundColor: '#2e7d32', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  approveBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  denyBtn: { backgroundColor: '#f5f5f5', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  denyBtnText: { color: '#888', fontSize: 12, fontWeight: '600' },
  count: { fontSize: 13, color: '#999', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { fontSize: 18, fontWeight: '700', color: '#2e7d32' },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  rating: { fontSize: 12, color: '#888', marginTop: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  chevron: { fontSize: 22, color: '#ccc', marginLeft: 8 },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 15 },
});
