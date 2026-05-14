import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import {
  getTournamentRole, TournamentRole,
  tournamentRoleLabel, tournamentRoleBadgeColor,
} from '../lib/tournamentRole';
import { TournamentRegistration, RootStackParamList } from '../types';
import { formatPlupr } from '../lib/plupr';
import ActionSheetModal, { ActionSheetAction } from '../components/ActionSheetModal';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentMembers'>;
  route: RouteProp<RootStackParamList, 'TournamentMembers'>;
};

export default function TournamentMembersScreen({ navigation, route }: Props) {
  const { tournamentId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [members, setMembers]   = useState<TournamentRegistration[]>([]);
  const [myRole, setMyRole]     = useState<TournamentRole>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [actionTarget, setActionTarget] = useState<TournamentRegistration | null>(null);

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
      .select('*, profile:profiles!tournament_registrations_user_id_fkey(id, full_name, rating, total_matches_played)')
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
    setActionTarget(member);
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

  function actionsFor(member: TournamentRegistration): ActionSheetAction[] {
    const list: ActionSheetAction[] = [];
    const role = member.role as TournamentRole;
    if (role === 'member')   list.push({ label: 'Promote to Co-Admin', onPress: () => handleAction(member, 'Promote to Co-Admin') });
    if (role === 'co-admin') list.push({ label: 'Demote to Member',    onPress: () => handleAction(member, 'Demote to Member') });
    list.push({ label: 'Remove from Tournament', style: 'destructive', onPress: () => handleAction(member, 'Remove from Tournament') });
    return list;
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  return (
    <>
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={members}
      keyExtractor={item => item.id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        <Text style={S.count}>{members.length} approved member{members.length !== 1 ? 's' : ''}</Text>
      }
      renderItem={({ item }) => {
        const role       = item.role as TournamentRole;
        const badgeColor = tournamentRoleBadgeColor(role);
        const manageable = canManage(item);
        return (
          <TouchableOpacity
            style={S.row}
            onPress={() => navigation.navigate('PlayerProfile', {
              userId:   item.user_id,
              userName: item.profile?.full_name ?? 'Player',
            })}
            activeOpacity={0.7}
          >
            <View style={S.avatar}>
              <Text style={S.avatarText}>{(item.profile?.full_name ?? '?')[0].toUpperCase()}</Text>
            </View>
            <View style={S.info}>
              <Text style={S.name}>{item.profile?.full_name ?? 'Unknown'}</Text>
              <Text style={S.rating}>{formatPlupr((item.profile as any)?.rating, (item.profile as any)?.total_matches_played)} PLUPR</Text>
            </View>
            <View style={[S.badge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}>
              <Text style={[S.badgeText, { color: badgeColor }]}>{tournamentRoleLabel(role)}</Text>
            </View>
            {manageable && (
              <TouchableOpacity
                style={S.kebab}
                onPress={(e) => { e.stopPropagation?.(); showOptions(item); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={S.kebabText}>⋮</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={S.empty}>No approved members yet.</Text>}
    />

    <ActionSheetModal
      visible={!!actionTarget}
      title={actionTarget?.profile?.full_name ?? 'Member'}
      subtitle={actionTarget ? `Current role: ${tournamentRoleLabel(actionTarget.role as TournamentRole)}` : undefined}
      actions={actionTarget ? actionsFor(actionTarget) : []}
      onClose={() => setActionTarget(null)}
    />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    count: { fontSize: 13, color: c.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 8, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    avatarText: { fontSize: 18, fontWeight: '700', color: c.primary },
    info: { flex: 1 },
    name: { fontSize: 15, fontWeight: '600', color: c.text },
    rating: { fontSize: 12, color: c.textMuted, marginTop: 1 },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
    badgeText: { fontSize: 11, fontWeight: '700' },
    chevron: { fontSize: 22, color: c.textMuted, marginLeft: 8 },
    kebab: { paddingHorizontal: 10, paddingVertical: 4, marginLeft: 4 },
    kebabText: { fontSize: 22, color: c.textMuted, fontWeight: '700' },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },
  });
}
