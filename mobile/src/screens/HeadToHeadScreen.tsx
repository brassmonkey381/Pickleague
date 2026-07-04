import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, Image, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { computeHeadToHead, HeadToHead, H2HMatchRow } from '../lib/headToHead';
import { AVATARS } from '../data/profileCustomization';
import FlairName from '../components/FlairName';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'HeadToHead'>;
  route: RouteProp<RootStackParamList, 'HeadToHead'>;
};

type MiniProfile = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  avatar_id: number | null;
  rating: number;
  name_color: string | null;
  profile_name_style_id: string | null;
};

const PROFILE_COLS = 'id, full_name, avatar_url, avatar_id, rating, name_color, profile_name_style_id';

function firstName(name: string | undefined | null): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'Player';
}

export default function HeadToHeadScreen({ route }: Props) {
  const { opponentId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [me, setMe] = useState<MiniProfile | null>(null);
  const [opp, setOpp] = useState<MiniProfile | null>(null);
  const [h2h, setH2h] = useState<HeadToHead | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useRefresh(load);
  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const [meRes, oppRes, matchRes] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLS).eq('id', user.id).single(),
      supabase.from('profiles').select(PROFILE_COLS).eq('id', opponentId).single(),
      // Matches where BOTH players appear (two AND-ed or-groups). Covers
      // opposite-team meetings and same-team partnerships in one query.
      supabase.from('matches')
        .select('id, match_type, player1_id, partner1_id, player2_id, partner2_id, player1_score, player2_score, winner_team, status, played_at')
        .or(`player1_id.eq.${user.id},partner1_id.eq.${user.id},player2_id.eq.${user.id},partner2_id.eq.${user.id}`)
        .or(`player1_id.eq.${opponentId},partner1_id.eq.${opponentId},player2_id.eq.${opponentId},partner2_id.eq.${opponentId}`)
        .order('played_at', { ascending: false })
        .limit(1000),
    ]);

    setMe(meRes.data as MiniProfile);
    setOpp(oppRes.data as MiniProfile);
    setH2h(computeHeadToHead(user.id, opponentId, (matchRes.data ?? []) as H2HMatchRow[]));
    setLoading(false);
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;
  if (!me || !opp || !h2h) return <Text style={S.error}>Couldn't load head-to-head.</Text>;

  const o = h2h.opponents;
  const oppFirst = firstName(opp.full_name);
  const lead = o.meWins - o.oppWins;
  const ratingGap = Math.round(me.rating - opp.rating);

  // Record summary headline.
  const headline =
    o.total === 0 ? `No matches yet`
    : lead > 0 ? `You lead ${o.meWins}–${o.oppWins}`
    : lead < 0 ? `${oppFirst} leads ${o.oppWins}–${o.meWins}`
    : `All square ${o.meWins}–${o.oppWins}`;

  // Streak copy.
  const streak = o.streak;
  const streakText =
    !streak.holder || streak.count === 0 ? null
    : streak.holder === 'me'
      ? `🔥 You've won the last ${streak.count}`
      : `❄️ ${oppFirst} has won the last ${streak.count}`;

  const mePct = o.total > 0 ? o.meWins / o.total : 0;

  return (
    <ScrollView style={S.container} contentContainerStyle={{ paddingBottom: 40 }} refreshControl={<AppRefreshControl {...refresh} />}>
      {/* VS header */}
      <View style={S.vsCard}>
        <PlayerColumn p={me} label="You" S={S} c={c} />
        <View style={S.vsMiddle}>
          <Text style={S.vsText}>VS</Text>
          <View style={S.gapChip}>
            <Text style={S.gapChipText}>
              {ratingGap === 0 ? 'Even rating' : ratingGap > 0 ? `You +${ratingGap}` : `${oppFirst} +${-ratingGap}`}
            </Text>
          </View>
        </View>
        <PlayerColumn p={opp} label={oppFirst} S={S} c={c} />
      </View>

      {o.total === 0 && h2h.partners.total === 0 ? (
        <EmptyState
          icon="🤝"
          title={`You haven't played ${oppFirst} yet`}
          subtitle="Once you face off (or team up), your full head-to-head record shows up here."
        />
      ) : (
        <>
          {/* Record summary */}
          {o.total > 0 && (
            <View style={S.card}>
              <Text style={S.headline}>{headline}</Text>
              <Text style={S.subtle}>{o.total} match{o.total !== 1 ? 'es' : ''} as opponents</Text>

              <View style={S.barRow}>
                <View style={[S.barSeg, { flex: Math.max(mePct, 0.001), backgroundColor: c.primary, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 }]} />
                <View style={[S.barSeg, { flex: Math.max(1 - mePct, 0.001), backgroundColor: c.danger, borderTopRightRadius: 6, borderBottomRightRadius: 6 }]} />
              </View>
              <View style={S.barLabels}>
                <Text style={[S.barLabel, { color: c.primary }]}>You {o.meWins}</Text>
                <Text style={[S.barLabel, { color: c.danger }]}>{o.oppWins} {oppFirst}</Text>
              </View>

              {streakText && <Text style={S.streak}>{streakText}</Text>}
            </View>
          )}

          {/* Splits */}
          {(o.singles.meWins + o.singles.oppWins > 0 || o.doubles.meWins + o.doubles.oppWins > 0) && (
            <View style={S.splitRow}>
              {o.singles.meWins + o.singles.oppWins > 0 && (
                <View style={S.splitCard}>
                  <Text style={S.splitLabel}>🎾 Singles</Text>
                  <Text style={S.splitValue}>{o.singles.meWins}–{o.singles.oppWins}</Text>
                </View>
              )}
              {o.doubles.meWins + o.doubles.oppWins > 0 && (
                <View style={S.splitCard}>
                  <Text style={S.splitLabel}>👥 Doubles</Text>
                  <Text style={S.splitValue}>{o.doubles.meWins}–{o.doubles.oppWins}</Text>
                </View>
              )}
            </View>
          )}

          {/* As partners */}
          {h2h.partners.total > 0 && (
            <View style={S.card}>
              <Text style={S.sectionTitle}>🤝 As partners</Text>
              <Text style={S.partnerLine}>
                {h2h.partners.wins}–{h2h.partners.losses} together
                {'  '}
                <Text style={S.subtle}>
                  ({Math.round((h2h.partners.wins / h2h.partners.total) * 100)}% win rate)
                </Text>
              </Text>
            </View>
          )}

          {/* Recent meetings */}
          {o.meetings.length > 0 && (
            <View style={S.card}>
              <Text style={S.sectionTitle}>Recent meetings</Text>
              {o.meetings.slice(0, 10).map((meet) => {
                const result = meet.iWon == null ? '—' : meet.iWon ? 'W' : 'L';
                const resultColor = meet.iWon == null ? c.textMuted : meet.iWon ? c.primary : c.danger;
                const score = meet.myScore != null && meet.oppScore != null ? `${meet.myScore}–${meet.oppScore}` : '';
                return (
                  <View key={meet.id} style={S.meetRow}>
                    <View style={[S.resultPill, { backgroundColor: resultColor + '22' }]}>
                      <Text style={[S.resultPillText, { color: resultColor }]}>{result}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.meetType}>{meet.match_type === 'singles' ? '🎾 Singles' : '👥 Doubles'}{score ? `  ·  ${score}` : ''}</Text>
                      <Text style={S.meetDate}>{new Date(meet.played_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function PlayerColumn({ p, label, S, c }: { p: MiniProfile; label: string; S: any; c: ReturnType<typeof useTheme>['colors'] }) {
  const av = AVATARS.find(a => a.id === (p.avatar_id ?? 1)) ?? AVATARS[0];
  return (
    <View style={S.playerCol}>
      {p.avatar_url ? (
        <Image source={{ uri: p.avatar_url }} style={S.avatarPhoto} />
      ) : (
        <View style={[S.avatar, { backgroundColor: av.bgColor }]}>
          <Text style={S.avatarEmoji}>{av.emoji}</Text>
        </View>
      )}
      <FlairName
        style={S.playerName}
        name={firstName(p.full_name)}
        nameColor={p.name_color}
        styleId={p.profile_name_style_id}
        mode="hero"
        numberOfLines={1}
      />
      <Text style={S.playerRating}>{Math.round(p.rating)}</Text>
      <Text style={S.playerLabel}>{label}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    error: { padding: 24, color: c.text },

    vsCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, margin: 12, borderRadius: 16, padding: 18, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4 },
    playerCol: { flex: 1, alignItems: 'center' },
    avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
    avatarPhoto: { width: 64, height: 64, borderRadius: 32, marginBottom: 8 },
    avatarEmoji: { fontSize: 32 },
    playerName: { fontSize: 16, fontWeight: '700', color: c.text, maxWidth: 110, textAlign: 'center' },
    playerRating: { fontSize: 22, fontWeight: '800', color: c.primary, marginTop: 2 },
    playerLabel: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    vsMiddle: { alignItems: 'center', paddingHorizontal: 6 },
    vsText: { fontSize: 16, fontWeight: '800', color: c.textMuted, letterSpacing: 1 },
    gapChip: { marginTop: 8, backgroundColor: c.surfaceAlt, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: c.border },
    gapChipText: { fontSize: 11, color: c.textSub, fontWeight: '600', textAlign: 'center' },

    card: { backgroundColor: c.surface, marginHorizontal: 12, marginBottom: 12, borderRadius: 14, padding: 16, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3 },
    headline: { fontSize: 20, fontWeight: '800', color: c.text },
    subtle: { fontSize: 12, color: c.textMuted, fontWeight: '500' },
    barRow: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', marginTop: 14, backgroundColor: c.border },
    barSeg: { height: 12 },
    barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    barLabel: { fontSize: 13, fontWeight: '700' },
    streak: { fontSize: 14, fontWeight: '700', color: c.text, marginTop: 12 },

    splitRow: { flexDirection: 'row', marginHorizontal: 12, marginBottom: 12, gap: 12 },
    splitCard: { flex: 1, backgroundColor: c.surface, borderRadius: 14, padding: 14, alignItems: 'center', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3 },
    splitLabel: { fontSize: 12, color: c.textSub, fontWeight: '600' },
    splitValue: { fontSize: 22, fontWeight: '800', color: c.text, marginTop: 4 },

    sectionTitle: { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
    partnerLine: { fontSize: 16, fontWeight: '700', color: c.text },

    meetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    resultPill: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
    resultPillText: { fontSize: 14, fontWeight: '800' },
    meetType: { fontSize: 14, fontWeight: '600', color: c.text },
    meetDate: { fontSize: 12, color: c.textMuted, marginTop: 1 },
  });
}
