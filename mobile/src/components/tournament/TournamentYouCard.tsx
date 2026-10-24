// TournamentDetail's "You" card (plan section 5, slot 2): the screen's one
// Emphasis card (Panel + 3px accent left edge, no shadow) with the viewer's
// status and ONE primary action, per the status x role table:
//
//   Registration  spectator    [Request to join] / [Join waitlist] · spots · ante
//                 invitee      "X invited you" [Accept] [Decline]
//                 requester / waitlisted / rejected: one status line
//                 approved     "You're in" · partner / team · bracket countdown
//                 organizer    "Setup 1 of 5 · Approve 3 requests ›" -> Manage
//   Active        player       Next match: vs X & Y · round · [Record score]
//                 spectator    no card (the status strip has the stage)
//   Completed     anyone       your finish + podium + payout (tournament_final_ranks)
//   Cancelled     no card
//
// The kind is decided by tournamentModel.youCardKind; youCardView turns it and
// the screen's facts into what this card renders, so the StickyActionBar can
// repeat the same primary action once the card scrolls off.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, RankMedal, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button, type ButtonVariant } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { ordinal, type YouCardKind } from './tournamentModel';

export type YouCardAction = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
};

export type YouCardView = {
  /** Small caps line above the title ("Next match"). */
  eyebrow?: string;
  title: string;
  /** Up to two supporting lines (each clamped to 1 line). */
  lines?: string[];
  primary?: YouCardAction;
  /** Sits after the primary (e.g. Decline next to Accept). */
  secondary?: YouCardAction;
  /** A text link in its own 44 box ("Find a partner" + chevron glyph). */
  link?: { label: string; onPress: () => void };
  /** The whole card opens something (Setup -> Manage); shows a chevron. */
  onPress?: () => void;
  /** Completed: the top places from tournament_final_ranks. */
  podium?: { rank: number; names: string; isMe: boolean }[];
};

/** Everything the screen knows that the card's copy needs. */
export type YouCardFacts = {
  // Registration, spectator
  isFull: boolean;
  spotsLeft: number | null;
  ante: number;
  closesLabel: string | null;
  register: () => void;
  registering?: boolean;
  // Invitee
  inviterName: string;
  accept: () => void;
  decline: () => void;
  responding?: boolean;
  // Waitlisted
  waitlistPosition: number | null;
  // Approved
  teamLine: string | null;
  needsPartner: boolean;
  findPartnerLabel: string;
  onFindPartner: () => void;
  releaseLine: string | null;
  // Organizer setup
  setupIndex: number;
  setupTotal: number;
  setupLabel: string;
  /** Co-admin, and the next step (generate / lock in) is the admin's only. */
  setupWaitingOnAdmin?: boolean;
  onOpenSetup: () => void;
  // Active player
  opponents: string;
  partner: string | null;
  roundLabel: string | null;
  recordLine: string | null;
  onRecord: () => void;
  onOpenSchedule: (() => void) | null;
  // Completed
  myRank: number | null;
  podium: { rank: number; names: string; isMe: boolean }[];
  payoutLine: string | null;
};

/** "50-pickle ante" (prose: the pickle glyph stays out of sentences). */
const anteLabel = (ante: number) => `${ante.toLocaleString()}-pickle ante`;

/** The card's content for a kind, or null when the kind has no card. */
export function youCardView(kind: YouCardKind, f: YouCardFacts): YouCardView | null {
  switch (kind) {
    case 'join': {
      const facts = [
        f.isFull ? 'Full' : f.spotsLeft != null ? `${f.spotsLeft} spot${f.spotsLeft === 1 ? '' : 's'} left` : null,
        f.ante > 0 ? anteLabel(f.ante) : null,
        f.closesLabel,
      ].filter(Boolean) as string[];
      return {
        title: f.isFull ? 'This tournament is full' : 'Want to play?',
        lines: [
          f.isFull ? 'Join the waitlist and you\'re in when a spot opens.' : 'Request a spot and an organizer will approve it.',
          ...(facts.length ? [facts.join(' · ')] : []),
        ],
        primary: { title: f.isFull ? 'Join waitlist' : 'Request to join', onPress: f.register, loading: f.registering },
      };
    }
    case 'invite_only':
      return { title: 'Invite only', lines: ['Ask an organizer to add you.'] };
    case 'closed':
      return { title: 'Registration has closed', lines: ['This tournament isn\'t taking new players.'] };
    case 'invited':
      return {
        title: `${f.inviterName} invited you`,
        lines: f.ante > 0 ? [`Entry is a ${anteLabel(f.ante)}, charged when you accept.`] : ['Accept to take your spot.'],
        primary: { title: 'Accept', onPress: f.accept, loading: f.responding },
        secondary: { title: 'Decline', onPress: f.decline, variant: 'outline', disabled: f.responding },
      };
    case 'requested':
      return { title: 'Request sent', lines: ['An organizer will review it.'] };
    case 'waitlisted':
      return {
        title: f.waitlistPosition != null ? `#${f.waitlistPosition} on the waitlist` : 'On the waitlist',
        lines: ['You\'ll be notified when a spot opens.'],
      };
    case 'rejected':
      return { title: 'Request not approved' };
    case 'approved':
      return {
        title: 'You\'re in',
        lines: [f.teamLine, f.releaseLine].filter(Boolean) as string[],
        link: f.needsPartner ? { label: f.findPartnerLabel, onPress: f.onFindPartner } : undefined,
      };
    case 'setup':
      return {
        eyebrow: 'Setup',
        // A co-admin can't generate or lock in; say who the step is waiting
        // on instead of pointing them at a button they don't have. The card
        // still opens Manage (preview, roster, invites).
        title: f.setupWaitingOnAdmin
          ? 'Waiting on the tournament admin'
          : `Step ${f.setupIndex + 1} of ${f.setupTotal}: ${f.setupLabel}`,
        lines: [f.setupWaitingOnAdmin ? `Next: ${f.setupLabel} (admin only).` : 'Open Manage to finish setting up.'],
        onPress: f.onOpenSetup,
      };
    case 'next_match':
      return {
        eyebrow: 'Next match',
        title: `vs ${f.opponents}`,
        lines: [
          [f.roundLabel, f.partner ? `with ${f.partner}` : null].filter(Boolean).join(' · '),
          f.recordLine ?? '',
        ].filter(Boolean),
        primary: { title: 'Record score', onPress: f.onRecord },
      };
    case 'playing':
      return {
        title: 'No match to play right now',
        lines: f.recordLine ? [f.recordLine] : ['Your next match shows here once it is drawn.'],
        link: f.onOpenSchedule ? { label: 'Schedule', onPress: f.onOpenSchedule } : undefined,
      };
    case 'finished':
      return {
        eyebrow: 'Final results',
        title: f.myRank != null ? `You finished ${ordinal(f.myRank)}` : 'Podium',
        podium: f.podium,
        lines: f.payoutLine ? [f.payoutLine] : undefined,
      };
    default:
      return null;
  }
}

export default function TournamentYouCard({ view }: { view: YouCardView }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);

  const textBlock = (
    <View style={styles.text}>
      {view.eyebrow ? (
        <Text style={t.label} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{view.eyebrow}</Text>
      ) : null}
      <Text style={t.title} numberOfLines={2} accessibilityRole="header">{view.title}</Text>
      {(view.lines ?? []).slice(0, 2).map((l, i) => (
        <Text key={i} style={t.sub} numberOfLines={1}>{l}</Text>
      ))}
    </View>
  );

  return (
    <Panel emphasis style={styles.card}>
      {view.onPress ? (
        <TouchableOpacity
          onPress={view.onPress}
          activeOpacity={0.7}
          style={styles.pressRow}
          accessibilityRole="button"
          accessibilityLabel={[view.eyebrow, view.title].filter(Boolean).join(': ')}
        >
          {textBlock}
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>
      ) : textBlock}

      {view.podium && view.podium.length > 0 ? (
        <View style={styles.podium}>
          {view.podium.map((p, i) => (
            <View
              key={p.rank}
              style={[styles.podiumRow, i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}
            >
              <View style={styles.medal}>
                <RankMedal place={p.rank} />
              </View>
              <Text
                style={[t.sub, styles.podiumName, { color: p.isMe ? c.primary : c.text }, p.isMe && styles.strong]}
                numberOfLines={1}
              >
                {p.names}{p.isMe ? ' (you)' : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.primary || view.secondary || view.link ? (
        <View style={styles.actions}>
          {view.primary ? (
            <Button
              size="sm"
              title={view.primary.title}
              onPress={view.primary.onPress}
              loading={view.primary.loading}
              disabled={view.primary.disabled}
              variant={view.primary.variant ?? 'primary'}
            />
          ) : null}
          {view.secondary ? (
            <Button
              size="sm"
              title={view.secondary.title}
              onPress={view.secondary.onPress}
              loading={view.secondary.loading}
              disabled={view.secondary.disabled}
              variant={view.secondary.variant ?? 'outline'}
            />
          ) : null}
          {view.link ? <TextLink label={view.link.label} onPress={view.link.onPress} /> : null}
        </View>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { gap: SPACE.sm },
  text: { flex: 1, minWidth: 0, gap: SPACE.xxs },
  pressRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  podium: {},
  podiumRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  medal: { width: 32, alignItems: 'flex-start' },
  podiumName: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
});
