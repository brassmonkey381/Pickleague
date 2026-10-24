import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { ErrorState, Panel, RemoteImage } from '@just-messin-around/expo-foundation/ui';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useRefresh(load);
  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    // LOCAL session read — getUser() is a network call, so offline this bailed
    // before even trying and the screen sat on "Couldn't load head-to-head."
    const uid = await currentUserId(supabase);
    if (!uid) { setLoading(false); return; }

    try {
      const [meRow, oppRow, matchRows] = await Promise.all([
        sbCall(() => supabase.from('profiles').select(PROFILE_COLS).eq('id', uid).single()),
        sbCall(() => supabase.from('profiles').select(PROFILE_COLS).eq('id', opponentId).single()),
        // Matches where BOTH players appear (two AND-ed or-groups). Covers
        // opposite-team meetings and same-team partnerships in one query.
        sbCall(() => supabase.from('matches')
          .select('id, match_type, player1_id, partner1_id, player2_id, partner2_id, player1_score, player2_score, winner_team, status, played_at')
          .eq('status', 'completed')
          .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
          .or(`player1_id.eq.${opponentId},partner1_id.eq.${opponentId},player2_id.eq.${opponentId},partner2_id.eq.${opponentId}`)
          .order('played_at', { ascending: false })
          .limit(1000)),
      ]);

      setMe(meRow as MiniProfile);
      setOpp(oppRow as MiniProfile);
      setH2h(computeHeadToHead(uid, opponentId, (matchRows ?? []) as H2HMatchRow[]));
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load head-to-head."));
    } finally {
      // Always: a throw above used to leave the skeleton up forever.
      setLoading(false);
    }
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;
  if (!me || !opp || !h2h) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load head-to-head. ${loadError ?? 'Try again in a moment.'}`}
          onRetry={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

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
  const streakLine: { iconName: IconName; color: string; text: string } | null =
    !streak.holder || streak.count === 0 ? null
    : streak.holder === 'me'
      ? { iconName: 'fire', color: c.warning, text: `You've won the last ${streak.count}` }
      : { iconName: 'snowflake', color: c.info, text: `${oppFirst} has won the last ${streak.count}` };

  const mePct = o.total > 0 ? o.meWins / o.total : 0;

  return (
    <ScrollView style={S.container} contentContainerStyle={S.content} refreshControl={<AppRefreshControl {...refresh} />}>
      {/* VS header */}
      <Panel padded={SPACE.lg} style={S.vsCard}>
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
      </Panel>

      {o.total === 0 && h2h.partners.total === 0 ? (
        <EmptyState
          iconName="handshake"
          title={`You haven't played ${oppFirst} yet`}
          subtitle="Once you face off (or team up), your full head-to-head record shows up here."
        />
      ) : (
        <>
          {/* Record summary */}
          {o.total > 0 && (
            <Panel padded={SPACE.lg} style={S.card}>
              <Text style={S.headline}>{headline}</Text>
              <Text style={S.subtle}>{o.total} match{o.total !== 1 ? 'es' : ''} as opponents</Text>

              <View style={S.barRow}>
                <View style={[S.barSeg, { flex: Math.max(mePct, 0.001), backgroundColor: c.primary }]} />
                <View style={[S.barSeg, { flex: Math.max(1 - mePct, 0.001), backgroundColor: c.danger }]} />
              </View>
              <View style={S.barLabels}>
                <Text style={[S.barLabel, { color: c.primary }]}>You {o.meWins}</Text>
                <Text style={[S.barLabel, { color: c.danger }]}>{o.oppWins} {oppFirst}</Text>
              </View>

              {streakLine && (
                <View style={[S.iconRow, S.streakRow]}>
                  <Icon name={streakLine.iconName} size={14} color={streakLine.color} />
                  <Text style={S.streak}>{streakLine.text}</Text>
                </View>
              )}
            </Panel>
          )}

          {/* Splits */}
          {(o.singles.meWins + o.singles.oppWins > 0 || o.doubles.meWins + o.doubles.oppWins > 0) && (
            <View style={S.splitRow}>
              {o.singles.meWins + o.singles.oppWins > 0 && (
                <Panel padded={SPACE.md} style={S.splitCard}>
                  <View style={S.iconRow}>
                    <Icon name="person" size={12} color={c.textSub} />
                    <Text style={S.splitLabel}>Singles</Text>
                  </View>
                  <Text style={S.splitValue}>{o.singles.meWins}–{o.singles.oppWins}</Text>
                </Panel>
              )}
              {o.doubles.meWins + o.doubles.oppWins > 0 && (
                <Panel padded={SPACE.md} style={S.splitCard}>
                  <View style={S.iconRow}>
                    <Icon name="group" size={12} color={c.textSub} />
                    <Text style={S.splitLabel}>Doubles</Text>
                  </View>
                  <Text style={S.splitValue}>{o.doubles.meWins}–{o.doubles.oppWins}</Text>
                </Panel>
              )}
            </View>
          )}

          {/* As partners */}
          {h2h.partners.total > 0 && (
            <Panel padded={SPACE.lg} style={S.card}>
              <View style={[S.iconRow, S.sectionHead]}>
                <Icon name="handshake" size={14} color={c.textSub} />
                <Text style={S.sectionTitle}>As partners</Text>
              </View>
              <Text style={S.partnerLine}>
                {h2h.partners.wins}–{h2h.partners.losses} together
                {'  '}
                <Text style={S.subtle}>
                  ({Math.round((h2h.partners.wins / h2h.partners.total) * 100)}% win rate)
                </Text>
              </Text>
            </Panel>
          )}

          {/* Recent meetings */}
          {o.meetings.length > 0 && (
            <Panel padded={SPACE.lg} style={S.card}>
              <Text style={[S.sectionTitle, S.sectionHead]}>Recent meetings</Text>
              {o.meetings.slice(0, 10).map((meet) => {
                const result = meet.iWon == null ? '—' : meet.iWon ? 'W' : 'L';
                const resultColor = meet.iWon == null ? c.textMuted : meet.iWon ? c.primary : c.danger;
                const resultBg = meet.iWon == null ? c.surfaceAlt : meet.iWon ? c.primaryLight : c.dangerLight;
                const singles = meet.match_type === 'singles';
                const score = meet.myScore != null && meet.oppScore != null ? `${meet.myScore}–${meet.oppScore}` : '';
                return (
                  <View key={meet.id} style={S.meetRow}>
                    <View style={[S.resultPill, { backgroundColor: resultBg }]}>
                      <Text style={[S.resultPillText, { color: resultColor }]}>{result}</Text>
                    </View>
                    <View style={S.flex}>
                      <View style={S.iconRow}>
                        <Icon name={singles ? 'person' : 'group'} size={14} color={c.textSub} />
                        <Text style={S.meetType}>{singles ? 'Singles' : 'Doubles'}{score ? `  ·  ${score}` : ''}</Text>
                      </View>
                      <Text style={S.meetDate}>{new Date(meet.played_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                    </View>
                  </View>
                );
              })}
            </Panel>
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
        // RemoteImage, not a bare <Image>: an uploaded avatar that fails to
        // load rendered as a blank hole in the VS header with no fallback.
        <RemoteImage
          uri={p.avatar_url}
          containerStyle={S.avatarPhoto}
          hideSpinner
          accessibilityLabel={`${firstName(p.full_name)} avatar`}
          fallback={
            <View style={[S.avatar, { backgroundColor: av.bgColor }]}>
              <Text style={S.avatarEmoji}>{av.emoji}</Text>
            </View>
          }
        />
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
  const t = textStyles(c);
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    // The lg gutter and the md gap between cards, as every detail screen.
    content: { padding: SPACE.lg, paddingBottom: SPACE.xl * 2, gap: SPACE.md },
    iconRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    flex: { flex: 1, minWidth: 0 },

    vsCard: { flexDirection: 'row', alignItems: 'center' },
    playerCol: { flex: 1, alignItems: 'center' },
    avatar: { width: 64, height: 64, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
    avatarPhoto: { width: 64, height: 64, borderRadius: RADIUS.pill, marginBottom: SPACE.sm },
    // The player's own avatar emoji (content, not chrome), sized to the 64 circle.
    avatarEmoji: { fontSize: FONT.size.display + SPACE.xs },
    playerName: { ...t.title, maxWidth: 110, textAlign: 'center' },
    playerRating: { ...t.h2, color: c.primary, marginTop: SPACE.xxs },
    playerLabel: { ...t.meta, marginTop: SPACE.xxs },
    vsMiddle: { alignItems: 'center', paddingHorizontal: SPACE.xs },
    vsText: { ...t.title, fontWeight: FONT.weight.heavy, color: c.textMuted, letterSpacing: 1 },
    gapChip: {
      marginTop: SPACE.sm, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.pill,
      paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderWidth: HAIRLINE, borderColor: c.border,
    },
    gapChipText: { ...t.caption, color: c.textSub, fontWeight: FONT.weight.semibold, textAlign: 'center' },

    card: {},
    headline: { ...t.h2 },
    subtle: { ...t.meta, fontWeight: FONT.weight.medium, letterSpacing: 0 },
    barRow: { flexDirection: 'row', height: 12, borderRadius: RADIUS.sm, overflow: 'hidden', marginTop: SPACE.md, backgroundColor: c.border },
    barSeg: { height: 12 },
    barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.xs },
    barLabel: { fontSize: FONT.size.base, fontWeight: FONT.weight.bold },
    streakRow: { marginTop: SPACE.md },
    streak: { ...t.bodySub, color: c.text, fontWeight: FONT.weight.bold },

    splitRow: { flexDirection: 'row', gap: SPACE.md },
    splitCard: { flex: 1, alignItems: 'center' },
    splitLabel: { ...t.meta, color: c.textSub, letterSpacing: 0 },
    splitValue: { ...t.h2, marginTop: SPACE.xs, fontVariant: ['tabular-nums'] },

    sectionHead: { marginBottom: SPACE.sm },
    sectionTitle: { ...t.fieldLabel, color: c.textSub },
    partnerLine: { ...t.title },

    meetRow: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 44, paddingVertical: SPACE.sm,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    resultPill: { width: 30, height: 30, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    resultPillText: { fontSize: FONT.size.md, fontWeight: FONT.weight.heavy },
    meetType: { ...t.bodySub, color: c.text, fontWeight: FONT.weight.semibold, flexShrink: 1 },
    meetDate: { ...t.meta, fontWeight: FONT.weight.regular, letterSpacing: 0, marginTop: 1 },
  });
}
