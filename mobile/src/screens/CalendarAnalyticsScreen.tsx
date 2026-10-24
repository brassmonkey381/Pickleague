import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ScrollView, Pressable } from 'react-native';
import { Calendar, DateData } from 'react-native-calendars';
import { RouteProp } from '@react-navigation/native';
import {
  sbCall,
  currentUserId as sessionUserId,
  friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import { isoDate } from '@just-messin-around/expo-foundation/scheduling/drillTime';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { Match, RootStackParamList } from '../types';

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
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [dateMap, setDateMap]       = useState<Record<string, DayRecord>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);

  // LOCAL session read — getUser() is a network call, so offline `uid` came back
  // null and the calendar silently showed EVERYONE's matches instead of yours.
  const refresh = useRefresh(async () => {
    const uid = userId ?? (await sessionUserId(supabase));
    setCurrentUserId(uid);
    await loadMatches(uid);
  });

  useEffect(() => {
    sessionUserId(supabase).then((sessionUid) => {
      const uid = userId ?? sessionUid;
      setCurrentUserId(uid);
      loadMatches(uid);
    });
  }, []);

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
    let matches: Match[] = data ?? [];

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

        const onTeam1 = isOnTeam1(match, uid);
        const before  = onTeam1 ? match.player1_rating_before : match.player2_rating_before;
        const after   = onTeam1 ? match.player1_rating_after  : match.player2_rating_after;
        if (before != null && after != null) map[dateKey].ratingDelta += (after - before);
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

  const selectedDayRecord = selectedDate ? dateMap[selectedDate] : null;

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
      <Calendar
        markedDates={markedDates}
        dayComponent={({ date, state }: any) => {
          const record     = date ? dateMap[date.dateString] : undefined;
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

      {Object.keys(dateMap).length === 0 && (
        <EmptyState iconName="calendar-event" title="No matches yet" subtitle="No match data found for this view." />
      )}

      {selectedDayRecord ? (
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
                  <Text style={S.matchOpponent} numberOfLines={1}>
                    vs {opponent?.full_name ?? 'Unknown'}{typeTag}
                  </Text>
                  <Text style={S.matchScore}>{myScore}–{oppScore}</Text>
                  <Text style={S.matchTime}>{timeStr}</Text>
                </View>
              );
            }}
          />
        </View>
      ) : (
        Object.keys(dateMap).length > 0 && (
          <Text style={S.hint}>Tap a highlighted date to see match details.</Text>
        )
      )}
    </ScrollView>
  );
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
  });
}
