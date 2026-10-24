// TournamentDetail's identity block (plan section 5, slot 1): the status pill
// plus one chip row, and the description clamped to 2 lines with "more".
//
//   (Registration open) ([repeat] Round Robin · Doubles) ([calendar] Sat, Oct 18, 9 AM)
//   ([pin] Lake Merritt) ([group] 6/16) ([pickle] 50 ante) ([info] How it works)
//
// Every chip glyph is an `iconName` (glyphs-ui-plan.md), drawn in the chip's
// tone colour and hidden from screen readers; the chips centre in the row
// (`align="center"`) so plain pills and 44px tap boxes sit on one line.
//
// Plan section 5 caps the chip row at 2 rows on a 358pt content width, so the
// match type rides on the format chip, the date drops ":00", a long court name
// truncates, and there is no role chip (Manage and the Setup card already say
// you organize this one).
//
// It replaces the header card (format block, settings chips and five meta
// lines) and the three closure banners ("edits are locked", "bracket
// finalized", "tournament complete"): the status pill now says where the
// tournament is. The rarer settings (seeding, pools, playoff, registration
// mode, expected length, registration close time) live on TournamentInfo,
// behind "How it works".
//
// Content rules: no TBD / zero values for non-admins. A tournament with no
// date or location shows nothing there to players; an admin who can still
// edit gets a "No date" / "No location" outline chip that opens Edit.
//
// Pressable chips opt in to being announced as buttons, named without their
// glyphs (same as LeagueIdentity; none sits inside another button).
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Chip, ClampText } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { Tournament } from '../../types';
import { FORMAT_META } from '../../lib/tournament';
import { displayCourtName } from '../../lib/courtNickname';
import { statusPill } from './tournamentModel';

export type TournamentIdentityProps = {
  tournament: Tournament;
  approvedCount: number;
  isFull: boolean;
  regClosed: boolean;
  /** "How it works" (info glyph) -> TournamentInfo. */
  onOpenInfo: () => void;
  /** Admin who can still edit: the "No date" / "No location" chips open Edit. */
  onEdit?: () => void;
};

export default function TournamentIdentity({
  tournament: t, approvedCount, isFull, regClosed, onOpenInfo, onEdit,
}: TournamentIdentityProps) {
  const { colors: c } = useTheme();
  const tx = textStyles(c);
  const fmt = FORMAT_META[t.format];
  const pill = statusPill({ status: t.status, regClosed, isFull });
  const chipProps = { size: 'sm' as const, maxFontSizeMultiplier: SMALL_TEXT_MAX_SCALE, align: 'center' as const };

  const start = t.start_time ? new Date(t.start_time) : null;
  const date = start
    ? start.toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric',
        // "9 AM", not "9:00 AM": every character counts toward the 2-row cap.
        ...(start.getMinutes() !== 0 ? { minute: '2-digit' as const } : {}),
      })
    : '';
  const court = displayCourtName(t.location_name);
  const players = t.max_players != null ? `${approvedCount}/${t.max_players}` : `${approvedCount}`;
  const playersA11y = t.max_players != null
    ? `${approvedCount} of ${t.max_players} players`
    : `${approvedCount} ${approvedCount === 1 ? 'player' : 'players'}`;
  const desc = t.description?.trim() ?? '';

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        <Chip {...chipProps} label={pill.label} tone={pill.tone} variant="solid" />
        <Chip {...chipProps} iconName={fmt.iconName} label={`${fmt.label} · ${t.match_type === 'doubles' ? 'Doubles' : 'Singles'}`} />
        {date ? (
          <Chip {...chipProps} iconName="calendar" label={date} />
        ) : onEdit ? (
          <Chip
            {...chipProps}
            hitBox
            iconName="calendar"
            label="No date"
            tone="warning"
            variant="outline"
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="No date"
            accessibilityHint="Opens Edit tournament to set one"
          />
        ) : null}
        {court ? (
          <Chip {...chipProps} iconName="pin" label={court} shrink style={styles.courtChip} />
        ) : onEdit ? (
          <Chip
            {...chipProps}
            hitBox
            iconName="pin"
            label="No location"
            tone="warning"
            variant="outline"
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="No location"
            accessibilityHint="Opens Edit tournament to set one"
          />
        ) : null}
        {approvedCount > 0 || t.max_players != null ? (
          // The glyph is hidden from screen readers, so the count gets words.
          <View accessible accessibilityLabel={playersA11y} style={styles.a11yWrap}>
            <Chip {...chipProps} iconName="group" label={players} />
          </View>
        ) : null}
        {(t.pickle_ante ?? 0) > 0 ? <Chip {...chipProps} iconName="pickle" label={`${t.pickle_ante} ante`} tone="success" /> : null}
        <Chip
          {...chipProps}
          hitBox
          iconName="info"
          label="How it works"
          variant="outline"
          tone="brand"
          onPress={onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel="How it works"
        />
      </View>

      {desc ? (
        // "more" beside the last line (one 44 block when clamped), shown only
        // when ClampText measures a real overflow. TournamentInfo doesn't show
        // the description, so the clamp must always offer a way to read it.
        <ClampText
          style={tx.sub}
          togglePlacement="beside"
          moreA11yLabel="Show the full description"
          lessA11yLabel="Show less of the description"
        >
          {desc}
        </ClampText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACE.xs },
  // Pills and 44 tap boxes share one row; alignItems keeps the pills on one line.
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm, rowGap: SPACE.xs },
  // A long venue name truncates (Chip's label is 1 line) instead of taking a row.
  courtChip: { maxWidth: 160 },
  a11yWrap: { alignSelf: 'center' },
});
