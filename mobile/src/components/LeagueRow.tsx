// A league as one compact row (plan section 4 mockups, section 6 Compact/Row).
// One component for every list of leagues:
//   - Home YOURS        layout='row', role chip, `subtitle` = the live fact
//                       ("1 vote open · next Thu 6 PM"), trailingText "Wk 7/12"
//   - Home JOIN A LEAGUE layout='row', court · players · fact, action =
//                       <LeagueJoinButton> (inline Join / Request via useLeagueJoin)
//   - Play Mine/Discover layout='compact' (the default), same pieces
//   - Profile Coming up  layout='row'
// Presentational: the caller fetches, decides the facts and navigates.
//
// The subtitle names the league's COURT (displayCourtName, so a nickname
// wins), never a city: a city needs a nearest_us_city() lookup per row.
import React, { type ReactNode, type Ref } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useCourtName } from '../lib/courtNickname';
import { joinFacts, leagueRoleChip, playerCountLabel } from '../lib/entityGlyph';
import type { UseLeagueJoin } from '../lib/useLeagueJoin';
import EntityRow, { type EntityRowChip, type EntityRowLayout } from './EntityRow';

export type LeagueRowLeague = {
  id: string;
  name: string;
  home_court?: string | null;
  /** false = private (join by code / request). Missing counts as open, as LeaguesScreen does. */
  is_open?: boolean | null;
};

export type LeagueRowRole = 'admin' | 'co-admin' | 'member' | 'unknown' | null;

export type LeagueRowProps = {
  league: LeagueRowLeague;
  /** Default 'compact' (full-screen lists); 'row' inside a <Panel padded={false}>. */
  layout?: EntityRowLayout;
  /** The viewer's role: shown as the first chip. null / 'unknown' = no chip. */
  role?: LeagueRowRole;
  /** The viewer has a pending join request (non-members only): a "Requested" chip. */
  requested?: boolean;
  /** "3 players". 0 / null is omitted, never "0 players". */
  memberCount?: number | null;
  /** Extra subtitle facts after the court and the player count ("In season", "Vote open"). */
  facts?: ReadonlyArray<string | null | undefined | false>;
  /** Replaces the whole built subtitle (Home YOURS: one live fact). '' = no subtitle. */
  subtitle?: string | null;
  /** Default true. false drops the court from the built subtitle. */
  showCourt?: boolean;
  /** Extra chips after the role / Private / Requested chips. Only 2 chips render in total. */
  chips?: ReadonlyArray<EntityRowChip | null | undefined | false>;
  /** The one trailing badge ("Wk 7/12"). Hidden when `action` is set. */
  trailingText?: string | null;
  /** Trailing action, e.g. <LeagueJoinButton />. Replaces the chevron. */
  action?: ReactNode;
  onPress?: () => void;
  lastRow?: boolean;
  highlighted?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function LeagueRow({
  league,
  layout = 'compact',
  role,
  requested,
  memberCount,
  facts,
  subtitle,
  showCourt = true,
  chips,
  trailingText,
  action,
  onPress,
  lastRow,
  highlighted,
  style,
}: LeagueRowProps) {
  // Subscribes to the court-nickname cache so the row re-renders when it loads.
  const courtName = useCourtName();
  const isMember = role === 'admin' || role === 'co-admin' || role === 'member';
  const isPrivate = league.is_open === false;

  const builtSubtitle = subtitle !== undefined
    ? subtitle
    : joinFacts([
        showCourt && courtName(league.home_court),
        playerCountLabel(memberCount),
        ...(facts ?? []),
      ]);

  const rowChips: (EntityRowChip | null | undefined | false)[] = [
    leagueRoleChip(role),
    // A member already knows; to everyone else it says why the action is
    // [Request] rather than [Join].
    !isMember && isPrivate && { label: 'Private', tone: 'neutral' },
    !isMember && requested && { label: 'Requested', tone: 'info' },
    ...(chips ?? []),
  ];

  return (
    <EntityRow
      kind="league"
      layout={layout}
      title={league.name}
      subtitle={builtSubtitle}
      chips={rowChips}
      trailingText={trailingText}
      action={action}
      onPress={onPress}
      lastRow={lastRow}
      highlighted={highlighted}
      style={style}
    />
  );
}

export type LeagueJoinButtonProps = {
  league: LeagueRowLeague;
  /** The screen's useLeagueJoin() instance (it owns busy / requested / joined state). */
  leagueJoin: UseLeagueJoin;
  /** The server says a request is already pending (LeagueWithStats.hasRequested). */
  requested?: boolean;
  /** Label for an open league. Default 'Join'. */
  joinLabel?: string;
  /** Label for a private league. Default 'Request' (Play may pass 'Request code'). */
  requestLabel?: string;
  /** Spotlight-tour anchor (the 'leagues/join' step): a ref to a View wrapping
   *  the button. A wrapper even though Button forwards its ref (foundation
   *  1.40): it gives the onLayout that registers the anchor (Button takes no
   *  onLayout) and stays the same element when [Join] turns into "Joined". */
  anchorRef?: Ref<View>;
  /** Fires on the wrapper's layout, e.g. to registerAnchor once it is measurable. */
  onAnchorLayout?: () => void;
  /** Called after the press is handled (analytics: trackHomeTap / trackPlayFilter). */
  onPressed?: (kind: 'join' | 'request') => void;
};

/**
 * The inline [Join] / [Request] for a non-member's league row, wired to
 * useLeagueJoin. After a request it reads "Requested"; after a join, "Joined"
 * until the caller's reload moves the row into YOURS / Mine. Both states are
 * plain text in a 44px box (not pressable), so a second request can't be sent.
 */
export function LeagueJoinButton({
  league,
  leagueJoin,
  requested,
  joinLabel = 'Join',
  requestLabel = 'Request',
  anchorRef,
  onAnchorLayout,
  onPressed,
}: LeagueJoinButtonProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const isPrivate = league.is_open === false;
  const busy = leagueJoin.isBusy(league.id);

  const doneLabel = leagueJoin.joinedIds.has(league.id)
    ? 'Joined'
    : isPrivate && (requested || leagueJoin.requestedIds.has(league.id))
      ? 'Requested'
      : null;

  return (
    <View ref={anchorRef} onLayout={onAnchorLayout} collapsable={false}>
      {doneLabel ? (
        <View style={styles.doneBox}>
          <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {doneLabel}
          </Text>
        </View>
      ) : (
        <Button
          size="sm"
          variant={isPrivate ? 'outline' : 'primary'}
          title={isPrivate ? requestLabel : joinLabel}
          loading={busy}
          onPress={() => {
            if (isPrivate) void leagueJoin.request(league.id, league.name);
            else void leagueJoin.join(league.id);
            onPressed?.(isPrivate ? 'request' : 'join');
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same 44 box as the button it replaces, so the row doesn't jump.
  doneBox: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
