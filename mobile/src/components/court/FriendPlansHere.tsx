// Friends planning to play at this court, on its page (plan sharing;
// Doggle's place page lists who plans to come): the shared plans the server
// lets me see here, 7 days ahead, from list_friend_court_plans (each owner's
// plans level, pause, hide-froms and blocks already applied, so a closed-
// league mate the owner allows shows too). Renders nothing when there are none.
//
//   FRIENDS PLANNING TO PLAY HERE
//   (Sky)  Sky                                   [Routine]
//          planned tomorrow 6 PM
//
// A row opens the player's profile.
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { useTicker } from '@just-messin-around/expo-foundation/hooks';
import { friendPlanLabel } from '@just-messin-around/expo-foundation/plans/rules';
import { Avatar, PresenceCard } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { track } from '../../lib/analytics';
import { CHECKIN_PLANS_ENABLED, FRIENDS_AT_COURTS_ENABLED, PLAN_SHARING_ENABLED } from '../../lib/features';
import { STOP_GRACE_MS } from '../../lib/pickleagueFeed';
import {
  FRIEND_PLANS_PERSIST_MS,
  FRIEND_PLANS_TTL_MS,
  fetchFriendCourtPlans,
  friendPlansAtKey,
} from '../../data/planSharing';
import type { RootStackParamList } from '../../types';

const ENABLED = PLAN_SHARING_ENABLED && CHECKIN_PLANS_ENABLED && FRIENDS_AT_COURTS_ENABLED;
const AVATAR = 32;

export default function FriendPlansHere({ venueId }: { venueId: string }) {
  return ENABLED ? <List venueId={venueId} /> : null;
}

function List({ venueId }: { venueId: string }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const now = Math.max(useTicker(60_000), Date.now());
  const q = useCachedQuery(friendPlansAtKey(venueId), () => fetchFriendCourtPlans(venueId), {
    ttlMs: FRIEND_PLANS_TTL_MS,
    persistMs: FRIEND_PLANS_PERSIST_MS,
  });
  // A cached copy can outlive a plan's window: drop the ones over.
  const plans = (q.data ?? []).filter((p) => Date.parse(p.at) > now - STOP_GRACE_MS);
  if (plans.length === 0) return null;
  return (
    <PresenceCard
      title="Friends planning to play here"
      compact
      style={S.card}
      rows={plans.map((p) => {
        const label = friendPlanLabel(p, now);
        return {
          key: p.planId,
          avatar: (
            <Avatar
              size={AVATAR}
              photoUrl={p.avatarUrl}
              name={p.ownerName}
              icon={p.avatarEmoji && !p.avatarUrl ? <Text style={S.emoji}>{p.avatarEmoji}</Text> : undefined}
              backgroundColor={p.avatarBgColor ?? undefined}
            />
          ),
          label: p.ownerName,
          sublabel: label.text,
          badge: p.kind === 'routine' ? { label: 'Routine', tone: 'info' as const } : null,
          onPress: () => {
            track('courts.friend_plan', { kind: p.kind });
            navigation.navigate('PlayerProfile', { userId: p.ownerId, userName: p.ownerName });
          },
        };
      })}
    />
  );
}

const S = StyleSheet.create({
  card: { marginTop: SPACE.sm },
  // The player's own avatar emoji (content, not chrome).
  emoji: { fontSize: 18 },
});
