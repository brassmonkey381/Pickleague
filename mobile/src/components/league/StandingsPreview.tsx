// A short standings table, shared by LeagueDetail's Standings section and the
// Home league card:
//
//   #    Player                         W-L     PLUPR
//   (1)  (av) Alice                     5-1     3.82 +0.32       56 (44 compact)
//   (2)  (av) You                       4-2     3.71 +0.21
//   ...  top `maxRows`; (1)-(3) are RankMedal discs
//   ---- (heavier rule: the next row isn't adjacent in rank)
//   12   (av) You                       1-4     3.31 -0.19      your row, pinned
//   See all 18 >                                                 44 (TextLink)
//
// The columns mean what SeasonStandings' StandingsTable columns mean (the
// caller builds the rows from the same numbers, see useLeagueStandings), so a
// row here and the same row in "Full table" always agree. Purely
// presentational: no data, no navigation.
//
// `compact` (Home): 44 rows, no avatar, no column header. Rows are minHeight,
// never height, so large text grows a row instead of clipping it.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, RankMedal, ROW_MIN_HEIGHT, TextLink } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { AVATARS } from '../../data/profileCustomization';
import { formatPluprChange } from '../standings/standingsModel';
import FlairName from '../FlairName';

export type StandingsPreviewRow = {
  userId: string;
  /** 1-based position in the full list. */
  rank: number;
  name: string;
  /** Name flair (profiles.name_color / list_name_style_id). */
  flair?: { nameColor?: string | null; styleId?: string | null } | null;
  /** profiles.avatar_id (the emoji avatar). */
  avatar?: number | null;
  /** Record in the ranked window. null/undefined with no `middle` shows "–". */
  wins?: number | null;
  losses?: number | null;
  /** Overrides the W-L cell, e.g. "2.5" (median rank) on final standings. */
  middle?: string | null;
  /** PLUPR; null = not rated ("NR"). */
  rating: number | null;
  /** Change shown after the PLUPR ("+0.12"); null/0 shows nothing. */
  ratingDelta?: number | null;
  isMe: boolean;
};

export type StandingsPreviewProps = {
  /** The FULL ranked list (the preview slices it), in rank order. */
  rows: StandingsPreviewRow[];
  /** Rows shown before "your row" and "See all". Default 10. */
  maxRows?: number;
  /** Pin the viewer's row under a heavier rule when it's below `maxRows`. Default true. */
  pinMe?: boolean;
  onPressRow: (row: StandingsPreviewRow) => void;
  /** "See all N" footer link, shown only when rows are hidden. */
  onSeeAll?: () => void;
  /** N in "See all N" when `rows` is not the whole list. Default rows.length. */
  totalCount?: number;
  /** Third column's header ("W-L", "Median"); null hides the column. Default "W-L". */
  middleLabel?: string | null;
  /** RankMedal discs for the top 3 (real standings). False for a by-PLUPR preview. Default true. */
  medals?: boolean;
  /** Home card: 44 rows, no avatar, no column header. */
  compact?: boolean;
  /** Drawn inside the panel above the rows (Home's league line); the first row
   *  then gets a divider. Optional: without it the panel is unchanged. */
  header?: React.ReactNode;
  /** Drawn inside the panel below the rows and "See all", under a divider
   *  (Home's "Next" line). */
  footer?: React.ReactNode;
};

/** Which rows the preview draws: the top `maxRows`, plus the viewer's row when pinned. */
export function previewSlice(
  rows: ReadonlyArray<StandingsPreviewRow>,
  maxRows: number,
  pinMe: boolean,
): { top: StandingsPreviewRow[]; pinned: StandingsPreviewRow | null } {
  const top = rows.slice(0, Math.max(0, maxRows));
  const me = pinMe ? rows.find((r) => r.isMe) ?? null : null;
  return { top, pinned: me && !top.includes(me) ? me : null };
}

export default function StandingsPreview({
  rows,
  maxRows = 10,
  pinMe = true,
  onPressRow,
  onSeeAll,
  totalCount,
  middleLabel = 'W-L',
  medals = true,
  compact = false,
  header,
  footer,
}: StandingsPreviewProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c, compact);

  if (rows.length === 0) return null;
  const { top, pinned } = previewSlice(rows, maxRows, pinMe);
  const total = Math.max(totalCount ?? rows.length, rows.length);
  const shown = top.length + (pinned ? 1 : 0);
  const showSeeAll = !!onSeeAll && total > shown;
  const showHead = !compact;
  const drawn = pinned ? [...top, pinned] : top;
  const above = showHead || header != null;

  const renderRow = (row: StandingsPreviewRow, i: number) => {
    const first = i === 0 && !above;
    const last = i === drawn.length - 1 && !showSeeAll && footer == null;
    const isPinned = row === pinned;
    const name = row.isMe ? 'You' : row.name || 'Player';
    const record = row.middle ?? (row.wins != null && row.losses != null ? `${row.wins}-${row.losses}` : '–');
    const rating = row.rating != null && Number.isFinite(row.rating) ? row.rating.toFixed(2) : 'NR';
    const change = row.ratingDelta != null ? formatPluprChange(row.ratingDelta) : '';
    const av = AVATARS.find((a) => a.id === (row.avatar ?? 1)) ?? AVATARS[0];
    return (
      <TouchableOpacity
        key={isPinned ? `${row.userId}@pinned` : row.userId}
        onPress={() => onPressRow(row)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={
          `${row.isMe ? 'You, ' : ''}rank ${row.rank}, ${row.name || 'Player'}`
          + (middleLabel ? `, ${middleLabel} ${record}` : '')
          + `, PLUPR ${rating}${change ? ` ${change}` : ''}`
        }
        style={[
          S.row,
          (i > 0 || above) && S.divider,
          isPinned && S.pinnedRule,
          row.isMe && S.mine,
          first && S.firstRow,
          last && S.lastRow,
        ]}
      >
        {medals && row.rank <= 3 ? (
          <View style={S.colRank}>
            <RankMedal place={row.rank} />
          </View>
        ) : (
          <Text
            style={[S.colRank, t.meta, S.rankNum, { color: row.isMe ? c.primary : c.textSub }]}
            maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
          >
            {String(row.rank)}
          </Text>
        )}
        <View style={[S.colName, S.nameCell]}>
          {compact ? null : (
            <View style={[S.avatar, { backgroundColor: av.bgColor }]}>
              <Text style={S.avatarEmoji} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{av.emoji}</Text>
            </View>
          )}
          <FlairName
            name={name}
            nameColor={row.flair?.nameColor}
            styleId={row.flair?.styleId ?? null}
            mode="list"
            style={[t.sub, S.name, row.isMe && S.meName]}
            numberOfLines={1}
          />
        </View>
        {middleLabel ? <Text style={[t.sub, S.colMid, { color: c.text }]} numberOfLines={1}>{record}</Text> : null}
        <View style={[S.colPlupr, S.pluprCell]}>
          <Text style={[t.sub, S.pluprValue]} numberOfLines={1}>{rating}</Text>
          {change ? (
            <Text
              style={[t.meta, { color: change.startsWith('+') ? c.success : c.danger }]}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            >
              {change}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Panel padded={false} radius={RADIUS.lg}>
      {header}
      {showHead ? (
        <View style={[S.row, S.headRow, header != null && S.divider]} accessibilityRole="header">
          <Text style={[t.fieldLabel, S.colRank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>#</Text>
          <Text style={[t.fieldLabel, S.colName]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Player</Text>
          {middleLabel ? (
            <Text style={[t.fieldLabel, S.colMid]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{middleLabel}</Text>
          ) : null}
          <Text style={[t.fieldLabel, S.colPlupr, S.right]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>PLUPR</Text>
        </View>
      ) : null}
      {drawn.map(renderRow)}
      {showSeeAll && onSeeAll ? (
        <View style={S.divider}>
          <TextLink
            label={`See all ${total}`}
            onPress={onSeeAll}
            accessibilityLabel={`See all ${total} players`}
            style={S.seeAll}
          />
        </View>
      ) : null}
      {footer != null ? <View style={S.divider}>{footer}</View> : null}
    </Panel>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors'], compact: boolean) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: compact ? ROW_MIN_HEIGHT.single : ROW_MIN_HEIGHT.double,
      paddingHorizontal: SPACE.md,
      gap: SPACE.sm,
    },
    headRow: { minHeight: 32 },
    divider: { borderTopWidth: HAIRLINE, borderTopColor: c.border },
    // The pinned row isn't adjacent in rank: a heavier rule says so.
    pinnedRule: { borderTopWidth: HAIRLINE * 3 },
    mine: { backgroundColor: c.primaryLight },
    // The Panel's radius clips nothing on its own; round an edge row's tint to match.
    firstRow: { borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg },
    lastRow: { borderBottomLeftRadius: RADIUS.lg, borderBottomRightRadius: RADIUS.lg },
    colRank: { width: 28, alignItems: 'center', textAlign: 'center' },
    rankNum: { fontVariant: ['tabular-nums'], letterSpacing: 0 },
    colName: { flex: 1, minWidth: 0 },
    colMid: { width: 52, textAlign: 'center' },
    colPlupr: { width: 92 },
    right: { textAlign: 'right' },
    nameCell: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    avatar: { width: 32, height: 32, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: FONT.size.lg },
    name: { flexShrink: 1, color: c.text, fontWeight: FONT.weight.semibold },
    meName: { fontWeight: FONT.weight.bold },
    pluprCell: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end', gap: SPACE.xs },
    pluprValue: { color: c.text, fontWeight: FONT.weight.bold },
    // The link's 44 box spans the row, so the whole footer is the tap target.
    seeAll: { alignSelf: 'stretch', minHeight: ROW_MIN_HEIGHT.single, paddingHorizontal: SPACE.md },
  });
}
