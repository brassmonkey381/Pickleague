import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { Calendar, DateData } from 'react-native-calendars';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
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

    // Filter to matches involving the target player (including as doubles partner)
    if (uid) {
      matches = matches.filter((m) =>
        m.player1_id === uid || m.player2_id === uid ||
        m.partner1_id === uid || m.partner2_id === uid
      );
    }

    // Group by UTC date from played_at
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

  // Build markedDates for the calendar
  const markedDates: Record<string, any> = {};
  for (const [date, record] of Object.entries(dateMap)) {
    const isSelected   = date === selectedDate;
    const netPositive  = record.ratingDelta > 0 || record.wins > record.losses;
    const dotColor     = currentUserId
      ? (netPositive ? '#2e7d32' : '#c62828')
      : '#2e7d32'; // league view: always green dot

    markedDates[date] = {
      selected: isSelected,
      selectedColor: '#2e7d32',
      marked: true,
      dotColor: isSelected ? '#fff' : dotColor,
    };
  }

  const selectedDayRecord = selectedDate ? dateMap[selectedDate] : null;

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <ScrollView style={styles.container}>
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
                styles.dayCell,
                isSelected && styles.dayCellSelected,
                pressed && styles.dayCellPressed,
              ]}
            >
              <Text style={[
                styles.dayNum,
                isDisabled && styles.dayDisabled,
                isSelected && styles.dayNumSelected,
              ]}>
                {date?.day}
              </Text>
              {record && currentUserId && (
                <Text style={[styles.dayRecord, isSelected && styles.dayTextSelected]}>
                  {record.wins}W-{record.losses}L
                </Text>
              )}
              {record && !currentUserId && (
                <Text style={[styles.dayRecord, isSelected && styles.dayTextSelected]}>
                  {record.matches.length}
                </Text>
              )}
              {record && currentUserId && record.ratingDelta !== 0 && (
                <Text style={[
                  styles.dayElo,
                  record.ratingDelta > 0 ? styles.eloUp : styles.eloDown,
                  isSelected && styles.dayTextSelected,
                ]}>
                  {record.ratingDelta > 0 ? '+' : ''}{record.ratingDelta}
                </Text>
              )}
            </Pressable>
          );
        }}
        theme={{
          calendarBackground: '#fff',
          textSectionTitleColor: '#666',
          todayTextColor: '#2e7d32',
          arrowColor: '#2e7d32',
        }}
      />

      {Object.keys(dateMap).length === 0 && (
        <Text style={styles.hint}>No match data found for this view.</Text>
      )}

      {selectedDayRecord ? (
        <View style={styles.dayDetail}>
          <Text style={styles.detailDate}>
            {new Date(selectedDate! + 'T12:00:00').toLocaleDateString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </Text>

          {currentUserId && (
            <View style={styles.summaryRow}>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryNum}>{selectedDayRecord.wins}</Text>
                <Text style={styles.summaryLabel}>Wins</Text>
              </View>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryNum}>{selectedDayRecord.losses}</Text>
                <Text style={styles.summaryLabel}>Losses</Text>
              </View>
              <View style={styles.summaryBadge}>
                <Text style={[
                  styles.summaryNum,
                  selectedDayRecord.ratingDelta >= 0 ? styles.eloUp : styles.eloDown,
                ]}>
                  {selectedDayRecord.ratingDelta >= 0 ? '+' : ''}{selectedDayRecord.ratingDelta}
                </Text>
                <Text style={styles.summaryLabel}>ELO</Text>
              </View>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryNum}>{selectedDayRecord.matches.length}</Text>
                <Text style={styles.summaryLabel}>Matches</Text>
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
                  <View style={styles.matchRow}>
                    <Text style={styles.matchOpponent}>
                      {item.player1?.full_name} vs {item.player2?.full_name}
                    </Text>
                    <Text style={styles.matchScore}>{item.player1_score}–{item.player2_score}</Text>
                    <Text style={styles.matchTime}>{timeStr}</Text>
                  </View>
                );
              }

              const onTeam1  = isOnTeam1(item, currentUserId);
              const won      = didWin(item, currentUserId);
              const opponent = onTeam1 ? item.player2 : item.player1;
              const myScore  = onTeam1 ? item.player1_score : item.player2_score;
              const oppScore = onTeam1 ? item.player2_score : item.player1_score;
              const typeTag  = item.match_type === 'doubles' ? ' (2v2)' : '';

              return (
                <View style={styles.matchRow}>
                  <Text style={[styles.matchResult, won ? styles.winText : styles.lossText]}>
                    {won ? 'W' : 'L'}
                  </Text>
                  <Text style={styles.matchOpponent} numberOfLines={1}>
                    vs {opponent?.full_name ?? 'Unknown'}{typeTag}
                  </Text>
                  <Text style={styles.matchScore}>{myScore}–{oppScore}</Text>
                  <Text style={styles.matchTime}>{timeStr}</Text>
                </View>
              );
            }}
          />
        </View>
      ) : (
        Object.keys(dateMap).length > 0 && (
          <Text style={styles.hint}>Tap a highlighted date to see match details.</Text>
        )
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  dayCell: { width: 44, height: 52, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4, borderRadius: 6 },
  dayCellSelected: { backgroundColor: '#2e7d32' },
  dayCellPressed: { opacity: 0.6 },
  dayNum: { fontSize: 14, color: '#1a1a1a', fontWeight: '500' },
  dayNumSelected: { color: '#fff' },
  dayDisabled: { color: '#ccc' },
  dayRecord: { fontSize: 8, color: '#2e7d32', fontWeight: '700', marginTop: 1 },
  dayElo: { fontSize: 8, fontWeight: '700', marginTop: 0 },
  dayTextSelected: { color: '#fff' },
  eloUp:   { color: '#2e7d32' },
  eloDown: { color: '#c62828' },
  dayDetail: { backgroundColor: '#fff', margin: 12, borderRadius: 12, padding: 16 },
  detailDate: { fontSize: 18, fontWeight: '700', color: '#1a1a1a', marginBottom: 12 },
  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  summaryBadge: { flex: 1, alignItems: 'center', backgroundColor: '#f5f5f5', borderRadius: 8, padding: 10 },
  summaryNum: { fontSize: 20, fontWeight: '800', color: '#1a1a1a' },
  summaryLabel: { fontSize: 10, color: '#888', marginTop: 2, textTransform: 'uppercase' },
  matchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', gap: 8 },
  matchResult: { fontSize: 15, fontWeight: '800', width: 20 },
  winText:  { color: '#2e7d32' },
  lossText: { color: '#c62828' },
  matchOpponent: { flex: 1, fontSize: 14, fontWeight: '600', color: '#333' },
  matchScore: { fontSize: 14, fontWeight: '700', color: '#555' },
  matchTime: { fontSize: 11, color: '#aaa' },
  hint: { textAlign: 'center', color: '#aaa', marginTop: 24, fontSize: 14, padding: 16 },
});
