// An event's or tournament's group session (lib/groupSession): who is playing
// in it now and who played today, "Join the group session" on its day, and
// once I'm in, "You're in · 0:42" with End (the island's own End: the end
// sheet asks for the match that makes it count). Sits above the album.
//
// Hidden from anyone not in the event or tournament (list_group_session says
// can_view false), and while the group SQL isn't live yet (the read fails).
// Join opens the normal Play sheet with this event or tournament, so the court
// check-in works as for any session; "Let everyone know" (off by default)
// tells the people going once the Start lands.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Avatar, Panel, PresenceCard, SettingSwitchRow } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { peekQuery, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { useElapsed, usePollWhileActive, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import { SMALL_TEXT_MAX_SCALE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { listGroupSession } from '../data/playSessions';
import { checkOutAndEnd } from '../lib/checkinPlay';
import { explainRefusal } from '../lib/refusalNotices';
import { STILL_WORKING } from '../lib/refusals';
import { playSession, playStartLanded } from '../lib/playSession';
import { clockLabel } from '../lib/courtRoutineRules';
import { inThisGroup, joinGroupSession } from '../lib/groupSession';
import {
  GROUP_CACHE_TTL_MS,
  groupJoinOpen,
  groupSessionKey,
  meFirst,
  playerStatus,
  playingLine,
  playingNow,
  type GroupKind,
  type GroupPlayer,
} from '../lib/groupSessionRules';
import { groupCardModel } from '../lib/shareCards';
import { initialsOf, shortName } from '../lib/finishShare';
import { albumKey } from '../lib/albumRules';
import type { Album } from '../data/albums';
import PickleShareStudio from './share/PickleShareStudio';

type Props = {
  kind: GroupKind;
  id: string;
  /** The event's or tournament's name. */
  title: string;
  /** When it starts and ends (ISO); Join shows on its day (lib/groupSessionRules groupJoinOpen). */
  startsAt: string | null;
  endsAt: string | null;
  /** Under way whatever the clock says (a tournament in progress with no start time). */
  live?: boolean;
  /** For the share card: the league's name, or "Tournament". */
  over: string | null;
  court: string | null;
};

const ROWS = 8;
const POLL_MS = 60_000;

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
}

function PlayerAvatar({ p }: { p: GroupPlayer }) {
  return (
    <Avatar
      size={32}
      photoUrl={p.avatarUrl}
      name={p.name}
      icon={p.avatarEmoji ? <Text style={styles.emoji}>{p.avatarEmoji}</Text> : undefined}
      backgroundColor={p.avatarBg ?? undefined}
    />
  );
}

export default function GroupSessionSection({ kind, id, title, startsAt, endsAt, live, over, court }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const focused = useIsFocused();
  const session = playSession.useLiveSession();
  const mine = inThisGroup(kind, id);
  const elapsed = useElapsed(mine ? session.startedAtMs : null);
  const [notify, setNotify] = React.useState(false);
  const [ending, setEnding] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const query = useCachedQuery(groupSessionKey(kind, id), () => listGroupSession(kind, id), { ttlMs: GROUP_CACHE_TTL_MS });
  const refresh = query.refresh;
  usePollWhileActive(() => refresh(), POLL_MS, focused ? `${kind}:${id}` : null);
  // My Start landed: show me in the list now, not at the next poll.
  useSignal(playStartLanded, () => {
    if (inThisGroup(kind, id)) void refresh();
  });
  // Joined or ended here: read again (the server may still be catching up).
  React.useEffect(() => {
    void refresh();
  }, [mine, refresh]);

  const group = query.data;
  if (!group || !group.canView) return null;

  const players = meFirst(group.players);
  const now = playingNow(group.players);
  const open = groupJoinOpen({ startsAt, endsAt, nowMs: Date.now(), live });
  // Nothing to show: not its day, nobody played, and I'm not in it.
  if (!open && players.length === 0 && !mine) return null;
  const canJoin = group.canJoin && open && !mine;

  async function end() {
    if (ending) return;
    setEnding(true);
    try {
      const { ended, checkedOut, venueName, error } = await checkOutAndEnd();
      if (error) {
        toast.error(explainRefusal(error, "Couldn't check you out. Try again.", { venueName }));
        return;
      }
      if (!ended) toast.success(checkedOut && venueName ? `Checked out of ${venueName}.` : 'Session ended.');
      void refresh();
    } catch {
      toast.error(STILL_WORKING);
    } finally {
      setEnding(false);
    }
  }

  // My own album photos start on the share card (others' only if I add them).
  const me = players.find((p) => p.isMe) ?? null;
  const albumPhotos = (peekQuery<Album>(albumKey(kind, id))?.photos ?? [])
    .filter((p) => me && p.uploaderId === me.userId)
    .slice(0, 4)
    .map((p) => p.url);
  const shareModel = groupCardModel({
    title,
    over,
    court,
    date: startsAt && new Date(startsAt).toDateString() !== new Date().toDateString()
      ? new Date(startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : 'Today',
    myMinutes: me ? Math.round(me.playedS / 60) : null,
    people: players.map((p) => ({ name: shortName(p.name), initials: initialsOf(p.name) })),
  });
  const canShare = isImageShareAvailable() && !!me && players.length > 0;

  return (
    <View style={styles.wrap}>
      <Panel>
        <View style={styles.head}>
          <Icon name="group" size={18} color={c.primary} />
          <Text style={[t.title, styles.flex]} accessibilityRole="header">Group session</Text>
          <Text style={[t.meta, { color: now.length ? c.success : c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {playingLine(group.players)}
          </Text>
        </View>
        <Text style={[t.sub, styles.gap]}>
          {kind === 'event'
            ? 'Start your play session here and everyone in this event sees you playing.'
            : 'Start your play session here and everyone in this tournament sees you playing.'}
        </Text>

        {players.length > 0 ? (
          <PresenceCard
            compact
            bare
            maxRows={ROWS}
            style={styles.gap}
            rows={players.map((p) => ({
              key: p.userId,
              avatar: <PlayerAvatar p={p} />,
              label: p.isMe ? `${p.name} (you)` : p.name,
              sublabel: playerStatus(p, (iso) => clockLabel(iso)),
              badge: p.endedAt === null ? { label: 'Playing', tone: 'success' as const } : null,
            }))}
          />
        ) : null}

        {mine ? (
          <View style={[styles.inRow, styles.gap]}>
            <Text style={[t.title, styles.flex, { color: c.success }]}>{`You're in · ${clock(elapsed)}`}</Text>
            <Button size="sm" variant="outline" title="End" loading={ending} onPress={() => void end()} />
          </View>
        ) : canJoin ? (
          <View style={styles.gap}>
            <SettingSwitchRow
              label="Let everyone know"
              hint={kind === 'event' ? 'A push to the people going' : 'A push to the players in it'}
              value={notify}
              onChange={setNotify}
            />
            <Button
              title="Join the group session"
              iconName="play"
              variant="success"
              style={styles.join}
              onPress={() => joinGroupSession({ kind, id, title, notify })}
            />
          </View>
        ) : null}

        {canShare ? (
          <TouchableOpacity style={[styles.shareLink, styles.gap]} onPress={() => setShareOpen(true)} accessibilityRole="button">
            <Icon name="share" size={14} color={c.primary} />
            <Text style={[t.meta, { color: c.primary }]}>Share the group session</Text>
          </TouchableOpacity>
        ) : null}
      </Panel>
      {canShare ? (
        <PickleShareStudio
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          title="Share the group session"
          model={shareModel}
          trackProps={{ group: kind, people: players.length }}
          initialPhotos={albumPhotos.length ? albumPhotos : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: SPACE.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  flex: { flex: 1, minWidth: 0 },
  gap: { marginTop: SPACE.sm },
  inRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  join: { marginTop: SPACE.sm },
  shareLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 32 },
  emoji: { fontSize: 16 },
});
