/**
 * TournamentBracket — renders a pool-play → semi-finals → final bracket.
 *
 * Layout (horizontal, left-to-right):
 *
 *  [1st A] ─┐
 *            ├── [SEMI 1] ─┐
 *  [2nd B] ─┘               ├── [🏆 FINAL]
 *            ┌── [SEMI 2] ─┘
 *  [1st B] ─┘
 *            [etc.]
 *  [2nd A] ─┘
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

export type BracketSlot = {
  label: string;            // "1st Pool A", "Winner Semi 1", etc.
  team?: string;            // player1 & player2 display name (or null = TBD)
  highlight?: boolean;      // this user is in this slot
};

type Props = {
  slotA1: BracketSlot;  // 1st place Pool A
  slotA2: BracketSlot;  // 2nd place Pool A
  slotB1: BracketSlot;  // 1st place Pool B
  slotB2: BracketSlot;  // 2nd place Pool B
  semi1: BracketSlot;   // winner advances to final
  semi2: BracketSlot;
  final: BracketSlot;
};

// Fixed dimensions for bracket layout
const CW   = 128;   // card width
const CH   = 54;    // card height
const CONN = 24;    // connector line width
const SEED_V_GAP = 10;  // gap between the two seeds in one semi group
const SEMI_GAP   = 36;  // gap between the semi-final groups

// Heights
const SEMI_GROUP_H = CH + SEED_V_GAP + CH;  // 118
const TOTAL_H = SEMI_GROUP_H + SEMI_GAP + SEMI_GROUP_H; // 272

// Vertical midpoints
const SEMI1_MID = SEMI_GROUP_H / 2;          // 59
const SEMI2_TOP = SEMI_GROUP_H + SEMI_GAP;   // 154
const SEMI2_MID = SEMI2_TOP + SEMI_GROUP_H / 2; // 213

const FINAL_MID  = (SEMI1_MID + SEMI2_MID) / 2; // 136

const FINAL_COLOR = '#b8860b';

function SlotCard({ slot, isFinal }: { slot: BracketSlot; isFinal?: boolean }) {
  const { colors: c } = useTheme();
  const styles = makeStyles(c);
  const hasteam = !!slot.team;
  return (
    <View style={[
      styles.card,
      isFinal && styles.cardFinal,
      slot.highlight && styles.cardHighlight,
    ]}>
      <Text style={[styles.cardLabel, isFinal && styles.cardLabelFinal]}>{slot.label}</Text>
      <Text style={[
        styles.cardTeam,
        !hasteam && styles.cardTbd,
        slot.highlight && styles.cardTeamHighlight,
        isFinal && styles.cardTeamFinal,
      ]} numberOfLines={1}>
        {slot.team ?? 'TBD'}
      </Text>
    </View>
  );
}

export default function TournamentBracket({ slotA1, slotA2, slotB1, slotB2, semi1, semi2, final }: Props) {
  const { colors: c } = useTheme();
  const styles = makeStyles(c);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll}>
      <View style={[styles.container, { height: TOTAL_H }]}>

        {/* ── Seeds column (absolute) ────────────────────────────── */}
        {/* Semi 1 seeds */}
        <View style={[styles.abs, { left: 0, top: 0 }]}>
          <SlotCard slot={slotA1} />
        </View>
        <View style={[styles.abs, { left: 0, top: CH + SEED_V_GAP }]}>
          <SlotCard slot={slotB2} />
        </View>

        {/* Semi 2 seeds */}
        <View style={[styles.abs, { left: 0, top: SEMI2_TOP }]}>
          <SlotCard slot={slotB1} />
        </View>
        <View style={[styles.abs, { left: 0, top: SEMI2_TOP + CH + SEED_V_GAP }]}>
          <SlotCard slot={slotA2} />
        </View>

        {/* ── Connectors: seeds → semis ──────────────────────────── */}
        {/* Semi 1 connector */}
        <View style={[styles.abs, { left: CW, top: 0, width: CONN, height: SEMI_GROUP_H }]}>
          {/* top half: connects A1 center down to midpoint */}
          <View style={[styles.connTop, { height: SEMI_GROUP_H / 2 }]} />
          {/* bottom half: connects B2 center up to midpoint */}
          <View style={[styles.connBottom, { height: SEMI_GROUP_H / 2 }]} />
        </View>

        {/* Semi 2 connector */}
        <View style={[styles.abs, { left: CW, top: SEMI2_TOP, width: CONN, height: SEMI_GROUP_H }]}>
          <View style={[styles.connTop, { height: SEMI_GROUP_H / 2 }]} />
          <View style={[styles.connBottom, { height: SEMI_GROUP_H / 2 }]} />
        </View>

        {/* ── Semi-final cards ───────────────────────────────────── */}
        <View style={[styles.abs, { left: CW + CONN, top: SEMI1_MID - CH / 2 }]}>
          <SlotCard slot={semi1} />
        </View>
        <View style={[styles.abs, { left: CW + CONN, top: SEMI2_MID - CH / 2 }]}>
          <SlotCard slot={semi2} />
        </View>

        {/* Semi labels */}
        <View style={[styles.abs, { left: CW + CONN, top: SEMI1_MID - CH / 2 - 18 }]}>
          <Text style={styles.roundLabel}>SEMI-FINAL 1</Text>
        </View>
        <View style={[styles.abs, { left: CW + CONN, top: SEMI2_MID - CH / 2 - 18 }]}>
          <Text style={styles.roundLabel}>SEMI-FINAL 2</Text>
        </View>

        {/* ── Connector: semis → final ───────────────────────────── */}
        <View style={[styles.abs, {
          left: CW + CONN + CW,
          top: SEMI1_MID,
          width: CONN,
          height: SEMI2_MID - SEMI1_MID,
        }]}>
          <View style={[styles.connTopFinal, { height: (SEMI2_MID - SEMI1_MID) / 2 }]} />
          <View style={[styles.connBottomFinal, { height: (SEMI2_MID - SEMI1_MID) / 2 }]} />
        </View>

        {/* ── Final card ─────────────────────────────────────────── */}
        <View style={[styles.abs, { left: CW + CONN + CW + CONN, top: FINAL_MID - CH / 2 - 20 }]}>
          <Text style={[styles.roundLabel, styles.finalLabel]}>🏆 GRAND FINAL</Text>
        </View>
        <View style={[styles.abs, { left: CW + CONN + CW + CONN, top: FINAL_MID - CH / 2 }]}>
          <SlotCard slot={final} isFinal />
        </View>

      </View>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const BORDER_COLOR = c.textSub;

  return StyleSheet.create({
    scroll: { backgroundColor: c.surfaceAlt },
    container: {
      // total width = CW + CONN + CW + CONN + CW + 16 (right padding)
      width: 3 * CW + 2 * CONN + 24,
      position: 'relative',
      margin: 8,
    },
    abs: { position: 'absolute' },

    // Slot card
    card: {
      width: CW, height: CH,
      backgroundColor: c.surface,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: c.border,
      justifyContent: 'center',
      paddingHorizontal: 10,
    },
    cardFinal: {
      borderColor: FINAL_COLOR,
      backgroundColor: '#fffbf0',
      borderWidth: 2,
    },
    cardHighlight: {
      borderColor: c.primary,
      backgroundColor: c.primaryLight,
    },
    cardLabel: { fontSize: 9, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
    cardLabelFinal: { color: FINAL_COLOR },
    cardTeam: { fontSize: 13, fontWeight: '700', color: c.text },
    cardTbd: { color: c.textMuted, fontStyle: 'italic' },
    cardTeamHighlight: { color: c.primary },
    cardTeamFinal: { fontSize: 13 },

    roundLabel: {
      fontSize: 9, color: c.textMuted, fontWeight: '700',
      textTransform: 'uppercase', letterSpacing: 0.8,
    },
    finalLabel: { color: FINAL_COLOR, fontSize: 10 },

    // Bracket connector lines (seeds → semis)
    connTop: {
      borderRightWidth: 2,
      borderBottomWidth: 2,
      borderColor: BORDER_COLOR,
      borderBottomRightRadius: 4,
    },
    connBottom: {
      borderRightWidth: 2,
      borderTopWidth: 2,
      borderColor: BORDER_COLOR,
      borderTopRightRadius: 4,
    },

    // Bracket connector lines (semis → final)
    connTopFinal: {
      borderRightWidth: 2,
      borderBottomWidth: 2,
      borderColor: FINAL_COLOR,
      borderBottomRightRadius: 4,
    },
    connBottomFinal: {
      borderRightWidth: 2,
      borderTopWidth: 2,
      borderColor: FINAL_COLOR,
      borderTopRightRadius: 4,
    },
  });
}
