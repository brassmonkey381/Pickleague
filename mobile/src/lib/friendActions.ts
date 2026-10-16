// Lock-screen Accept / Decline on "🤝 Sam wants to be friends" (catalog
// category friend_request; send-push attaches it only while the request is
// still pending). entity_id is the requester.
//
// Idempotent: respond_friend_request answers 'gone' when nothing is pending,
// so a replayed press (or one on a request already answered in the app) reads
// the status back and says "Already friends" or "Nothing to answer", never
// "That didn't save". Imported once by lib/push.ts so the handlers register
// at startup.
import { NeedsApp, registerActionHandler, requireUser, type ActionPushData } from './notificationActions';
import { pushSubject } from './pushSubject';
import { getFriendStatus, respondFriendRequest } from '../data/friends';
import { refreshFriends } from './useFriends';
import { friendActionNotice, friendActionOutcome, type FriendActionOutcome, type FriendshipStatus } from './friendship';

async function answer(d: ActionPushData, accept: boolean): Promise<FriendActionOutcome> {
  const requester = d.entity_id;
  if (!requester) throw new NeedsApp('Open Pickleague to answer this request.');
  await requireUser();
  const res = await respondFriendRequest(requester, accept);
  let now: FriendshipStatus | null = null;
  if (res === 'gone') {
    try {
      now = (await getFriendStatus(requester)).status;
    } catch {
      // Unknown: reads as "nothing to answer", which is still true.
    }
  }
  // An open Friends screen or profile shows the new state on its next render.
  refreshFriends();
  return friendActionOutcome(accept, res, now);
}

const friendsLink = (d: ActionPushData, res: unknown) =>
  d.entity_id && (res === 'accepted' || res === 'already_friends') ? `player/${d.entity_id}` : null;

registerActionHandler('friend_accept', {
  success: (res, d) => friendActionNotice(res as FriendActionOutcome, pushSubject(d.title)),
  // "You're friends: Sam" opens Sam's profile.
  link: friendsLink,
  run: (d) => answer(d, true),
});

registerActionHandler('friend_decline', {
  success: (res, d) => friendActionNotice(res as FriendActionOutcome, pushSubject(d.title)),
  link: friendsLink,
  run: (d) => answer(d, false),
});
