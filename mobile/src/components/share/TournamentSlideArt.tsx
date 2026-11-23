// PKL-070: one tournament slide's body (lib/tournamentSlides): the format and
// the draw, the results, or the standings. ShareCardArt puts it in the card's
// frame (header, footer, the look's court texture) and scales it to fit. `k`
// is the card's unit (the preview is 300 wide; a story a step bigger). The
// sharer is lit up on every slide: their rows and their side of a match on the
// look's accent, the way the Bracket layout marks "YOU".
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { ShareLookDef } from '../../lib/shareCards';
import {
  packSections,
  type SlideGrid,
  type SlideMatch,
  type SlidePageId,
  type SlideSection,
  type SlideSide,
  type SlideStandRow,
  type SlideTable,
  type TournamentSlides,
} from '../../lib/tournamentSlides';

type P = { look: ShareLookDef; k: number };

export default function TournamentSlideArt({ slides, page, you, look, k }: P & {
  slides: TournamentSlides;
  page: SlidePageId;
  /** The sharer's line ("2nd place", "Record 3-1"). */
  you: string;
}) {
  const sub =
    page === 'draw' ? slides.formatLine
    : page === 'results' ? slides.statusLine
    : slides.standings?.title ?? 'Standings';
  return (
    <View style={{ gap: 9 * k }}>
      <View style={{ gap: 3 * k }}>
        <Text style={[st.title, { color: look.ink, fontSize: 16 * k }]} numberOfLines={2}>{slides.title}</Text>
        {/* The draw's format line can be long: it gets the width, the YOU pill goes on the field line. */}
        {page === 'draw' ? <Text style={[st.sub, { color: look.accent, fontSize: 12 * k }]} numberOfLines={3}>{sub}</Text> : null}
        <View style={[st.row, { gap: 8 * k }]}>
          {page === 'draw'
            ? <Text style={[st.sub, { color: look.muted, fontSize: 10.5 * k, flex: 1 }]} numberOfLines={2}>{slides.fieldLine}</Text>
            : <Text style={[st.sub, { color: look.accent, fontSize: 12 * k, flex: 1 }]} numberOfLines={2}>{sub}</Text>}
          <View style={{ backgroundColor: look.accent, borderRadius: 8 * k, paddingHorizontal: 7 * k, paddingVertical: 3 * k, flexShrink: 0, maxWidth: '55%' }}>
            <Text style={[st.bold, { color: look.ground, fontSize: 9.5 * k }]} numberOfLines={1}>YOU  {you}</Text>
          </View>
        </View>
      </View>
      {page === 'standings' ? <Journey slides={slides} look={look} k={k} /> : null}
      {page === 'draw' ? <Draw slides={slides} look={look} k={k} />
        : page === 'results' ? <Results slides={slides} look={look} k={k} />
        : <Standings slides={slides} look={look} k={k} />}
    </View>
  );
}

// ── Slide 1: format & draw ──────────────────────────────────────────────

function Draw({ slides, look, k }: P & { slides: TournamentSlides }) {
  const d = slides.draw;
  const then = d.then.length ? `Then: ${d.then.join(', ')}` : null;
  return (
    <View style={{ gap: 8 * k }}>
      {d.kind === 'pools' ? (
        <View style={[st.wrap, { rowGap: 6 * k }]}>
          {d.pools.map((p, i) => (
            <View key={i} style={[d.pools.length > 1 ? st.half : st.full, { backgroundColor: look.chip, borderRadius: 8 * k, padding: 6 * k, gap: 3 * k }]}>
              <Heading text={p.label} look={look} k={k} />
              {p.teams.map((t, j) => <NameLine key={j} side={t} look={look} k={k} seed />)}
            </View>
          ))}
        </View>
      ) : d.kind === 'bracket' ? (
        <View style={{ gap: 4 * k }}>
          <Heading text={d.section.label} look={look} k={k} />
          <Boxes matches={d.section.matches} look={look} k={k} seeds noScores cols={d.section.matches.length > 1 ? 2 : 1} />
        </View>
      ) : (
        <View style={[st.wrap, { rowGap: 4 * k }]}>
          {d.teams.map((t, j) => (
            <View key={j} style={d.teams.length > 6 ? st.half : st.full}><NameLine side={t} look={look} k={k} seed /></View>
          ))}
        </View>
      )}
      {then ? <Text style={[st.sub, { color: look.muted, fontSize: 10.5 * k }]}>{then}</Text> : null}
    </View>
  );
}

/** A team in a list: its seed, its name; the sharer's on the accent. */
function NameLine({ side, look, k, seed }: P & { side: SlideSide; seed?: boolean }) {
  const ink = side.me ? look.ground : look.ink;
  return (
    <View style={[st.row, { gap: 5 * k, borderRadius: 5 * k, paddingHorizontal: 4 * k, paddingVertical: 2 * k, backgroundColor: side.me ? look.accent : 'transparent' }]}>
      {seed ? <Text style={[st.bold, { color: side.me ? ink : look.muted, fontSize: 9 * k, width: 13 * k, textAlign: 'right' }]}>{side.seed ?? ''}</Text> : null}
      <Text style={[side.me ? st.bold : st.sub, { color: ink, fontSize: 10.5 * k, flex: 1 }]} numberOfLines={3}>{side.name}</Text>
    </View>
  );
}

function Heading({ text, look, k, hint }: P & { text: string; hint?: string | null }) {
  return (
    <Text style={[st.kind, { color: look.muted, fontSize: 8.5 * k, letterSpacing: 1 * k }]} numberOfLines={1}>
      {text.toUpperCase()}
      {hint ? <Text style={[st.sub, { letterSpacing: 0, fontStyle: 'italic' }]}>{`  ${hint}`}</Text> : null}
    </Text>
  );
}

// ── Slide 2: results ────────────────────────────────────────────────────

function Results({ slides, look, k }: P & { slides: TournamentSlides }) {
  const r = slides.results;
  if (!r) return null;
  const split = !!(r.winners?.length || r.losers?.length);
  // Double elimination: the Grand Final goes under the shorter bracket column, not on a row of its own.
  const weight = (ss: SlideSection[]) => ss.reduce((n, x) => n + 1 + 2.6 * x.matches.length, 0);
  const shortRight = weight(r.losers ?? []) <= weight(r.winners ?? []);
  const cols: [string, SlideSection[], SlideSection[]][] = [
    ['Winners bracket', r.winners ?? [], split && !shortRight ? r.main : []],
    ['Losers bracket', r.losers ?? [], split && shortRight ? r.main : []],
  ];
  return (
    <View style={{ gap: 8 * k }}>
      {split ? (
        <View style={[st.row, { alignItems: 'flex-start', gap: 8 * k }]}>
          {cols.map(([name, secs, tail]) => (
            <View key={name} style={{ flex: 1, gap: 5 * k }}>
              <Text style={[st.title, { color: look.ink, fontSize: 10.5 * k }]}>{name}</Text>
              {/* Under "Winners bracket", "Winners Round 2" reads "Round 2". */}
              {secs.length ? secs.map((s, i) => <Section key={i} s={{ ...s, label: s.label.replace(/^(winners|losers)\s+/i, '') }} look={look} k={k} cols={1} />)
                : <Text style={[st.sub, { color: look.muted, fontSize: 9.5 * k, fontStyle: 'italic' }]}>still to play</Text>}
              {tail.map((s, i) => <Section key={`t${i}`} s={s} look={look} k={k} cols={1} />)}
            </View>
          ))}
        </View>
      ) : null}
      {(split ? [] : packSections(r.main)).map((row, i) => (
        <View key={i} style={[st.row, { alignItems: 'flex-start', gap: 8 * k }]}>
          {row.map((s, j) => (
            <View key={j} style={{ flex: 1 }}>
              <Section s={s} look={look} k={k} cols={row.length === 1 && s.matches.length > 1 ? 2 : 1} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Section({ s, look, k, cols }: P & { s: SlideSection; cols: 1 | 2 }) {
  const hint = s.state === 'next' ? 'still to play' : s.state === 'now' ? 'playing' : null;
  return (
    <View style={{ gap: 3 * k }}>
      <Heading text={s.label} look={look} k={k} hint={hint} />
      {s.grid ? <PoolSheet g={s.grid} look={look} k={k} />
        : s.matches.length ? <Boxes matches={s.matches} look={look} k={k} cols={cols} /> : null}
      {s.more > 0 ? (
        <Text style={[st.sub, { color: look.muted, fontSize: 9.5 * k, fontStyle: 'italic' }]}>
          {s.matches.length ? `+${s.more} more, ` : `${s.more} ${s.more === 1 ? 'match' : 'matches'}, `}see the standings
        </Text>
      ) : null}
      {!s.matches.length && !s.more && !s.grid ? (
        <View style={{ borderRadius: 6 * k, borderWidth: 1 * k, borderStyle: 'dashed', borderColor: look.muted, padding: 5 * k }}>
          <Text style={[st.sub, { color: look.muted, fontSize: 9.5 * k }]}>To be drawn</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A pool as a sheet: each team's row has its score against every other ("11-3", the winner's in bold; "-" still to play). */
function PoolSheet({ g, look, k }: P & { g: SlideGrid }) {
  const cw = (g.teams.length <= 4 ? 33 : 27) * k;
  return (
    <View style={{ backgroundColor: look.chip, borderRadius: 6 * k, padding: 3 * k, gap: 1 * k }}>
      <View style={[st.row, { paddingHorizontal: 3 * k }]}>
        <View style={{ flex: 1 }} />
        {g.teams.map((_, j) => (
          <Text key={j} style={[st.bold, { color: look.muted, fontSize: 8.5 * k, width: cw, textAlign: 'center' }]}>{j + 1}</Text>
        ))}
      </View>
      {g.teams.map((t, i) => {
        const ink = t.me ? look.ground : look.ink;
        return (
          <View key={i} style={[st.row, { borderRadius: 4 * k, paddingHorizontal: 3 * k, paddingVertical: 1.5 * k, backgroundColor: t.me ? look.accent : 'transparent' }]}>
            <Text style={[st.bold, { color: t.me ? ink : look.muted, fontSize: 8.5 * k, width: 11 * k }]}>{i + 1}</Text>
            <Text style={[t.me ? st.bold : st.sub, { color: ink, fontSize: 9.5 * k, flex: 1 }]} numberOfLines={3}>{t.name}</Text>
            {g.cells[i].map((c, j) => {
              const w = g.won[i][j];
              return c == null ? (
                <View key={j} style={{ width: cw, alignItems: 'center' }}>
                  <View style={{ width: cw - 8 * k, height: 9 * k, borderRadius: 2 * k, backgroundColor: t.me ? look.ground : look.chip, opacity: 0.35 }} />
                </View>
              ) : (
                <Text key={j} style={[w ? st.title : st.sub, { color: t.me ? ink : w === false ? look.muted : look.ink, fontSize: 9.5 * k, width: cw, textAlign: 'center' }]}>
                  {c || '-'}
                </Text>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

/** `noScores`: the draw, before anything's played (results are the next slide). */
function Boxes({ matches, look, k, cols, seeds, noScores }: P & { matches: SlideMatch[]; cols: 1 | 2; seeds?: boolean; noScores?: boolean }) {
  return (
    <View style={[st.wrap, { rowGap: 3 * k }]}>
      {matches.map((m, i) => (
        <View key={i} style={cols === 2 ? st.half : st.full}><Box m={noScores ? { ...m, sa: null, sb: null, win: null } : m} look={look} k={k} seeds={seeds} /></View>
      ))}
    </View>
  );
}

/** A match: two lines, the winner in bold, the loser faded; the sharer's side on the accent. */
function Box({ m, look, k, seeds }: P & { m: SlideMatch; seeds?: boolean }) {
  const line = (sd: SlideSide | null, score: number | null, won: boolean | null) => {
    const ink = sd?.me ? look.ground : won === false ? look.muted : look.ink;
    return (
      <View style={[st.row, { gap: 4 * k, borderRadius: 4 * k, paddingHorizontal: 3 * k, paddingVertical: 0.5 * k, backgroundColor: sd?.me ? look.accent : 'transparent' }]}>
        {seeds ? <Text style={[st.bold, { color: sd?.me ? ink : look.muted, fontSize: 8.5 * k, width: 11 * k, textAlign: 'right' }]}>{sd?.seed ?? ''}</Text> : null}
        <Text style={[won || sd?.me ? st.bold : st.sub, { color: ink, fontSize: 9.5 * k, flex: 1, fontStyle: sd ? 'normal' : 'italic' }]} numberOfLines={3}>
          {sd ? sd.name : m.bye ? 'bye' : 'TBD'}
        </Text>
        {score != null ? <Text style={[won ? st.title : st.sub, { color: ink, fontSize: 10 * k }]}>{score}</Text> : null}
      </View>
    );
  };
  return (
    <View style={{ backgroundColor: look.chip, borderRadius: 6 * k, padding: 2.5 * k, gap: 0.5 * k, borderWidth: m.me ? 1.5 * k : 0, borderColor: look.accent }}>
      {line(m.a, m.sa, m.win == null ? null : m.win === 'a')}
      {line(m.b, m.sb, m.win == null ? null : m.win === 'b')}
    </View>
  );
}

// ── Slide 3: standings ──────────────────────────────────────────────────

function Standings({ slides, look, k }: P & { slides: TournamentSlides }) {
  const s = slides.standings;
  if (!s) return null;
  // Small pool tables sit two across; one big table (the final places) takes the width.
  // (Doubles names wrap badly at half width: long names take the width too.)
  const twoUp = s.tables.length > 1 && s.tables.every((t) => t.rows.length <= 6 && t.rows.every((r) => r.name.length <= 15));
  return (
    <View style={{ gap: 8 * k }}>
      <View style={[st.wrap, { rowGap: 8 * k, alignItems: 'flex-start' }]}>
        {s.tables.map((t, i) => (
          <View key={i} style={twoUp ? st.half : st.full}><Table t={t} look={look} k={k} narrow={twoUp} /></View>
        ))}
      </View>
      {s.note ? <Text style={[st.sub, { color: look.muted, fontSize: 9.5 * k }]}>{s.note}</Text> : null}
    </View>
  );
}

/** PKL-070: the sharer's path through the tournament, one line under the slide's heading. */
function Journey({ slides, look, k }: P & { slides: TournamentSlides }) {
  if (!slides.journey) return null;
  return (
    <Text style={[st.bold, { color: look.accent, fontSize: 10.5 * k }]} numberOfLines={2}>
      {slides.journey.split(' > ').join('  →  ')}
    </Text>
  );
}

function Table({ t, look, k, narrow }: P & { t: SlideTable; narrow: boolean }) {
  const places = t.rows.some((r) => r.place);
  return (
    <View style={{ backgroundColor: look.chip, borderRadius: 8 * k, padding: 5 * k, gap: 2 * k }}>
      {t.label ? <View style={{ paddingHorizontal: 4 * k }}><Heading text={t.label} look={look} k={k} /></View> : null}
      {t.rows.map((r, i) => <StandRow key={i} r={r} look={look} k={k} places={places} narrow={narrow} />)}
    </View>
  );
}

function StandRow({ r, look, k, places, narrow }: P & { r: SlideStandRow; places: boolean; narrow: boolean }) {
  const ink = r.me ? look.ground : look.ink;
  const fs = (narrow ? 10 : 11.5) * k;
  return (
    <View style={[st.row, { gap: 6 * k, borderRadius: 5 * k, paddingHorizontal: 4 * k, paddingVertical: (narrow ? 2 : 3) * k, backgroundColor: r.me ? look.accent : 'transparent' }]}>
      {places ? <Text style={[st.title, { color: ink, fontSize: fs, minWidth: (narrow ? 22 : 28) * k }]}>{r.place}</Text> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[r.me ? st.bold : st.sub, { color: ink, fontSize: fs }]} numberOfLines={3}>{r.name}</Text>
        {r.note ? <Text style={[st.sub, { color: r.me ? ink : look.muted, fontSize: fs * 0.8 }]} numberOfLines={2}>{r.note}</Text> : null}
      </View>
      <Text style={[st.bold, { color: ink, fontSize: fs }]}>{r.record}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  half: { width: '48.5%' },
  full: { width: '100%' },
  title: { fontWeight: '800' },
  bold: { fontWeight: '700' },
  sub: { fontWeight: '500' },
  kind: { fontWeight: '700' },
});
