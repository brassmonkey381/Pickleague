import React from 'react';
import { Platform, ScrollView, View, Text, StyleSheet } from 'react-native';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';

// Courier is iOS's; Android and web read the generic family.
const MONO = Platform.select({ ios: 'Courier', default: 'monospace' });

export default function ScoringAlgoScreen() {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  return (
    <ScrollView contentContainerStyle={S.container}>
      {/* Hero */}
      <View style={S.hero}>
        <Text style={S.heroVersion}>PLUPR · v1</Text>
        <Text style={S.heroTitle}>Scoring Algo</Text>
        <Text style={S.heroSub}>
          Pickleague Universal Pickleball Rating — how every match changes
          your number.
        </Text>
      </View>

      {/* Scale */}
      <Section S={S} title="The scale">
        <P S={S}>
          PLUPR runs from <B S={S}>2.000</B> (floor) to roughly <B S={S}>8.000+</B>,
          with three decimal places. New players start at <B S={S}>3.250</B>.
          Higher = stronger.
        </P>
        <Bullet S={S}>Beginner range: ~2.500–3.250</Bullet>
        <Bullet S={S}>Intermediate: ~3.250–4.000</Bullet>
        <Bullet S={S}>Advanced: ~4.000–5.000</Bullet>
        <Bullet S={S}>Expert / pro: 5.000+</Bullet>
      </Section>

      {/* Per-match formula */}
      <Section S={S} title="Per-match formula">
        <P S={S}>
          For every completed match we compute a <B S={S}>delta</B> for each
          team, applied symmetrically (winner gains, loser loses by the same
          amount). PLUPR uses a <B S={S}>margin-of-victory</B> model: the
          algorithm predicts the final point differential from the two teams'
          ratings, then rewards or penalizes you based on whether you beat
          that prediction.
        </P>

        <Sub S={S}>1 · Predicted point differential</Sub>
        <Mono S={S}>{`expected_diff = 10 × tanh((you − opp) / 1.0)`}</Mono>
        <P S={S}>
          A smooth curve that asymptotes at <B S={S}>±10</B> (the largest
          margin in a game to 11). Equal ratings predict a toss-up; a
          1.0-PLUPR gap predicts roughly an 11-3 win; a 2.0-PLUPR gap predicts
          a near-shutout.
        </P>
        <Mono S={S}>{`gap 0.0 →  0.0   (toss-up)
gap 0.5 → +4.6   (~ 11-6)
gap 1.0 → +7.6   (~ 11-3)
gap 2.0 → +9.6   (blowout)`}</Mono>

        <Sub S={S}>2 · Actual point differential</Sub>
        <Mono S={S}>{`actual_diff = yourScore − oppScore`}</Mono>
        <P S={S}>
          A signed value: <B S={S}>+11</B> for a shutout win, <B S={S}>−11</B>{' '}
          for being shut out. An 11-9 loss is <B S={S}>−2</B>.
        </P>

        <Sub S={S}>3 · Surprise</Sub>
        <Mono S={S}>{`surprise = (actual_diff − expected_diff) / 10`}</Mono>
        <P S={S}>
          How much you beat (or missed) expectations, normalized to a
          ~<B S={S}>−2 to +2</B> range. Critically, a close loss against a
          much stronger opponent can still produce a <B S={S}>positive</B>{' '}
          surprise — you exceeded the prediction even though you didn't win.
        </P>

        <Sub S={S}>4 · K factor (decays with experience)</Sub>
        <Mono S={S}>{`matches < 5  → K = 1.75
matches < 15 → K = 1.10
else         → K = 0.75`}</Mono>
        <P S={S}>
          Newer players move faster (their early ratings are noisy);
          established players move slowly (their ratings are confident).
        </P>

        <Sub S={S}>5 · The delta</Sub>
        <Mono S={S}>{`delta = K × surprise   (at most ±0.60; ±0.80 under 5 matches)`}</Mono>
        <P S={S}>
          Rounded to 3 decimal places. Ratings are clamped at <B S={S}>2.000</B>{' '}
          floor.
        </P>
      </Section>

      {/* Doubles */}
      <Section S={S} title="Doubles">
        <P S={S}>
          For doubles matches we average each side's two players' PLUPRs to
          get team ratings, then run the same formula. The full team delta is
          applied <B S={S}>identically</B> to both teammates — you and your
          partner gain or lose the same amount.
        </P>
        <P S={S}>
          Doubles matches additionally split into <B S={S}>Gendered</B>{' '}
          (all four players share a gender) or <B S={S}>Mixed</B> (anything
          else). Each variant maintains a separate facet PLUPR (Doubles
          Gendered, Doubles Mixed) — your overall PLUPR also moves. Matches
          with any unspecified-gender player don't affect any rating.
        </P>
      </Section>

      {/* Period reset */}
      <Section S={S} title="Period & season resets">
        <P S={S}>
          Inside a league season, every locked-in <B S={S}>period</B> triggers
          a soft PLUPR reset. Top-5 finishers carry a small head start into
          the next period; everyone else snaps to the base.
        </P>
        <View style={S.resetBox}>
          <Reset S={S} place={1} rank="1st" final={3.65} bonus={0.40} />
          <Reset S={S} place={2} rank="2nd" final={3.525} bonus={0.275} />
          <Reset S={S} place={3} rank="3rd" final={3.425} bonus={0.175} />
          <Reset S={S} rank="4th"   final={3.35} bonus={0.10} />
          <Reset S={S} rank="5th"   final={3.30} bonus={0.05} />
          <Reset S={S} rank="rest"  final={3.25} bonus={0}   note="(default)" />
        </View>
        <P S={S}>
          Season completion uses the same ladder, applied to a player's{' '}
          <B S={S}>median rank across all locked periods</B> — so consistency
          beats one big finish.
        </P>
      </Section>

      {/* Facets */}
      <Section S={S} title="Four PLUPR facets per player">
        <Bullet S={S}><B S={S}>Overall</B> — every match counts</Bullet>
        <Bullet S={S}><B S={S}>Singles</B> — 1v1 only</Bullet>
        <Bullet S={S}><B S={S}>Gendered Doubles</B> — same-gender doubles</Bullet>
        <Bullet S={S}><B S={S}>Mixed Doubles</B> — mixed-gender doubles</Bullet>
        <P S={S}>
          See your trajectory across all four on the chart in your Profile.
        </P>
      </Section>

      {/* History */}
      <Section S={S} title="What changed in v1?">
        <P S={S}>
          PLUPR v1 replaces an earlier integer-scale rating system. We
          wiped all rating history and replayed every recorded match in
          chronological order, so every player's PLUPR reflects their
          match history under the current algorithm.
        </P>
        <P S={S}>
          Match snapshots (<B S={S}>before</B> / <B S={S}>after</B> ratings)
          are now stored as PLUPR values too, so trajectory charts and
          per-match deltas read naturally.
        </P>
      </Section>

      <Text style={S.footnote}>PLUPR v1.1 · Last updated 2026-05-23</Text>
    </ScrollView>
  );
}

// ── Layout helpers ─────────────────────────────────────────────────────

function Section({ S, title, children }: { S: ReturnType<typeof makeStyles>; title: string; children: React.ReactNode }) {
  return (
    <View style={S.section}>
      <Text style={S.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
function Sub({ S, children }: { S: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return <Text style={S.subTitle}>{children}</Text>;
}
function P({ S, children }: { S: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return <Text style={S.body}>{children}</Text>;
}
function B({ S, children }: { S: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return <Text style={S.bold}>{children}</Text>;
}
function Bullet({ S, children }: { S: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return (
    <View style={S.bulletRow}>
      <Text style={S.bulletDot}>•</Text>
      <Text style={S.bulletText}>{children}</Text>
    </View>
  );
}
function Mono({ S, children }: { S: ReturnType<typeof makeStyles>; children: string }) {
  return (
    <View style={S.monoBox}>
      <Text style={S.monoText}>{children}</Text>
    </View>
  );
}
/** One ladder row. `place` 1-3 draws the RankMedal before the label; the
 *  other rows keep the medal's width so every label starts in one column. */
function Reset({ S, place, rank, final, bonus, note }: { S: ReturnType<typeof makeStyles>; place?: number; rank: string; final: number; bonus: number; note?: string }) {
  return (
    <View style={S.resetRow}>
      <View style={S.resetRank}>
        {place ? <RankMedal place={place} /> : <View style={S.medalSpacer} />}
        <Text style={S.resetRankText}>{rank}</Text>
      </View>
      <Text style={S.resetCalc}>3.250 + {bonus.toFixed(3)}</Text>
      <Text style={S.resetEquals}>=</Text>
      <Text style={S.resetFinal}>{final.toFixed(3)}{note ? ` ${note}` : ''}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container: { padding: SPACE.lg, paddingBottom: SPACE.xl * 2, backgroundColor: c.bg },

    hero: {
      backgroundColor: c.headerBg,
      borderRadius: RADIUS.lg, padding: SPACE.lg, marginBottom: SPACE.md,
      shadowColor: c.shadow, shadowOpacity: 0.15, shadowRadius: SPACE.sm, shadowOffset: { width: 0, height: 3 }, elevation: 4,
    },
    heroVersion: { ...t.label, color: c.headerSub, marginBottom: SPACE.xs },
    heroTitle:   { ...t.display, color: c.headerText, marginBottom: SPACE.xs },
    heroSub:     { ...t.sub, color: c.headerSub },

    section: {
      backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg, marginBottom: SPACE.md,
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    sectionTitle: { ...t.h3, marginBottom: SPACE.sm },
    subTitle:     { ...t.fieldLabel, color: c.textSub, marginTop: SPACE.md, marginBottom: SPACE.xs },
    body:         { ...t.bodySub, marginBottom: SPACE.sm },
    bold:         { fontWeight: FONT.weight.heavy, color: c.text },

    bulletRow:    { flexDirection: 'row', alignItems: 'flex-start', marginBottom: SPACE.xs },
    bulletDot:    { fontSize: FONT.size.md, color: c.primary, marginRight: SPACE.sm, lineHeight: FONT.line.normal },
    bulletText:   { ...t.bodySub, flex: 1 },

    // 3px accent edge, as Panel's emphasis variant.
    monoBox:  { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.sm, padding: SPACE.md, marginVertical: SPACE.sm, borderLeftWidth: 3, borderLeftColor: c.primary },
    monoText: { fontFamily: MONO, fontSize: FONT.size.sm, color: c.text, lineHeight: FONT.line.tight },

    resetBox: { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, marginVertical: SPACE.sm },
    resetRow: { flexDirection: 'row', alignItems: 'center', minHeight: 28, paddingVertical: SPACE.xxs },
    resetRank:     { width: 64, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    // RankMedal's default 20px disc, so the "4th" / "rest" labels line up with "1st".
    medalSpacer:   { width: 20 },
    resetRankText: { fontSize: FONT.size.base, fontWeight: FONT.weight.bold, color: c.text },
    resetCalc:   { width: 110, fontSize: FONT.size.sm, color: c.textSub, fontFamily: MONO },
    resetEquals: { width: 18, textAlign: 'center', color: c.textMuted },
    resetFinal:  { flex: 1, fontSize: FONT.size.base, fontWeight: FONT.weight.heavy, color: c.primary, fontFamily: MONO },

    footnote: { ...t.caption, textAlign: 'center', marginTop: SPACE.md },
  });
}
