// Discover › Players (state/feed-discover-play-plan.md §4, decision 5): the
// people side of Discover, built from the Friends screen (which now renders
// this same panel when Discover is off). No new server work: the friends RPCs
// and the player search the Friends screen already used.
//
//   [🔍 Search players near Alameda, CA]            opens a player's profile
//   (Friends 5) (Requests 2) (Played with) (Nearby)  the view; Requests counts what waits on you
//   Friends     ⭐ Close friends are listed first...  (A) Sam · Friends since Oct 2   ⭐ ⋯
//   Requests    WAITING ON YOU (A) Sam · 2d ago   [Accept] [Decline]
//               SENT           (B) Ana · requested 3d ago   [Cancel]
//   Played with (C) Lee · 4 matches together   [➕ Add]
//   ─────────────
//   🏋 Drill partners ›                              the Drill screen
//   ▸ Invite & Earn                                  REFERRALS_ENABLED (not for guests)
//   SHARE YOUR PROFILE  [↗ Share my profile link]
//
// - Opening view: Discover's `players` param (a friend-request push says
//   'requests', the old Friends > Find says 'find'), consumed once; else
//   Requests when something waits on you (on a cold open, once the requests
//   load, unless the player picked a view first); else Friends.
// - Header "+" (only while this tab shows): Find a player · Invite a friend.
//   Invite shares the referral link when referrals are on (you both get
//   REFERRAL_REWARD_PICKLES), else the profile link.
// - Every write goes through lib/useFriends: the row moves at once, then the
//   lists refetch; a failure puts it back and says why.
// - The search is UserPickerModal with realPeopleOnly (no unclaimed DUPR
//   placeholders, guest passes or deleted accounts). Picking a player opens
//   their profile, where Add friend is one tap.
// - Discover's search area (the pills above the tabs) limits the search and
//   Nearby to the players who PLAY there (data/playersNear: their leagues'
//   home courts, and their starred and frequent courts when their presence
//   privacy names them to you; never where they are now). Friends, Requests
//   and Played with are yours and are not limited. Without an area yet the
//   search covers everyone, as before.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { cachedFetch, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import {
  ActionSheetModal,
  Avatar,
  EmptyState,
  Panel,
  QueryState,
  SectionHeader,
  SegmentedToggle,
  type ActionSheetAction,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../../lib/supabase';
import { inviteUrl } from '../../lib/qrWallet';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { shareInvite } from '../../lib/share';
import { useRefresh } from '../../lib/useRefresh';
import { track } from '../../lib/analytics';
import { REFERRALS_ENABLED } from '../../lib/features';
import { REFERRAL_REWARD_PICKLES } from '../../lib/referralRules';
import AppRefreshControl from '../AppRefreshControl';
import ConfirmModal from '../ConfirmModal';
import { SkeletonList } from '../Skeleton';
import UserPickerModal, { type PickedUser } from '../UserPickerModal';
import { CLOSE_FRIEND_EXPLAINER } from '../FriendButton';
import InviteEarnSection from '../referrals/InviteEarnSection';
import { usePlayHeaderPlus } from '../play/HeaderPlusButton';
import {
  addFriend,
  answerFriendRequest,
  markCloseFriend,
  unfriend,
  useFriendRequests,
  useFriendSuggestions,
  useMyFriends,
  withdrawFriendRequestAndCheck,
  type FriendPerson,
} from '../../lib/useFriends';
import { explainRefusal } from '../../lib/refusalNotices';
import {
  cancelResultMessage,
  firstNameOf,
  friendsSinceLabel,
  requestAgoLabel,
  respondResultMessage,
  sendResultMessage,
  sortFriends,
  splitRequests,
  visibleSuggestions,
  type FriendRow,
} from '../../lib/friendship';
import {
  REFERRAL_CODE_KEY,
  REFERRAL_CODE_PERSIST_MS,
  REFERRAL_CODE_TTL_MS,
  getMyReferralCode,
  referralShareContent,
} from '../../data/referrals';
import type { PlayersView } from '../../lib/discoverTabs';
import { useSearchArea } from '../../lib/useSearchArea';
import { searchAreaKey } from '../../lib/searchArea';
import { playsAtLabel, type NearPlayer } from '../../lib/playersNear';
import { listPlayersNear } from '../../data/playersNear';
import { useBlockedIds } from '../../lib/moderation';
import { useSearchAreaPlace } from '../SearchAreaBar';
import type { RootStackParamList } from '../../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  /** This tab is the one showing (Discover keeps it mounted after a visit). */
  active?: boolean;
  /** The view to open (Discover's `players` param); `onViewConsumed` clears it. */
  view?: PlayersView;
  onViewConsumed?: () => void;
};

type Colors = ReturnType<typeof useTheme>['colors'];

const AVATAR = 40;

const VIEW_LABELS: Record<PlayersView, string> = { friends: 'Friends', requests: 'Requests', find: 'Played with', near: 'Nearby' };

/** A people-list row for the picker (discover_players_near's columns). */
function toPicked(p: NearPlayer): PickedUser {
  return {
    id: p.id,
    full_name: p.full_name ?? 'Player',
    username: p.username ?? '',
    avatar_id: p.avatar_id,
    avatar_emoji: p.avatar_emoji,
    avatar_bg_color: p.avatar_bg_color,
    detail: playsAtLabel(p),
  };
}

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

/** Referrals pay only on a saved account: a guest gets the profile link. */
function useCanRefer(): boolean {
  const [guest, setGuest] = useState<boolean | null>(null);
  useEffect(() => {
    if (!REFERRALS_ENABLED) return;
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => alive && setGuest(!data.session || !!data.session.user.is_anonymous))
      .catch(() => alive && setGuest(true));
    return () => { alive = false; };
  }, []);
  return REFERRALS_ENABLED && guest === false;
}

export default function PlayersPanel({ navigation, active = true, view: viewParam, onViewConsumed }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const focused = useIsFocused();
  const live = focused && active;
  const canRefer = useCanRefer();
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => { void currentUserId(supabase).then(setMeId); }, []);

  const requestsQ = useFriendRequests();
  const friendsQ = useMyFriends();
  const { incoming, outgoing } = useMemo(() => splitRequests(requestsQ.data), [requestsQ.data]);

  // The opening view: the param's, else Requests when anything waits on me
  // (from the cache, so a warm open lands right), else Friends.
  const [view, setView] = useState<PlayersView>(() => viewParam ?? (incoming.length > 0 ? 'requests' : 'friends'));
  // A cold open (nothing cached yet) chose Friends blind: when the requests
  // first arrive with something waiting, move to Requests, unless a view was
  // asked for or the player has picked one since.
  const viewSettledRef = useRef(viewParam != null || requestsQ.data !== undefined);
  useEffect(() => {
    if (viewSettledRef.current || requestsQ.data === undefined) return;
    viewSettledRef.current = true;
    if (incoming.length > 0) setView('requests');
  }, [requestsQ.data, incoming.length]);
  // A push opening an already-mounted panel updates the param.
  const consumeRef = useRef(onViewConsumed);
  consumeRef.current = onViewConsumed;
  useEffect(() => {
    if (!viewParam) return;
    viewSettledRef.current = true;
    setView(viewParam);
    consumeRef.current?.();
  }, [viewParam]);

  const suggestQ = useFriendSuggestions(view === 'find' && active);
  const suggestions = useMemo(
    () => visibleSuggestions(suggestQ.data, { meId, friends: friendsQ.data, requests: requestsQ.data }),
    [suggestQ.data, meId, friendsQ.data, requestsQ.data],
  );
  const friends = useMemo(() => sortFriends(friendsQ.data), [friendsQ.data]);

  // ── The search area: Nearby and the search ──
  const { area } = useSearchArea();
  const areaKey = searchAreaKey(area);
  const areaPlace = useSearchAreaPlace();
  const blockedIds = useBlockedIds();
  const nearQ = useCachedQuery<NearPlayer[]>(
    `players:near:${areaKey}`,
    () => listPlayersNear(area, { realPeopleOnly: true, limit: 200 }),
    { ttlMs: 60_000, persistMs: 6 * 60 * 60 * 1000, enabled: view === 'near' && active && area != null },
  );
  const nearby = useMemo(
    () => (nearQ.data ?? []).filter((p) => p.id !== meId && !blockedIds.has(p.id)),
    [nearQ.data, meId, blockedIds],
  );
  const friendIds = useMemo(() => new Set((friendsQ.data ?? []).map((f) => f.user_id)), [friendsQ.data]);
  const requestedIds = useMemo(
    () => new Set([...incoming, ...outgoing].map((r) => r.user_id)),
    [incoming, outgoing],
  );

  const { refresh: refreshRequests } = requestsQ;
  const { refresh: refreshFriendsList } = friendsQ;
  const { refresh: refreshSuggestions } = suggestQ;
  const { refresh: refreshNear } = nearQ;
  const reload = useCallback(async () => {
    await Promise.all([
      refreshRequests(),
      refreshFriendsList(),
      view === 'find' ? refreshSuggestions() : Promise.resolve(),
      view === 'near' && area ? refreshNear() : Promise.resolve(),
    ]);
  }, [refreshRequests, refreshFriendsList, refreshSuggestions, refreshNear, view, area]);
  const refresh = useRefresh(reload);
  // Requests arrive by push while this is in the background.
  useFocusEffect(useCallback(() => { void refreshRequests(); }, [refreshRequests]));

  // One write at a time per person (its row's buttons go busy).
  const [busyId, setBusyId] = useState<string | null>(null);
  async function run<T>(
    userId: string,
    write: () => Promise<T>,
    done: (res: T) => string | null,
    failMsg: string,
    name?: string | null,
  ) {
    if (busyId) return;
    setBusyId(userId);
    try {
      const msg = done(await write());
      if (msg) toast.success(msg);
    } catch (e) {
      // Why, then what to do (lib/refusals): not joined yet, a guest pass,
      // 20 a day, no longer friends. A block stays vague.
      toast.error(explainRefusal(e, failMsg, { personName: firstNameOf(name), action: 'friend' }));
    } finally {
      setBusyId(null);
    }
  }

  const add = (p: FriendPerson) =>
    run(
      p.user_id,
      () => addFriend(p),
      (res) => sendResultMessage(res, p.full_name),
      "Couldn't send the request. Try again.",
      p.full_name,
    );

  const openProfile = (userId: string, name: string | null | undefined) =>
    navigation.navigate('PlayerProfile', { userId, userName: name ?? 'Player' });

  // ── Search: a player's profile ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const notMe = useMemo(() => [...(meId ? [meId] : []), ...blockedIds], [meId, blockedIds]);
  // The search lists the players near the search area (everyone without one).
  const loadNear = useCallback(
    async () => (await listPlayersNear(area, { realPeopleOnly: true, limit: 500 })).map(toPicked),
    [area],
  );
  function onPick(u: PickedUser) {
    setPickerOpen(false);
    track('discover.players_search_pick', {});
    openProfile(u.id, u.full_name);
  }

  // ── Invite ──
  const [sharing, setSharing] = useState(false);
  /** The referral link when it can pay (you both earn), else my profile link. */
  async function invite(kind: 'best' | 'profile') {
    if (sharing) return;
    setSharing(true);
    try {
      if (kind === 'best' && canRefer) {
        const code = await cachedFetch(REFERRAL_CODE_KEY, getMyReferralCode, {
          ttlMs: REFERRAL_CODE_TTL_MS,
          persistMs: REFERRAL_CODE_PERSIST_MS,
        }).catch(() => '');
        if (code) {
          const res = await shareInvite(referralShareContent(code));
          if (res.copied) toast.success('Invite copied. Paste it to a friend.');
          track('discover.players_invite', { link: 'referral' });
          return;
        }
      }
      const res = await shareInvite({
        title: 'Join me on Pickleague',
        message: "I'm on Pickleague. Add me as a friend so we can see when we're at the courts:",
        url: inviteUrl(meId),
      });
      if (res.copied) toast.success('Invite link copied. Paste it into a text.');
      track('discover.players_invite', { link: 'profile' });
    } catch {
      // Share sheet dismissed: nothing to do.
    } finally {
      setSharing(false);
    }
  }

  // ── Header "+": Find a player · Invite a friend ──
  const [plusOpen, setPlusOpen] = useState(false);
  // The sheet's choice, run once it has fully closed (iOS won't present the
  // picker or the share sheet while the action sheet is still animating out).
  const queuedRef = useRef<null | (() => void)>(null);
  usePlayHeaderPlus(navigation, live, 'Find or invite a player', () => setPlusOpen(true));
  const plusActions: ActionSheetAction[] = [
    { label: '🔍 Find a player', onPress: () => { queuedRef.current = () => setPickerOpen(true); } },
    {
      // The Invite & Earn panel's wording, with the amount.
      label: canRefer ? `↗ Invite a friend (you both get ${REFERRAL_REWARD_PICKLES} 🥒)` : '↗ Invite a friend',
      onPress: () => { queuedRef.current = () => { void invite('best'); }; },
    },
  ];

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
      "Couldn't change that just now. Try again.",
      f.full_name,
    );
  };
  const remove = (f: FriendRow) =>
    run(
      f.user_id,
      () => unfriend(f.user_id),
      () => { setRemoveFor(null); return `${firstNameOf(f.full_name) ?? 'They'} is no longer a friend.`; },
      "Couldn't remove them just now.",
      f.full_name,
    );

  const changeView = (next: PlayersView) => {
    viewSettledRef.current = true;
    if (next === view) return;
    setView(next);
    track('discover.players_view', { view: next });
  };

  // ── Views ──
  function requestsView() {
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
            actionLabel="People you've played with"
            onAction={() => changeView('find')}
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
                      onOpen={() => openProfile(r.user_id, r.full_name)}
                      trailing={
                        <>
                          <Button
                            size="sm"
                            variant="success"
                            title="Accept"
                            accessibilityLabel={`Accept ${r.full_name ?? 'this player'}'s friend request`}
                            loading={busyId === r.user_id}
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => answerFriendRequest(r.user_id, true),
                                (res) => respondResultMessage(res, r.full_name), "Couldn't accept just now.", r.full_name);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            title="Decline"
                            accessibilityLabel={`Decline ${r.full_name ?? 'this player'}'s friend request`}
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => answerFriendRequest(r.user_id, false),
                                (res) => respondResultMessage(res, r.full_name), "Couldn't decline just now.", r.full_name);
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
                        onOpen={() => openProfile(r.user_id, r.full_name)}
                        trailing={
                          <Button
                            size="sm"
                            variant="outline"
                            title="Cancel"
                            accessibilityLabel={`Cancel your friend request to ${r.full_name ?? 'this player'}`}
                            loading={busyId === r.user_id}
                            disabled={!!busyId}
                            onPress={() => {
                              void run(r.user_id, () => withdrawFriendRequestAndCheck(r.user_id),
                                (res) => cancelResultMessage(res.cancelled, res.statusNow, r.full_name),
                                "Couldn't cancel just now. Try again.", r.full_name);
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

  function friendsView() {
    return (
      <QueryState
        query={friendsQ}
        renderSkeleton={() => <SkeletonList rows={5} variant="row" />}
        renderEmpty={() => (
          <EmptyState
            icon="🤝"
            title="No friends yet"
            subtitle="Add the people you play with to see each other at the courts."
            actionLabel="People you've played with"
            onAction={() => changeView('find')}
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
                    onOpen={() => openProfile(f.user_id, f.full_name)}
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

  function nearView() {
    if (!area) {
      return (
        <Panel>
          <EmptyState
            compact
            icon="📍"
            title="Choose an area"
            subtitle="Pick your location or a city above to see the players who play there."
          />
        </Panel>
      );
    }
    return (
      <View style={S.block}>
        <SectionHeader title={`Players near ${areaPlace ?? 'here'}`} />
        <QueryState
          query={nearQ}
          isEmpty={() => nearby.length === 0}
          renderSkeleton={() => <SkeletonList rows={4} variant="row" />}
          renderEmpty={() => (
            <Panel>
              <EmptyState
                compact
                icon="🏓"
                title={`No one plays within ${area.radiusMi} mi yet`}
                subtitle="Players show up here by their leagues' courts and the courts they star. Try a wider radius above."
              />
            </Panel>
          )}
        >
          {() => (
            <Panel padded={false}>
              {nearby.map((p, i) => {
                const person: FriendPerson = {
                  user_id: p.id,
                  full_name: p.full_name,
                  avatar_url: p.avatar_url,
                  avatar_emoji: p.avatar_emoji,
                  avatar_bg_color: p.avatar_bg_color,
                  doubles_rating: p.doubles_rating,
                };
                const known = friendIds.has(p.id) || requestedIds.has(p.id);
                return (
                  <PersonRow
                    key={p.id}
                    c={c}
                    person={person}
                    subtitle={friendIds.has(p.id) ? `Friend · ${playsAtLabel(p) ?? ''}`.replace(/ · $/, '') : playsAtLabel(p)}
                    lastRow={i === nearby.length - 1}
                    onOpen={() => openProfile(p.id, p.full_name)}
                    trailing={known ? undefined : (
                      <Button
                        size="sm"
                        title="➕ Add"
                        accessibilityLabel={`Add ${p.full_name ?? 'this player'} as a friend`}
                        loading={busyId === p.id}
                        disabled={!!busyId}
                        onPress={() => { void add(person); }}
                      />
                    )}
                  />
                );
              })}
            </Panel>
          )}
        </QueryState>
      </View>
    );
  }

  function playedWithView() {
    return (
      <View style={S.block}>
        <SectionHeader title="People you've played with" />
        <QueryState
          query={suggestQ}
          isEmpty={() => suggestions.length === 0}
          renderSkeleton={() => <SkeletonList rows={3} variant="row" />}
          renderEmpty={() => (
            <Panel>
              {/* Not a dead end (Friends' empty state points here): search. */}
              <EmptyState
                compact
                icon="🏓"
                title="No one yet"
                subtitle="Play a match, drill or join a league, and they show up here."
                actionLabel="Search players"
                onAction={() => setPickerOpen(true)}
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
                  onOpen={() => openProfile(s.user_id, s.full_name)}
                  trailing={
                    <Button
                      size="sm"
                      title="➕ Add"
                      // Not "heavy plus sign Add": who, and what.
                      accessibilityLabel={`Add ${s.full_name ?? 'this player'} as a friend`}
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
    );
  }

  return (
    <View style={S.screen}>
      <ScrollView contentContainerStyle={S.content} refreshControl={<AppRefreshControl {...refresh} />}>
        <TouchableOpacity
          style={[S.search, { borderColor: c.border, backgroundColor: c.surface }]}
          onPress={() => setPickerOpen(true)}
          activeOpacity={0.7}
          // A button that opens the search (role "search" made it a landmark
          // on web and a "search field" to VoiceOver).
          accessibilityRole="button"
          accessibilityLabel={area ? `Search players near ${areaPlace ?? 'your area'}` : 'Search players by name'}
          accessibilityHint="Opens player search"
        >
          <Text style={S.searchGlyph}>🔍</Text>
          <Text style={[t.sub, S.flex]} numberOfLines={1}>
            {area ? `Search players near ${areaPlace ?? 'your area'}` : 'Search players by name or @username'}
          </Text>
        </TouchableOpacity>

        <SegmentedToggle<PlayersView>
          size="sm"
          options={(['friends', 'requests', 'find', 'near'] as const).map((k) => ({
            value: k,
            label: VIEW_LABELS[k],
            count: k === 'requests' ? incoming.length : k === 'friends' ? friendsQ.data?.length : undefined,
          }))}
          value={view}
          onChange={changeView}
          style={S.views}
        />

        {view === 'requests' ? requestsView() : view === 'friends' ? friendsView() : view === 'near' ? nearView() : playedWithView()}

        <View style={[S.divider, { backgroundColor: c.border }]} />

        <TouchableOpacity
          style={[S.linkRow, { borderColor: c.border, backgroundColor: c.surface }]}
          onPress={() => navigation.navigate('Drill')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Drill partners. Find someone to drill with"
        >
          <Text style={S.linkGlyph}>🏋️</Text>
          <View style={S.flex}>
            <Text style={[S.linkLabel, { color: c.text }]} numberOfLines={1}>Drill partners</Text>
            <Text style={t.sub} numberOfLines={1}>Find someone to drill with</Text>
          </View>
          <Text style={[S.chevron, { color: c.textMuted }]}>›</Text>
        </TouchableOpacity>

        {/* Renders nothing while REFERRALS_ENABLED is off, and for guests. */}
        <View style={S.block}>
          <InviteEarnSection />
        </View>

        <View style={S.block}>
          <SectionHeader title="Share your profile" />
          <Panel>
            <Text style={t.sub}>
              Send a friend a link to your profile. On Pickleague already? Add friend is one tap. Not yet? They can join from there.
            </Text>
            <Button
              size="sm"
              title={sharing ? 'Opening…' : '↗ Share my profile link'}
              onPress={() => { void invite('profile'); }}
              disabled={sharing}
              style={S.inviteBtn}
            />
          </Panel>
        </View>
      </ScrollView>

      <UserPickerModal
        visible={pickerOpen}
        title="Find a player"
        excludeUserIds={notMe}
        realPeopleOnly
        load={area ? loadNear : undefined}
        loadKey={areaKey}
        subtitle={area ? `Players near ${areaPlace ?? 'your area'} · ${area.radiusMi} mi` : null}
        onPick={onPick}
        onClose={() => setPickerOpen(false)}
      />
      <ActionSheetModal
        visible={plusOpen}
        title="Players"
        actions={plusActions}
        onClose={() => setPlusOpen(false)}
        onDismissed={() => {
          const next = queuedRef.current;
          queuedRef.current = null;
          next?.();
        }}
      />
      <ActionSheetModal
        visible={menuFor != null}
        title={menuFor?.full_name ?? 'Friend'}
        subtitle={CLOSE_FRIEND_EXPLAINER}
        actions={menuFor ? [
          menuFor.is_close_friend
            ? { label: 'Remove from close friends', onPress: () => { void toggleClose(menuFor); } }
            : { label: '⭐ Make close friend', onPress: () => { void toggleClose(menuFor); } },
          { label: 'View profile', onPress: () => openProfile(menuFor.user_id, menuFor.full_name) },
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

/** Friend requests waiting on me (Discover's Players badge). A cache read on
 *  every surface after the first (FriendsLink shares it). */
export function usePlayersBadge(enabled: boolean): number {
  const { data } = useFriendRequests(enabled);
  return useMemo(() => (enabled ? splitRequests(data).incoming.length : 0), [enabled, data]);
}

const S = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xl, flexGrow: 1 },
  block: { marginBottom: SPACE.md },
  flex: { flex: 1, minWidth: 0 },
  explainer: { marginBottom: SPACE.sm },
  views: { marginBottom: SPACE.md },
  divider: { height: HAIRLINE, marginBottom: SPACE.md },

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
    paddingHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: HAIRLINE, marginBottom: SPACE.sm,
  },
  searchGlyph: { fontSize: FONT.size.base },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 56,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderRadius: RADIUS.lg, borderWidth: HAIRLINE,
    marginBottom: SPACE.md,
  },
  linkGlyph: { fontSize: FONT.size.lg },
  linkLabel: { fontSize: FONT.size.base, fontWeight: '600' },
  chevron: { fontSize: FONT.size.h2, fontWeight: '700' },
  inviteBtn: { alignSelf: 'flex-start', marginTop: SPACE.sm },
});
