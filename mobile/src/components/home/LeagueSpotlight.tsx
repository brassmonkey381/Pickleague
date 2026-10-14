// LEAGUE SPOTLIGHT (it replaced YOURS, which repeated Play's "Mine" list): one
// of my leagues, with a glance at its standings.
//
//   YOUR LEAGUE        [Dinks] [Sean Lg]      chips only in 2+ leagues   44
//   ┌ Dinks · Fall · Wk 7/12              › ┐  header -> LeagueDetail     44
//   │ 🥇 Sean K.          8-2   1,512        │  StandingsPreview compact,
//   │ 🥈 You              7-3   1,488  +12   │  top 3, your row pinned     44 each
//   │ 🥉 Ana P.           6-4   1,470        │
//   │ See all 18 ›                           │
//   └ Next: Thu 6 PM · 1 vote open        › ┘  -> EventDetail (vote focus) 44
//   All my leagues (3) ›   My tournaments (2) ›                           44
//
// Which league: the user's chip choice, remembered per user (foundation
// usePersistedState, 'home:spotlight:<userId>'); else, or when the remembered
// league was left, lib/agenda's pickSpotlightLeague (open vote, next event,
// active season, newest match).
//
// Data: the header and the "Next" line come from Home's own payload
// (homeData), so they paint with it. The standings are loaded for the
// SELECTED league only (components/league/useLeagueStandings'
// loadLeagueStandings), lazily on a chip switch, each league under its own
// cache key so switching back is instant (and persisted, so a cold start
// paints the last table at once). No season: the loader falls back to the last
// season's final standings, else the members by PLUPR, so the card is never
// empty; admins also get "Start a season in Manage ›".
import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, SectionHeader, FilterChipRow, SkeletonList, EmptyState, ROW_MIN_HEIGHT } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { usePersistedState } from '@just-messin-around/expo-foundation/hooks';
import { useCachedQuery, cachedFetch } from '@just-messin-around/expo-foundation/cache';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../../lib/ThemeContext';
import {
  pickSpotlightLeague,
  spotlightHeaderLine,
  spotlightNextLine,
  type AgendaTarget,
} from '../../lib/agenda';
import StandingsPreview, { type StandingsPreviewRow } from '../league/StandingsPreview';
import { loadLeagueStandings, type LeagueStandings } from '../league/useLeagueStandings';
import type { HomeLeague } from './homeData';

/** Standings rows on the card before your pinned row and "See all". */
export const SPOTLIGHT_ROWS = 3;
const STANDINGS_TTL_MS = 60_000;
const STANDINGS_PERSIST_MS = 24 * 60 * 60 * 1000;
/** Chip labels are cut here so a long league name can't fill the row. */
const CHIP_LABEL_MAX = 16;

type Choice = { leagueId: string | null };
const NO_CHOICE: Choice = { leagueId: null };

export type LeagueSpotlightState = {
  /** null until the remembered choice has loaded (or with no leagues). */
  selected: HomeLeague | null;
  select: (leagueId: string) => void;
  standings: { data: LeagueStandings | undefined; loading: boolean; error: unknown };
  /** Forced reload of the selected league's standings (pull-to-refresh, Retry). */
  refresh: () => Promise<void>;
  /** TTL-guarded reload (focus): free while the table is fresh. Never rejects. */
  revalidate: () => Promise<void>;
};

/** Which league the spotlight shows, and its standings. HomeScreen owns it so
 *  pull-to-refresh and focus reach the table too. */
export function useLeagueSpotlight(leagues: HomeLeague[], userId: string | null, now: number): LeagueSpotlightState {
  const [choice, setChoice, { ready }] = usePersistedState<Choice>(
    userId ? `home:spotlight:${userId}` : null,
    { version: 1, defaults: NO_CHOICE },
  );
  const defaultId = useMemo(() => pickSpotlightLeague(leagues.map(l => ({
    id: l.id,
    openVotes: l.openVotes,
    openVoteEndsAt: l.openVote?.endsAt ?? null,
    nextEventAt: l.nextEventAt,
    season: l.season,
    lastMatchAt: l.lastMatchAt ?? null,
  })), now), [leagues, now]);
  // Held until the stored choice is read, so a remembered league never loads
  // the default league's table first.
  const selected = !ready
    ? null
    : leagues.find(l => l.id === choice.leagueId) ?? leagues.find(l => l.id === defaultId) ?? null;
  const leagueId = selected?.id ?? null;

  const enabled = !!leagueId && !!userId;
  // userId is in the key: the rows mark "You" by it.
  const key = enabled ? `home:spotlight:standings:${userId}:${leagueId}` : 'home:spotlight:standings:none';
  const fetcher = useCallback(
    () => loadLeagueStandings({ leagueId: leagueId as string, myUserId: userId }),
    [leagueId, userId],
  );
  const q = useCachedQuery<LeagueStandings>(key, fetcher, {
    ttlMs: STANDINGS_TTL_MS,
    persistMs: STANDINGS_PERSIST_MS,
    enabled,
  });
  // useCachedQuery's `error` isn't keyed: after a chip switch it still holds the
  // previous league's failure until the new league's fetch settles. Pin each
  // error to the key it arrived under so a switch shows the skeleton, not a
  // false "Couldn't load".
  const errRef = useRef<{ key: string; error: unknown }>({ key, error: q.error });
  if (q.error !== errRef.current.error) errRef.current = { key, error: q.error };
  const error = errRef.current.key === key ? q.error : null;
  const revalidate = useCallback(async () => {
    if (!enabled) return;
    try {
      await cachedFetch(key, fetcher, { ttlMs: STANDINGS_TTL_MS, persistMs: STANDINGS_PERSIST_MS });
    } catch {
      // The table keeps its last good rows; the card's Retry covers a first load.
    }
  }, [enabled, key, fetcher]);
  const { refresh } = q;
  const refreshSelected = useCallback(async () => { if (enabled) await refresh(); }, [enabled, refresh]);
  const select = useCallback((id: string) => setChoice({ leagueId: id }), [setChoice]);

  return {
    selected,
    select,
    standings: { data: q.data, loading: enabled && q.data === undefined && error == null, error },
    refresh: refreshSelected,
    revalidate,
  };
}

function chipLabel(name: string): string {
  return name.length > CHIP_LABEL_MAX ? `${name.slice(0, CHIP_LABEL_MAX - 1).trimEnd()}…` : name;
}

/** The small line under the header for anything but a live period table. */
function standingsCaption(d: LeagueStandings): string | null {
  switch (d.kind) {
    case 'locked': return d.period != null ? `Period ${d.period} locked` : null;
    case 'noMatches': return 'No matches yet · by PLUPR';
    case 'upcoming': return 'Members by PLUPR';
    case 'final': return d.seasonName ? `${d.seasonName} final standings` : 'Final standings';
    case 'leaderboard': return 'No season yet · members by PLUPR';
    default: return null;
  }
}

type Props = {
  leagues: HomeLeague[];
  spotlight: LeagueSpotlightState;
  /** Live / upcoming tournament registrations ("My tournaments (N) ›"). */
  tournamentCount: number;
  now: number;
  onSelect: (leagueId: string, position: number) => void;
  onHeader: (l: HomeLeague) => void;
  onRow: (row: StandingsPreviewRow) => void;
  /** "See all N ›": the standings (or, for a by-PLUPR list, the members). */
  onSeeAll: (l: HomeLeague, d: LeagueStandings) => void;
  onNext: (target: AgendaTarget) => void;
  /** Admin, no season: "Start a season in Manage ›". */
  onStartSeason: (l: HomeLeague) => void;
  onAllLeagues: () => void;
  onMyTournaments: () => void;
};

export default function LeagueSpotlight({
  leagues,
  spotlight,
  tournamentCount,
  now,
  onSelect,
  onHeader,
  onRow,
  onSeeAll,
  onNext,
  onStartSeason,
  onAllLeagues,
  onMyTournaments,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { selected, standings } = spotlight;
  const chipOptions = useMemo(() => leagues.map(l => ({ value: l.id, label: chipLabel(l.name) })), [leagues]);

  const links = (leagues.length >= 2 || tournamentCount > 0) ? (
    <View style={styles.links}>
      {leagues.length >= 2 ? (
        <TouchableOpacity
          style={styles.link}
          activeOpacity={0.6}
          onPress={onAllLeagues}
          accessibilityRole="button"
          accessibilityLabel={`All my leagues, ${leagues.length}`}
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            All my leagues ({leagues.length}) ›
          </Text>
        </TouchableOpacity>
      ) : null}
      {tournamentCount > 0 ? (
        <TouchableOpacity
          style={styles.link}
          activeOpacity={0.6}
          onPress={onMyTournaments}
          accessibilityRole="button"
          accessibilityLabel={`My tournaments, ${tournamentCount}`}
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            My tournaments ({tournamentCount}) ›
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  ) : null;

  // Not in a league: no card (JOIN A LEAGUE shows), but registrations stay reachable.
  if (leagues.length === 0) return links;

  const header = (
    <View style={styles.headRow}>
      <SectionHeader title="Your league" style={styles.headTitle} />
      {leagues.length >= 2 ? (
        <FilterChipRow
          size="md"
          scrollable
          scrollToSelected
          options={chipOptions}
          value={selected?.id ?? ''}
          onChange={(id) => {
            if (id === selected?.id) return;
            onSelect(id, leagues.findIndex(l => l.id === id));
            spotlight.select(id);
          }}
          style={styles.chips}
        />
      ) : null}
    </View>
  );

  if (!selected) {
    // The remembered choice is still loading (a frame or two).
    return (
      <View style={styles.section}>
        {header}
        <Panel padded={false} radius={RADIUS.lg}>
          <SkeletonList rows={SPOTLIGHT_ROWS + 1} variant="row" rowHeight={ROW_MIN_HEIGHT.single} />
        </Panel>
        {links}
      </View>
    );
  }

  const l = selected;
  const privileged = l.role === 'admin' || l.role === 'co-admin';
  const data = standings.data;
  const headLine = spotlightHeaderLine(l, now);
  const caption = data ? standingsCaption(data) : null;

  const nextText = spotlightNextLine({ openVotes: l.openVotes, nextEventAt: l.nextEventAt }, now);
  const vote = l.openVote ?? null;
  const ev = l.nextEvent && Date.parse(l.nextEvent.startsAt) > now ? l.nextEvent : null;
  // An open vote opens the event at its vote; else the next event itself.
  const nextTarget: AgendaTarget | null = vote
    ? { screen: 'EventDetail', params: { eventId: vote.id, title: vote.title, focus: 'vote' } }
    : ev
      ? { screen: 'EventDetail', params: { eventId: ev.id, title: ev.title } }
      : null;
  const noSeason = !l.season && (!data || data.kind === 'final' || data.kind === 'leaderboard');

  const cardHeader = (
    <TouchableOpacity
      style={styles.cardHeader}
      activeOpacity={0.7}
      onPress={() => onHeader(l)}
      accessibilityRole="button"
      accessibilityLabel={`${headLine}${caption ? `. ${caption}` : ''}. Open league`}
    >
      <View style={styles.flex}>
        <Text style={[t.sub, styles.headLine]} numberOfLines={1}>{headLine}</Text>
        {caption ? (
          <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{caption}</Text>
        ) : null}
      </View>
      <Text style={[t.sub, { color: c.textMuted }]}>›</Text>
    </TouchableOpacity>
  );

  const footerLines: React.ReactElement[] = [];
  if (nextText) {
    footerLines.push(
      <TouchableOpacity
        key="next"
        style={styles.line}
        activeOpacity={0.7}
        disabled={!nextTarget}
        onPress={() => { if (nextTarget) onNext(nextTarget); }}
        accessibilityRole={nextTarget ? 'button' : 'text'}
        accessibilityLabel={nextText}
      >
        <Text style={[t.sub, styles.flex, { color: c.text }]} numberOfLines={1}>{nextText}</Text>
        {nextTarget ? <Text style={[t.sub, { color: c.textMuted }]}>›</Text> : null}
      </TouchableOpacity>,
    );
  }
  if (noSeason && privileged) {
    footerLines.push(
      <TouchableOpacity
        key="start-season"
        style={[styles.line, footerLines.length > 0 && styles.divider, { borderTopColor: c.border }]}
        activeOpacity={0.6}
        onPress={() => onStartSeason(l)}
        accessibilityRole="button"
        accessibilityLabel="Start a season in Manage"
      >
        <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          Start a season in Manage ›
        </Text>
      </TouchableOpacity>,
    );
  }
  const footer = footerLines.length > 0 ? <>{footerLines}</> : null;
  const divider = { borderTopWidth: HAIRLINE, borderTopColor: c.border };

  let card: React.ReactElement;
  if (data && data.rows.length > 0) {
    card = (
      <StandingsPreview
        rows={data.rows}
        maxRows={SPOTLIGHT_ROWS}
        pinMe
        compact
        middleLabel={data.middleLabel}
        medals={data.medals}
        onPressRow={onRow}
        onSeeAll={() => onSeeAll(l, data)}
        header={cardHeader}
        footer={footer}
      />
    );
  } else {
    // Loading, a failed first load, or (never expected: I'm a member) no rows.
    let body: React.ReactNode = null;
    if (!data && standings.error) {
      body = (
        <EmptyState
          compact
          icon="📡"
          title="Couldn't load standings"
          subtitle={friendlySbMessage(standings.error)}
          actionLabel="Retry"
          onAction={() => { void spotlight.refresh(); }}
        />
      );
    } else if (!data) {
      body = <SkeletonList rows={SPOTLIGHT_ROWS} variant="row" rowHeight={ROW_MIN_HEIGHT.single} />;
    } else if (!footer) {
      body = (
        <Text style={[t.meta, styles.line]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>No season yet</Text>
      );
    }
    card = (
      <Panel padded={false} radius={RADIUS.lg}>
        {cardHeader}
        {body ? <View style={divider}>{body}</View> : null}
        {footer ? <View style={divider}>{footer}</View> : null}
      </Panel>
    );
  }

  return (
    <View style={styles.section}>
      {header}
      {card}
      {links}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.xs },
  flex: { flex: 1, minWidth: 0 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  headTitle: { flexShrink: 0 },
  // Beside the label; scrolls sideways when the names don't fit.
  chips: { flex: 1, minWidth: 0 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_MIN_HEIGHT.single,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs,
    gap: SPACE.sm,
  },
  headLine: { fontWeight: FONT.weight.bold },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_MIN_HEIGHT.single,
    paddingHorizontal: SPACE.md,
    gap: SPACE.sm,
  },
  divider: { borderTopWidth: HAIRLINE },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.lg },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md },
});
