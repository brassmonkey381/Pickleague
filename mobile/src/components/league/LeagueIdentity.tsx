// LeagueDetail's identity block (plan section 5, slot 1): one chip row plus the
// description clamped to 2 lines with "more".
//
//   (Public) (📍 Lake Merritt · 2 here ›) (3 members) (You: Admin) (ⓘ How it works)
//
// It replaces three cards the screen used to stack (about 250-350px): the
// home-court banner, the description/privacy card and the "Your role" banner.
// The region label ("East Bay") those cards showed is gone: the court chip
// names the actual court (lib/regions.ts was retired, plan section 4).
//
// Content rules: no "Not set" / "Unknown" / zero values for non-admins. A
// league without a home court shows nothing there to members; an admin gets a
// "No home court" chip that opens Edit. A 0 or unknown member count is left out.
//
// Pressable chips use Chip's `hitBox` (a 28px pill centred in a real 44x44 box,
// since react-native-web ignores hitSlop) and opt in to being announced as
// buttons, named without their glyphs (none sits inside another button, so
// the <button> RNW renders for them on web nests nothing); plain chips are
// just pills.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { Chip } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useCourtName } from '../../lib/courtNickname';
import { roleLabel, type LeagueRole } from '../../lib/leagueRole';
import { leagueRoleChip } from '../../lib/entityGlyph';
import PlayersHereList from '../PlayersHereList';
import { useCourtPresence } from './useCourtPresence';

export type LeagueIdentityProps = {
  league: {
    is_open: boolean;
    is_active: boolean;
    description: string | null;
    home_court: string | null;
    home_court_lat: number | null;
    home_court_lng: number | null;
  };
  myRole: LeagueRole;
  /** null = not loaded / failed: the chip is left out. */
  memberCount: number | null;
  /** Admin/co-admin: sees the "No home court" prompt. */
  privileged: boolean;
  /** "ⓘ How it works" -> LeagueInfo. */
  onOpenInfo: () => void;
  /** Admin's "No home court" chip -> the Edit league sheet. */
  onSetCourt?: () => void;
};

/** "more" is decided by an estimate of how many characters fit on 2 lines, from
 *  the window width and the OS text size (the description is body text, so it
 *  scales uncapped). RN-web never fires onTextLayout, so a measured line count
 *  isn't available on every platform. The estimate errs toward showing "more":
 *  a "more" that expands to the same text costs nothing, clipped text with no
 *  "more" can't be read anywhere else on the screen.
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
 *  so the window width overstates the text width there. Capping everywhere only
 *  makes a wide tablet show "more" a little sooner, which is the safe side. */
const CONTENT_MAX_WIDTH = 720;

/** A raw Places name (no nickname, or the nickname cache isn't loaded yet) can
 *  pass a phone's width; Chip's one-line label then overflows the gutter on web
 *  and ellipsizes away the "· N here ›" cue on native. Cap the court part. */
const COURT_LABEL_MAX = 24;

export default function LeagueIdentity({
  league,
  myRole,
  memberCount,
  privileged,
  onOpenInfo,
  onSetCourt,
}: LeagueIdentityProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const presence = useCourtPresence(league.home_court_lat, league.home_court_lng);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const { width, fontScale } = useWindowDimensions();
  // Subscribes, so the chip re-renders to the (shorter) nickname once the cache loads.
  const courtName = useCourtName();

  const court = league.home_court ? courtName(league.home_court) : '';
  const courtShort = court.length > COURT_LABEL_MAX ? `${court.slice(0, COURT_LABEL_MAX - 1).trimEnd()}…` : court;
  const hereCount = presence.count != null && presence.count > 0 ? presence.count : null;
  const roleChip = myRole && myRole !== 'unknown' ? leagueRoleChip(myRole) : null;
  const desc = league.description?.trim() ?? '';
  // Text width beside the "more" box: the screen gutters (SPACE.lg each side),
  // the row gap and the 44 box. Floored so a tiny window still gets a sane bar.
  const textWidth = Math.max(120, Math.min(width, CONTENT_MAX_WIDTH) - 2 * SPACE.lg - SPACE.sm - MORE_BOX);
  const charsPerLine = Math.max(1, Math.floor(textWidth / (DESC_FONT_SIZE * AVG_CHAR_EM * Math.max(1, fontScale))));
  const longDesc = desc.length > 2 * charsPerLine || desc.includes('\n');

  const chipProps = { size: 'sm' as const, maxFontSizeMultiplier: SMALL_TEXT_MAX_SCALE };

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        <Chip {...chipProps} label={league.is_open ? '🌐 Public' : '🔒 Private'} tone={league.is_open ? 'brand' : 'warning'} />
        {!league.is_active ? <Chip {...chipProps} label="Closed" tone="danger" /> : null}
        {court ? (
          presence.venueId ? (
            <Chip
              {...chipProps}
              hitBox
              label={`📍 ${courtShort}${hereCount ? ` · ${hereCount} here` : ''} ${rosterOpen ? '▾' : '›'}`}
              onPress={() => setRosterOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={`Home court: ${court}${hereCount ? `, ${hereCount} here` : ''}`}
              accessibilityHint={rosterOpen ? "Hides who's here" : "Shows who's here"}
            />
          ) : (
            <Chip {...chipProps} label={`📍 ${courtShort}`} />
          )
        ) : privileged && onSetCourt ? (
          <Chip
            {...chipProps}
            hitBox
            label="📍 No home court ›"
            tone="warning"
            variant="outline"
            onPress={onSetCourt}
            accessibilityRole="button"
            accessibilityLabel="No home court"
            accessibilityHint="Opens Edit league to set one"
          />
        ) : null}
        {memberCount != null && memberCount > 0 ? (
          <Chip {...chipProps} label={`${memberCount} member${memberCount === 1 ? '' : 's'}`} />
        ) : null}
        {roleChip ? <Chip {...chipProps} label={`You: ${roleLabel(myRole)}`} tone={roleChip.tone} /> : null}
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

      {rosterOpen && presence.venueId ? (
        <PlayersHereList venueId={presence.venueId} venueName={court || undefined} />
      ) : null}

      {desc ? (
        // "more" sits beside the text, not under it, so a clamped description
        // costs one 44 line and the quick row's Record stays above y=200.
        <View style={styles.descRow}>
          <Text style={[t.sub, styles.descText]} numberOfLines={descOpen ? undefined : 2}>{desc}</Text>
          {longDesc ? (
            <TouchableOpacity
              onPress={() => setDescOpen((v) => !v)}
              style={styles.more}
              accessibilityRole="button"
              accessibilityLabel={descOpen ? 'Show less of the description' : 'Show the full description'}
            >
              <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm },
  descRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.sm },
  descText: { flex: 1, minWidth: 0 },
  // A real 44 box at the end of the clamped text.
  more: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'flex-end', paddingBottom: SPACE.xxs },
});
