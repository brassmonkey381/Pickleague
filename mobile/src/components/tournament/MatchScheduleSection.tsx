import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { FilterChipRow, FilterPill, SingleSelectModal, type FilterChipOption } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { Tournament } from '../../types';
import { FlowOverviewStage } from '../TournamentFlowOverview';
import { WAGERS_ENABLED } from '../../lib/features';
import { useTournamentDetailStyles } from './styles';
import SectionCard from './SectionCard';
import {
  canRecordMatch, filterSchedule, hasBothStages, involves, isScheduleFiltered, visibleScheduleMatches,
  EMPTY_SCHEDULE_FILTER, type ScheduleFilter, type ScheduleMatch,
} from './tournamentModel';
import type { TournamentDetailNavigation, TournamentDetailState } from './useTournamentDetail';

/** Matches listed before "Show N more" while no filter is on. */
const UNFILTERED_LIMIT = 12;

type ChipKey = 'mine' | 'to_play' | 'done' | 'group' | 'playoff';

type Props = {
  navigation: TournamentDetailNavigation;
  tournament: Tournament;
  myUserId: string | null;
  isPriv: boolean;
  upcomingStages: FlowOverviewStage[];
  filter: ScheduleFilter;
  setFilter: (f: ScheduleFilter) => void;
  /** "History" in the header: the full TournamentMatchHistory screen. */
  onOpenHistory: () => void;
} & Pick<TournamentDetailState, 'savedMatches' | 'savedRounds' | 'playerName' | 'openMatchActionSheet'>;

/**
 * The saved schedule of an active or completed tournament (the caller gates
 * it), P5b layout: chips Mine / To play / Done, stage chips (Group / Playoff,
 * only when both exist), and a Round filter pill. The round label on every
 * group of rows ships with that Round pill (the match-history filter-pill
 * convention). A tapped flow-strip card sets the same round filter. Each
 * predicted stage the DB hasn't created yet is one line.
 *
 * A row opens MatchEntry only for someone who can record it (its players, the
 * organizers): a spectator gets no chevron and no tap. Long-press still opens
 * the wager sheet when wagering is on.
 */
export default function MatchScheduleSection({
  navigation, tournament, myUserId, isPriv, upcomingStages, filter, setFilter, onOpenHistory,
  savedMatches, savedRounds, playerName, openMatchActionSheet,
}: Props) {
  const { S, c } = useTournamentDetailStyles();
  const [expanded, setExpanded] = useState(false);
  const [roundPickerOpen, setRoundPickerOpen] = useState(false);

  const visible = useMemo(() => visibleScheduleMatches(savedMatches as ScheduleMatch[]), [savedMatches]);
  const myCount = visible.filter(m => involves(m, myUserId)).length;
  const displayed = useMemo(
    () => filterSchedule(savedMatches as ScheduleMatch[], filter, { myUserId, format: tournament.format }),
    [savedMatches, filter, myUserId, tournament.format],
  );
  const filtered = isScheduleFiltered(filter);
  const showStages = hasBothStages(savedRounds, tournament.format);
  const rounds = useMemo(
    () => [...savedRounds].sort((a: any, b: any) => a.round_number - b.round_number),
    [savedRounds],
  );
  const selectedRound = filter.roundId ? rounds.find((r: any) => r.id === filter.roundId) : null;

  // ── Chips ──
  const options: FilterChipOption<ChipKey>[] = [];
  if (myCount > 0) options.push({ value: 'mine', label: 'Mine', count: myCount });
  options.push({ value: 'to_play', label: 'To play' }, { value: 'done', label: 'Done' });
  if (showStages) options.push({ value: 'group', label: 'Group stage' }, { value: 'playoff', label: 'Playoff' });
  const values: ChipKey[] = [];
  if (filter.mine) values.push('mine');
  if (filter.play !== 'all') values.push(filter.play);
  if (filter.stage !== 'all') values.push(filter.stage);
  function onChangeValues(next: ChipKey[]) {
    const added = next.find(v => !values.includes(v));
    // To play / Done are exclusive, and so are Group / Playoff: the chip just
    // tapped wins over its partner.
    let play: ScheduleFilter['play'] = 'all';
    if (next.includes('to_play') && next.includes('done')) play = added === 'done' ? 'done' : 'to_play';
    else if (next.includes('to_play')) play = 'to_play';
    else if (next.includes('done')) play = 'done';
    let stage: ScheduleFilter['stage'] = 'all';
    if (next.includes('group') && next.includes('playoff')) stage = added === 'playoff' ? 'playoff' : 'group';
    else if (next.includes('group')) stage = 'group';
    else if (next.includes('playoff')) stage = 'playoff';
    setFilter({ ...filter, mine: next.includes('mine'), play, stage });
  }

  // ── Rows, grouped by round, capped while unfiltered ──
  const limit = filtered || expanded ? displayed.length : UNFILTERED_LIMIT;
  const groups = useMemo(() => {
    const out: { round: any | null; matches: any[] }[] = [];
    const idx = new Map<string, number>();
    for (const m of displayed) {
      const key = m.round?.id ?? '__no_round__';
      let i = idx.get(key);
      if (i === undefined) { i = out.length; idx.set(key, i); out.push({ round: m.round ?? null, matches: [] }); }
      out[i].matches.push(m);
    }
    out.sort((a, b) => (a.round?.round_number ?? 999) - (b.round?.round_number ?? 999));
    return out;
  }, [displayed]);
  const hiddenCount = Math.max(0, displayed.length - limit);

  let globalIdx = 0;
  const groupViews = groups.map((group, gi) => {
    const rows: React.ReactNode[] = [];
    for (const m of group.matches) {
      if (globalIdx >= limit) break;
      const i = globalIdx++;
      rows.push(renderMatch(m, i));
    }
    if (rows.length === 0) return null;
    return (
      <View key={group.round?.id ?? `g${gi}`} style={gi > 0 && S.roundBlock}>
        {group.round?.label ? <Text style={S.roundLabel}>{group.round.label}</Text> : null}
        {rows}
      </View>
    );
  });

  function renderMatch(m: any, i: number) {
    const t1 = [m.team1_player1, m.team1_player2].filter(Boolean).map(playerName).join(' & ') || '—';
    const t2 = [m.team2_player1, m.team2_player2].filter(Boolean).map(playerName).join(' & ') || '—';
    const isMyMatch = involves(m, myUserId);
    const completed = m.status === 'completed' && m.winner_team != null;
    const team1Won = m.winner_team === 'team1';
    // Pending dreambreaker = 5th singles sub-match the meeting is tied 2-2
    // and needs to play out.
    const isPendingDreambreaker = m.is_dreambreaker && m.status === 'pending';
    // BYE rows: a single seed advancing to the next round; no scoring, no tap.
    if (m.match_type === 'bye') {
      return (
        <View key={m.id} style={[S.matchRow, isMyMatch && S.matchRowHighlight]}>
          <Text style={S.matchNum}>{i + 1}</Text>
          <Text style={[S.matchup, S.matchupWinner, isMyMatch && S.matchupHighlight]} numberOfLines={1}>{t1}</Text>
          <Text style={S.vs}>—</Text>
          <Text style={S.matchup} numberOfLines={1}>bye to next round</Text>
          {isMyMatch && <Text style={S.youTag}>YOU</Text>}
        </View>
      );
    }
    const tappable = canRecordMatch(m, { isPriv, myUserId });
    const handlePress = () => navigation.navigate('MatchEntry', {
      leagueId:           tournament?.league_id ?? '',
      tournamentId:       tournament?.id,
      tournamentMatchId:  m.id,
      tournamentName:     tournament?.name,
      prefillMatchType:   m.match_type,
      prefillTeam1Player: m.team1_player1 ?? undefined,
      prefillTeam1Partner:m.team1_player2 ?? undefined,
      prefillTeam2Player: m.team2_player1 ?? undefined,
      prefillTeam2Partner:m.team2_player2 ?? undefined,
    });
    // Gated (lib/features.ts): with wagering off there is nothing for a
    // long-press to open.
    const wagerable = WAGERS_ENABLED && !completed && !!m.team1_player1 && !!m.team2_player1;
    const Row: any = tappable || wagerable ? TouchableOpacity : View;
    const rowProps: Record<string, any> = {};
    if (tappable) {
      rowProps.onPress = handlePress;
      rowProps.activeOpacity = 0.6;
      rowProps.accessibilityRole = 'button';
      rowProps.accessibilityLabel = `Record ${t1} versus ${t2}`;
    }
    if (wagerable) rowProps.onLongPress = () => openMatchActionSheet(m);
    return (
      <React.Fragment key={m.id}>
        {isPendingDreambreaker && (
          <View style={[local.dreamBadge, { backgroundColor: c.warningLight }]}>
            <Icon name="trophy" size={12} color={c.warning} />
            <Text style={[local.dreamText, { color: c.warning }]}>Dreambreaker (singles tiebreaker)</Text>
          </View>
        )}
        <Row style={[S.matchRow, isMyMatch && S.matchRowHighlight]} {...rowProps}>
          <Text style={S.matchNum}>{i + 1}</Text>
          <Text style={[
            S.matchup,
            completed && team1Won && S.matchupWinner,
            completed && !team1Won && S.matchupLoser,
            isMyMatch && S.matchupHighlight,
          ]} numberOfLines={1}>{t1}</Text>
          {completed ? (
            <Text style={S.matchScore}>{m.team1_score}–{m.team2_score}</Text>
          ) : (
            <Text style={S.vs}>vs</Text>
          )}
          <Text style={[
            S.matchup,
            completed && !team1Won && S.matchupWinner,
            completed && team1Won && S.matchupLoser,
            isMyMatch && S.matchupHighlight,
          ]} numberOfLines={1}>{t2}</Text>
          {isMyMatch && <Text style={S.youTag}>YOU</Text>}
          {tappable && !isMyMatch && <Icon name="chevron-right" size={16} color={c.textMuted} />}
        </Row>
      </React.Fragment>
    );
  }

  const expectedTotal = visible.length + upcomingStages.reduce((n, s) => n + s.total, 0);

  return (
    <SectionCard
      title="Schedule"
      count={filtered ? `${displayed.length} of ${visible.length}` : visible.length}
      action={{ label: 'History', onPress: onOpenHistory, a11yLabel: 'Open the full match history' }}
    >
      <FilterChipRow
        size="md"
        multi
        options={options}
        values={values}
        onChangeValues={onChangeValues}
        wrapAtWidth={600}
        trailing={rounds.length > 1 ? (
          <FilterPill
            label={selectedRound?.label ?? 'Round'}
            active={!!selectedRound}
            trailingIconName="chevron-down"
            onPress={() => setRoundPickerOpen(true)}
            accessibilityLabel={selectedRound ? `Round: ${selectedRound.label}. Change round` : 'Filter by round'}
          />
        ) : undefined}
      />

      {displayed.length === 0 ? (
        <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <Text style={[S.note, { flex: 1 }]}>
            {filter.mine && myCount === 0 ? 'You have no matches in this tournament.' : 'No matches match these filters.'}
          </Text>
          <TouchableOpacity
            onPress={() => setFilter(EMPTY_SCHEDULE_FILTER)}
            style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}
            accessibilityRole="button"
          >
            <Text style={[S.note, { color: c.primary, fontWeight: FONT.weight.bold }]}>Clear</Text>
          </TouchableOpacity>
        </View>
      ) : groupViews}

      {hiddenCount > 0 && (
        <TouchableOpacity
          onPress={() => setExpanded(true)}
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
          accessibilityRole="button"
        >
          <Text style={[S.note, { color: c.primary, fontWeight: FONT.weight.bold }]}>Show {hiddenCount} more</Text>
        </TouchableOpacity>
      )}

      {/* Upcoming stages the DB hasn't created yet: one line each, so the
          whole road to the final is visible from lock-in. */}
      {!filtered && upcomingStages.length > 0 && (
        <View style={S.roundBlock}>
          <Text style={S.roundLabel}>Still to come · {expectedTotal} matches expected</Text>
          {upcomingStages.map(stage => (
            <View key={stage.key} style={[S.row, S.rowLast]}>
              <Text style={[S.note, { flex: 1 }]} numberOfLines={1}>
                {stage.label} · {stage.total} match{stage.total === 1 ? '' : 'es'}
                {stage.byes > 0 ? ` · ${stage.byes} bye${stage.byes === 1 ? '' : 's'}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      <SingleSelectModal
        visible={roundPickerOpen}
        title="Round"
        items={rounds.map((r: any) => ({ id: r.id as string, name: (r.label as string | null) ?? `Round ${r.round_number}` }))}
        selectedId={filter.roundId}
        noneLabel="All rounds"
        onPick={(id) => { setFilter({ ...filter, roundId: id }); setRoundPickerOpen(false); }}
        onClose={() => setRoundPickerOpen(false)}
      />
    </SectionCard>
  );
}

// The dreambreaker label: trophy glyph + words on the warning tint (the shared
// styles.ts `dreambreakerBadge` was a Text pill; a glyph needs a row).
const local = StyleSheet.create({
  dreamBadge: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, alignSelf: 'flex-start',
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs, borderRadius: RADIUS.sm, marginTop: SPACE.xs,
  },
  dreamText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy },
});
