// A league's roster (plan section 5, "LeagueMembers"):
//   [Join this league  [Join]]        non-members: the shared LeagueJoinCard
//   JOIN REQUESTS 2                   admins/co-admins, FIRST — the
//     Sam wants to join  [Approve] [Deny]       league_members/ push lands here
//   MEMBERS 14 · avg 3.62      Suggest
//   [Q search]  (Role)(PLUPR)(Name)   only once the league has > 10 members
//   56px rows: avatar · name · PLUPR · role chip · ⋮ (admin tools)
import { useScreenBottomInset } from '../lib/appChrome';
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Pressable, StyleSheet,
  ActivityIndicator, Modal, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import {
  sbCall,
  currentUserId,
  friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import {
  Badge, FilterChipRow, FilterSearchField, ListCard, Panel, SectionHeader, StatusBanner,
  type FilterChipOption,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { getLeagueRole, isMember, isPrivileged, roleLabel, LeagueRole } from '../lib/leagueRole';
import { leagueRoleChip } from '../lib/entityGlyph';
import { WAGERS_ENABLED } from '../lib/features';
import { LeagueMember, LeagueJoinRequest, RootStackParamList } from '../types';
import { availabilityOverlap, TOTAL_CELLS } from '../lib/availability';
import { formatPlupr } from '../lib/plupr';
import { AVATARS } from '../data/profileCustomization';
import ActionSheetModal, { ActionSheetAction } from '../components/ActionSheetModal';
import FlairName from '../components/FlairName';
import LeagueJoinCard from '../components/LeagueJoinCard';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';
import { dropJoinedRequests } from '../lib/inboxRequests';
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

type MemberSort = 'role' | 'plupr' | 'name';
const SORT_OPTIONS: FilterChipOption<MemberSort>[] = [
  { value: 'role', label: 'Role' },
  { value: 'plupr', label: 'PLUPR' },
  { value: 'name', label: 'Name' },
];
const ROLE_ORDER: Record<string, number> = { admin: 0, 'co-admin': 1, member: 2 };
/** Search + sort earn their room only past this many members (plan section 5). */
const SEARCH_THRESHOLD = 10;

export default function LeagueMembersScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  // A push (join request) opens this screen with the placeholder name 'League'
  // and a cold web URL with none; load() replaces it with the real one.
  const [leagueName, setLeagueName] = useState(route.params.leagueName ?? '');
  const { colors } = useTheme();
  const t = textStyles(colors);
  const S = makeStyles(colors);
  // The navigator already keeps the bottom bar and the island clear (lib/appChrome).
  const bottomInset = useScreenBottomInset(SPACE.xl);
  const [members, setMembers]   = useState<LeagueMember[]>([]);
  const [requests, setRequests] = useState<LeagueJoinRequest[]>([]);
  const [myRole, setMyRole]     = useState<LeagueRole>(null);
  // The role read has succeeded at least once: until then the join card stays
  // hidden, so a member on a slow read never sees [Join].
  const [roleKnown, setRoleKnown] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOpen, setIsOpen]     = useState<boolean | null>(null);
  const [myRequestPending, setMyRequestPending] = useState(false);
  // Requests with an Approve / Deny in flight (double-tap guard).
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading]   = useState(true);
  // A failed roster read must not render as an empty league.
  const [loadError, setLoadError]           = useState<string | null>(null);
  const [showSuggest, setShowSuggest]       = useState(false);
  const [suggestions, setSuggestions]       = useState<SuggestedPlayer[]>([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [actionTarget, setActionTarget]     = useState<LeagueMember | null>(null);
  const [wagerTotals, setWagerTotals]       = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [sort, setSort]     = useState<MemberSort>('role');
  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      // LOCAL session read — getUser() over the network made every member look
      // like a stranger offline (no "you", no admin controls).
      const [uid, role, league] = await Promise.all([
        currentUserId(supabase),
        getLeagueRole(leagueId),
        sbCall(() => supabase.from('leagues').select('is_open, name').eq('id', leagueId).single()),
      ]);
      setMyUserId(uid);
      // 'unknown' means the role read failed — keep whatever we last knew
      // rather than demoting an admin because of one bad request.
      if (role !== 'unknown') {
        setMyRole(role);
        setRoleKnown(true);
      }
      setIsOpen(league?.is_open ?? true);
      if (league?.name) {
        setLeagueName(league.name);
        navigation.setOptions({ title: league.name + ' Members' });
      }

      const [memberRows, requestRows, mine] = await Promise.all([
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
        // A non-member's own pending request ("Users can view own requests"),
        // so the join card says "Request sent" instead of offering it again.
        role === null && uid
          ? sbCall(() => supabase
              .from('league_join_requests')
              .select('id')
              .eq('league_id', leagueId)
              .eq('user_id', uid)
              .eq('status', 'pending')
              .maybeSingle()).catch(() => null)
          : Promise.resolve(null),
      ]);

      const memberList = (memberRows ?? []) as LeagueMember[];
      setMembers(memberList);
      // 'unknown' = the role read failed, so the requests query was skipped:
      // keep the last list rather than hiding an admin's pending requests
      // (the block a league_members push opens this screen for). Requesters
      // who are already members are dropped (belt and braces: the database
      // now deletes their request when they join).
      if (role !== 'unknown') {
        setRequests(dropJoinedRequests((requestRows ?? []) as LeagueJoinRequest[], memberList));
      }
      if (role === null) setMyRequestPending(!!mine);
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
          ((totals ?? []) as any[]).forEach((w: any) => { if (w.user_id) map[w.user_id] = w.total; });
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
      status.error(friendlySbMessage(e, "Couldn't load suggested players."));
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

    // Suggested players to invite: discover_players (migration_hide_test_accounts.sql)
    // never offers a tombstoned account, nor a test account while God mode
    // hides them.
    const candidates = await sbCall(() => supabase
      .rpc('discover_players', {
        p_exclude: memberIds,
        p_min_rating: avgElo - 1.75,
        p_max_rating: avgElo + 1.75,
        p_limit: 50,
        // The 50 nearest the league's level, not the first 50 names.
        p_near_rating: avgElo,
      })
      .select('id, full_name, username, rating, singles_rating, doubles_rating, availability, avatar_id, avatar_url, name_color, list_name_style_id')) as any[] | null;

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
      status.error(friendlySbMessage(e, `Couldn't ${action.toLowerCase()}.`));
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

  // One-tap Approve / Deny (migration_league_join_resolution.sql). Both RPCs
  // check the caller is an admin / co-admin; the database clears every
  // admin's notice for the request and tells the requester.
  async function approveRequest(request: LeagueJoinRequest) {
    if (answering.has(request.id)) return;
    setAnswering((prev) => new Set(prev).add(request.id));
    try {
      const res = await sbCall(() => supabase.rpc('approve_league_join_request', { p_request_id: request.id }));
      const who = request.profile?.full_name || 'They';
      status.success(res === 'member' ? `${who} was already in the league.` : `${who} is in.`);
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't approve that request."));
    } finally {
      setAnswering((prev) => { const n = new Set(prev); n.delete(request.id); return n; });
    }
    load();
  }

  async function denyRequest(request: LeagueJoinRequest) {
    if (answering.has(request.id)) return;
    setAnswering((prev) => new Set(prev).add(request.id));
    try {
      await sbCall(() => supabase.rpc('deny_league_join_request', { p_request_id: request.id }));
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't deny that request."));
    } finally {
      setAnswering((prev) => { const n = new Set(prev); n.delete(request.id); return n; });
    }
    load();
  }

  const showSearch = members.length > SEARCH_THRESHOLD;
  const visibleMembers = useMemo(() => {
    const q = showSearch ? search.trim().toLowerCase() : '';
    const rows = q
      ? members.filter(m => (m.profile?.full_name ?? '').toLowerCase().includes(q))
      : [...members];
    const name = (m: LeagueMember) => (m.profile?.full_name ?? '').toLowerCase();
    const sortBy = showSearch ? sort : 'role';
    rows.sort((a, b) => {
      if (sortBy === 'plupr') return (b.profile?.rating ?? 0) - (a.profile?.rating ?? 0) || name(a).localeCompare(name(b));
      if (sortBy === 'name') return name(a).localeCompare(name(b));
      // 'role': admins, then co-admins, then members (the old .order('role')),
      // each group by name.
      return (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || name(a).localeCompare(name(b));
    });
    return rows;
  }, [members, search, sort, showSearch]);

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} variant="row" /></View>;

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
  const privileged = isPrivileged(myRole);

  const initialOf = (name: string | null | undefined) => (name ?? '').trim()[0]?.toUpperCase() || '?';

  return (
    <>
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={visibleMembers}
      keyExtractor={(item) => item.id}
      refreshControl={<AppRefreshControl {...refresh} />}
      contentContainerStyle={[S.list, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <>
          {status.value ? <StatusBanner status={status.value} style={S.banner} /> : null}

          {/* Non-members: the shared join card (renders nothing for members or
              until the role read has succeeded). */}
          <LeagueJoinCard
            leagueId={leagueId}
            leagueName={leagueName}
            isOpen={isOpen}
            roleKnown={roleKnown}
            isMember={isMember(myRole)}
            requested={myRequestPending}
            onJoined={() => load()}
            onRequested={() => setMyRequestPending(true)}
            onWithdrawn={() => setMyRequestPending(false)}
            style={S.joinCard}
          />

          {/* Pending join requests FIRST: the league_members/ push lands here. */}
          {privileged && requests.length > 0 && (
            <View style={S.block}>
              <SectionHeader title="Join requests" count={requests.length} />
              <Panel padded={false}>
                {requests.map((req, i) => (
                  <View key={req.id} style={[S.requestRow, i < requests.length - 1 && S.divider]}>
                    <View style={S.avatar}>
                      <Text style={[t.title, { color: colors.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                        {initialOf(req.profile?.full_name)}
                      </Text>
                    </View>
                    <View style={S.rowText}>
                      <FlairName
                        name={req.profile?.full_name || 'A player'}
                        nameColor={req.profile?.name_color}
                        styleId={req.profile?.list_name_style_id ?? null}
                        mode="list"
                        style={t.title}
                        numberOfLines={1}
                      />
                      <Text style={t.sub} numberOfLines={1}>wants to join</Text>
                    </View>
                    <Button
                      size="sm"
                      title="Approve"
                      loading={answering.has(req.id)}
                      onPress={() => approveRequest(req)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      title="Deny"
                      disabled={answering.has(req.id)}
                      onPress={() => denyRequest(req)}
                    />
                  </View>
                ))}
              </Panel>
            </View>
          )}

          <SectionHeader
            title="Members"
            count={members.length > 0 ? `${members.length} · avg ${avgLeagueElo.toFixed(2)} PLUPR` : undefined}
            action={privileged ? { label: '✨ Suggest', onPress: openSuggest, a11yLabel: 'Suggest players to invite' } : undefined}
          />

          {showSearch && (
            <View style={S.searchBlock}>
              <FilterSearchField
                size="sm"
                value={search}
                onChangeText={setSearch}
                placeholder="Search members"
                autoCorrect={false}
                autoCapitalize="none"
              />
              <FilterChipRow size="md" options={SORT_OPTIONS} value={sort} onChange={setSort} />
            </View>
          )}
        </>
      }
      renderItem={({ item }) => {
        const role = item.role as LeagueRole;
        // Only the roles worth flagging: "Member" on every row is noise.
        const chip = role === 'admin' || role === 'co-admin' ? leagueRoleChip(role) : null;
        const manageable = canManage(item);
        const wagered    = WAGERS_ENABLED ? (wagerTotals[item.user_id] ?? 0) : 0;
        const name = item.profile?.full_name || 'Player';
        const isMe = item.user_id === myUserId;
        return (
          <ListCard
            density="compact"
            style={(wagered > 0 || manageable) ? S.actionRow : undefined}
            highlighted={isMe}
            onPress={() => navigation.navigate('PlayerProfile', { userId: item.user_id, userName: name })}
            leading={
              <View style={S.avatar}>
                <Text style={[t.title, { color: colors.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{initialOf(name)}</Text>
              </View>
            }
            title={
              <View style={S.titleLine}>
                <FlairName
                  name={isMe ? `${name} (you)` : name}
                  nameColor={item.profile?.name_color}
                  styleId={item.profile?.list_name_style_id ?? null}
                  mode="list"
                  style={[t.title, S.titleText]}
                  numberOfLines={1}
                />
                {chip ? <Badge label={chip.label} tone={chip.tone} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} /> : null}
              </View>
            }
            subtitle={`${formatPlupr(item.profile?.rating, item.profile?.total_matches_played)} PLUPR`}
            trailing={(wagered > 0 || manageable) ? (
              <View style={S.trailing}>
                {wagered > 0 && (
                  // Each nested pressable is its own 44 box (RNW ignores hitSlop);
                  // the innermost touchable takes the press on both platforms.
                  <TouchableOpacity
                    style={S.box44}
                    onPress={() => navigation.navigate('PlayerWagers', {
                      userId: item.user_id,
                      userName: name,
                      scopeType: 'league',
                      scopeId: leagueId,
                      scopeName: leagueName,
                    })}
                    accessibilityRole="button"
                    accessibilityLabel={`View wagers on ${name}`}
                  >
                    <View style={S.wagerPill}>
                      <Text style={[t.meta, { color: colors.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>🥒 {wagered.toLocaleString()}</Text>
                    </View>
                  </TouchableOpacity>
                )}
                {manageable && (
                  <TouchableOpacity
                    style={S.box44}
                    onPress={() => showOptions(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Manage ${name}`}
                  >
                    <Text style={[t.title, { color: colors.textMuted }]}>⋮</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : undefined}
            chevron={!manageable && wagered === 0}
          />
        );
      }}
      ListEmptyComponent={
        members.length === 0
          ? <EmptyState icon="👥" title="No members yet" />
          : <EmptyState compact icon="🔍" title="No members match" actionLabel="Clear" onAction={() => setSearch('')} />
      }
    />

    <Modal
      visible={showSuggest}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setShowSuggest(false)}
    >
      <View style={S.modalRoot}>
        <View style={S.modalHeader}>
          <View style={S.rowText}>
            <Text style={t.h3}>✨ Suggested Players</Text>
            <Text style={t.sub} numberOfLines={2}>
              Similar PLUPR to {leagueName || 'this league'} · sorted by schedule overlap
            </Text>
          </View>
          <Pressable onPress={() => setShowSuggest(false)} style={S.box44} accessibilityRole="button">
            <Text style={[t.title, { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>

        {loadingSuggest ? (
          <ActivityIndicator style={{ marginTop: SPACE.xl }} size="large" color={colors.primary} />
        ) : suggestions.length === 0 ? (
          <EmptyState
            icon="🔎"
            title="No suggestions found nearby."
            subtitle="Try setting your availability on your profile so we can find good matches!"
          />
        ) : (
          <ScrollView contentContainerStyle={S.modalList}>
            <Text style={[t.hint, S.suggestHint]}>
              Players ranked by schedule overlap with you, then by PLUPR proximity to league average ({avgLeagueElo.toFixed(2)}).
              Share your invite link to bring them in.
            </Text>
            {suggestions.map((p, idx) => {
              const avatar = AVATARS.find(a => a.id === (p.avatar_id ?? 1)) ?? AVATARS[0];
              const ratingDiff = p.rating - avgLeagueElo;
              const eloDiffLabel = Math.abs(ratingDiff) < 0.005 ? 'same PLUPR' : `${ratingDiff > 0 ? '+' : ''}${ratingDiff.toFixed(2)} vs avg`;
              const hasOverlap = p.overlapHours > 0;
              return (
                <ListCard
                  key={p.id}
                  density="compact"
                  // Its trailing [Invite] is a 44 box.
                  style={S.actionRow}
                  leading={
                    <View style={S.suggestLead}>
                      <Text style={[t.meta, S.suggestRank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{idx + 1}</Text>
                      <View style={[S.avatar, { backgroundColor: avatar.bgColor }]}>
                        <Text style={t.title} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{avatar.emoji}</Text>
                      </View>
                    </View>
                  }
                  title={
                    <FlairName
                      name={p.full_name}
                      nameColor={p.name_color}
                      styleId={p.list_name_style_id}
                      mode="list"
                      style={t.title}
                      numberOfLines={1}
                    />
                  }
                  subtitle={`@${p.username} · ${p.rating.toFixed(2)} PLUPR (${eloDiffLabel}) · ${hasOverlap ? `${p.overlapHours}h overlap` : 'no overlap'}`}
                  trailing={
                    <Button
                      size="sm"
                      title="Invite"
                      onPress={() => {
                        setShowSuggest(false);
                        navigation.navigate('Invite', { leagueId, leagueName });
                      }}
                    />
                  }
                />
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
    list:         { padding: SPACE.lg },
    banner:       { marginTop: 0, marginBottom: SPACE.md },
    joinCard:     { marginBottom: SPACE.md },
    block:        { marginBottom: SPACE.md },
    requestRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 56, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.md },
    divider:      { borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    avatar:       { width: 36, height: 36, borderRadius: RADIUS.pill, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center' },
    rowText:      { flex: 1, minWidth: 0 },
    searchBlock:  { gap: SPACE.xs, marginBottom: SPACE.sm },
    titleLine:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minWidth: 0 },
    titleText:    { flexShrink: 1 },
    trailing:     { flexDirection: 'row', alignItems: 'center' },
    box44:        { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    // A trailing 44 tap box plus ListCard's 10px vertical padding makes a 64
    // row; 4px keeps it a 56 row (the minHeight floor centres the text) with
    // the whole 44 box inside the row's bounds (Android needs that to deliver
    // the touch). Same fix as EntityRow's actionRow.
    actionRow:    { paddingVertical: SPACE.xs },
    wagerPill:    { backgroundColor: c.primaryLight, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs },

    modalRoot:    { flex: 1, backgroundColor: c.surface },
    modalHeader:  { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingTop: SPACE.xl, paddingBottom: SPACE.md, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    modalList:    { padding: SPACE.lg, paddingBottom: SPACE.xl },
    suggestHint:  { marginBottom: SPACE.md },
    suggestLead:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    suggestRank:  { width: 20, textAlign: 'center' },
  });
}
