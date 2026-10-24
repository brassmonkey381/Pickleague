import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/useToast';
import { useTheme } from '../lib/ThemeContext';
import { WAGERS_ENABLED } from '../lib/features';
import {
  getTournamentRole, TournamentRole,
  tournamentRoleLabel, tournamentRoleBadgeColor,
} from '../lib/tournamentRole';
import { TournamentRegistration, RootStackParamList } from '../types';
import { formatPlupr } from '../lib/plupr';
import ActionSheetModal, { ActionSheetAction } from '../components/ActionSheetModal';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { Chip, ErrorState } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { shadowColor } from '@just-messin-around/expo-foundation/theme';
import { SPACE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { PickleAmount, picklesLabel } from '../components/PickleAmount';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentMembers'>;
  route: RouteProp<RootStackParamList, 'TournamentMembers'>;
};

export default function TournamentMembersScreen({ navigation, route }: Props) {
  const { tournamentId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const toast = useToast();
  const [members, setMembers]   = useState<TournamentRegistration[]>([]);
  // A failed read must not render as "0 approved members".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [myRole, setMyRole]     = useState<TournamentRole>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [actionTarget, setActionTarget] = useState<TournamentRegistration | null>(null);
  const [wagerTotals, setWagerTotals]   = useState<Record<string, number>>({});

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      // LOCAL session read (getUser() is a network call that fails offline).
      const [uid, role] = await Promise.all([
        currentUserId(supabase),
        getTournamentRole(tournamentId),
      ]);
      setMyUserId(uid);
      // 'unknown' = the role read failed; keep the last known one so a director
      // doesn't lose their manage actions to one bad request.
      if (role !== 'unknown') setMyRole(role);

      const rows = await sbCall(() => supabase
        .from('tournament_registrations')
        .select('*, profile:profiles!tournament_registrations_user_id_fkey(id, full_name, rating, total_matches_played)')
        .eq('tournament_id', tournamentId)
        .eq('status', 'approved')
        .order('role'));
      setMembers((rows ?? []) as TournamentRegistration[]);
      setLoadError(null);

      // Public "pickles wagered on this player" totals, scoped to this
      // tournament. Decorative — never let it blank the roster. Skipped
      // while wagering is gated (lib/features.ts): the RPC is absent in
      // production, so this would just fail on every roster load.
      if (WAGERS_ENABLED) {
        try {
          const totals = await sbCall(() =>
            supabase.rpc('get_tournament_wager_totals', { p_tournament_id: tournamentId }),
          );
          const map: Record<string, number> = {};
          ((totals ?? []) as any[]).forEach((t: any) => { if (t.user_id) map[t.user_id] = t.total; });
          setWagerTotals(map);
        } catch {
          // Keep the previous totals.
        }
      }
    } catch (e) {
      setLoadError(friendlySbMessage(e));
    } finally {
      // Always: a throw used to leave the skeleton up for good.
      setLoading(false);
    }
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
    try {
      // Each of these discarded its error, so a failed remove/promote looked
      // exactly like a successful one until the reload silently undid it.
      if (action === 'Promote to Co-Admin') {
        await sbCall(() => supabase.from('tournament_registrations').update({ role: 'co-admin' }).eq('id', member.id));
      } else if (action === 'Demote to Member') {
        await sbCall(() => supabase.from('tournament_registrations').update({ role: 'member' }).eq('id', member.id));
      } else if (action === 'Remove from Tournament') {
        await sbCall(() => supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', member.id));
      }
    } catch (e) {
      toast.error(friendlySbMessage(e, `Couldn't ${action.toLowerCase()}.`));
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

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  if (loadError && members.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorState
          iconName="offline"
          error={null}
          message={`Couldn't load the roster. ${loadError}`}
          onRetry={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  return (
    <>
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={members}
      keyExtractor={item => item.id}
      contentContainerStyle={{ padding: SPACE.lg }}
      refreshControl={<AppRefreshControl {...refresh} />}
      ListHeaderComponent={
        <Text style={S.count}>{members.length} approved member{members.length !== 1 ? 's' : ''}</Text>
      }
      renderItem={({ item }) => {
        const role       = item.role as TournamentRole;
        const badgeColor = tournamentRoleBadgeColor(role, colors);
        const manageable = canManage(item);
        const wagered    = WAGERS_ENABLED ? (wagerTotals[item.user_id] ?? 0) : 0;
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
            {wagered > 0 && (
              <TouchableOpacity
                style={S.wagerPill}
                onPress={(e) => {
                  e.stopPropagation?.();
                  navigation.navigate('PlayerWagers', {
                    userId: item.user_id,
                    userName: item.profile?.full_name ?? 'Player',
                    scopeType: 'tournament',
                    scopeId: tournamentId,
                    scopeName: route.params.tournamentName,
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel={`${picklesLabel(wagered)} wagered on ${item.profile?.full_name ?? 'this player'}`}
              >
                <View style={S.wagerPillInner}>
                  <PickleAmount amount={wagered} preset="meta" />
                </View>
              </TouchableOpacity>
            )}
            <Chip size="sm" accent={badgeColor} label={tournamentRoleLabel(role)} align="center" />
            {manageable && (
              <TouchableOpacity
                style={S.kebab}
                onPress={(e) => { e.stopPropagation?.(); showOptions(item); }}
                accessibilityRole="button"
                accessibilityLabel={`Manage ${item.profile?.full_name ?? 'member'}`}
              >
                <Icon name="more-vertical" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<EmptyState iconName="group" title="No members yet" subtitle="No approved members yet." />}
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
  const t = textStyles(c);
  return StyleSheet.create({
    count: { ...t.fieldLabel, marginBottom: SPACE.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, minHeight: 64, marginBottom: SPACE.sm, elevation: 3, shadowColor: shadowColor(c), shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: SPACE.xs },
    avatarText: { ...t.h3, color: c.primary },
    info: { flex: 1, minWidth: 0 },
    name: t.title,
    rating: { ...t.meta, marginTop: SPACE.xxs },
    // A 44 tap box around the small pickle pill (web ignores hitSlop).
    wagerPill: { minHeight: 44, justifyContent: 'center' },
    wagerPillInner: { backgroundColor: c.primaryLight, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs },
    // The 44 box overhangs the row padding so the glyph sits near the edge.
    kebab: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -SPACE.md, marginRight: -SPACE.sm },
  });
}
