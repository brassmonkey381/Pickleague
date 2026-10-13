// The non-member's "You" card on LeagueDetail and LeagueMembers (plan section
// 5: slot 2, the one Emphasis card per screen). Replaces the two hand-rolled
// join cards those screens had, with the join logic from useLeagueJoin:
//   open league    -> "Join this league"  [Join]
//   private league -> "Want in?"          [Request]  -> "Request sent"
//
// It renders NOTHING until the viewer's membership is known (`roleKnown`): a
// failed or in-flight role read must not hand an existing member a Join button
// (LeagueDetail's roleKnown guard; LeagueMembers used to flash it while its
// role read was in flight). It also renders nothing for a member, or before
// the league's is_open has loaded.
//
// Emphasis variant: Panel + 3px accent left border, no shadow.
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Panel, StatusBanner } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useStatusMessage } from '@just-messin-around/expo-foundation/hooks';
import { useTheme } from '../lib/ThemeContext';
import { useLeagueJoin } from '../lib/useLeagueJoin';

export type LeagueJoinCardProps = {
  leagueId: string;
  /** Named in the request-sent copy. */
  leagueName: string;
  /** leagues.is_open. null / undefined = not loaded yet: renders nothing. */
  isOpen: boolean | null | undefined;
  /** The viewer's role read has SUCCEEDED (LeagueRole is not 'unknown' and the
   *  first load finished). Until then the card renders nothing. */
  roleKnown: boolean;
  /** The viewer is a member (any role). The card renders nothing for members. */
  isMember: boolean;
  /** A join request is already pending (league_join_requests, status 'pending'). */
  requested?: boolean;
  /** After a join: reload the screen (flip isMember). Awaited while the
   *  button shows its spinner, so the card doesn't flash back to [Join]. */
  onJoined?: () => void | Promise<unknown>;
  /** After a request was sent. */
  onRequested?: () => void;
  style?: StyleProp<ViewStyle>;
};

/** Emphasis variant's accent edge (plan section 6). */
const ACCENT_EDGE = 3;

export default function LeagueJoinCard({
  leagueId,
  leagueName,
  isOpen,
  roleKnown,
  isMember,
  requested,
  onJoined,
  onRequested,
  style,
}: LeagueJoinCardProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const leagueJoin = useLeagueJoin({
    status,
    onJoined: () => onJoined?.(),
    onRequested: () => onRequested?.(),
  });

  if (!roleKnown || isMember || isOpen == null) return null;

  const busy = leagueJoin.isBusy(leagueId);
  const joined = leagueJoin.joinedIds.has(leagueId);
  const sent = !isOpen && (requested || leagueJoin.requestedIds.has(leagueId));

  const title = isOpen ? 'Join this league' : 'Want in?';
  const sub = isOpen
    ? 'Join to record matches, see standings, and play in events.'
    : 'This league is private — request to join and an admin will share an invite code.';

  return (
    <Panel style={[styles.emphasis, { borderLeftColor: c.primary }, style]}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={t.title} numberOfLines={1} accessibilityRole="header">{title}</Text>
          <Text style={[t.sub, styles.sub]} numberOfLines={2}>{sub}</Text>
        </View>
        {joined || sent ? (
          <View style={styles.doneBox}>
            <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {joined ? 'Joined' : 'Request sent'}
            </Text>
          </View>
        ) : (
          <Button
            size="sm"
            title={isOpen ? 'Join' : 'Request'}
            variant={isOpen ? 'primary' : 'outline'}
            loading={busy}
            onPress={() => {
              if (isOpen) void leagueJoin.join(leagueId);
              else void leagueJoin.request(leagueId, leagueName);
            }}
          />
        )}
      </View>
      {status.value ? <StatusBanner status={status.value} style={styles.banner} /> : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  emphasis: { borderLeftWidth: ACCENT_EDGE, borderRadius: RADIUS.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  text: { flex: 1, minWidth: 0 },
  sub: { marginTop: SPACE.xxs },
  // Same 44 box as the button it replaces, so the card doesn't jump.
  doneBox: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  banner: { marginTop: SPACE.sm },
});
