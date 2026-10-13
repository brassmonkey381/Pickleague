// TournamentDetail's identity block (plan section 5, slot 1): the status pill
// plus one chip row, and the description clamped to 2 lines with "more".
//
//   (Registration open) (🔄 Round Robin · Doubles) (📅 Sat, Oct 18, 9 AM)
//   (📍 Lake Merritt) (👥 6/16) (🥒 50 ante) (ⓘ How it works)
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
// edit gets a "No date ›" / "No location ›" chip that opens Edit.
//
// Pressable chips opt in to being announced as buttons, named without their
// glyphs (same as LeagueIdentity; none sits inside another button).
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { Chip } from '@just-messin-around/expo-foundation/ui';
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
  /** "ⓘ How it works" -> TournamentInfo. */
  onOpenInfo: () => void;
  /** Admin who can still edit: the "No date" / "No location" chips open Edit. */
  onEdit?: () => void;
};

/** Whether the description likely passes 2 lines, so it gets "more". Estimated
 *  from the text width and fontScale (same estimate as LeagueIdentity) because
 *  RN-web never fires onTextLayout. The estimate errs toward showing "more": a
 *  "more" that expands to the same text costs nothing, clipped text with no
 *  "more" can't be read anywhere else (TournamentInfo doesn't show it).
 *
 * FOUNDATION-TODO: foundation 1.41's ClampText measures overflow for real, but
 * its text View has no flex, so "more" can only sit under the text (+44px when
 * clamped) or in a fixed right inset that narrows every description. Add a
 * `textContainerStyle` (or `toggleBeside`) option to ClampText, then use it here
 * with a row containerStyle and drop this estimate. */
const DESC_FONT_SIZE = 13; // t.sub
const AVG_CHAR_EM = 0.55;
const MORE_BOX = 44;
/** Web renders the app in a centred 720px column (AppNavigator's WebMaxWidth),
 *  so the window width overstates the text width there. */
const CONTENT_MAX_WIDTH = 720;

export default function TournamentIdentity({
  tournament: t, approvedCount, isFull, regClosed, onOpenInfo, onEdit,
}: TournamentIdentityProps) {
  const { colors: c } = useTheme();
  const tx = textStyles(c);
  const [descOpen, setDescOpen] = useState(false);
  const { width, fontScale } = useWindowDimensions();
  const fmt = FORMAT_META[t.format];
  const pill = statusPill({ status: t.status, regClosed, isFull });
  const chipProps = { size: 'sm' as const, maxFontSizeMultiplier: SMALL_TEXT_MAX_SCALE };

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
  const desc = t.description?.trim() ?? '';
  // Text width beside the "more" box: the screen gutters (SPACE.lg each side),
  // the row gap and the 44 box. Floored so a tiny window still gets a sane bar.
  const textWidth = Math.max(120, Math.min(width, CONTENT_MAX_WIDTH) - 2 * SPACE.lg - SPACE.sm - MORE_BOX);
  const charsPerLine = Math.max(1, Math.floor(textWidth / (DESC_FONT_SIZE * AVG_CHAR_EM * Math.max(1, fontScale))));
  const longDesc = desc.length > 2 * charsPerLine || desc.includes('\n');

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        <Chip {...chipProps} label={pill.label} tone={pill.tone} variant="solid" />
        <Chip {...chipProps} label={`${fmt.icon} ${fmt.label} · ${t.match_type === 'doubles' ? 'Doubles' : 'Singles'}`} />
        {date ? (
          <Chip {...chipProps} label={`📅 ${date}`} />
        ) : onEdit ? (
          <Chip
            {...chipProps}
            hitBox
            label="📅 No date ›"
            tone="warning"
            variant="outline"
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="No date"
            accessibilityHint="Opens Edit tournament to set one"
          />
        ) : null}
        {court ? (
          <Chip {...chipProps} label={`📍 ${court}`} style={styles.courtChip} />
        ) : onEdit ? (
          <Chip
            {...chipProps}
            hitBox
            label="📍 No location ›"
            tone="warning"
            variant="outline"
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="No location"
            accessibilityHint="Opens Edit tournament to set one"
          />
        ) : null}
        {approvedCount > 0 || t.max_players != null ? (
          <Chip {...chipProps} label={`👥 ${players}`} />
        ) : null}
        {(t.pickle_ante ?? 0) > 0 ? <Chip {...chipProps} label={`🥒 ${t.pickle_ante} ante`} tone="success" /> : null}
        <Chip
          {...chipProps}
          hitBox
          label="ⓘ How it works"
          variant="outline"
          tone="brand"
          onPress={onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel="How it works"
        />
      </View>

      {desc ? (
        <View style={styles.descRow}>
          <Text style={[tx.sub, styles.descText]} numberOfLines={descOpen ? undefined : 2}>{desc}</Text>
          {longDesc ? (
            <TouchableOpacity
              onPress={() => setDescOpen(v => !v)}
              style={styles.more}
              accessibilityRole="button"
              accessibilityLabel={descOpen ? 'Show less of the description' : 'Show the full description'}
            >
              <Text style={[tx.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {descOpen ? 'less' : 'more'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
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
  descRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.sm },
  descText: { flex: 1, minWidth: 0 },
  more: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'flex-end', paddingBottom: SPACE.xxs },
});
