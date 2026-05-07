import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import {
  getTournamentRole, TournamentRole,
  tournamentRoleLabel, tournamentRoleBadgeColor,
} from '../lib/tournamentRole';
import { TournamentRegistration, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentMembers'>;
  route: RouteProp<RootStackParamList, 'TournamentMembers'>;
};

export default function TournamentMembersScreen({ route }: Props) {
  const { tournamentId } = route.params;
  const [members, setMembers]   = useState<TournamentRegistration[]>([]);
  const [myRole, setMyRole]     = useState<TournamentRole>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const [{ data: { user } }, role] = await Promise.all([
      supabase.auth.getUser(),
      getTournamentRole(tournamentId),
    ]);
    setMyUserId(user?.id ?? null);
    setMyRole(role);

    const { data } = await supabase
      .from('tournament_registrations')
      .select('*, profile:profiles(id, full_name, rating)')
      .eq('tournament_id', tournamentId)
      .eq('status', 'approved')
      .order('role');
    setMembers((data ?? []) as TournamentRegistration[]);
    setLoading(false);
  }

  function canManage(target: TournamentRegistration): boolean {
    if (myRole !== 'admin') return false;
    if (target.user_id === myUserId) return false;
    if (target.role === 'admin') return false;
    return true;
  }

  function showOptions(member: TournamentRegistration) {
    if (!canManage(member)) return;
    const role = member.role as TournamentRole;
    const opts: string[] = [];
    if (role === 'member')   opts.push('Promote to Co-Admin');
    if (role === 'co-admin') opts.push('Demote to Member');
    opts.push('Remove from Tournament');
    opts.push('Cancel');

    Alert.alert(member.profile?.full_name ?? 'Member', `Current role: ${tournamentRoleLabel(role)}`,
      opts.map(o => ({
        text: o,
        style: o === 'Remove from Tournament' ? 'destructive' : o === 'Cancel' ? 'cancel' : 'default',
        onPress: o !== 'Cancel' ? () => handleAction(member, o) : undefined,
      }))
    );
  }

  async function handleAction(member: TournamentRegistration, action: string) {
    if (action === 'Promote to Co-Admin') {
      await supabase.from('tournament_registrations').update({ role: 'co-admin' }).eq('id', member.id);
    } else if (action === 'Demote to Member') {
      await supabase.from('tournament_registrations').update({ role: 'member' }).eq('id', member.id);
    } else if (action === 'Remove from Tournament') {
      await supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', member.id);
    }
    load();
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <FlatList
      data={members}
      keyExtractor={item => item.id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        <Text style={styles.count}>{members.length} approved member{members.length !== 1 ? 's' : ''}</Text>
      }
      renderItem={({ item }) => {
        const role       = item.role as TournamentRole;
        const badgeColor = tournamentRoleBadgeColor(role);
        const manageable = canManage(item);
        return (
          <TouchableOpacity
            style={styles.row}
            onPress={() => showOptions(item)}
            activeOpacity={manageable ? 0.7 : 1}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(item.profile?.full_name ?? '?')[0].toUpperCase()}</Text>
            </View>
            <View style={styles.info}>
              <Text style={styles.name}>{item.profile?.full_name ?? 'Unknown'}</Text>
              <Text style={styles.rating}>{(item.profile as any)?.rating ?? 1000} ELO</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}>
              <Text style={[styles.badgeText, { color: badgeColor }]}>{tournamentRoleLabel(role)}</Text>
            </View>
            {manageable && <Text style={styles.chevron}>›</Text>}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={styles.empty}>No approved members yet.</Text>}
    />
  );
}

const styles = StyleSheet.create({
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
