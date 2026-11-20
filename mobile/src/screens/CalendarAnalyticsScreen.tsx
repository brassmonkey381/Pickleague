import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ScrollView, Pressable } from 'react-native';
import { Calendar, DateData } from 'react-native-calendars';
import { RouteProp, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  sbCall,
  currentUserId as sessionUserId,
  friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import { isoDate } from '@just-messin-around/expo-foundation/scheduling/drillTime';
import { ErrorState, FilterChipRow } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { Match, RootStackParamList } from '../types';
import {
  fromTournamentHistoryRow,
  mergeHistory,
  tournamentRatingChange,
  type TournamentHistoryMatch,
  type TournamentHistoryRow,
} from '../lib/tournamentHistory';
import {
  CAL_KIND_LABEL,
  calendarKinds,
  itemsByDay,
  lengthText,
  type CalItem,
  type CalKind,
} from '../lib/calendarItems';
import { PLAY_KIND_LABEL } from '../lib/playHistory';

const shortName = (n: string | null | undefined) => (n ?? '').trim().split(/\s+/)[0] || 'someone';

type Props = { route: RouteProp<RootStackParamList, 'CalendarAnalytics'> };

type DayRecord = {
  wins: number;
  losses: number;
  ratingDelta: number;
  matches: Match[];
};

export default function CalendarAnalyticsScreen({ route }: Props) {
  // A cold /analytics/calendar link carries no params: the signed-in player's own calendar.
  const { userId, leagueId } = route.params ?? ({} as Partial<RootStackParamList['CalendarAnalytics']>);
  return <CalendarAnalyticsView userId={userId} leagueId={leagueId} />;
}

/** The calendar itself, also Play history's Calendar view (the signed-in
 *  player's own matches when `userId` is left out). */
export function CalendarAnalyticsView({ userId, leagueId }: { userId?: string; leagueId?: string }) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [dateMap, setDateMap]       = useState<Record<string, DayRecord>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // PKL-051: what this calendar offers (lib/calendarItems) and which kinds are on.
  const [kinds, setKinds]           = useState<CalKind[]>(['matches']);
  const [shown, setShown]           = useState<CalKind[]>(['matches']);
  const [itemMap, setItemMap]       = useState<Record<string, CalItem[]>>({});

  // LOCAL session read — getUser() is a network call, so offline `uid` came back
  // null and the calendar silently showed EVERYONE's matches instead of yours.
  async function loadAll(sessionUid: string | null, first: boolean) {
    const uid = userId ?? sessionUid;
    setCurrentUserId(uid);
    const offered = calendarKinds({ own: !!uid && uid === sessionUid, leagueId });
    setKinds(offered);
    if (first) setShown(offered);
    await Promise.all([loadMatches(uid), loadItems(uid, offered)]);
  }

  const refresh = useRefresh(async () => {
    await loadAll(await sessionUserId(supabase), false);
  });

  useEffect(() => {
    sessionUserId(supabase).then((sessionUid) => loadAll(sessionUid, true));
  }, []);

  /** Upcoming matches, events, drills and check-ins for this calendar. Each
   *  source is best effort: one failing leaves the others (and the results). */
  async function loadItems(uid: string | null, offered: CalKind[]) {
    if (!uid) { setItemMap({}); return; }
    const items: CalItem[] = [];
    const tries: Promise<void>[] = [];

    if (offered.includes('upcoming')) tries.push((async () => {
      let q = supabase
        .from('matches')
        .select(`id, scheduled_at, match_type, league_id, player1_id, partner1_id, player2_id, partner2_id,
          player1:profiles!matches_player1_id_fkey(full_name), partner1:profiles!matches_partner1_id_fkey(full_name),
          player2:profiles!matches_player2_id_fkey(full_name), partner2:profiles!matches_partner2_id_fkey(full_name),
          league:leagues(name)`)
        .eq('status', 'scheduled')
        .not('scheduled_at', 'is', null)
        .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`);
      if (leagueId) q = q.eq('league_id', leagueId);
      const rows = ((await sbCall(() => q)) ?? []) as any[];
      for (const m of rows) {
        const onTeam1 = m.player1_id === uid || m.partner1_id === uid;
        const opp = onTeam1 ? [m.player2, m.partner2] : [m.player1, m.partner1];
        const names = opp.filter(Boolean).map((p: any) => shortName(p.full_name)).join(' & ');
        items.push({ id: `m:${m.id}`, kind: 'upcoming', at: m.scheduled_at, title: `vs ${names || 'TBD'}`,
          sub: leagueId ? null : m.league?.name ?? null });
      }
    })());

    if (offered.includes('events')) tries.push((async () => {
      let leagueIds: string[];
      if (leagueId) leagueIds = [leagueId];
      else {
        const mem = ((await sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', uid))) ?? []) as { league_id: string }[];
        leagueIds = mem.map((r) => r.league_id);
      }
      if (!leagueIds.length) return;
      const rows = ((await sbCall(() => supabase
        .from('league_events')
        .select('id, title, location_name, league:leagues(name), event_slots!league_events_confirmed_slot_id_fkey!inner(starts_at, ends_at)')
        .in('league_id', leagueIds)
        .in('status', ['scheduled', 'completed']))) ?? []) as any[];
      for (const e of rows) {
        const slot = Array.isArray(e.event_slots) ? e.event_slots[0] : e.event_slots;
        if (!slot?.starts_at) continue;
        items.push({ id: `e:${e.id}`, kind: 'events', at: slot.starts_at, title: e.title, eventId: e.id,
          sub: [e.location_name, leagueId ? null : e.league?.name].filter(Boolean).join(', ') || null });
      }
    })());

    if (offered.includes('drills')) tries.push((async () => {
      const rows = ((await sbCall(() => supabase
        .from('drill_sessions')
        .select('id, player1_id, starts_at, length_minutes, p1:profiles!drill_sessions_player1_id_fkey(full_name), p2:profiles!drill_sessions_player2_id_fkey(full_name), req:drill_requests(location_name)')
        .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
        .not('starts_at', 'is', null))) ?? []) as any[];
      for (const d of rows) {
        const other = d.player1_id === uid ? d.p2 : d.p1;
        const req = Array.isArray(d.req) ? d.req[0] : d.req;
        items.push({ id: `d:${d.id}`, kind: 'drills', at: d.starts_at, title: `Drill with ${shortName(other?.full_name)}`,
          sub: [req?.location_name, d.length_minutes ? `${d.length_minutes} min` : null].filter(Boolean).join(', ') || null });
      }
    })());

    if (offered.includes('play')) tries.push((async () => {
      const rows = ((await sbCall(() => supabase
        .from('play_sessions')
        .select('id, kind, started_at, ended_at, venues(name)')
        .eq('user_id', uid)
        .is('discarded_at', null))) ?? []) as any[];
      for (const p of rows) {
        const venue = Array.isArray(p.venues) ? p.venues[0] : p.venues;
        items.push({ id: `p:${p.id}`, kind: 'play', at: p.started_at,
          title: venue?.name ? `Checked in at ${venue.name}` : 'Checked in',
          sub: [PLAY_KIND_LABEL[p.kind as keyof typeof PLAY_KIND_LABEL], lengthText(p.started_at, p.ended_at)].filter(Boolean).join(', ') || null });
      }
    })());

    await Promise.all(tries.map((t) => t.catch(() => undefined)));
    setItemMap(itemsByDay(items, isoDate));
  }

  function isOnTeam1(match: Match, uid: string) {
    return match.player1_id === uid || match.partner1_id === uid;
  }

  function didWin(match: Match, uid: string) {
    return isOnTeam1(match, uid) ? match.winner_team === 'team1' : match.winner_team === 'team2';
  }

  function buildMatchQuery() {
    let query = supabase
      .from('matches')
      .select(`
        *,
        player1:profiles!matches_player1_id_fkey(id, full_name),
        player2:profiles!matches_player2_id_fkey(id, full_name)
      `)
      .eq('status', 'completed')
      .order('played_at', { ascending: false });
    if (leagueId) query = query.eq('league_id', leagueId);
    return query;
  }

  async function loadMatches(uid: string | null) {
    let data: Match[] | null;
    try {
      // Was `const { data } = await query` — a failed fetch rendered as "no
      // matches on any day", which reads as a wiped history.
      data = await sbCall(() => buildMatchQuery());
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load your match calendar."));
      setLoading(false);
      return;
    }
    // Tournament matches live in tournament_matches (PKL-051: they were missing
    // here). Best effort, like Match History: a failed read keeps league days.
    let tournamentRows: TournamentHistoryMatch[] = [];
    try {
      const rows = await sbCall(() => supabase.rpc('get_tournament_match_history', {
        p_user_id: uid ?? null,
        p_league_id: leagueId ?? null,
        p_limit: 300,
      }));
      tournamentRows = ((rows ?? []) as TournamentHistoryRow[]).map(fromTournamentHistoryRow);
    } catch {
      tournamentRows = [];
    }
    let matches: Match[] = mergeHistory<Match>(data ?? [], tournamentRows);

    if (uid) {
      matches = matches.filter((m) =>
        m.player1_id === uid || m.player2_id === uid ||
        m.partner1_id === uid || m.partner2_id === uid
      );
    }

    const map: Record<string, DayRecord> = {};
    for (const match of matches) {
      // The device's day: played_at comes back in UTC, so its first 10
      // characters put an evening match on the next day.
      const dateKey = isoDate(new Date(match.played_at));
      if (!map[dateKey]) map[dateKey] = { wins: 0, losses: 0, ratingDelta: 0, matches: [] };
      map[dateKey].matches.push(match);

      if (uid) {
        const won = didWin(match, uid);
        if (won) map[dateKey].wins++;
        else map[dateKey].losses++;

        // My own move: a tournament row knows everyone's; a league row only
        // player 1's and player 2's (a partner's teammate moved, not them).
        const t = match as Partial<TournamentHistoryMatch>;
        if (t.source === 'tournament') {
          const d = tournamentRatingChange(t, uid);
          if (d != null) map[dateKey].ratingDelta += d;
        } else if (match.player1_id === uid || match.player2_id === uid) {
          const mine    = match.player1_id === uid;
          const before  = mine ? match.player1_rating_before : match.player2_rating_before;
          const after   = mine ? match.player1_rating_after  : match.player2_rating_after;
          if (before != null && after != null) map[dateKey].ratingDelta += (after - before);
        }
      }
    }

    setDateMap(map);
    setLoading(false);
  }

  const markedDates: Record<string, any> = {};
  for (const [date, record] of Object.entries(dateMap)) {
    const isSelected   = date === selectedDate;
    const netPositive  = record.ratingDelta > 0 || record.wins > record.losses;
    const dotColor     = currentUserId
      ? (netPositive ? colors.primary : colors.danger)
      : colors.primary;

    markedDates[date] = {
      selected: isSelected,
      selectedColor: colors.primary,
      marked: true,
      dotColor: isSelected ? colors.textInverse : dotColor,
    };
  }

  const showResults = shown.includes('matches');
  const itemsOn = (day: string) => (itemMap[day] ?? []).filter((it) => shown.includes(it.kind));
  const selectedDayRecord = selectedDate && showResults ? dateMap[selectedDate] ?? null : null;
  const selectedItems = selectedDate ? itemsOn(selectedDate) : [];
  const anyData = (showResults && Object.keys(dateMap).length > 0)
    || Object.keys(itemMap).some((d) => itemsOn(d).length > 0);

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  if (loadError && Object.keys(dateMap).length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load your calendar. ${loadError}`}
          onRetry={() => { setLoading(true); void loadMatches(currentUserId); }}
        />
      </View>
    );
  }

  return (
    <ScrollView style={S.container} refreshControl={<AppRefreshControl {...refresh} />}>
      {kinds.length > 1 && (
        <FilterChipRow<CalKind>
          multi
          size="md"
          scrollable
          options={kinds.map((k) => ({ value: k, label: CAL_KIND_LABEL[k] }))}
          values={shown}
          onChangeValues={(v) => setShown([...v])}
          style={S.chips}
        />
      )}
      <Calendar
        markedDates={markedDates}
        dayComponent={({ date, state }: any) => {
          const record     = date && showResults ? dateMap[date.dateString] : undefined;
          const dayItems   = date ? itemsOn(date.dateString).length : 0;
          const isSelected = date?.dateString === selectedDate;
          const isDisabled = state === 'disabled';

          return (
            <Pressable
              onPress={() =>
                date && setSelectedDate(
                  date.dateString === selectedDate ? null : date.dateString
                )
              }
              style={({ pressed }) => [
                S.dayCell,
                isSelected && S.dayCellSelected,
                pressed && S.dayCellPressed,
              ]}
            >
              <Text style={[
                S.dayNum,
                isDisabled && S.dayDisabled,
                isSelected && S.dayNumSelected,
              ]}>
                {date?.day}
              </Text>
              {record && currentUserId && (
                <Text style={[S.dayRecord, isSelected && S.dayTextSelected]}>
                  {record.wins}W-{record.losses}L
                </Text>
              )}
              {record && !currentUserId && (
                <Text style={[S.dayRecord, isSelected && S.dayTextSelected]}>
                  {record.matches.length}
                </Text>
              )}
              {record && currentUserId && record.ratingDelta !== 0 && (
                <Text style={[
                  S.dayElo,
                  record.ratingDelta > 0 ? S.eloUp : S.eloDown,
                  isSelected && S.dayTextSelected,
                ]}>
                  {record.ratingDelta > 0 ? '+' : ''}{record.ratingDelta.toFixed(2)}
                </Text>
              )}
              {/* Upcoming matches, events, drills or check-ins that day: a count badge. */}
              {dayItems > 0 && (
                <View style={[S.itemBadge, isSelected && S.itemBadgeSelected]}>
                  <Text style={[S.itemBadgeText, isSelected && S.itemBadgeTextSelected]}>{dayItems}</Text>
                </View>
              )}
            </Pressable>
          );
        }}
        theme={{
          calendarBackground: colors.surface,
          textSectionTitleColor: colors.textSub,
          dayTextColor: colors.text,
          monthTextColor: colors.text,
          todayTextColor: colors.primary,
          arrowColor: colors.primary,
        }}
      />

      {!anyData && (
        <EmptyState iconName="calendar-event" title="Nothing on the calendar yet"
          subtitle={kinds.length > 1 ? 'Nothing here for the kinds picked above.' : 'No match data found for this view.'} />
      )}

      {selectedDate && !selectedDayRecord && selectedItems.length > 0 ? (
        <View style={S.dayDetail}>
          <Text style={S.detailDate}>
            {new Date(selectedDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          {selectedItems.map(renderItem)}
        </View>
      ) : selectedDayRecord ? (
        <View style={S.dayDetail}>
          <Text style={S.detailDate}>
            {new Date(selectedDate! + 'T12:00:00').toLocaleDateString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </Text>

          {currentUserId && (
            <View style={S.summaryRow}>
              <View style={S.summaryBadge}>
                <Text style={S.summaryNum}>{selectedDayRecord.wins}</Text>
                <Text style={S.summaryLabel}>Wins</Text>
              </View>
              <View style={S.summaryBadge}>
                <Text style={S.summaryNum}>{selectedDayRecord.losses}</Text>
                <Text style={S.summaryLabel}>Losses</Text>
              </View>
              <View style={S.summaryBadge}>
                <Text style={[
                  S.summaryNum,
                  selectedDayRecord.ratingDelta >= 0 ? S.eloUp : S.eloDown,
                ]}>
                  {selectedDayRecord.ratingDelta >= 0 ? '+' : ''}{selectedDayRecord.ratingDelta.toFixed(2)}
                </Text>
                <Text style={S.summaryLabel}>PLUPR</Text>
              </View>
              <View style={S.summaryBadge}>
                <Text style={S.summaryNum}>{selectedDayRecord.matches.length}</Text>
                <Text style={S.summaryLabel}>Matches</Text>
              </View>
            </View>
          )}

          <FlatList
            data={selectedDayRecord.matches}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            renderItem={({ item }) => {
              const timeStr = new Date(item.played_at).toLocaleTimeString(undefined, {
                hour: '2-digit', minute: '2-digit',
              });

              if (!currentUserId) {
                return (
                  <View style={S.matchRow}>
                    <Text style={S.matchOpponent}>
                      {item.player1?.full_name} vs {item.player2?.full_name}
                    </Text>
                    <Text style={S.matchScore}>{item.player1_score}–{item.player2_score}</Text>
                    <Text style={S.matchTime}>{timeStr}</Text>
                  </View>
                );
              }

              const onTeam1  = isOnTeam1(item, currentUserId);
              const won      = didWin(item, currentUserId);
              const opponent = onTeam1 ? item.player2 : item.player1;
              const myScore  = onTeam1 ? item.player1_score : item.player2_score;
              const oppScore = onTeam1 ? item.player2_score : item.player1_score;
              const typeTag  = item.match_type === 'doubles'
                ? ` (${item.doubles_category === 'gendered' ? 'Gendered Doubles' : item.doubles_category === 'mixed' ? 'Mixed Doubles' : 'Doubles'})`
                : '';

              return (
                <View style={S.matchRow}>
                  <Text style={[S.matchResult, won ? S.winText : S.lossText]}>
                    {won ? 'W' : 'L'}
                  </Text>
                  <Text style={S.matchOpponent} numberOfLines={2}>
                    vs {opponent?.full_name ?? 'Unknown'}{typeTag}
                  </Text>
                  <Text style={S.matchScore}>{myScore}–{oppScore}</Text>
                  <Text style={S.matchTime}>{timeStr}</Text>
                </View>
              );
            }}
          />
          {selectedItems.map(renderItem)}
        </View>
      ) : (
        anyData && (
          <Text style={S.hint}>Tap a highlighted date to see that day.</Text>
        )
      )}
    </ScrollView>
  );

  function renderItem(it: CalItem) {
    const time = new Date(it.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const body = (
      <>
        <Text style={S.itemKind}>{CAL_KIND_LABEL[it.kind]}</Text>
        <View style={S.itemText}>
          <Text style={S.matchOpponent} numberOfLines={2}>{it.title}</Text>
          {it.sub ? <Text style={S.matchTime} numberOfLines={1}>{it.sub}</Text> : null}
        </View>
        <Text style={S.matchTime}>{time}</Text>
      </>
    );
    return it.eventId ? (
      <Pressable key={it.id} style={({ pressed }) => [S.matchRow, pressed && S.dayCellPressed]} accessibilityRole="link"
        onPress={() => navigation.navigate('EventDetail', { eventId: it.eventId!, title: it.title })}>
        {body}
      </Pressable>
    ) : (
      <View key={it.id} style={S.matchRow}>{body}</View>
    );
  }
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    dayCell: { width: 44, height: 52, alignItems: 'center', justifyContent: 'flex-start', paddingTop: SPACE.xs, borderRadius: RADIUS.sm },
    dayCellSelected: { backgroundColor: c.primary },
    dayCellPressed: { opacity: 0.6 },
    dayNum: { fontSize: FONT.size.md, color: c.text, fontWeight: FONT.weight.medium },
    dayNumSelected: { color: c.textInverse },
    dayDisabled: { color: c.textMuted },
    // The smallest step on the type scale (was 8px): fixed line height so the
    // record and the change still fit the 52 cell under the day number.
    dayRecord: { fontSize: FONT.size.xxs, lineHeight: 12, color: c.primary, fontWeight: FONT.weight.bold, marginTop: 1 },
    dayElo: { fontSize: FONT.size.xxs, lineHeight: 12, fontWeight: FONT.weight.bold },
    dayTextSelected: { color: c.textInverse },
    eloUp:   { color: c.primary },
    eloDown: { color: c.danger },
    dayDetail: {
      backgroundColor: c.surface, margin: SPACE.md, borderRadius: RADIUS.lg, padding: SPACE.lg,
      shadowColor: c.shadow, shadowOpacity: 0.07, shadowRadius: SPACE.sm, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    detailDate: { ...t.h3, marginBottom: SPACE.md },
    summaryRow: { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.lg },
    summaryBadge: { flex: 1, alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.sm },
    summaryNum: { ...t.h2, fontVariant: ['tabular-nums'] },
    summaryLabel: { ...t.fieldLabel, marginTop: SPACE.xxs },
    matchRow: {
      flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: SPACE.sm,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border, gap: SPACE.sm,
    },
    matchResult: { ...t.title, fontWeight: FONT.weight.heavy, width: 20 },
    winText:  { color: c.primary },
    lossText: { color: c.danger },
    matchOpponent: { ...t.bodySub, flex: 1, color: c.text, fontWeight: FONT.weight.semibold },
    matchScore: { fontSize: FONT.size.md, fontWeight: FONT.weight.bold, color: c.textSub, fontVariant: ['tabular-nums'] },
    matchTime: { ...t.caption },
    hint: { ...t.hint, textAlign: 'center', marginTop: SPACE.xl, padding: SPACE.lg },
    chips: { paddingHorizontal: SPACE.md, backgroundColor: c.surface },
    itemBadge: {
      position: 'absolute', top: 1, right: 1, minWidth: 14, height: 14, borderRadius: 7, paddingHorizontal: 3,
      backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border, alignItems: 'center', justifyContent: 'center',
    },
    itemBadgeSelected: { backgroundColor: c.textInverse, borderColor: c.textInverse },
    itemBadgeText: { fontSize: FONT.size.xxs, lineHeight: 12, color: c.textSub, fontWeight: FONT.weight.bold },
    itemBadgeTextSelected: { color: c.primary },
    itemKind: { ...t.fieldLabel, width: 64 },
    itemText: { flex: 1, minWidth: 0 },
  });
}
