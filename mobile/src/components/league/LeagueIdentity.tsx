// LeagueDetail's identity block (plan section 5, slot 1): one chip row plus the
// description clamped to 2 lines with "more".
//
//   (globe Public) (pin Lake Merritt · 2 here >) (3 members) (You: Admin) (info How it works)
//
// It replaces three cards the screen used to stack (about 250-350px): the
// home-court banner, the description/privacy card and the "Your role" banner.
// The region label ("East Bay") those cards showed is gone: the court chip
// names the actual court (lib/regions.ts was retired, plan section 4).
//
// Tapping the court chip opens who's here: the crowd line ("6 playing now ·
// mostly 3.5–4.0 · 2 friends") with the "my courts" star, then the roster.
// With COURT_DISCOVERY_ENABLED it opens the court's page instead (CourtDetail,
// which has the same crowd, star and roster, plus the facts and Check in).
//
// Content rules: no "Not set" / "Unknown" / zero values for non-admins. A
// league without a home court shows nothing there to members; an admin gets a
// "No home court" chip that opens Edit. A 0 or unknown member count is left out.
//
// Pressable chips use Chip's `hitBox` (a 28px pill centred in a real 44x44 box,
// since react-native-web ignores hitSlop) and opt in to being announced as
// buttons, named without their glyphs (none sits inside another button, so
// the <button> RNW renders for them on web nests nothing); plain chips are
// just pills. Every pill is centred in the row (Chip align="center"), so a
// plain pill no longer rides 8px above a 44 tap box beside it.
//
// The court chip is the foundation FilterPill: the same 28px neutral pill in a
// 44 box, and the one pill with a trailing glyph (the chevron that says it
// opens: right when closed, down while the roster shows).
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Chip, ClampText, FilterPill } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useCourtName } from '../../lib/courtNickname';
import { roleLabel, type LeagueRole } from '../../lib/leagueRole';
import { leagueRoleChip } from '../../lib/entityGlyph';
import PlayersHereList from '../PlayersHereList';
import CrowdLine from '../court/CrowdLine';
import { useCourtPresence } from './useCourtPresence';
import { COURT_DISCOVERY_ENABLED } from '../../lib/features';
import type { RootStackParamList } from '../../types';

export type LeagueIdentityProps = {
  league: {
    is_open: boolean;
    is_active: boolean;
    description: string | null;
    home_court: string | null;
    home_court_lat: number | null;
    home_court_lng: number | null;
    /** The stored home court (leagues.home_venue_id), when set: used as is
     *  instead of the closest court to the coordinates. */
    home_venue_id?: string | null;
  };
  myRole: LeagueRole;
  /** null = not loaded / failed: the chip is left out. */
  memberCount: number | null;
  /** Admin/co-admin: sees the "No home court" prompt. */
  privileged: boolean;
  /** "How it works" (info glyph) -> LeagueInfo. Left out (no chip) on a
   *  closed league's preview, whose LeagueInfo a non-member can't read. */
  onOpenInfo?: () => void;
  /** Admin's "No home court" chip -> the Edit league sheet. */
  onSetCourt?: () => void;
};

/** A raw Places name (no nickname, or the nickname cache isn't loaded yet) can
 *  pass a phone's width; the pill's one-line label then overflows the gutter on
 *  web and ellipsizes away the "· N here" cue on native. Cap the court part. */
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
  const presence = useCourtPresence(league.home_court_lat, league.home_court_lng, league.home_venue_id);
  const [rosterOpen, setRosterOpen] = useState(false);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Subscribes, so the chip re-renders to the (shorter) nickname once the cache loads.
  const courtName = useCourtName();

  const court = league.home_court ? courtName(league.home_court) : '';
  const courtShort = court.length > COURT_LABEL_MAX ? `${court.slice(0, COURT_LABEL_MAX - 1).trimEnd()}…` : court;
  const hereCount = presence.count != null && presence.count > 0 ? presence.count : null;
  const roleChip = myRole && myRole !== 'unknown' ? leagueRoleChip(myRole) : null;
  const desc = league.description?.trim() ?? '';

  const chipProps = { size: 'sm' as const, align: 'center' as const, maxFontSizeMultiplier: SMALL_TEXT_MAX_SCALE };

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        <Chip
          {...chipProps}
          iconName={league.is_open ? 'globe' : 'lock'}
          label={league.is_open ? 'Public' : 'Private'}
          tone={league.is_open ? 'brand' : 'warning'}
        />
        {!league.is_active ? <Chip {...chipProps} label="Closed" tone="danger" /> : null}
        {court ? (
          presence.venueId ? (
            <FilterPill
              iconName="pin"
              label={`${courtShort}${hereCount ? ` · ${hereCount} here` : ''}`}
              trailingIconName={rosterOpen ? 'chevron-down' : 'chevron-right'}
              active={rosterOpen}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              onPress={() => {
                const venueId = presence.venueId;
                if (COURT_DISCOVERY_ENABLED && venueId) navigation.navigate('CourtDetail', { venueId });
                else setRosterOpen((v) => !v);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Home court: ${court}${hereCount ? `, ${hereCount} here` : ''}. ${
                COURT_DISCOVERY_ENABLED ? "Opens the court's page" : rosterOpen ? "Hides who's here" : "Shows who's here"
              }`}
              accessibilityState={COURT_DISCOVERY_ENABLED ? {} : { selected: rosterOpen }}
            />
          ) : (
            <Chip {...chipProps} iconName="pin" label={courtShort} />
          )
        ) : privileged && onSetCourt ? (
          <Chip
            {...chipProps}
            hitBox
            iconName="pin"
            label="No home court"
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
        {onOpenInfo ? (
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
        ) : null}
      </View>

      {rosterOpen && presence.venueId ? (
        <View>
          <CrowdLine venueId={presence.venueId} venueName={court || null} star />
          <PlayersHereList venueId={presence.venueId} venueName={court || undefined} />
        </View>
      ) : null}

      {desc ? (
        // "more" sits beside the text, not under it, so a clamped description
        // costs one 44 line and the quick row's Record stays above y=200.
        // ClampText measures the real overflow (no character estimate).
        <ClampText
          style={t.sub}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm },
});
