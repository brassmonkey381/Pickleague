import React, { useEffect } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { StreakResult } from '../lib/loginStreak';

const MILESTONES = [
  { day: 3,   bonus: 25,   label: '3-day streak' },
  { day: 7,   bonus: 100,  label: 'One week'     },
  { day: 30,  bonus: 500,  label: 'One month'    },
  { day: 100, bonus: 2000, label: 'Century'      },
] as const;
const DAILY = 10;

type RowStatus = 'done' | 'now' | 'next' | 'future';
type TimelineRow = {
  key: string;
  status: RowStatus;
  bullet: string;
  title: string;
  reward: number | null;
  subtitle: string;
};

function buildTimeline(streak: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const nextIdx = MILESTONES.findIndex(m => streak < m.day);

  MILESTONES.forEach((m, i) => {
    if (i === nextIdx) {
      const inDays = m.day - streak;
      rows.push({
        key: 'now',
        status: 'now',
        bullet: '●',
        title: `Day ${streak} — you're here`,
        reward: null,
        subtitle: `${inDays} ${inDays === 1 ? 'day' : 'days'} to next milestone`,
      });
    }
    const status: RowStatus =
      nextIdx === -1 || i < nextIdx ? 'done' :
      i === nextIdx ? 'next' :
      'future';
    rows.push({
      key: `m-${m.day}`,
      status,
      bullet: status === 'done' ? '✓' : status === 'next' ? '🎯' : '⏳',
      title: `Day ${m.day}`,
      reward: DAILY + m.bonus,
      subtitle: m.label,
    });
  });

  if (nextIdx === -1) {
    rows.push({
      key: 'now',
      status: 'now',
      bullet: '🏁',
      title: `Day ${streak} — beyond the road map!`,
      reward: null,
      subtitle: "You've unlocked every milestone. Keep going.",
    });
  }
  return rows;
}

type Props = {
  visible: boolean;
  result: StreakResult | null;
  onClose: () => void;
};

export default function StreakModal({ visible, result, onClose }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  if (!result) return null;

  const { claimed_today, streak_after, daily_pickles, milestone_pickles, milestone_label, used_freeze, freezes_remaining, longest_streak } = result;
  const total = daily_pickles + milestone_pickles;
  const timeline = buildTimeline(streak_after);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={S.backdrop}
        onPress={(e: any) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <View style={S.card}>
          <ScrollView contentContainerStyle={S.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={S.header}>
              <Text style={S.flame}>🔥</Text>
              <Text style={S.streakNum}>{streak_after}</Text>
              <Text style={S.streakLabel}>day streak</Text>
            </View>

            {claimed_today ? (
              <View style={S.rewardBox}>
                <Text style={S.rewardHeading}>Today's reward</Text>
                <View style={S.rewardRow}>
                  <Text style={S.rewardLine}>Daily login</Text>
                  <Text style={S.rewardAmount}>+{daily_pickles} 🥒</Text>
                </View>
                {milestone_pickles > 0 && (
                  <View style={S.rewardRow}>
                    <Text style={[S.rewardLine, S.milestoneLine]}>🎉 {milestone_label}</Text>
                    <Text style={[S.rewardAmount, S.milestoneAmount]}>+{milestone_pickles} 🥒</Text>
                  </View>
                )}
                <View style={S.totalRow}>
                  <Text style={S.totalLabel}>Total</Text>
                  <Text style={S.totalAmount}>+{total} 🥒</Text>
                </View>
              </View>
            ) : (
              <View style={S.rewardBox}>
                <Text style={S.alreadyHeading}>Already claimed today ✓</Text>
                <Text style={S.alreadyBody}>Come back tomorrow to extend your streak.</Text>
              </View>
            )}

            {used_freeze && (
              <Text style={S.freezeNote}>❄️ Used a streak freeze to bridge a missed day.</Text>
            )}

            <Text style={S.sectionHeading}>Road map</Text>
            <View style={S.timeline}>
              {timeline.map((row, i) => (
                <TimelineEntry
                  key={row.key}
                  row={row}
                  isFirst={i === 0}
                  isLast={i === timeline.length - 1}
                  colors={c}
                />
              ))}
            </View>

            <View style={S.metaRow}>
              <View style={S.metaCell}>
                <Text style={S.metaLabel}>Longest</Text>
                <Text style={S.metaValue}>{longest_streak}</Text>
              </View>
              <View style={S.metaCell}>
                <Text style={S.metaLabel}>Freezes left</Text>
                <Text style={S.metaValue}>{freezes_remaining}</Text>
              </View>
            </View>
          </ScrollView>

          <Pressable style={S.primaryBtn} onPress={onClose}>
            <Text style={S.primaryBtnText}>{claimed_today ? 'Sweet!' : 'Got it'}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

function TimelineEntry({
  row, isFirst, isLast, colors,
}: {
  row: TimelineRow;
  isFirst: boolean;
  isLast: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const S = makeStyles(colors);
  const statusStyle =
    row.status === 'done'   ? S.entryDone   :
    row.status === 'now'    ? S.entryNow    :
    row.status === 'next'   ? S.entryNext   :
    S.entryFuture;
  const titleStyle =
    row.status === 'done'   ? S.titleDone   :
    row.status === 'now'    ? S.titleNow    :
    row.status === 'next'   ? S.titleNext   :
    S.titleFuture;
  return (
    <View style={S.entryRow}>
      <View style={S.bulletColumn}>
        <View style={[S.lineSeg, isFirst && S.lineHidden]} />
        <View style={[S.bullet, statusStyle]}>
          <Text style={S.bulletText}>{row.bullet}</Text>
        </View>
        <View style={[S.lineSeg, S.lineSegBottom, isLast && S.lineHidden]} />
      </View>
      <View style={S.entryBody}>
        <View style={S.entryTitleRow}>
          <Text style={[S.entryTitle, titleStyle]}>{row.title}</Text>
          {row.reward !== null && (
            <Text style={[S.rewardChip, row.status === 'done' && S.rewardChipDone]}>
              +{row.reward} 🥒
            </Text>
          )}
        </View>
        <Text style={[S.entrySubtitle, row.status === 'done' && S.subtitleDone]}>
          {row.subtitle}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:         { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    card:             { width: '100%', maxWidth: 440, maxHeight: '90%', backgroundColor: c.surface, borderRadius: 16, overflow: 'hidden' },
    scrollContent:    { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 16 },

    header:           { alignItems: 'center', marginBottom: 16 },
    flame:            { fontSize: 56, marginBottom: 4 },
    streakNum:        { fontSize: 64, fontWeight: '900', color: c.primary, lineHeight: 70 },
    streakLabel:      { fontSize: 14, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 },

    rewardBox:        { width: '100%', backgroundColor: c.primaryLight, borderRadius: 12, padding: 14, marginBottom: 12 },
    rewardHeading:    { fontSize: 12, fontWeight: '800', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
    rewardRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
    rewardLine:       { fontSize: 14, color: c.text, fontWeight: '600' },
    rewardAmount:     { fontSize: 14, color: c.primary, fontWeight: '700' },
    milestoneLine:    { color: c.primary, fontWeight: '800' },
    milestoneAmount:  { fontSize: 16, fontWeight: '800' },
    totalRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, marginTop: 6, borderTopWidth: 1, borderTopColor: c.primary },
    totalLabel:       { fontSize: 13, color: c.textSub, fontWeight: '700' },
    totalAmount:      { fontSize: 18, color: c.primary, fontWeight: '900' },

    alreadyHeading:   { fontSize: 14, fontWeight: '800', color: c.primary, textAlign: 'center', marginBottom: 6 },
    alreadyBody:      { fontSize: 13, color: c.textSub, textAlign: 'center' },
    freezeNote:       { fontSize: 12, color: c.textMuted, fontStyle: 'italic', marginBottom: 12, textAlign: 'center' },

    sectionHeading:   { fontSize: 12, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 8, marginBottom: 12 },
    timeline:         { width: '100%', marginBottom: 8 },

    entryRow:         { flexDirection: 'row', alignItems: 'stretch' },
    bulletColumn:     { width: 28, alignItems: 'center' },
    lineSeg:          { flex: 1, width: 2, backgroundColor: c.border, minHeight: 6 },
    lineSegBottom:    { minHeight: 6 },
    lineHidden:       { backgroundColor: 'transparent' },
    bullet:           { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
    bulletText:       { fontSize: 13, lineHeight: 14 },
    entryBody:        { flex: 1, paddingLeft: 12, paddingTop: 4, paddingBottom: 12 },
    entryTitleRow:    { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 2 },
    entryTitle:       { fontSize: 15, fontWeight: '700' },
    entrySubtitle:    { fontSize: 12, color: c.textSub },
    rewardChip:       { fontSize: 13, fontWeight: '800', color: c.primary, backgroundColor: c.primaryLight, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },

    // status-specific
    entryDone:        { backgroundColor: c.primary, borderColor: c.primary },
    entryNow:         { backgroundColor: c.surface, borderColor: c.primary, transform: [{ scale: 1.15 }] },
    entryNext:        { backgroundColor: c.primaryLight, borderColor: c.primary },
    entryFuture:      { backgroundColor: c.surface, borderColor: c.border },
    titleDone:        { color: c.textSub },
    titleNow:         { color: c.primary, fontWeight: '900' },
    titleNext:        { color: c.text },
    titleFuture:      { color: c.textSub },
    subtitleDone:     { color: c.textMuted },
    rewardChipDone:   { color: c.textSub, backgroundColor: c.bg },

    metaRow:          { flexDirection: 'row', marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border, gap: 16 },
    metaCell:         { flex: 1, alignItems: 'center' },
    metaLabel:        { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
    metaValue:        { fontSize: 18, fontWeight: '800', color: c.text },

    primaryBtn:       { backgroundColor: c.primary, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
    primaryBtnText:   { color: '#fff', fontSize: 15, fontWeight: '700' },
  });
}
