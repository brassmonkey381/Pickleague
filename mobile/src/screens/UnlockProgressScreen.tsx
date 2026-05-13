import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'UnlockProgress'> };

type Progress = { text: string; pct: number; showBar: boolean };

function ProgressRow({ prog, c }: { prog: Progress; c: any }) {
  if (!prog.showBar) {
    return <Text style={{ fontSize: 11, color: c.textMuted, fontStyle: 'italic' }}>{prog.text}</Text>;
  }
  const filled = Math.max(prog.pct, 0.02);
  const empty  = 1 - filled;
  return (
    <>
      <View style={{ flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginBottom: 3, backgroundColor: c.border }}>
        <View style={{ backgroundColor: c.primary, flex: filled }} />
        {empty > 0 && <View style={{ backgroundColor: c.border, flex: empty }} />}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, fontWeight: '600' }}>{prog.text}</Text>
    </>
  );
}

export default function UnlockProgressScreen(_props: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [earnedBadgeNames, setEarnedBadgeNames] = useState<string[]>([]);
  const [badgeProgress, setBadgeProgress] = useState<Record<string, Progress>>({});

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const [profileRes, badgesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('player_badges').select('badge:badges(name)').eq('user_id', user.id),
    ]);

    const names = ((badgesRes.data ?? []) as any[])
      .map(b => b.badge?.name)
      .filter(Boolean) as string[];
    setEarnedBadgeNames(Array.from(new Set(names)));

    const prof = profileRes.data;
    if (prof) {
      const { data: matches } = await supabase
        .from('matches')
        .select('match_type, player1_id, partner1_id, player2_id, partner2_id, winner_team, location_name')
        .or(`player1_id.eq.${user.id},partner1_id.eq.${user.id},player2_id.eq.${user.id},partner2_id.eq.${user.id}`)
        .order('played_at', { ascending: false })
        .limit(200);

      const mx = matches ?? [];
      const didWin = (m: any) => {
        const t1 = m.player1_id === user.id || m.partner1_id === user.id;
        return (t1 && m.winner_team === 'team1') || (!t1 && m.winner_team === 'team2');
      };
      let streak = 0;
      for (const m of mx) { if (didWin(m)) streak++; else break; }
      const courts = new Set(mx.map((m: any) => m.location_name).filter(Boolean)).size;
      const doublesPlayed = mx.filter((m: any) => m.match_type === 'doubles').length;
      const singlesPlayed = mx.filter((m: any) => m.match_type === 'singles').length;
      const memberDays = Math.floor((Date.now() - new Date(prof.created_at).getTime()) / 86_400_000);
      const elo = prof.rating ?? 3.25;

      const entry = (current: number, target: number, label: (c: number, t: number) => string): Progress => ({
        text: label(current, target),
        pct: Math.min(current / target, 1),
        showBar: true,
      });
      const league = (): Progress => ({ text: 'Progress tracked per-league', pct: 0, showBar: false });

      setBadgeProgress({
        'Hot Streak':         entry(streak,        5,   (c, t) => `${c} / ${t} wins in a row`),
        'Top Rated':          entry(elo,           4.0, (c, t) => `${c.toFixed(2)} / ${t.toFixed(2)} PLUPR`),
        'Veteran':            entry(memberDays,    30,  (c, t) => `${c} / ${t} days as member`),
        'Court Hopper':       entry(courts,        5,   (c, t) => `${c} / ${t} courts played`),
        'Doubles Dynamo':     entry(doublesPlayed, 20,  (c, t) => `${c} / ${t} doubles matches`),
        'Singles Specialist': entry(singlesPlayed, 25,  (c, t) => `${c} / ${t} singles matches`),
        'League Leader':      league(),
        'Hat Trick':          league(),
        'Home Court Hero':    league(),
        'League Regular':     league(),
        'Dominant':           league(),
        'Iron Player':        league(),
        'Comeback King':      league(),
      });
    }
    setLoading(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

  const lockedAvatars = AVATARS.filter(a => !!a.unlock);
  const lockedTags    = PLAY_TAGS.filter(t => !!t.unlock);
  const earnedAvatars = lockedAvatars.filter(a => earnedBadgeNames.includes(a.unlock!.badge)).length;
  const earnedTags    = lockedTags.filter(t => earnedBadgeNames.includes(t.unlock!.badge)).length;
  const earnedSlots   = TAG_SLOT_UNLOCKS.filter(u => earnedBadgeNames.includes(u.badge)).length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>🔓 Unlockable Rewards</Text>
      <Text style={styles.subtitle}>
        Earn the gating badge to unlock each cosmetic. Progress is tracked across your account.
      </Text>

      <View style={styles.summaryRow}>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedAvatars}/{lockedAvatars.length}</Text>
          <Text style={styles.summaryLabel}>Avatars</Text>
        </View>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedTags}/{lockedTags.length}</Text>
          <Text style={styles.summaryLabel}>Tags</Text>
        </View>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedSlots}/{TAG_SLOT_UNLOCKS.length}</Text>
          <Text style={styles.summaryLabel}>Tag Slots</Text>
        </View>
      </View>

      <Text style={styles.catLabel}>Special Avatars</Text>
      {lockedAvatars.map(av => {
        const earned = earnedBadgeNames.includes(av.unlock!.badge);
        const prog   = badgeProgress[av.unlock!.badge];
        return (
          <View key={av.id} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? av.bgColor : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>{av.emoji}</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{av.name} Avatar</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{av.unlock!.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{av.unlock!.description}</Text>}
            </View>
          </View>
        );
      })}

      <Text style={styles.catLabel}>Extra Tag Slots</Text>
      {TAG_SLOT_UNLOCKS.map(u => {
        const earned = earnedBadgeNames.includes(u.badge);
        const prog   = badgeProgress[u.badge];
        return (
          <View key={u.badge} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? '#e8f5e9' : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>🏷️</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>+1 Tag Slot</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{u.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{u.description}</Text>}
            </View>
          </View>
        );
      })}

      <Text style={styles.catLabel}>Exclusive Tags</Text>
      {lockedTags.map(t => {
        const earned = earnedBadgeNames.includes(t.unlock!.badge);
        const prog   = badgeProgress[t.unlock!.badge];
        return (
          <View key={t.slug} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? '#e8f5e9' : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>🏷️</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{t.label}</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{t.unlock!.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{t.unlock!.description}</Text>}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { padding: 20, backgroundColor: c.bg, flexGrow: 1 },
    title:        { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 4 },
    subtitle:     { fontSize: 13, color: c.textMuted, marginBottom: 16 },
    summaryRow:   { flexDirection: 'row', gap: 8, marginBottom: 16 },
    summaryPill:  { flex: 1, backgroundColor: c.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    summaryValue: { fontSize: 18, fontWeight: '800', color: c.text },
    summaryLabel: { fontSize: 11, color: c.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.6 },
    catLabel:     { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 8, marginBottom: 8 },
    row:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10, backgroundColor: c.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.border },
    iconCircle:   { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
    iconEmoji:    { fontSize: 22 },
    info:         { flex: 1 },
    nameRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 },
    name:         { fontSize: 14, fontWeight: '700', color: c.text, flex: 1 },
    earned:       { fontSize: 11, color: c.primary, fontWeight: '700' },
    locked:       { fontSize: 11, color: c.textMuted, fontWeight: '600' },
    badgeName:    { fontSize: 11, color: c.primary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
    req:          { fontSize: 12, color: c.textMuted },
  });
}
