// One proposed time on EventDetail: "Option 2 · Thu, Oct 16 · 6:00 – 8:00 PM",
// a 4px availability bar, "3 of 8 available" and the first names of who said
// yes. While voting is open the whole card is the vote toggle (a 56+ box);
// afterwards it's read-only inside "Vote results", with the winner marked.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Badge } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
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
  const when = `${fmtDay(slot.starts_at)} · ${fmtTime(slot.starts_at)} – ${fmtTime(slot.ends_at)}`;

  return (
    <TouchableOpacity
      style={[S.card, mine && S.cardMine, isWinner && S.cardWinner]}
      onPress={onToggle}
      disabled={!votable || busy}
      activeOpacity={votable ? 0.7 : 1}
      accessibilityRole={votable ? 'checkbox' : undefined}
      accessibilityState={votable ? { checked: mine, busy } : undefined}
      accessibilityLabel={`${optionNo ? `Option ${optionNo}, ` : ''}${when}, ${votes} of ${memberCount} available${isWinner ? ', confirmed time' : ''}`}
    >
      <View style={S.top}>
        <View style={S.when}>
          {optionNo ? (
            <Text style={t.fieldLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Option {optionNo}</Text>
          ) : null}
          <Text style={t.title} numberOfLines={1}>{when}</Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={c.primary} />
        ) : isWinner ? (
          <Badge label="★ Confirmed" tone="info" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
        ) : mine ? (
          <Badge label="✓ Available" tone="success" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
        ) : null}
      </View>
      <View style={S.barBg}>
        <View style={[S.barFill, { width: `${pct * 100}%` as any }, isWinner && S.barWinner]} />
      </View>
      <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {votes} of {memberCount} {memberCount === 1 ? 'player' : 'players'} available
      </Text>
      <VoterChips voters={(slot.voters ?? []) as SlotVoter[]} />
    </TouchableOpacity>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      minHeight: 56,
      padding: SPACE.md,
      gap: SPACE.xs,
      borderRadius: RADIUS.md,
      borderWidth: HAIRLINE,
      borderColor: c.border,
      backgroundColor: c.surface,
      marginBottom: SPACE.sm,
    },
    cardMine: { borderColor: c.primary, backgroundColor: c.primaryLight },
    cardWinner: { borderColor: c.info, backgroundColor: c.infoLight },
    top: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    when: { flex: 1, minWidth: 0 },
    barBg: { height: SPACE.xs, backgroundColor: c.border, borderRadius: RADIUS.pill, overflow: 'hidden', marginTop: SPACE.xs },
    barFill: { height: SPACE.xs, backgroundColor: c.primary, borderRadius: RADIUS.pill },
    barWinner: { backgroundColor: c.info },
  });
}
