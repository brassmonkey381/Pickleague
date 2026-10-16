// Friends (docs/play-sessions-presence.md, Phase 1 step 5): mutual friends,
// the people who see you at the courts. Three tabs:
//
//   [Requests 2] [Friends 5] [Find]
//   Requests  WAITING ON YOU  (A) Sam · 2d ago             [Accept] [Decline]
//             SENT            (B) Ana · requested 3d ago   [Cancel]
//   Friends   ⭐ Close friends will get a heads-up when you're at a court.
//             (A) Sam · Friends since Oct 2                ⭐  ⋯
//   Find      [🔍 Search players]
//             PEOPLE YOU'VE PLAYED WITH  (C) Lee · 4 matches together  [Add]
//             INVITE TO PICKLEAGUE        [Share invite link]
//
// - Opening tab: route.params.tab (a friend-request push says 'requests'),
//   else Requests when something waits on me, else Friends.
// - Every write goes through lib/useFriends: the row moves at once, then the
//   lists refetch; a failure puts it back and says why (the RPC's message).
// - Find's search is UserPickerModal with realPeopleOnly: the 472 unclaimed
//   DUPR placeholders, guest passes and deleted accounts can't answer a
//   request, so they aren't listed. Picking someone sends the request.
// - The invite link is MY profile URL: it unfurls into my card, and opens my
//   profile in the app, where Add friend is one tap.
// - Registered only while FRIENDS_AT_COURTS_ENABLED is on (AppNavigator).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import { currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import {
  Avatar,
  EmptyState,
  Panel,
  QueryState,
  SectionHeader,
  SegmentedToggle,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { shareInvite } from '../lib/share';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import ActionSheetModal from '../components/ActionSheetModal';
import ConfirmModal from '../components/ConfirmModal';
import { SkeletonList } from '../components/Skeleton';
import UserPickerModal, { type PickedUser } from '../components/UserPickerModal';
import { CLOSE_FRIEND_EXPLAINER } from '../components/FriendButton';
import {
  addFriend,
  answerFriendRequest,
  markCloseFriend,
  unfriend,
  useFriendRequests,
  useFriendSuggestions,
  useMyFriends,
  withdrawFriendRequest,
  type FriendPerson,
} from '../lib/useFriends';
import {
  findExcludeIds,
  firstNameOf,
  friendsSinceLabel,
  requestAgoLabel,
  respondResultMessage,
  sendResultMessage,
  sortFriends,
  splitRequests,
  visibleSuggestions,
  type FriendRow,
} from '../lib/friendship';
import type { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Friends'>;
  route: RouteProp<RootStackParamList, 'Friends'>;
};

type Tab = 'requests' | 'friends' | 'find';

type Colors = ReturnType<typeof useTheme>['colors'];

const AVATAR = 40;

/** One person: avatar + name + one line, which opens their profile, and the
 *  row's buttons BESIDE it (not inside it: a button nested in a touchable
 *  can't be reached by VoiceOver, and on web it is a press inside a press). */
function PersonRow({
  person, subtitle, trailing, lastRow, onOpen, c,
}: {
  person: FriendPerson;
  subtitle: string | null;
  trailing?: React.ReactNode;
  lastRow: boolean;
  onOpen: () => void;
  c: Colors;
}) {
  const t = textStyles(c);
  const name = person.full_name ?? 'Player';
  return (
    <View style={[S.row, !lastRow && { borderBottomWidth: HAIRLINE, borderBottomColor: c.border }]}>
      <TouchableOpacity
        style={S.who}
        onPress={onOpen}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${name}${subtitle ? `, ${subtitle}` : ''}. Open profile`}
      >
        <Avatar
          size={AVATAR}
          photoUrl={person.avatar_url}
          name={name}
          icon={person.avatar_emoji ? <Text style={S.emoji}>{person.avatar_emoji}</Text> : undefined}
          backgroundColor={person.avatar_bg_color ?? undefined}
        />
        <View style={S.whoText}>
          <Text style={t.title} numberOfLines={1}>{name}</Text>
          {subtitle ? <Text style={t.sub} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </TouchableOpacity>
      {trailing ? <View style={S.actions}>{trailing}</View> : null}
    </View>
  );
}

export default function FriendsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => { void currentUserId(supabase).then(setMeId); }, []);

  const requestsQ = useFriendRequests();
  const friendsQ = useMyFriends();
  const { incoming, outgoing } = useMemo(() => splitRequests(requestsQ.data), [requestsQ.data]);

  // The opening tab: the route's, else Requests when anything waits on me
  // (from the cache, so a warm open lands right), else Friends.
  const [tab, setTab] = useState<Tab>(() => route.params?.tab ?? (incoming.length > 0 ? 'requests' : 'friends'));
  // A push opening an already-mounted Friends updates its params.
  const paramTab = route.params?.tab;
  useEffect(() => {
    if (!paramTab) return;
    setTab(paramTab);
    navigation.setParams({ tab: undefined });
  }, [paramTab, navigation]);

  const suggestQ = useFriendSuggestions(tab === 'find');
  const suggestions = useMemo(
    () => visibleSuggestions(suggestQ.data, { meId, friends: friendsQ.data, requests: requestsQ.data }),
    [suggestQ.data, meId, friendsQ.data, requestsQ.data],
  );
  const friends = useMemo(() => sortFriends(friendsQ.data), [friendsQ.data]);

  const { refresh: refreshRequests } = requestsQ;
  const { refresh: refreshFriendsList } = friendsQ;
  const { refresh: refreshSuggestions } = suggestQ;
  const reload = useCallback(async () => {
    await Promise.all([
      refreshRequests(),
      refreshFriendsList(),
      tab === 'find' ? refreshSuggestions() : Promise.resolve(),
    ]);
  }, [refreshRequests, refreshFriendsList, refreshSuggestions, tab]);
  const refresh = useRefresh(reload);
  // Requests arrive by push while this is in the background.
  useFocusEffect(useCallback(() => { void refreshRequests(); }, [refreshRequests]));

  // One write at a time per person (its row's buttons go busy).
  const [busyId, setBusyId] = useState<string | null>(null);
  async function run<T>(userId: string, write: () => Promise<T>, done: (res: T) => string | null, failMsg: string) {
    if (busyId) return;
    setBusyId(userId);
    try {
      const msg = done(await write());
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(friendlySbMessage(e, failMsg));
    } finally {
      setBusyId(null);
    }
  }

  const add = (p: FriendPerson) =>
    run(p.user_id, () => addFriend(p), (res) => sendResultMessage(res, p.full_name), "Couldn't send the request.");

  const openProfile = (p: FriendPerson) =>
    navigation.navigate('PlayerProfile', { userId: p.user_id, userName: p.full_name ?? 'Player' });

  // ── Find: search ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const exclude = useMemo(
    () => findExcludeIds(meId, friendsQ.data, requestsQ.data),
    [meId, friendsQ.data, requestsQ.data],
  );
  function onPick(u: PickedUser) {
    setPickerOpen(false);
    void add({
      user_id: u.id,
      full_name: u.full_name,
      avatar_url: null,
      avatar_emoji: u.avatar_emoji,
      avatar_bg_color: u.avatar_bg_color,
      doubles_rating: null,
    });
  }

  // ── Find: invite ──
  const [sharing, setSharing] = useState(false);
  async function invite() {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await shareInvite({
        title: 'Join me on Pickleague',
        message: "I'm on Pickleague. Add me as a friend so we can see when we're at the courts:",
        url: meId ? `https://www.pickleague.club/players/${meId}` : 'https://www.pickleague.club',
      });
      if (res.copied) toast.success('Invite link copied. Paste it into a text.');
    } catch {
      // Share sheet dismissed: nothing to do.
    } finally {
      setSharing(false);
    }
  }

  // ── Friends: menu and remove ──
  const [menuFor, setMenuFor] = useState<FriendRow | null>(null);
  const [removeFor, setRemoveFor] = useState<FriendRow | null>(null);
  // The menu's Remove, held until the sheet has fully closed (iOS won't
  // present the confirm while the sheet is still animating out).
  const [queuedRemove, setQueuedRemove] = useState<FriendRow | null>(null);
  const toggleClose = (f: FriendRow) => {
    const first = firstNameOf(f.full_name) ?? 'They';
    return run(
      f.user_id,
      () => markCloseFriend(f.user_id, !f.is_close_friend),
      () => (f.is_close_friend ? `${first} is no longer a close friend.` : `⭐ ${first} is a close friend.`),
      "Couldn't change that just now.",
    );
  };
  const remove = (f: FriendRow) =>
    run(
      f.user_id,
      () => unfriend(f.user_id),
      () => { setRemoveFor(null); return `${firstNameOf(f.full_name) ?? 'They'} is no longer a friend.`; },
      "Couldn't remove them just now.",
    );

  // ── Tabs ──
  function requestsTab() {
    return (
      <QueryState
        query={requestsQ}
        isEmpty={() => incoming.length + outgoing.length === 0}
        renderSkeleton={() => <SkeletonList rows={4} variant="row" />}
        renderEmpty={() => (
          <EmptyState
            icon="🤝"
            title="No friend requests"
            subtitle="Requests you send or get show up here."
            actionLabel="Find friends"
            onAction={() => setTab('find')}
          />
        )}
      >
        {() => (
          <>
            {incoming.length > 0 && (
              <View style={S.block}>
                <SectionHeader title="Waiting on you" count={incoming.length} />
                <Panel padded={false}>
                  {incoming.map((r, i) => (
                    <PersonRow
                      key={r.user_id}
                      c={c}
                      person={r}
                      subtitle={requestAgoLabel(r.created_at, Date.now())}
                      lastRow={i === incoming.length - 1}
                      onOpen={() => openProfile(r)}
                      trailing={
                        <>
                          <Button
                            size="sm"
                            variant="success"
                            title="Accept"
                            loading={busyId === r.user_id}
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => answerFriendRequest(r.user_id, true),
                                (res) => respondResultMessage(res, r.full_name), "Couldn't accept just now.");
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            title="Decline"
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => answerFriendRequest(r.user_id, false),
                                (res) => respondResultMessage(res, r.full_name), "Couldn't decline just now.");
                            }}
                          />
                        </>
                      }
                    />
                  ))}
                </Panel>
              </View>
            )}
            {outgoing.length > 0 && (
              <View style={S.block}>
                <SectionHeader title="Sent" count={outgoing.length} />
                <Panel padded={false}>
                  {outgoing.map((r, i) => {
                    const ago = requestAgoLabel(r.created_at, Date.now());
                    return (
                      <PersonRow
                        key={r.user_id}
                        c={c}
                        person={r}
                        subtitle={ago ? `Requested ${ago}` : 'Requested'}
                        lastRow={i === outgoing.length - 1}
                        onOpen={() => openProfile(r)}
                        trailing={
                          <Button
                            size="sm"
                            variant="outline"
                            title="Cancel"
                            loading={busyId === r.user_id}
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => withdrawFriendRequest(r.user_id),
                                () => 'Request cancelled.', "Couldn't cancel just now.");
                            }}
                          />
                        }
                      />
                    );
                  })}
                </Panel>
              </View>
            )}
          </>
        )}
      </QueryState>
    );
  }

  function friendsTab() {
    return (
      <QueryState
        query={friendsQ}
        renderSkeleton={() => <SkeletonList rows={5} variant="row" />}
        renderEmpty={() => (
          <EmptyState
            icon="🤝"
            title="No friends yet"
            subtitle="Add the people you play with to see each other at the courts."
            actionLabel="Find friends"
            onAction={() => setTab('find')}
          />
        )}
      >
        {() => (
          <View style={S.block}>
            <Text style={[t.hint, S.explainer]}>⭐ {CLOSE_FRIEND_EXPLAINER}</Text>
            <Panel padded={false}>
              {friends.map((f, i) => {
                const name = f.full_name ?? 'Player';
                return (
                  <PersonRow
                    key={f.user_id}
                    c={c}
                    person={f}
                    subtitle={friendsSinceLabel(f.since, Date.now())}
                    lastRow={i === friends.length - 1}
                    onOpen={() => openProfile(f)}
                    trailing={
                      <>
                        <TouchableOpacity
                          style={S.iconBox}
                          onPress={() => { void toggleClose(f); }}
                          disabled={!!busyId}
                          accessibilityRole="switch"
                          accessibilityState={{ checked: f.is_close_friend, disabled: !!busyId }}
                          accessibilityLabel={`Close friend: ${name}`}
                        >
                          <Text style={[S.star, { color: f.is_close_friend ? c.warning : c.textMuted }]}>
                            {f.is_close_friend ? '★' : '☆'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={S.iconBox}
                          onPress={() => setMenuFor(f)}
                          accessibilityRole="button"
                          accessibilityLabel={`More options for ${name}`}
                        >
                          <Text style={[S.more, { color: c.textSub }]}>⋯</Text>
                        </TouchableOpacity>
                      </>
                    }
                  />
                );
              })}
            </Panel>
          </View>
        )}
      </QueryState>
    );
  }

  function findTab() {
    return (
      <>
        <TouchableOpacity
          style={[S.search, { borderColor: c.border, backgroundColor: c.surface }]}
          onPress={() => setPickerOpen(true)}
          activeOpacity={0.7}
          accessibilityRole="search"
          accessibilityLabel="Search players by name to add a friend"
        >
          <Text style={S.searchGlyph}>🔍</Text>
          <Text style={[t.sub, S.flex]} numberOfLines={1}>Search players by name or @username</Text>
        </TouchableOpacity>

        <View style={S.block}>
          <SectionHeader title="People you've played with" />
          <QueryState
            query={suggestQ}
            isEmpty={() => suggestions.length === 0}
            renderSkeleton={() => <SkeletonList rows={3} variant="row" />}
            renderEmpty={() => (
              <Panel>
                <EmptyState
                  compact
                  icon="🏓"
                  title="No one yet"
                  subtitle="Play a match, drill or join a league, and they show up here."
                />
              </Panel>
            )}
          >
            {() => (
              <Panel padded={false}>
                {suggestions.map((s, i) => (
                  <PersonRow
                    key={s.user_id}
                    c={c}
                    person={s}
                    subtitle={s.reason}
                    lastRow={i === suggestions.length - 1}
                    onOpen={() => openProfile(s)}
                    trailing={
                      <Button
                        size="sm"
                        title="➕ Add"
                        loading={busyId === s.user_id}
                        disabled={!!busyId}
                        onPress={() => { void add(s); }}
                      />
                    }
                  />
                ))}
              </Panel>
            )}
          </QueryState>
        </View>

        <View style={S.block}>
          <SectionHeader title="Invite to Pickleague" />
          <Panel>
            <Text style={t.sub}>
              Not on Pickleague yet? Send them a link to your profile. Once they join, Add friend is one tap.
            </Text>
            <Button
              size="sm"
              title={sharing ? 'Opening…' : '↗ Share invite link'}
              onPress={() => { void invite(); }}
              disabled={sharing}
              style={S.inviteBtn}
            />
          </Panel>
        </View>
      </>
    );
  }

  return (
    <View style={[S.screen, { backgroundColor: c.bg }]}>
      <SegmentedToggle<Tab>
        variant="underline"
        options={[
          { value: 'requests', label: 'Requests', count: incoming.length },
          { value: 'friends', label: 'Friends', count: friendsQ.data?.length },
          { value: 'find', label: 'Find' },
        ]}
        value={tab}
        onChange={setTab}
        style={S.tabs}
      />
      <ScrollView contentContainerStyle={S.content} refreshControl={<AppRefreshControl {...refresh} />}>
        {tab === 'requests' ? requestsTab() : tab === 'friends' ? friendsTab() : findTab()}
      </ScrollView>

      <UserPickerModal
        visible={pickerOpen}
        title="Send a friend request"
        excludeUserIds={exclude}
        realPeopleOnly
        onPick={onPick}
        onClose={() => setPickerOpen(false)}
      />
      <ActionSheetModal
        visible={menuFor != null}
        title={menuFor?.full_name ?? 'Friend'}
        subtitle={CLOSE_FRIEND_EXPLAINER}
        actions={menuFor ? [
          menuFor.is_close_friend
            ? { label: 'Remove from close friends', onPress: () => { void toggleClose(menuFor); } }
            : { label: '⭐ Make close friend', onPress: () => { void toggleClose(menuFor); } },
          { label: 'View profile', onPress: () => openProfile(menuFor) },
          { label: 'Remove friend', style: 'destructive', onPress: () => setQueuedRemove(menuFor) },
        ] : []}
        onClose={() => setMenuFor(null)}
        onDismissed={() => {
          if (!queuedRemove) return;
          setRemoveFor(queuedRemove);
          setQueuedRemove(null);
        }}
      />
      <ConfirmModal
        visible={removeFor != null}
        title={`Remove ${firstNameOf(removeFor?.full_name) ?? 'them'} as a friend?`}
        body={`${firstNameOf(removeFor?.full_name) ?? 'They'} won't be told. You can send a new request any time.`}
        primaryLabel="Remove"
        variant="danger"
        busy={busyId != null && busyId === removeFor?.user_id}
        onConfirm={() => { if (removeFor) void remove(removeFor); }}
        onClose={() => { if (!busyId) setRemoveFor(null); }}
      />
    </View>
  );
}

const S = StyleSheet.create({
  screen: { flex: 1 },
  tabs: { paddingHorizontal: SPACE.lg },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xl, flexGrow: 1 },
  block: { marginBottom: SPACE.md },
  flex: { flex: 1, minWidth: 0 },
  explainer: { marginBottom: SPACE.sm },

  // A person row inside a grouped Panel (ListCard 'row' metrics: padding
  // 10/12, 56 tall with a subtitle, hairline divider).
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 56, paddingVertical: 10, paddingHorizontal: 12 },
  who: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 44 },
  whoText: { flex: 1, minWidth: 0 },
  emoji: { fontSize: FONT.size.lg },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  iconBox: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  star: { fontSize: FONT.size.xl },
  more: { fontSize: FONT.size.xl, fontWeight: '700' },

  search: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 48,
    paddingHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: HAIRLINE, marginBottom: SPACE.md,
  },
  searchGlyph: { fontSize: FONT.size.base },
  inviteBtn: { alignSelf: 'flex-start', marginTop: SPACE.sm },
});
