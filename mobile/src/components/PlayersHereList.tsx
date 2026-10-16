// "N players here now" at one court, with their PLUPR. Refreshes every minute
// while its screen is focused and the app is in the foreground. A failed load
// shows a line saying so rather than "nobody here".
//
// Rows come from court_presence, which applies each player's own privacy
// setting on the server: someone this viewer may not name arrives anonymous
// (no ids, no name) and renders as a neutral dot, "Player · 3.5–4.0" (a band,
// never the exact rating). Close friends are marked ⭐ and listed first, then
// friends, then other named players, then the anonymous rows.
//
// Three looks:
//   - default:  the summary line plus up to 12 names (kept for any caller that
//               wants the full roster).
//   - compact:  one summary line only (league screen).
//   - presence: the foundation PresenceCard, compact, capped at `maxRows` with
//               "+N more".
//
// Home's NOW block (plan layout C, about 120 tall) can't afford the stacked
// PresenceCard on every render, so it uses the pieces below instead: one
// usePlayersHere fetch, PlayersHerePile on the same 44px line as the buttons
// ("(A)(B)(C) +4 here"), and PlayersHereRoster (the PresenceCard) only once the
// pile is tapped.
import React, { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { AvatarPile, PresenceCard } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../lib/ThemeContext';
import { formatPluprShort } from '../lib/plupr';
import { presenceRowLabel, sortPresenceRows } from '../lib/courtCrowd';
import { getCourtPresence, type CourtPresenceRow } from '../data/courtPresence';

/** One row of who's here (court_presence). */
export type PlayerHere = CourtPresenceRow;

type Props = {
  venueId: string;
  /** One summary line only (league screen), no roster. */
  compact?: boolean;
  /** Label for the compact line, e.g. the court name. */
  venueName?: string;
  /** The foundation PresenceCard look, capped at this many rows (Home NOW). */
  presenceMaxRows?: number;
};

const AVATAR = 28;
/** Avatars on the NOW line before the rest collapse into "+N". */
const PILE_MAX = 3;

/** Who's checked in at a court, refreshed every minute while its screen is
 *  focused and the app is in the foreground. `players` stays null until the
 *  first load; `failed` only means the latest refresh failed (an earlier
 *  roster is kept). */
export function usePlayersHere(venueId: string): { players: PlayerHere[] | null; failed: boolean } {
  const focused = useIsFocused();
  const [players, setPlayers] = useState<PlayerHere[] | null>(null);
  const [failed, setFailed] = useState(false);
  usePollWhileActive(
    async () => {
      try {
        setPlayers(sortPresenceRows(await getCourtPresence(venueId)));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    60_000,
    // Covered by another screen (Home stays mounted under the native stack):
    // stop. Refocusing re-arms the poll and fetches at once; the last roster
    // is kept meanwhile.
    focused ? venueId : null,
  );
  return { players, failed };
}

/** A named row's emoji avatar; an anonymous row is a neutral dot (no emoji,
 *  nothing to tell one player from another). */
function RowAvatar({ p, fill }: { p: PlayerHere; fill?: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  if (p.anonymous) {
    return (
      <View style={[fill ? S.pileFill : S.avatar, { backgroundColor: c.surfaceAlt }]}>
        <View style={[S.dot, { backgroundColor: c.border }]} />
      </View>
    );
  }
  return (
    <View style={[fill ? S.pileFill : S.avatar, { backgroundColor: c.surfaceAlt }]}>
      <Text style={t.sub}>{p.avatar_emoji || '🙂'}</Text>
    </View>
  );
}

/** "Close friend · PLUPR 3.62", "Friend · PLUPR 3.62", "PLUPR 3.62"; none for
 *  an anonymous row (its label already carries the band). */
function rowSublabel(p: PlayerHere): string | null {
  if (p.anonymous) return null;
  const plupr = `PLUPR ${formatPluprShort(p.doubles_rating, undefined)}`;
  if (p.is_close_friend) return `Close friend · ${plupr}`;
  if (p.is_friend) return `Friend · ${plupr}`;
  return plupr;
}

/** The full roster: the foundation PresenceCard, compact, capped at `maxRows`
 *  with "+N more", embedded in a panel (no second border or inset). */
export function PlayersHereRoster({ players, maxRows }: { players: PlayerHere[]; maxRows: number }) {
  const n = players.length;
  return (
    <PresenceCard
      compact
      bare
      maxRows={maxRows}
      meta={n > 0 ? `${n} here` : null}
      emptyText="No one else checked in yet."
      style={S.presence}
      rows={players.map((p) => ({
        key: p.checkin_id,
        avatar: <RowAvatar p={p} />,
        label: presenceRowLabel(p),
        sublabel: rowSublabel(p),
      }))}
    />
  );
}

/**
 * One line for the NOW block: up to 3 overlapping avatars and "+N here" /
 * "N here" / "No one else here yet", in a 44 tap box that shows or hides the
 * full roster (`onPress`). Flexes and truncates its caption; never wraps.
 *
 * AvatarPile `inline` with `overlap` and the caption as `trailing`, so the
 * whole line is one button. No `maxVisible`: the caption carries "+N here"
 * instead of a "+N" chip.
 */
export function PlayersHerePile({
  players,
  failed,
  expanded,
  onPress,
  style,
}: {
  players: PlayerHere[] | null;
  failed: boolean;
  expanded: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  if (!players) {
    // Still loading: hold the line's space; a failed first load says so.
    return (
      <View style={[S.pile, style]}>
        {failed ? (
          <Text style={[t.meta, S.shrink]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            Couldn't load who's here
          </Text>
        ) : null}
      </View>
    );
  }
  const n = players.length;
  const caption = n === 0 ? 'No one else here yet' : n > PILE_MAX ? `+${n - PILE_MAX} here` : `${n} here`;
  const captionText = (
    <Text style={[t.meta, S.shrink]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
      {caption}
    </Text>
  );
  // Nobody to list: nothing to expand, so not a button (and AvatarPile renders
  // nothing for an empty list).
  if (n === 0) return <View style={[S.pile, style]}>{captionText}</View>;
  return (
    <AvatarPile
      inline
      items={players.slice(0, PILE_MAX)}
      keyOf={(p) => p.checkin_id}
      labelOf={presenceRowLabel}
      size={AVATAR}
      // The ring in the panel colour keeps the stacked avatars apart (no shadow).
      overlap={SPACE.sm}
      renderAvatar={(p) => <RowAvatar p={p} fill />}
      trailing={captionText}
      onPress={onPress}
      expanded={expanded}
      accessibilityLabel={`${n} player${n === 1 ? '' : 's'} here`}
      accessibilityHint={expanded ? 'Hides the list' : 'Shows who is here'}
      style={style}
    />
  );
}

export default function PlayersHereList({ venueId, compact, venueName, presenceMaxRows }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { players, failed } = usePlayersHere(venueId);

  if (failed && !players) return <Text style={[t.sub, S.top]}>Couldn't load who's here.</Text>;
  if (!players) return null;
  const n = players.length;
  const where = venueName ? ` at ${venueName}` : ' here';
  const summary = n === 0 ? `No one checked in${where} right now` : `${n} player${n === 1 ? '' : 's'}${where} now`;

  if (compact) return <Text style={[t.bodySub, S.top]}>🟢 {summary}</Text>;

  if (presenceMaxRows != null) return <PlayersHereRoster players={players} maxRows={presenceMaxRows} />;

  return (
    <View style={S.top}>
      <Text style={t.bodySub}>{summary}</Text>
      {players.slice(0, 12).map((p) => (
        <View key={p.checkin_id} style={S.row}>
          <Text style={[t.body, S.name]} numberOfLines={1}>
            {p.anonymous ? '· ' : p.avatar_emoji ? `${p.avatar_emoji} ` : ''}
            {presenceRowLabel(p)}
          </Text>
          {p.anonymous ? null : <Text style={t.sub}>PLUPR {formatPluprShort(p.doubles_rating, undefined)}</Text>}
        </View>
      ))}
      {n > 12 ? <Text style={t.sub}>and {n - 12} more</Text> : null}
    </View>
  );
}

const S = StyleSheet.create({
  top: { marginTop: SPACE.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: SPACE.xs, gap: SPACE.sm },
  name: { flex: 1 },
  presence: { paddingTop: SPACE.xs },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pile: { flexDirection: 'row', alignItems: 'center', minHeight: 44, minWidth: 0 },
  // Fills the pile's ringed circle (it clips to round), centring the emoji.
  pileFill: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  shrink: { flexShrink: 1 },
  dot: { width: AVATAR / 3, height: AVATAR / 3, borderRadius: RADIUS.pill },
});
