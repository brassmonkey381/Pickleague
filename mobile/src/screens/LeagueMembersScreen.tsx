import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Modal, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { getLeagueRole, isPrivileged, roleBadgeColor, roleLabel, LeagueRole } from '../lib/leagueRole';
import { LeagueMember, LeagueJoinRequest, RootStackParamList } from '../types';
import { availabilityOverlap, totalAvailableSlots, TOTAL_CELLS } from '../lib/availability';
import { AVATARS } from '../data/profileCustomization';

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
  const [loading, setLoading]   = useState(true);
  const [showSuggest, setShowSuggest]       = useState(false);
  const [suggestions, setSuggestions]       = useState<SuggestedPlayer[]>([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);

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

  async function loadSuggestions() {
    setLoadingSuggest(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoadingSuggest(false); return; }

    const myProfileRes = await supabase
      .from('profiles')
      .select('rating, availability')
      .eq('id', user.id)
      .single();
    const myRating = myProfileRes.data?.rating ?? 1000;
    const myAv: boolean[] = myProfileRes.data?.availability ?? [];

    const memberIds = members.map(m => m.user_id);
    const memberRatings = members.map(m => m.profile?.rating ?? 1000);
    const avgElo = memberRatings.length
      ? Math.round(memberRatings.reduce((a, b) => a + b, 0) / memberRatings.length)
      : myRating;

    const { data: candidates } = await supabase
      .from('profiles')
      .select('id, full_name, username, rating, singles_rating, doubles_rating, availability, avatar_id, avatar_url')
      .not('id', 'in', `(${memberIds.join(',')})`)
      .gte('rating', avgElo - 350)
      .lte('rating', avgElo + 350)
      .limit(50);

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
        eloDiff: Math.abs(p.rating - avgElo),
        overlapHours: +(overlapSlots * 0.5).toFixed(1),
      };
    });

    scored.sort((a, b) =>
      b.overlapHours - a.overlapHours || a.eloDiff - b.eloDiff
    );

    setSuggestions(scored.slice(0, 20));
    setLoadingSuggest(false);
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
    const options: string[] = [];
    if (member.role === 'member')   options.push('Promote to Co-Admin');
    if (member.role === 'co-admin') options.push('Demote to Member');
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
      await supabase.from('league_members').update({ role: 'co-admin' }).eq('id', member.id);
    } else if (action === 'Demote to Member') {
      await supabase.from('league_members').update({ role: 'member' }).eq('id', member.id);
    } else if (action === 'Remove from League') {
      await supabase.from('league_members').delete().eq('id', member.id);
    }
    load();
  }

  async function denyRequest(request: LeagueJoinRequest) {
    await supabase.from('league_join_requests').update({ status: 'denied' }).eq('id', request.id);
    load();
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  const avgLeagueElo = members.length
    ? Math.round(members.reduce((s, m) => s + (m.profile?.rating ?? 1000), 0) / members.length)
    : 1000;

  return (
    <>
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={members}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      ListHeaderComponent={
        <>
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
                  <Text style={S.requestName} numberOfLines={1}>
                    {req.profile?.full_name ?? 'Unknown'} wants to join
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
              {members.length} member{members.length !== 1 ? 's' : ''} · avg {avgLeagueElo} ELO
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
              <Text style={S.name}>{item.profile?.full_name ?? 'Unknown'}</Text>
              <Text style={S.rating}>{item.profile?.rating ?? 1000} ELO</Text>
            </View>
            <View style={[S.badge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}>
              <Text style={[S.badgeText, { color: badgeColor }]}>{roleLabel(role)}</Text>
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
      ListEmptyComponent={<Text style={S.empty}>No members yet.</Text>}
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
              Similar ELO to {leagueName} · sorted by schedule overlap
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
              Players ranked by schedule overlap with you, then by ELO proximity to league average ({avgLeagueElo}).{'\n'}
              Share your invite link to bring them in.
            </Text>
            {suggestions.map((p, idx) => {
              const avatar = AVATARS.find(a => a.id === (p.avatar_id ?? 1)) ?? AVATARS[0];
              const eloDiffLabel = p.eloDiff === 0 ? 'same ELO' : `${p.eloDiff > 0 ? '+' : ''}${p.eloDiff < 0 ? '' : ''}${p.rating - avgLeagueElo} vs avg`;
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
                    <Text style={S.suggestName} numberOfLines={1}>{p.full_name}</Text>
                    <Text style={S.suggestSub}>@{p.username}</Text>
                    <View style={S.suggestPills}>
                      <View style={S.eloPill}>
                        <Text style={S.eloPillText}>{p.rating} ELO</Text>
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
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
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
