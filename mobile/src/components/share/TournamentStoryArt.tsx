// PKL-092: the four approved tournament share layouts (Brian's mock rows 2-3): A Scorecard, B Bracket, C Poster and
// D Team photo. The words come from lib/tournamentShare (TournamentStory); this file only draws them in the look the
// studio has picked. Everything scales with `u` (the preview is 300 wide), like ShareCardArt.
import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { ScaleToFit } from '@just-messin-around/expo-foundation/ui';
import { fitFontSize } from '@just-messin-around/expo-foundation/typography';
import { CourtPattern } from './ShareCardArt';
import type { ShareLookDef } from '../../lib/shareCards';
import type { StoryRow, TournamentStory } from '../../lib/tournamentShare';

type Props = {
  story: TournamentStory;
  template: 'tour-scorecard' | 'tour-bracket' | 'tour-poster' | 'tour-photo';
  look: ShareLookDef;
  width: number;
  height: number;
  story916: boolean;
  photo: string | null;
  logo: string;
};

const WIN = '#2e8b57';
const LOSS = '#9aa1a9';
const MEDAL: Record<number, string> = { 1: '#d4af37', 2: '#c0c4cc', 3: '#cd7f32' };

export default function TournamentStoryArt({ story, template, look, width, height, story916, photo, logo }: Props) {
  const u = width / 300;
  const k = story916 ? 1.12 : 1;
  const pad = 20 * u;
  const padY = (story916 ? 52 : 20) * u;
  const lineW = width - 2 * pad;
  const ink = look.ink, muted = look.muted, accent = look.accent, chip = look.chip;

  const Big = ({ text, size, color = ink, center }: { text: string; size: number; color?: string; center?: boolean }) => {
    const fs = fitFontSize(text, lineW, size, size * 0.4);
    return <Text style={[s.big, { color, fontSize: fs, lineHeight: fs * 1.05, textAlign: center ? 'center' : 'left' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{text}</Text>;
  };
  const Kick = ({ text, center, color = muted }: { text: string; center?: boolean; color?: string }) => (
    <Text style={[s.kick, { color, fontSize: 9.5 * u * k, letterSpacing: 1.6 * u, textAlign: center ? 'center' : 'left' }]} numberOfLines={2}>{text.toUpperCase()}</Text>
  );
  const Team = ({ center, c = ink, chipBg = chip }: { center?: boolean; c?: string; chipBg?: string }) => (
    <View style={[s.row, { gap: 8 * u, justifyContent: center ? 'center' : 'flex-start' }]}>
      <View style={s.row}>
        {story.me.people.slice(0, 4).map((p, i) => (
          <View key={i} style={[s.av, { width: 26 * u, height: 26 * u, borderRadius: 13 * u, marginLeft: i ? -6 * u : 0, backgroundColor: chipBg, borderColor: c, borderWidth: 1.5 * u }]}>
            <Text style={[s.avText, { color: c, fontSize: 9 * u }]}>{p.initials}</Text>
          </View>
        ))}
      </View>
      <Text style={[s.title, { color: c, fontSize: 14 * u * k, flexShrink: 1 }]} numberOfLines={1}>{story.me.name}</Text>
    </View>
  );
  const Foot = ({ c = muted, right = story.dateLabel ?? '' }: { c?: string; right?: string }) => (
    <View style={[s.row, { justifyContent: 'space-between', marginTop: 'auto', gap: 8 * u }]}>
      <Text style={[s.title, { color: c, fontSize: (logo === 'small' ? 15 : 12) * u, flexShrink: 0 }]} numberOfLines={1}>{logo === 'small' ? '🥒' : '🥒 Pickleague'}</Text>
      <Text style={[s.kick, { color: c, fontSize: 10 * u, flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>{right}</Text>
    </View>
  );
  const Rows = ({ rows, max, c = ink, cm = muted }: { rows: StoryRow[]; max: number; c?: string; cm?: string }) => (
    <View style={{ gap: 2 * u }}>
      {rows.slice(-max).map((r, i) => (
        <View key={i} style={[s.row, { gap: 8 * u, paddingVertical: 5 * u, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: chip }]}>
          {r.lead === 'next'
            ? <Text style={[s.title, { color: accent, fontSize: 12 * u * k, width: 18 * u, textAlign: 'center' }]}>›</Text>
            : (
              <View style={[s.av, { width: 18 * u, height: 18 * u, borderRadius: 4 * u, backgroundColor: r.lead === 'W' ? WIN : LOSS }]}>
                <Text style={[s.avText, { color: '#fff', fontSize: 10 * u }]}>{r.lead}</Text>
              </View>
            )}
          <Text style={[s.sub, { color: r.lead === 'next' ? cm : c, fontSize: 12.5 * u * k, flex: 1, fontStyle: r.lead === 'next' ? 'italic' : 'normal' }]} numberOfLines={1}>{r.text}</Text>
          {r.score ? <Text style={[s.title, { color: c, fontSize: 13 * u * k }]}>{r.score}</Text> : null}
        </View>
      ))}
    </View>
  );
  const ground = (children: React.ReactNode) => (
    <View style={[s.fill, { backgroundColor: look.ground }]}>
      <CourtPattern look={look} width={width} height={height} />
      <View style={[s.fill, { paddingHorizontal: pad, paddingVertical: padY, gap: 10 * u * k }]}>{children}</View>
    </View>
  );

  switch (template) {
    case 'tour-scorecard':
      return ground(
        <>
          <Kick text={story.kicker} />
          <ScaleToFit align="top" minScale={0.6}>
            <View style={{ gap: 10 * u * k }}>
              <Big text={story.headline} size={40 * u * k} />
              <Team />
              <View style={[s.row, { gap: 16 * u }]}>
                {story.stats.map((x) => (
                  <View key={x.label} style={{ gap: 1 * u }}>
                    <Text style={[s.big, { color: accent, fontSize: 22 * u * k }]}>{x.value}</Text>
                    <Text style={[s.kick, { color: muted, fontSize: 8.5 * u, letterSpacing: 1 * u }]}>{x.label.toUpperCase()}</Text>
                  </View>
                ))}
              </View>
              <Rows rows={story.rows} max={story916 ? 8 : 5} />
              {story.note ? <Text style={[s.sub, { color: muted, fontSize: 11 * u * k }]} numberOfLines={2}>{story.note}</Text> : null}
            </View>
          </ScaleToFit>
          <Foot />
        </>,
      );
    case 'tour-bracket': {
      const cols = story.columns;
      return ground(
        <>
          <Kick text={story.title} />
          <Big text={story.bracketHeadline} size={30 * u * k} color={accent} />
          <Text style={[s.sub, { color: muted, fontSize: 12 * u * k }]} numberOfLines={1}>{story.bracketSub}</Text>
          <ScaleToFit align="center" minScale={0.55}>
            {cols.length ? (
              <View style={[s.row, { gap: 8 * u, alignItems: 'center' }]}>
                {cols.map((col, ci) => (
                  <View key={ci} style={{ flex: 1, gap: 8 * u, minWidth: 0 }}>
                    <Text style={[s.kick, { color: muted, fontSize: 8.5 * u, letterSpacing: 1 * u }]} numberOfLines={1}>{col.stage.toUpperCase()}</Text>
                    {col.pairs.map((p, pi) => (
                      <View key={pi} style={{ backgroundColor: chip, borderRadius: 8 * u, paddingHorizontal: 7 * u, paddingVertical: 5 * u, gap: 3 * u,
                        borderWidth: p.mine ? 1.5 * u : 0, borderColor: accent }}>
                        {(['a', 'b'] as const).map((side) => (
                          <View key={side} style={[s.row, { justifyContent: 'space-between', gap: 4 * u }]}>
                            <Text style={[p.winner === side ? s.title : s.sub, { color: p.winner && p.winner !== side ? muted : ink, fontSize: 11 * u * k, flex: 1 }]} numberOfLines={1}>{p[side].name}</Text>
                            <Text style={[s.title, { color: p.winner === side ? accent : muted, fontSize: 11 * u * k }]}>{p[side].score ?? ''}</Text>
                          </View>
                        ))}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            ) : <Rows rows={story.rows} max={6} />}
          </ScaleToFit>
          <Text style={[s.sub, { color: ink, fontSize: 12 * u * k }]} numberOfLines={1}>{story.bracketFoot}</Text>
          <Foot right={story.isMlp ? story.me.name : story.dateLabel ?? ''} />
        </>,
      );
    }
    case 'tour-poster':
      return ground(
        <>
          <Kick text={story.posterKicker} center />
          <ScaleToFit align="center" minScale={0.6}>
            <View style={{ gap: 8 * u * k, alignItems: 'stretch' }}>
              {story.posterTop ? <Text style={[s.big, { color: accent, fontSize: 30 * u * k, textAlign: 'center', letterSpacing: 3 * u }]}>{story.posterTop}</Text> : null}
              <Big text={story.posterBig} size={110 * u * k} center />
              <Text style={[s.sub, { color: ink, fontSize: 15 * u * k, textAlign: 'center' }]} numberOfLines={3}>{story.posterLine}</Text>
              <View style={{ marginTop: 8 * u }}><Team center /></View>
            </View>
          </ScaleToFit>
          <Foot right={story.moment === 'pool' ? story.bracketFoot.replace(/^.*?, /, '') : story.headline.replace(/\.$/, '')} />
        </>,
      );
    case 'tour-photo': {
      // the photo on top (or the look's pattern when there is none), a banner, then the results or the podium
      const photoH = height * (story916 ? 0.5 : 0.44);
      // the look's own colours, so the studio's LOOK still changes it (Cream is the mock's)
      const cream = look.ground, dark = ink, dim = muted;
      return (
        <View style={[s.fill, { backgroundColor: cream }]}>
          <View style={{ height: photoH, backgroundColor: chip, overflow: 'hidden' }}>
            {photo
              ? <Image source={{ uri: photo }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              : <CourtPattern look={look} width={width} height={photoH} />}
          </View>
          <View style={{ alignSelf: 'flex-start', marginTop: -14 * u, marginLeft: pad, backgroundColor: look.accent, paddingHorizontal: 10 * u, paddingVertical: 5 * u, borderRadius: 6 * u }}>
            <Text style={[s.kick, { color: look.ground, fontSize: 10 * u * k, letterSpacing: 1.6 * u }]} numberOfLines={1}>{story.banner}</Text>
          </View>
          <View style={[s.fill, { paddingHorizontal: pad, paddingTop: 10 * u, paddingBottom: (story916 ? 40 : 16) * u, gap: 6 * u * k }]}>
            <Text style={[s.big, { color: dark, fontSize: 26 * u * k }]} numberOfLines={1} adjustsFontSizeToFit>{story.me.name}</Text>
            <Text style={[s.sub, { color: dim, fontSize: 11.5 * u * k }]} numberOfLines={2}>{story.photoSub}</Text>
            <ScaleToFit align="top" minScale={0.6}>
              {story.podium ? (
                <View style={[s.row, { gap: 6 * u, alignItems: 'flex-end' }]}>
                  {story.podium.flatMap((p) => p.names.map((n) => ({ place: p.place, n }))).slice(0, 4).map((x, i) => (
                    <View key={i} style={{ flex: 1, alignItems: 'center', gap: 3 * u, backgroundColor: chip, borderRadius: 8 * u, paddingVertical: 6 * u }}>
                      <View style={[s.av, { width: 20 * u, height: 20 * u, borderRadius: 10 * u, backgroundColor: MEDAL[x.place] ?? LOSS }]}>
                        <Text style={[s.avText, { color: '#1b1b1b', fontSize: 10 * u }]}>{x.place}</Text>
                      </View>
                      <Text style={[s.sub, { color: dark, fontSize: 10.5 * u }]} numberOfLines={1}>{x.n}</Text>
                    </View>
                  ))}
                </View>
              ) : <Rows rows={story.photoRows} max={story916 ? 6 : 3} c={dark} cm={dim} />}
            </ScaleToFit>
            <Foot c={dim} right={story.members} />
          </View>
        </View>
      );
    }
  }
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  big: { fontWeight: '900' },
  kick: { fontWeight: '800' },
  title: { fontWeight: '800' },
  sub: { fontWeight: '500' },
  av: { alignItems: 'center', justifyContent: 'center' },
  avText: { fontWeight: '800' },
});
