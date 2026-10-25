// "On my way to Lakeside": tell friends you're heading to a court, about N
// minutes out (supabase/migration_on_my_way.sql; Doggle's OnMyWayFriendsModal
// with an ETA). Opened from the feed's court card (its "On my way ▾", the
// Check in ▾ sheet, a line's sheet) and from the court page's Check in ▾
// (components/feed/useCheckinOptions).
//
//   On my way to Lakeside                                       ✕
//   About how long?
//   [5 min] [10 min] [15 min] [20 min] [30 min] [45 min] [1 hr]
//   Tell                                              All · None
//   ☑ Ann        Here now
//   ☑ Ben        Close friend
//   ☑ Cal
//   [ Tell 3 friends · about 15 min ]
//
// One tap on the button sends: the ETA starts at the last one this device
// used (15 the first time; the button waits the moment it takes to read it,
// so a quick tap never sends 15 over the remembered choice) and every friend
// starts ticked, friends at the court and close friends listed first
// (lib/onMyWay defaultRecipients). The server keeps it from being spam
// (one send per court, and one push per friend, per 30 minutes) and every
// "not sent" answer is a toast that says why and what to do.
//
// `here` ("Check in and tell friends", opened once the check-in landed):
// "Tell friends you're at Lakeside", no ETA, the button "Tell 3 friends
// you're here"; the push reads "<Name> is at <Court>" (send_on_my_way
// p_here, migration_court_oneoff_plans.sql: only while checked in there, its
// own 30-minute windows, at most 3 other courts per 30 minutes, only to
// friends who can see my check-ins now: not one I hid them from, nobody
// while I'm paused). Every friend starts ticked here too: Pickleague's On my
// way default (all friends), not Doggle's friends-at-the-park.
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { hapticSuccess } from '@just-messin-around/expo-foundation/platform';
import { Avatar, BottomSheet, DurationChips, TextLink } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { track } from '../lib/analytics';
import { explainRefusal } from '../lib/refusalNotices';
import { FRIENDS_AT_COURTS_ENABLED } from '../lib/features';
import { useMyFriends } from '../lib/useFriends';
import {
  DEFAULT_ETA_MINUTES,
  ETA_OPTIONS,
  defaultRecipients,
  etaLabel,
  onMyWayMessage,
  sendBlockedReason,
  sendLabel,
  sortRecipients,
  type OnMyWayFriend,
} from '../lib/onMyWay';
import { loadLastEta, peekLastEta, saveLastEta, sendOnMyWay } from '../data/onMyWay';

export type OnMyWayTarget = {
  venueId: string;
  venueName: string;
  /** Friends the caller shows at that court, with their line ("Here now"):
   *  listed first and ticked. */
  atCourt?: ReadonlyMap<string, string>;
  /** Where it was opened, for analytics. */
  from: 'feed' | 'feed_sheet' | 'court';
  /** "Check in and tell friends": I'm at the court now (no ETA). */
  here?: boolean;
};

type Friend = OnMyWayFriend & { avatarUrl: string | null; avatarEmoji: string | null; avatarBgColor: string | null };

const AVATAR = 32;

export default function OnMyWaySheet({ target, onClose }: { target: OnMyWayTarget | null; onClose: () => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const friendsQ = useMyFriends(FRIENDS_AT_COURTS_ENABLED && target != null);
  const [eta, setEta] = React.useState<number | null>(null);
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  // The title keeps its court while the sheet slides away (target is null then).
  const shown = React.useRef(target);
  if (target) shown.current = target;
  const view = target ?? shown.current;
  // A send that finishes after this sheet was closed or re-opened elsewhere must not close the new one.
  const current = React.useRef(target);
  current.current = target;

  const friends: Friend[] = React.useMemo(
    () =>
      sortRecipients(
        (friendsQ.data ?? []).map((f) => ({
          userId: f.user_id,
          name: f.full_name?.trim() || 'Friend',
          isCloseFriend: f.is_close_friend,
          note: view?.atCourt?.get(f.user_id) ?? null,
          avatarUrl: f.avatar_url,
          avatarEmoji: f.avatar_emoji,
          avatarBgColor: f.avatar_bg_color,
        })),
      ),
    [friendsQ.data, view],
  );

  // Each opening: the remembered ETA, and the default ticks once friends load.
  const seeded = React.useRef<OnMyWayTarget | null>(null);
  React.useEffect(() => {
    if (!target) {
      seeded.current = null;
      return;
    }
    let on = true;
    setEta(peekLastEta());
    void loadLastEta().then((m) => on && setEta((prev) => prev ?? m));
    return () => {
      on = false;
    };
  }, [target]);
  React.useEffect(() => {
    if (!target || seeded.current === target || friendsQ.data === undefined) return;
    seeded.current = target;
    setPicked(new Set(defaultRecipients(friends)));
  }, [target, friends, friendsQ.data]);

  const count = friends.reduce((n, f) => n + (picked.has(f.userId) ? 1 : 0), 0);
  const blocked = sendBlockedReason(count);
  const minutes = eta ?? DEFAULT_ETA_MINUTES;
  const here = view?.here === true;
  // The remembered ETA is still being read (the first sheet this session).
  const etaPending = eta == null && !here;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function send() {
    const sentFor = target;
    if (!sentFor || busy || blocked || etaPending) return;
    const ids = friends.filter((f) => picked.has(f.userId)).map((f) => f.userId);
    setBusy(true);
    try {
      const res = await sendOnMyWay(sentFor.venueId, minutes, ids, { here: sentFor.here === true });
      if (!sentFor.here) void saveLastEta(minutes);
      track('on_my_way.send', {
        from: sentFor.from,
        here: sentFor.here === true,
        eta: sentFor.here ? null : minutes,
        picked: ids.length,
        sent: res.sent,
        reason: res.reason ?? 'sent',
      });
      const msg = onMyWayMessage(res, { venueName: sentFor.venueName, nowMs: Date.now(), picked: true });
      if (res.sent) {
        hapticSuccess();
        toast.success(msg);
      } else {
        toast.info(msg);
      }
      // "Pick other friends": keep the sheet up so they can. Not checked in
      // there, or 3 other courts told in 30 minutes: nothing this sheet can change.
      if (res.sent || res.reason === 'recent' || res.reason === 'not_here' || res.reason === 'limit') {
        if (current.current === sentFor) onClose();
      }
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't tell your friends. Try again.", { action: 'on_my_way', venueName: sentFor.venueName }));
    } finally {
      setBusy(false);
    }
  }

  const loading = friendsQ.data === undefined && friendsQ.error == null;
  const failed = friendsQ.data === undefined && friendsQ.error != null;

  return (
    <BottomSheet
      visible={target != null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={view ? (here ? `Tell friends you're at ${view.venueName}` : `On my way to ${view.venueName}`) : 'On my way'}
      titleIconName={here ? 'megaphone' : 'arrow-right'}
    >
      <View style={S.body}>
        {here ? null : (
          <>
            <Text style={[t.label, { color: c.textSub }]}>About how long?</Text>
            <DurationChips
              value={minutes}
              onChange={setEta}
              options={ETA_OPTIONS}
              format={etaLabel}
              accessibilityLabelFor={(m) => `About ${etaLabel(m)} away`}
              disabled={busy}
            />
          </>
        )}

        <View style={S.tellRow}>
          <Text style={[t.label, S.flex, { color: c.textSub }]}>Tell</Text>
          {friends.length > 1 ? (
            <>
              <TextLink label="All" size="sub" onPress={() => setPicked(new Set(friends.map((f) => f.userId)))} />
              <TextLink label="None" size="sub" onPress={() => setPicked(new Set())} />
            </>
          ) : null}
        </View>
        {loading ? (
          <Text style={[t.sub, { color: c.textSub }]}>Loading your friends…</Text>
        ) : failed ? (
          <Text style={[t.sub, { color: c.textSub }]}>
            {explainRefusal(friendsQ.error, "Couldn't load your friends. Close this and try again.")}
          </Text>
        ) : friends.length === 0 ? (
          <Text style={[t.sub, { color: c.textSub }]}>
            No friends to tell yet. Add friends from a player's profile, then come back.
          </Text>
        ) : (
          <ScrollView style={S.list} contentContainerStyle={S.listContent} nestedScrollEnabled>
            {friends.map((f) => {
              const on = picked.has(f.userId);
              const note = f.note ?? (f.isCloseFriend ? 'Close friend' : null);
              return (
                <TouchableOpacity
                  key={f.userId}
                  style={S.row}
                  onPress={() => toggle(f.userId)}
                  disabled={busy}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: busy }}
                  accessibilityLabel={note ? `${f.name}, ${note}` : f.name}
                >
                  <Icon name={on ? 'check-mark' : 'circle'} size={20} color={on ? c.primary : c.textMuted} />
                  <Avatar
                    size={AVATAR}
                    photoUrl={f.avatarUrl}
                    name={f.name}
                    icon={f.avatarEmoji && !f.avatarUrl ? <Text style={S.emoji}>{f.avatarEmoji}</Text> : undefined}
                    backgroundColor={f.avatarBgColor ?? undefined}
                  />
                  <Text style={[t.title, S.flex]} numberOfLines={1}>
                    {f.name}
                  </Text>
                  {note ? (
                    <Text style={[t.meta, { color: f.note ? c.success : c.textSub }]} numberOfLines={1}>
                      {note}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {friends.length > 0 && blocked ? <Text style={[t.sub, { color: c.textSub }]}>{blocked}</Text> : null}
        <Button
          title={sendLabel(count, minutes, here)}
          iconName={here ? 'megaphone' : 'arrow-right'}
          variant="success"
          onPress={() => void send()}
          loading={busy}
          disabled={!!blocked || loading || etaPending}
        />
        <Text style={[t.hint, { color: c.textSub }]}>
          Each friend gets one notice, at most once every 30 minutes, and only if they allow it.
        </Text>
      </View>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  body: { gap: SPACE.sm, paddingBottom: SPACE.sm },
  flex: { flex: 1, minWidth: 0 },
  tellRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginTop: SPACE.xs },
  list: { maxHeight: 280 },
  listContent: { gap: SPACE.xxs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  // The friend's own avatar emoji (content, not chrome).
  emoji: { fontSize: 18 },
});
