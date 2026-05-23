import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { Calendar, DateData } from 'react-native-calendars';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Match, RootStackParamList } from '../types';

type Props = { route: RouteProp<RootStackParamList, 'CalendarAnalytics'> };

type DayRecord = {
  wins: number;
  losses: number;
  ratingDelta: number;
  matches: Match[];
};

export default function CalendarAnalyticsScreen({ route }: Props) {
  const { userId, leagueId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [dateMap, setDateMap]       = useState<Record<string, DayRecord>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      const uid = userId ?? user?.id ?? null;
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

  async function loadMatches(uid: string | null) {
    let query = supabase
      .from('matches')
      .select(`
        *,
        player1:profiles!matches_player1_id_fkey(id, full_name),
        player2:profiles!matches_player2_id_fkey(id, full_name)
      `)
      .order('played_at', { ascending: false });

    if (leagueId) query = query.eq('league_id', leagueId);

    const { data } = await query;
    let matches: Match[] = data ?? [];

    if (uid) {
      matches = matches.filter((m) =>
        m.player1_id === uid || m.player2_id === uid ||
        m.partner1_id === uid || m.partner2_id === uid
      );
    }

    const map: Record<string, DayRecord> = {};
    for (const match of matches) {
      const dateKey = match.played_at.slice(0, 10);
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
      dotColor: isSelected ? '#fff' : dotColor,
    };
  }

  const selectedDayRecord = selectedDate ? dateMap[selectedDate] : null;

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  return (
    <ScrollView style={S.container}>
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
        <Text style={S.hint}>No match data found for this view.</Text>
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
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    dayCell: { width: 44, height: 52, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4, borderRadius: 6 },
    dayCellSelected: { backgroundColor: c.primary },
    dayCellPressed: { opacity: 0.6 },
    dayNum: { fontSize: 14, color: c.text, fontWeight: '500' },
    dayNumSelected: { color: '#fff' },
    dayDisabled: { color: c.textMuted },
    dayRecord: { fontSize: 8, color: c.primary, fontWeight: '700', marginTop: 1 },
    dayElo: { fontSize: 8, fontWeight: '700', marginTop: 0 },
    dayTextSelected: { color: '#fff' },
    eloUp:   { color: c.primary },
    eloDown: { color: c.danger },
    dayDetail: { backgroundColor: c.surface, margin: 12, borderRadius: 14, padding: 16, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
    detailDate: { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 12 },
    summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    summaryBadge: { flex: 1, alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10 },
    summaryNum: { fontSize: 20, fontWeight: '800', color: c.text },
    summaryLabel: { fontSize: 10, color: c.textMuted, marginTop: 2, textTransform: 'uppercase', fontWeight: '700', letterSpacing: 0.6 },
    matchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    matchResult: { fontSize: 15, fontWeight: '800', width: 20 },
    winText:  { color: c.primary },
    lossText: { color: c.danger },
    matchOpponent: { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
    matchScore: { fontSize: 14, fontWeight: '700', color: c.textSub },
    matchTime: { fontSize: 11, color: c.textMuted },
    hint: { textAlign: 'center', color: c.textMuted, marginTop: 24, fontSize: 14, padding: 16 },
  });
}
