// LeagueDetail's Standings section (plan section 5, slot 3). It replaced the
// one-pressable season strip ("headline + top 3 + you") when the owner found
// the compacted league page too thin: the one expanded section on the page,
// open by default.
//
//   STANDINGS  Fall                                    Full table >   44
//   You #2 of 14 · Period 7 locks Oct 20 · Ends Dec 1                 1-2 lines
//   ┌ #   Player                        W-L     PLUPR ┐
//   │ (1) (av) Alice                    5-1     3.82 +0.32 │          56 each
//   │ ...top 10, your row pinned under a heavier rule  │
//   └ See all 18 >                                      ┘          44
//
// What it ranks (live period, locked period, upcoming preview, last season's
// final standings, or a members-by-PLUPR leaderboard) is decided by
// components/league/useLeagueStandings.ts; the header line is its
// leagueStandingsHeader (Home's spotlight shows the same status line, minus
// the season's end date), so
// the season's facts (You #N of M, the next lock or the season end) are each
// said once. It never renders an empty section: loading is a row
// skeleton, a failed first load is a compact ErrorState (offline glyph, the
// reason, Try again) in the table's Panel, and no rows at all renders nothing.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ErrorState, Panel, SectionHeader, ROW_MIN_HEIGHT } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { SkeletonList } from './Skeleton';
import StandingsPreview, { type StandingsPreviewRow } from './league/StandingsPreview';
import { leagueStandingsHeader, type LeagueStandings } from './league/useLeagueStandings';

/** Rows the section shows before "your row" and "See all". */
export const LEAGUE_STANDINGS_ROWS = 10;

export type SeasonStripProps = {
  /** null until the first load lands (or after a failed first load). */
  data: LeagueStandings | null;
  loading: boolean;
  /** The last load's error; shown only when there's no data to keep showing. */
  error: unknown;
  /** Admin / co-admin: "Lock due" in the status line, and "Start a season" with no season. */
  privileged: boolean;
  onRetry: () => void;
  /** Opens SeasonStandings for a season. */
  onOpenTable: (seasonId: string) => void;
  /** Opens LeagueMembers (the by-PLUPR lists' "See all"). */
  onOpenMembers: () => void;
  /** Privileged, no active or upcoming season: opens the season setup (the header
   *  action with no season ever; a "Start a season" line under last season's finals). */
  onStartSeason?: () => void;
  onPressRow: (row: StandingsPreviewRow) => void;
};

export default function SeasonStrip({
  data, loading, error, privileged, onRetry, onOpenTable, onOpenMembers, onStartSeason, onPressRow,
}: SeasonStripProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);

  if (!data) {
    if (loading) {
      return (
        <View style={styles.section}>
          <SectionHeader title="Standings" />
          <Panel padded={false} radius={RADIUS.lg}>
            <SkeletonList rows={3} variant="row" rowHeight={ROW_MIN_HEIGHT.double} />
          </Panel>
        </View>
      );
    }
    if (error) {
      return (
        <View style={styles.section}>
          <SectionHeader title="Standings" />
          <Panel padded={false} radius={RADIUS.lg}>
            <ErrorState
              compact
              iconName="offline"
              error={error}
              message={`Couldn't load standings. ${friendlySbMessage(error)}`}
              onRetry={onRetry}
            />
          </Panel>
        </View>
      );
    }
    return null;
  }
  if (data.rows.length === 0) return null;

  // withEnd: the line also names the season's end ("Period 7 locks Oct 20 ·
  // Ends Dec 1"), so it may wrap to a second line on a narrow phone.
  const head = leagueStandingsHeader(data, { privileged, withEnd: true });
  const ranked = data.kind === 'live' || data.kind === 'locked' || data.kind === 'final';
  const seasonId = data.seasonId;
  const action = seasonId
    ? { label: 'Full table', a11yLabel: 'Full standings table', onPress: () => onOpenTable(seasonId), chevron: true }
    : privileged && onStartSeason
      ? { label: 'Start a season', a11yLabel: 'Start a season', onPress: onStartSeason, chevron: true }
      : { label: 'Members', a11yLabel: 'All members', onPress: onOpenMembers, chevron: true };
  // Real standings page through the full table; a by-PLUPR list through Members.
  const seeAll = ranked && seasonId ? () => onOpenTable(seasonId) : onOpenMembers;
  // Between seasons the header keeps "Full table" for last season's finals, so
  // the start prompt (plan section 5, slot 3) gets its own line; Home's "Start a
  // season" lands here.
  const startLine = privileged && !!onStartSeason && data.kind === 'final';

  return (
    <View style={styles.section}>
      <SectionHeader title={head.title} count={head.label ?? undefined} action={action} />
      {head.subtitle ? (
        <Text style={[t.meta, styles.subtitle]} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {head.subtitle}
        </Text>
      ) : null}
      {startLine ? (
        <TouchableOpacity
          style={styles.startLine}
          onPress={onStartSeason}
          accessibilityRole="button"
          accessibilityLabel="No active season. Start one."
        >
          <View style={styles.startRow}>
            <Text style={[t.meta, styles.shrink]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              No active season ·
            </Text>
            <Text style={[t.meta, { color: c.primary }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Start a season
            </Text>
            <Icon name="chevron-right" size={14} color={c.primary} />
          </View>
        </TouchableOpacity>
      ) : null}
      <StandingsPreview
        rows={data.rows}
        maxRows={LEAGUE_STANDINGS_ROWS}
        pinMe
        middleLabel={data.middleLabel}
        medals={data.medals}
        onPressRow={onPressRow}
        onSeeAll={seeAll}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.xs },
  // Sits under the 44 header, above the table: tucked up to read as its caption.
  subtitle: { marginTop: -SPACE.xs, marginBottom: SPACE.xxs },
  startLine: { minHeight: 44, justifyContent: 'center' },
  startRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  shrink: { flexShrink: 1 },
});
