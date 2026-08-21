import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Modal, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import {
  sbCall,
  currentUserId,
  requireUserId,
  friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { getLeagueRole, isPrivileged, roleBadgeColor, roleLabel, LeagueRole } from '../lib/leagueRole';
import { WAGERS_ENABLED } from '../lib/features';
import { LeagueMember, LeagueJoinRequest, RootStackParamList } from '../types';
import { availabilityOverlap, totalAvailableSlots, TOTAL_CELLS } from '../lib/availability';
import { formatPlupr } from '../lib/plupr';
import { AVATARS } from '../data/profileCustomization';
import ActionSheetModal, { ActionSheetAction } from '../components/ActionSheetModal';
import FlairName from '../components/FlairName';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueMembers'>;
  route: RouteProp<RootStackParamList, 'LeagueMembers'>;
};

type SuggestedPlayer = {
  id: string;
  full_name: string;
  username: string;
  rating: number;
  singles_rating: number | null;
  doubles_rating: number | null;
  availability: boolean[];
  avatar_id: number;
  avatar_url: string | null;
  name_color: string | null;
  list_name_style_id: string | null;
  eloDiff: number;
  overlapHours: number;
};

export default function LeagueMembersScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [members, setMembers]   = useState<LeagueMember[]>([]);
  const [requests, setRequests] = useState<LeagueJoinRequest[]>([]);
  const [myRole, setMyRole]     = useState<LeagueRole>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOpen, setIsOpen]     = useState(true);
  const [loading, setLoading]   = useState(true);
  // A failed roster read must not render as an empty league.
  const [loadError, setLoadError]           = useState<string | null>(null);
  const [showSuggest, setShowSuggest]       = useState(false);
  const [suggestions, setSuggestions]       = useState<SuggestedPlayer[]>([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [actionTarget, setActionTarget]     = useState<LeagueMember | null>(null);
  const [joining, setJoining]   = useState(false);
  const [wagerTotals, setWagerTotals]       = useState<Record<string, number>>({});
  const joinStatus = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      // LOCAL session read — getUser() over the network made every member look
      // like a stranger offline (no "you", no admin controls).
      const [uid, role, league] = await Promise.all([
        currentUserId(supabase),
        getLeagueRole(leagueId),
        sbCall(() => supabase.from('leagues').select('is_open').eq('id', leagueId).single()),
      ]);
      setMyUserId(uid);
      // 'unknown' means the role read failed — keep whatever we last knew
      // rather than demoting an admin because of one bad request.
      if (role !== 'unknown') setMyRole(role);
      setIsOpen(league?.is_open ?? true);

      const [memberRows, requestRows] = await Promise.all([
        sbCall(() => supabase
          .from('league_members')
          .select('*, profile:profiles(id, full_name, rating, total_matches_played, name_color, list_name_style_id)')
          .eq('league_id', leagueId)
          .order('role')),
        isPrivileged(role)
          ? sbCall(() => supabase
              .from('league_join_requests')
              .select('*, profile:profiles(id, full_name, name_color, list_name_style_id)')
              .eq('league_id', leagueId)
              .eq('status', 'pending')
              .order('created_at'))
          : Promise.resolve([]),
      ]);

      setMembers((memberRows ?? []) as LeagueMember[]);
      setRequests((requestRows ?? []) as LeagueJoinRequest[]);
      setLoadError(null);

      // Public "pickles wagered on this player" totals, scoped to this league.
      // Decorative — a failure here must not blank the roster. Skipped
      // entirely while wagering is gated (lib/features.ts): the RPC does not
      // exist in production, so calling it only burns a failing round-trip
      // on every roster load.
      if (WAGERS_ENABLED) {
        try {
          const totals = await sbCall(() =>
            supabase.rpc('get_league_wager_totals', { p_league_id: leagueId }),
          );
          const map: Record<string, number> = {};
          ((totals ?? []) as any[]).forEach((t: any) => { if (t.user_id) map[t.user_id] = t.total; });
          setWagerTotals(map);
        } catch {
          // Leave the previous totals in place.
        }
      }
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load the roster."));
    } finally {
      // Always: any throw above used to leave the skeleton on screen forever.
      setLoading(false);
    }
  }

  async function loadSuggestions() {
    setLoadingSuggest(true);
    try {
      await loadSuggestionsInner();
    } catch (e) {
      // An empty suggestion list reads as "nobody matches you" — say otherwise.
      joinStatus.error(friendlySbMessage(e, "Couldn't load suggested players."));
      setSuggestions([]);
    } finally {
      setLoadingSuggest(false);
    }
  }

  async function loadSuggestionsInner() {
    const uid = await currentUserId(supabase);
    if (!uid) return;

    const myProfile = await sbCall(() =>
      supabase.from('profiles').select('rating, availability').eq('id', uid).single(),
    );
    const myRating = myProfile?.rating ?? 3.25;
    const myAv: boolean[] = myProfile?.availability ?? [];

    const memberIds = members.map(m => m.user_id);
    const memberRatings = members.map(m => m.profile?.rating ?? 3.25);
    const avgElo = memberRatings.length
      ? memberRatings.reduce((a, b) => a + b, 0) / memberRatings.length
      : myRating;

    const candidates = await sbCall(() => supabase
      .from('profiles')
      .select('id, full_name, username, rating, singles_rating, doubles_rating, availability, avatar_id, avatar_url, name_color, list_name_style_id')
      .not('id', 'in', `(${memberIds.join(',')})`)
      // Suggested players to invite — a tombstoned account is not one.
      .is('deleted_at', null)
      .gte('rating', avgElo - 1.75)
      .lte('rating', avgElo + 1.75)
      .limit(50));

    const scored: SuggestedPlayer[] = (candidates ?? []).map((p: any) => {
      const av: boolean[] = Array.isArray(p.availability) && p.availability.length === TOTAL_CELLS
        ? p.availability : Array(TOTAL_CELLS).fill(false);
      const overlapSlots = myAv.length === TOTAL_CELLS ? availabilityOverlap(myAv, av) : 0;
      return {
        id: p.id,
        full_name: p.full_name,
        username: p.username,
        rating: p.rating,
        singles_rating: p.singles_rating,
        doubles_rating: p.doubles_rating,
        availability: av,
        avatar_id: p.avatar_id ?? 1,
        avatar_url: p.avatar_url,
        name_color: p.name_color ?? null,
        list_name_style_id: p.list_name_style_id ?? null,
        eloDiff: Math.abs(p.rating - avgElo),
        overlapHours: +(overlapSlots * 0.5).toFixed(1),
      };
    });

    scored.sort((a, b) =>
      b.overlapHours - a.overlapHours || a.eloDiff - b.eloDiff
    );

    setSuggestions(scored.slice(0, 20));
  }

  function openSuggest() {
    setShowSuggest(true);
    loadSuggestions();
  }

  function canManage(target: LeagueMember): boolean {
    if (myRole !== 'admin') return false;
    if (target.user_id === myUserId) return false;
    if (target.role === 'admin') return false;
    return true;
  }

  function showOptions(member: LeagueMember) {
    if (!canManage(member)) return;
    setActionTarget(member);
  }

  async function handleAction(member: LeagueMember, action: string) {
    try {
      // These all discarded their error, so a failed promote/remove looked
      // identical to a successful one until the next reload undid it.
      if (action === 'Promote to Co-Admin') {
        await sbCall(() => supabase.from('league_members').update({ role: 'co-admin' }).eq('id', member.id));
      } else if (action === 'Demote to Member') {
        await sbCall(() => supabase.from('league_members').update({ role: 'member' }).eq('id', member.id));
      } else if (action === 'Remove from League') {
        await sbCall(() => supabase.from('league_members').delete().eq('id', member.id));
      }
    } catch (e) {
      joinStatus.error(friendlySbMessage(e, `Couldn't ${action.toLowerCase()}.`));
    }
    load();
  }

  function actionsFor(member: LeagueMember): ActionSheetAction[] {
    const list: ActionSheetAction[] = [];
    if (member.role === 'member')   list.push({ label: 'Promote to Co-Admin', onPress: () => handleAction(member, 'Promote to Co-Admin') });
    if (member.role === 'co-admin') list.push({ label: 'Demote to Member',    onPress: () => handleAction(member, 'Demote to Member') });
    list.push({ label: 'Remove from League', style: 'destructive', onPress: () => handleAction(member, 'Remove from League') });
    return list;
  }

  async function denyRequest(request: LeagueJoinRequest) {
    try {
      await sbCall(() =>
        supabase.from('league_join_requests').update({ status: 'denied' }).eq('id', request.id),
      );
    } catch (e) {
      joinStatus.error(friendlySbMessage(e, "Couldn't deny that request."));
    }
    load();
  }

  // ── Join / request-to-join (prospective members viewing the roster) ──
  async function joinOpenLeague() {
    setJoining(true);
    joinStatus.clear();
    try {
      // requireUserId reads the stored session locally, so this works on a
      // connection too flaky for getUser()'s round trip.
      const uid = await requireUserId(supabase, 'Please sign in again to join.');
      // Upsert on (league_id, user_id) — safe to retry.
      await sbCall(() =>
        supabase.from('league_members').upsert({ league_id: leagueId, user_id: uid, role: 'member' }),
      );
      await load();
    } catch (e) {
      joinStatus.error(friendlySbMessage(e, "Couldn't join this league."));
    } finally {
      setJoining(false);
    }
  }

  async function requestToJoin() {
    setJoining(true);
    joinStatus.clear();
    try {
      const uid = await requireUserId(supabase, 'Please sign in again to request access.');
      await sbCall(() =>
        supabase.from('league_join_requests').upsert({ league_id: leagueId, user_id: uid, status: 'pending' }),
      );
      joinStatus.success(`Request sent. The admins of "${leagueName}" have been notified — they'll share an invite code with you.`);
    } catch (e) {
      joinStatus.error(friendlySbMessage(e, "Couldn't send your request."));
    } finally {
      setJoining(false);
    }
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  if (loadError && members.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <EmptyState
          icon="📡"
          title="Couldn't load the roster"
          subtitle={loadError}
          actionLabel="Try again"
          onAction={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  const avgLeagueElo = members.length
    ? +(members.reduce((s, m) => s + (m.profile?.rating ?? 3.25), 0) / members.length).toFixed(2)
    : 3.25;

  return (
    <>
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={members}
      keyExtractor={(item) => item.id}
      refreshControl={<AppRefreshControl {...refresh} />}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      ListHeaderComponent={
        <>
          {/* TODO: smoke-test in browser — Join affordance for non-members viewing the roster */}
          {myRole === null && (
            <View style={S.joinCard}>
              <Text style={S.joinCardTitle}>
                {isOpen ? 'Join this league' : 'Want in?'}
              </Text>
              <Text style={S.joinCardSub}>
                {isOpen
                  ? 'Join to record matches, see standings, and play in events.'
                  : 'This league is private — request to join and an admin will share an invite code.'}
              </Text>
              <StatusBanner status={joinStatus.value} style={{ marginTop: 8 }} />
              <TouchableOpacity
                style={[S.joinBtn, joining && S.joinBtnDisabled]}
                onPress={isOpen ? joinOpenLeague : requestToJoin}
                disabled={joining}
                activeOpacity={0.85}
              >
                <Text style={S.joinBtnText}>
                  {joining
                    ? (isOpen ? 'Joining…' : 'Sending…')
                    : (isOpen ? 'Join League' : 'Request to Join')}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {isPrivileged(myRole) && requests.length > 0 && (
            <View style={S.requestsSection}>
              <Text style={S.requestsTitle}>
                🔔  {requests.length} Pending Request{requests.length !== 1 ? 's' : ''}
              </Text>
              {requests.map((req) => (
                <View key={req.id} style={S.requestRow}>
                  <View style={S.memberAvatar}>
                    <Text style={S.memberAvatarText}>
                      {(req.profile?.full_name ?? '?')[0].toUpperCase()}
                    </Text>
                  </View>
                  {/* TODO: smoke-test in browser — list mode FlairName wire-up */}
                  <Text style={S.requestName} numberOfLines={1}>
                    <FlairName
                      name={req.profile?.full_name ?? 'Unknown'}
                      nameColor={req.profile?.name_color}
                      styleId={req.profile?.list_name_style_id ?? null}
                      mode="list"
                      style={S.requestName}
                    />
                    {' wants to join'}
                  </Text>
                  <View style={S.requestActions}>
                    <TouchableOpacity
                      style={S.approveBtn}
                      onPress={() => navigation.navigate('Invite', { leagueId, leagueName })}
                    >
                      <Text style={S.approveBtnText}>Send Code</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={S.denyBtn} onPress={() => denyRequest(req)}>
                      <Text style={S.denyBtnText}>Deny</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          <View style={S.memberCountRow}>
            <Text style={S.count}>
              {members.length} member{members.length !== 1 ? 's' : ''} · avg {avgLeagueElo.toFixed(2)} PLUPR
            </Text>
            {isPrivileged(myRole) && (
              <TouchableOpacity style={S.suggestBtn} onPress={openSuggest}>
                <Text style={S.suggestBtnText}>✨ Suggest Players</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      }
      renderItem={({ item }) => {
        const role = item.role as LeagueRole;
        const badgeColor = roleBadgeColor(role);
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
            <View style={S.memberAvatar}>
              <Text style={S.memberAvatarText}>
                {(item.profile?.full_name ?? '?')[0].toUpperCase()}
              </Text>
            </View>
            <View style={S.info}>
              {/* TODO: smoke-test in browser — list mode FlairName wire-up */}
              <FlairName
                name={item.profile?.full_name ?? 'Unknown'}
                nameColor={item.profile?.name_color}
                styleId={item.profile?.list_name_style_id ?? null}
                mode="list"
                style={S.name}
              />
              <Text style={S.rating}>{formatPlupr(item.profile?.rating, item.profile?.total_matches_played)} PLUPR</Text>
            </View>
            {wagered > 0 && (
              <TouchableOpacity
                style={S.wagerPill}
                onPress={(e) => {
                  e.stopPropagation?.();
                  navigation.navigate('PlayerWagers', {
                    userId: item.user_id,
                    userName: item.profile?.full_name ?? 'Player',
                    scopeType: 'league',
                    scopeId: leagueId,
                    scopeName: leagueName,
                  });
                }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityRole="button"
                accessibilityLabel={`View wagers on ${item.profile?.full_name ?? 'player'}`}
              >
                <Text style={S.wagerPillText}>🥒 {wagered.toLocaleString()}</Text>
              </TouchableOpacity>
            )}
            <View style={[S.badge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}>
              <Text style={[S.badgeText, { color: badgeColor }]}>{roleLabel(role)}</Text>
            </View>
            {manageable && (
              <TouchableOpacity
                style={S.kebab}
                onPress={(e) => { e.stopPropagation?.(); showOptions(item); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`Manage ${item.profile?.full_name ?? 'member'}`}
              >
                <Text style={S.kebabText}>⋮</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<EmptyState icon="👥" title="No members yet" subtitle="No members yet." />}
    />

    <Modal
      visible={showSuggest}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setShowSuggest(false)}
    >
      <View style={S.modalRoot}>
        <View style={S.modalHeader}>
          <View>
            <Text style={S.modalTitle}>✨ Suggested Players</Text>
            <Text style={S.modalSubtitle}>
              Similar PLUPR to {leagueName} · sorted by schedule overlap
            </Text>
          </View>
          <TouchableOpacity onPress={() => setShowSuggest(false)} style={S.modalClose}>
            <Text style={S.modalCloseText}>Done</Text>
          </TouchableOpacity>
        </View>

        {loadingSuggest ? (
          <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.primary} />
        ) : suggestions.length === 0 ? (
          <View style={S.emptySuggest}>
            <Text style={S.emptySuggestText}>No suggestions found nearby.{'\n'}
              Try setting your availability on your profile so we can find good matches!
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <Text style={S.suggestHint}>
              Players ranked by schedule overlap with you, then by PLUPR proximity to league average ({avgLeagueElo.toFixed(2)}).{'\n'}
              Share your invite link to bring them in.
            </Text>
            {suggestions.map((p, idx) => {
              const avatar = AVATARS.find(a => a.id === (p.avatar_id ?? 1)) ?? AVATARS[0];
              const ratingDiff = p.rating - avgLeagueElo;
              const eloDiffLabel = Math.abs(ratingDiff) < 0.005 ? 'same PLUPR' : `${ratingDiff > 0 ? '+' : ''}${ratingDiff.toFixed(2)} vs avg`;
              const hasOverlap = p.overlapHours > 0;
              return (
                <View key={p.id} style={S.suggestCard}>
                  <View style={S.suggestRank}>
                    <Text style={S.suggestRankText}>{idx + 1}</Text>
                  </View>
                  <View style={[S.suggestAvatar, { backgroundColor: avatar.bgColor }]}>
                    <Text style={S.suggestAvatarEmoji}>{avatar.emoji}</Text>
                  </View>
                  <View style={S.suggestInfo}>
                    {/* TODO: smoke-test in browser — list mode FlairName wire-up */}
                    <FlairName
                      name={p.full_name}
                      nameColor={p.name_color}
                      styleId={p.list_name_style_id}
                      mode="list"
                      style={S.suggestName}
                      numberOfLines={1}
                    />
                    <Text style={S.suggestSub}>@{p.username}</Text>
                    <View style={S.suggestPills}>
                      <View style={S.eloPill}>
                        <Text style={S.eloPillText}>{p.rating.toFixed(2)} PLUPR</Text>
                      </View>
                      <View style={[S.overlapPill, !hasOverlap && S.overlapPillNone]}>
                        <Text style={[S.overlapPillText, !hasOverlap && S.overlapPillNoneText]}>
                          {hasOverlap ? `${p.overlapHours}h overlap` : 'No overlap'}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={S.inviteBtn}
                    onPress={() => {
                      setShowSuggest(false);
                      navigation.navigate('Invite', { leagueId, leagueName });
                    }}
                  >
                    <Text style={S.inviteBtnText}>Invite</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>

    <ActionSheetModal
      visible={!!actionTarget}
      title={actionTarget?.profile?.full_name ?? 'Member'}
      subtitle={actionTarget ? `Current role: ${roleLabel(actionTarget.role as LeagueRole)}` : undefined}
      actions={actionTarget ? actionsFor(actionTarget) : []}
      onClose={() => setActionTarget(null)}
    />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    joinCard:         { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: c.primary + '44', elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    joinCardTitle:    { fontSize: 17, fontWeight: '800', color: c.text },
    joinCardSub:      { fontSize: 13, color: c.textSub, marginTop: 4, lineHeight: 18 },
    joinBtn:          { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 12 },
    joinBtnDisabled:  { backgroundColor: c.primary + '80' },
    joinBtnText:      { color: '#fff', fontSize: 16, fontWeight: '700' },

    requestsSection:  { backgroundColor: '#fff8e1', borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#ffe082' },
    requestsTitle:    { fontSize: 14, fontWeight: '700', color: '#b8860b', marginBottom: 10 },
    requestRow:       { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
    requestName:      { flex: 1, fontSize: 14, fontWeight: '500', color: c.text },
    requestActions:   { flexDirection: 'row', gap: 6 },
    approveBtn:       { backgroundColor: c.primary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
    approveBtnText:   { color: '#fff', fontSize: 12, fontWeight: '700' },
    denyBtn:          { backgroundColor: c.surfaceAlt, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
    denyBtnText:      { color: c.textSub, fontSize: 12, fontWeight: '600' },
    memberCountRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    count:            { fontSize: 13, color: c.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    suggestBtn:       { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: c.primaryLight, borderWidth: 1.5, borderColor: c.primary },
    suggestBtnText:   { fontSize: 12, color: c.primary, fontWeight: '700' },
    row:              { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 8, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    memberAvatar:     { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    memberAvatarText: { fontSize: 18, fontWeight: '700', color: c.primary },
    info:             { flex: 1 },
    name:             { fontSize: 15, fontWeight: '600', color: c.text },
    rating:           { fontSize: 12, color: c.textMuted, marginTop: 1 },
    badge:            { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
    badgeText:        { fontSize: 11, fontWeight: '700' },
    wagerPill:        { backgroundColor: c.primaryLight, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 },
    wagerPillText:    { fontSize: 11, fontWeight: '700', color: c.primary },
    chevron:          { fontSize: 22, color: c.textMuted, marginLeft: 8 },
    kebab:            { paddingHorizontal: 10, paddingVertical: 4, marginLeft: 4 },
    kebabText:        { fontSize: 22, color: c.textMuted, fontWeight: '700' },
    empty:            { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },

    modalRoot:        { flex: 1, backgroundColor: c.surface },
    modalHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 20, borderBottomWidth: 1, borderBottomColor: c.border },
    modalTitle:       { fontSize: 18, fontWeight: '800', color: c.text },
    modalSubtitle:    { fontSize: 13, color: c.textMuted, marginTop: 2 },
    modalClose:       { paddingTop: 4 },
    modalCloseText:   { fontSize: 15, color: c.primary, fontWeight: '700' },
    emptySuggest:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
    emptySuggestText: { fontSize: 15, color: c.textMuted, textAlign: 'center', lineHeight: 22 },
    suggestHint:      { fontSize: 12, color: c.textMuted, lineHeight: 17, marginBottom: 16 },

    suggestCard:      { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: c.border, gap: 10 },
    suggestRank:      { width: 22, alignItems: 'center' },
    suggestRankText:  { fontSize: 13, fontWeight: '700', color: c.textMuted },
    suggestAvatar:    { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    suggestAvatarEmoji: { fontSize: 22 },
    suggestInfo:      { flex: 1 },
    suggestName:      { fontSize: 14, fontWeight: '700', color: c.text },
    suggestSub:       { fontSize: 11, color: c.textMuted, marginBottom: 5 },
    suggestPills:     { flexDirection: 'row', gap: 6 },
    eloPill:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: c.primaryLight },
    eloPillText:      { fontSize: 11, color: c.primary, fontWeight: '700' },
    overlapPill:      { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: '#e3f2fd' },
    overlapPillNone:  { backgroundColor: c.bg },
    overlapPillText:  { fontSize: 11, color: '#1565c0', fontWeight: '700' },
    overlapPillNoneText: { color: c.textMuted },
    inviteBtn:        { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: c.primary },
    inviteBtnText:    { color: '#fff', fontSize: 13, fontWeight: '700' },
  });
}
