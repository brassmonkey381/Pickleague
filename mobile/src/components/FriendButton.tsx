// Add friend / Requested / Accept + Decline / Friends on another player's
// profile (PlayerProfileScreen, beside Share · Save).
//
//   none              [+ Add friend]
//   pending_outgoing  [Requested]           tap -> "Cancel your request?"
//   pending_incoming  [Accept] [Decline]
//   friends           [check Friends]       tap -> star close friend / Remove friend
//   self, unavailable (guest, unclaimed placeholder, deleted, blocked): nothing
//
// The state is friendship_status_with's, cached per player (lib/useFriends),
// so a request answered on the Friends screen shows here too. Nothing renders
// until it is known, and nothing at all while FRIENDS_AT_COURTS_ENABLED is
// off. Blocking from the More menu beside it hides it at once (the server drops the
// friendship on block).
import React, { useState } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import ActionSheetModal, { type ActionSheetAction } from './ActionSheetModal';
import ConfirmModal from './ConfirmModal';
import { useToast } from '../lib/useToast';
import { useBlockedIds } from '../lib/moderation';
import { FRIENDS_AT_COURTS_ENABLED } from '../lib/features';
import {
  addFriend,
  answerFriendRequest,
  markCloseFriend,
  unfriend,
  useFriendStatus,
  withdrawFriendRequestAndCheck,
} from '../lib/useFriends';
import {
  cancelResultMessage,
  friendButtonState,
  firstNameOf,
  respondResultMessage,
  sendResultMessage,
} from '../lib/friendship';
import { explainRefusal } from '../lib/refusalNotices';

/** The fields of the profile row the screen already loaded. */
type ProfileLike = {
  full_name: string | null;
  avatar_url?: string | null;
  avatar_emoji?: string | null;
  avatar_bg_color?: string | null;
  doubles_rating?: number | null;
  is_unclaimed?: boolean | null;
  is_guest?: boolean | null;
  deleted_at?: string | null;
};

type Props = {
  userId: string;
  /** The signed-in user (null while unknown): hides the button on yourself. */
  meId: string | null;
  profile: ProfileLike;
  style?: StyleProp<ViewStyle>;
};

/**
 * One-line explainer for the ⭐. Phase 1: ordering only (the star is private;
 * close_friends is owner-only). When the Phase 2 close-friend push ships,
 * change it in the same commit, to match the push's direction.
 */
export const CLOSE_FRIEND_EXPLAINER = 'Close friends are listed first, here and at the courts. Only you see your stars.';

export default function FriendButton({ userId, meId, profile, style }: Props) {
  const toast = useToast();
  const blocked = useBlockedIds().has(userId);
  const enabled = FRIENDS_AT_COURTS_ENABLED && !!meId && meId !== userId && !blocked;
  const query = useFriendStatus(userId, enabled);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'cancel' | 'remove'>(null);
  // The menu's Remove, held until the sheet has fully closed (iOS won't
  // present the confirm while the sheet is still animating out).
  const [queuedRemove, setQueuedRemove] = useState(false);

  const state = enabled ? friendButtonState(query.data?.status, profile) : 'hidden';
  if (state === 'hidden') return null;

  const name = profile.full_name ?? 'this player';
  const first = firstNameOf(profile.full_name) ?? 'them';
  const closeFriend = query.data?.is_close_friend === true;

  async function run<T>(write: () => Promise<T>, done: (res: T) => string | null, failMsg: string) {
    if (busy) return;
    setBusy(true);
    try {
      const msg = done(await write());
      if (msg) toast.success(msg);
    } catch (e) {
      // Why, then what to do (lib/refusals): not joined yet, a guest pass,
      // 20 a day, no longer friends. A block stays vague.
      toast.error(explainRefusal(e, failMsg, { personName: firstNameOf(profile.full_name), action: 'friend' }));
    } finally {
      setBusy(false);
    }
  }

  const add = () => run(
    () => addFriend({
      user_id: userId,
      full_name: profile.full_name,
      avatar_url: profile.avatar_url ?? null,
      avatar_emoji: profile.avatar_emoji ?? null,
      avatar_bg_color: profile.avatar_bg_color ?? null,
      doubles_rating: profile.doubles_rating ?? null,
    }),
    (res) => sendResultMessage(res, profile.full_name),
    "Couldn't send the request.",
  );
  const respond = (accept: boolean) => run(
    () => answerFriendRequest(userId, accept),
    (res) => respondResultMessage(res, profile.full_name),
    "Couldn't answer the request.",
  );
  const cancel = () => run(
    () => withdrawFriendRequestAndCheck(userId),
    (res) => { setConfirm(null); return cancelResultMessage(res.cancelled, res.statusNow, profile.full_name); },
    "Couldn't cancel the request. Try again.",
  );
  const remove = () => run(
    () => unfriend(userId),
    () => { setConfirm(null); return `${first} is no longer a friend.`; },
    "Couldn't remove them just now.",
  );
  const toggleClose = () => run(
    () => markCloseFriend(userId, !closeFriend),
    () => (closeFriend ? `${first} is no longer a close friend.` : `${first} is a close friend.`),
    "Couldn't change that just now.",
  );

  const menu: ActionSheetAction[] = [
    closeFriend
      ? { label: 'Remove from close friends', iconName: 'star-outline', onPress: () => { void toggleClose(); } }
      : { label: 'Make close friend', iconName: 'star', onPress: () => { void toggleClose(); } },
    { label: 'Remove friend', style: 'destructive', onPress: () => setQueuedRemove(true) },
  ];

  return (
    <View style={[S.row, style]}>
      {state === 'add' && (
        <Button size="sm" title="Add friend" iconName="plus" onPress={() => { void add(); }} loading={busy} style={S.btn} />
      )}
      {state === 'requested' && (
        <Button size="sm" variant="outline" title="Requested" onPress={() => setConfirm('cancel')} disabled={busy} style={S.btn} />
      )}
      {state === 'respond' && (
        <>
          <Button size="sm" variant="success" title="Accept friend" onPress={() => { void respond(true); }} loading={busy} style={S.btn} />
          <Button size="sm" variant="outline" title="Decline" onPress={() => { void respond(false); }} disabled={busy} style={S.btn} />
        </>
      )}
      {state === 'friends' && (
        <Button
          size="sm"
          variant="outline"
          title="Friends"
          // A close friend shows the star (as on the court lists); a friend the check.
          iconName={closeFriend ? 'star' : 'check-mark'}
          accessibilityLabel={closeFriend ? 'Friends, close friend. Options' : 'Friends. Options'}
          onPress={() => setMenuOpen(true)}
          loading={busy}
          style={S.btn}
        />
      )}

      <ActionSheetModal
        visible={menuOpen}
        title={name}
        subtitle={CLOSE_FRIEND_EXPLAINER}
        actions={menu}
        onClose={() => setMenuOpen(false)}
        onDismissed={() => {
          if (!queuedRemove) return;
          setQueuedRemove(false);
          setConfirm('remove');
        }}
      />
      <ConfirmModal
        visible={confirm === 'cancel'}
        title="Cancel your friend request?"
        body={`${first} won't see it any more.`}
        primaryLabel="Cancel request"
        cancelLabel="Keep it"
        busy={busy}
        onConfirm={() => { void cancel(); }}
        onClose={() => { if (!busy) setConfirm(null); }}
      />
      <ConfirmModal
        visible={confirm === 'remove'}
        title={`Remove ${first} as a friend?`}
        body={`${first} won't be told. You can send a new request any time.`}
        primaryLabel="Remove"
        variant="danger"
        busy={busy}
        onConfirm={() => { void remove(); }}
        onClose={() => { if (!busy) setConfirm(null); }}
      />
    </View>
  );
}

const S = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  btn: { alignSelf: 'flex-start' },
});
