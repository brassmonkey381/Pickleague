import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

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
        <Mono S={S}>{`matches < 5  → K = 0.35
matches < 15 → K = 0.22
else         → K = 0.15`}</Mono>
        <P S={S}>
          Newer players move faster (their early ratings are noisy);
          established players move slowly (their ratings are confident).
        </P>

        <Sub S={S}>5 · The delta</Sub>
        <Mono S={S}>{`delta = K × surprise`}</Mono>
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
          <Reset S={S} rank="🥇 1st" final={3.65} bonus={0.40} />
          <Reset S={S} rank="🥈 2nd" final={3.525} bonus={0.275} />
          <Reset S={S} rank="🥉 3rd" final={3.425} bonus={0.175} />
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
function Reset({ S, rank, final, bonus, note }: { S: ReturnType<typeof makeStyles>; rank: string; final: number; bonus: number; note?: string }) {
  return (
    <View style={S.resetRow}>
      <Text style={S.resetRank}>{rank}</Text>
      <Text style={S.resetCalc}>3.250 + {bonus.toFixed(3)}</Text>
      <Text style={S.resetEquals}>=</Text>
      <Text style={S.resetFinal}>{final.toFixed(3)}{note ? ` ${note}` : ''}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 16, paddingBottom: 60, backgroundColor: c.bg },

    hero: {
      backgroundColor: c.headerBg,
      borderRadius: 14, padding: 20, marginBottom: 16,
      shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4,
    },
    heroVersion: { fontSize: 11, fontWeight: '800', color: c.headerSub, letterSpacing: 1.5, marginBottom: 4 },
    heroTitle:   { fontSize: 28, fontWeight: '900', color: c.headerText, letterSpacing: 0.5, marginBottom: 6 },
    heroSub:     { fontSize: 13, color: c.headerSub, lineHeight: 19 },

    section: {
      backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12,
      borderWidth: 1, borderColor: c.border,
    },
    sectionTitle: { fontSize: 16, fontWeight: '900', color: c.text, marginBottom: 8 },
    subTitle:     { fontSize: 13, fontWeight: '800', color: c.textSub, marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
    body:         { fontSize: 14, color: c.textSub, lineHeight: 20, marginBottom: 8 },
    bold:         { fontWeight: '800', color: c.text },

    bulletRow:    { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
    bulletDot:    { fontSize: 14, color: c.primary, marginRight: 8, lineHeight: 20 },
    bulletText:   { flex: 1, fontSize: 14, color: c.textSub, lineHeight: 20 },

    monoBox:  { backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 10, marginVertical: 6, borderLeftWidth: 3, borderLeftColor: c.primary },
    monoText: { fontFamily: 'Courier', fontSize: 12, color: c.text, lineHeight: 18 },

    resetBox: { backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, marginVertical: 8 },
    resetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
    resetRank:   { width: 60, fontSize: 13, fontWeight: '700', color: c.text },
    resetCalc:   { width: 110, fontSize: 12, color: c.textSub, fontFamily: 'Courier' },
    resetEquals: { width: 18, textAlign: 'center', color: c.textMuted },
    resetFinal:  { flex: 1, fontSize: 13, fontWeight: '800', color: c.primary, fontFamily: 'Courier' },

    footnote: { textAlign: 'center', fontSize: 11, color: c.textMuted, marginTop: 12 },
  });
}
