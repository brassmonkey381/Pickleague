// One proposed time on EventDetail, built to be read at a glance: the day and
// the time range each on their own large line (never cut off), a check circle
// for my vote, and the count on the right ("3/8"), then a thin availability
// bar and who said yes. While voting is open the whole card is the vote toggle
// (a 64+ box); afterwards it's read-only inside "Vote results", with the
// winner marked.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Badge } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import type { EventSlot, SlotVoter } from '../../types';
import VoterChips from './VoterChips';

export type EventSlotCardProps = {
  slot: EventSlot;
  /** "Option N" label (matches the numbered times in the vote push); omit for a single slot. */
  optionNo?: number | null;
  memberCount: number;
  isWinner: boolean;
  /** Voting is open: the card toggles the viewer's vote. */
  votable: boolean;
  busy: boolean;
  onToggle: () => void;
};

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function EventSlotCard({ slot, optionNo, memberCount, isWinner, votable, busy, onToggle }: EventSlotCardProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const mine = slot.my_vote ?? false;
  const votes = slot.vote_count ?? 0;
  const pct = memberCount > 0 ? Math.min(votes / memberCount, 1) : 0;
  const day = fmtDay(slot.starts_at);
  const time = `${fmtTime(slot.starts_at)} – ${fmtTime(slot.ends_at)}`;
  const accent = isWinner ? c.info : c.primary;

  return (
    <TouchableOpacity
      style={[S.card, mine && S.cardMine, isWinner && S.cardWinner]}
      onPress={onToggle}
      disabled={!votable || busy}
      activeOpacity={votable ? 0.7 : 1}
      accessibilityRole={votable ? 'checkbox' : undefined}
      accessibilityState={votable ? { checked: mine, busy } : undefined}
      accessibilityLabel={`${optionNo ? `Option ${optionNo}, ` : ''}${day}, ${time}, ${votes} of ${memberCount} available${isWinner ? ', confirmed time' : ''}`}
    >
      <View style={S.top}>
        {votable ? (
          <View style={[S.check, mine && { backgroundColor: c.primary, borderColor: c.primary }]}>
            {busy
              ? <ActivityIndicator size="small" color={mine ? c.textInverse : c.primary} />
              : mine ? <Icon name="check-mark" size={18} color={c.textInverse} /> : null}
          </View>
        ) : null}
        <View style={S.when}>
          <Text style={S.day}>
            {optionNo ? <Text style={S.optionNo}>{optionNo}  </Text> : null}
            {day}
          </Text>
          <Text style={[S.time, { color: accent }]}>{time}</Text>
        </View>
        <View style={S.count}>
          <Text style={S.countBig}>
            {votes}
            <Text style={S.countOf}>/{memberCount}</Text>
          </Text>
          {isWinner ? (
            <Badge iconName="star" label="Confirmed" tone="info" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
          ) : null}
        </View>
      </View>
      <View style={S.barBg}>
        <View style={[S.barFill, { width: `${pct * 100}%` as any, backgroundColor: accent }]} />
      </View>
      <VoterChips voters={(slot.voters ?? []) as SlotVoter[]} max={6} />
    </TouchableOpacity>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    card: {
      minHeight: 64,
      padding: SPACE.md,
      gap: SPACE.sm,
      borderRadius: RADIUS.lg,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surface,
      marginBottom: SPACE.sm,
    },
    cardMine: { borderColor: c.primary, backgroundColor: c.primaryLight },
    cardWinner: { borderColor: c.info, backgroundColor: c.infoLight },
    top: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
    check: {
      width: 32, height: 32, borderRadius: RADIUS.pill, borderWidth: 2, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface,
    },
    when: { flex: 1, minWidth: 0 },
    day: { ...t.h2 },
    optionNo: { ...t.h2, color: c.textMuted },
    time: { ...t.title, fontSize: FONT.size.xl, marginTop: SPACE.xxs },
    count: { alignItems: 'flex-end', gap: SPACE.xs },
    countBig: { ...t.h2 },
    countOf: { ...t.body, color: c.textSub, fontWeight: FONT.weight.semibold },
    barBg: { height: SPACE.xs, backgroundColor: c.border, borderRadius: RADIUS.pill, overflow: 'hidden' },
    barFill: { height: SPACE.xs, borderRadius: RADIUS.pill },
  });
}
