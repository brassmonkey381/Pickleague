// The share card itself (PKL-013): one ShareCardModel drawn in the layout,
// look, banner and logo picked in PickleShareStudio. The frame the studio
// captures is `width` x `height`; everything scales with `u` (the preview is
// 300 wide). Share images are printed stickers: fixed palettes from
// lib/shareCards, the same in light and dark mode.
//
// Photo-less layouts sit on the look's court texture (CourtPattern). Photo
// layouts use the foundation's PhotoCollage; where text sits over a photo the
// banner (Brand / Light / See-through / Dark / Solid) is behind it.
import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { PhotoCollage, type CollageLayoutId, type CollageRect } from '@just-messin-around/expo-foundation/ui';
import type { ShareStudioState } from '@just-messin-around/expo-foundation/share';
import {
  SHARE_LOOKS,
  bannerColors,
  type ShareCardModel,
  type ShareLookDef,
  type ShareLookId,
  type ShareRowItem,
} from '../../lib/shareCards';

type Ink = { ink: string; muted: string; accent: string; chip: string };
type Props = { s: ShareStudioState & { width: number; height: number }; model: ShareCardModel };

const MEDAL: Record<number, string> = { 1: '#d4af37', 2: '#c0c4cc', 3: '#cd7f32' };
const WIN = '#2e8b57';
const LOSS = '#9aa1a9';

export default function ShareCardArt({ s, model }: Props) {
  const look = SHARE_LOOKS[s.look as ShareLookId] ?? SHARE_LOOKS.court;
  const u = s.width / 300;
  const story = s.aspect === 'story';
  const lookInk: Ink = { ink: look.ink, muted: look.muted, accent: look.accent, chip: look.chip };
  const photos = s.photos;
  const aspect = s.width / s.height;

  switch (s.template) {
    case 'grind':
      return (
        <Ground look={look} s={s}>
          <View style={[cs.fill, { padding: 20 * u, paddingVertical: (story ? 48 : 20) * u, gap: 12 * u }]}>
            <Header model={model} logo={s.logo} c={lookInk} u={u} />
            <View style={[cs.fill, { justifyContent: 'center', gap: 10 * u }]}>
              <Text style={[cs.kind, { color: look.muted, fontSize: 11 * u, letterSpacing: 2 * u }]}>PUT IN THE WORK</Text>
              <Text style={[cs.huge, cs.stretch, { color: look.accent, fontSize: 58 * u, lineHeight: 64 * u }]} numberOfLines={1} adjustsFontSizeToFit>
                {model.hero.big}
              </Text>
              {model.hero.small ? <Text style={[cs.sub, { color: look.ink, fontSize: 15 * u }]} numberOfLines={1}>{model.hero.small}</Text> : null}
              <Text style={[cs.title, { color: look.ink, fontSize: 17 * u }]} numberOfLines={2}>{model.title}</Text>
              {model.over ? <Text style={[cs.sub, { color: look.muted, fontSize: 11 * u }]} numberOfLines={1}>{model.over}</Text> : null}
              <Bars model={model} s={s} c={lookInk} u={u} big />
              <Chips model={model} s={s} c={lookInk} u={u} />
              <Rows model={model} s={s} c={lookInk} u={u} max={story ? 5 : 3} />
              <Quote model={model} s={s} c={lookInk} u={u} />
            </View>
            <Footer c={lookInk} u={u} />
          </View>
        </Ground>
      );
    case 'big':
      return (
        <Ground look={look} s={s}>
          <View style={[cs.fill, { padding: 20 * u, paddingVertical: (story ? 48 : 20) * u }]}>
            <Header model={model} logo={s.logo} c={lookInk} u={u} />
            <View style={[cs.fill, cs.center, { gap: 8 * u }]}>
              {model.hero.medal ? <Medal rank={model.hero.medal} size={52 * u} /> : null}
              <Text style={[cs.huge, cs.stretch, { color: look.accent, fontSize: 64 * u, textAlign: 'center' }]} numberOfLines={1} adjustsFontSizeToFit>
                {model.hero.big}
              </Text>
              {model.hero.small ? <Text style={[cs.sub, { color: look.muted, fontSize: 14 * u, textAlign: 'center' }]} numberOfLines={1}>{model.hero.small}</Text> : null}
              {model.over ? <Text style={[cs.sub, { color: look.muted, fontSize: 11 * u, textAlign: 'center' }]} numberOfLines={1}>{model.over}</Text> : null}
              <Text style={[cs.title, cs.stretch, { color: look.ink, fontSize: 16 * u, textAlign: 'center' }]} numberOfLines={2}>{model.title}</Text>
              <Chips model={model} s={s} c={lookInk} u={u} center />
              <Bars model={model} s={s} c={lookInk} u={u} />
              <Rows model={model} s={s} c={lookInk} u={u} max={story ? 4 : 2} />
            </View>
            <Footer c={lookInk} u={u} />
          </View>
        </Ground>
      );
    case 'scorecard':
      return (
        <Ground look={look} s={s}>
          <View style={[cs.fill, { padding: 18 * u, paddingVertical: (story ? 44 : 18) * u, gap: 12 * u }]}>
            <Header model={model} logo={s.logo} c={lookInk} u={u} />
            <View style={[cs.fill, { justifyContent: 'center' }]}>
              <View style={{ backgroundColor: look.chip, borderRadius: 16 * u, padding: 14 * u, gap: 10 * u }}>
                <Body model={model} s={s} c={lookInk} u={u} align="left" />
              </View>
            </View>
            <Footer c={lookInk} u={u} />
          </View>
        </Ground>
      );
    case 'photo-full':
    case 'strip':
    case 'grid': {
      const layout: CollageLayoutId = s.template === 'photo-full' ? 'full' : s.template === 'strip' ? 'hero-strip' : 'grid';
      const b = bannerColors(s.banner, look);
      const bInk: Ink = { ink: b.ink, muted: b.muted, accent: b.accent, chip: 'rgba(127,127,127,0.18)' };
      return (
        <PhotoCollage
          layout={layout}
          photos={photos}
          width={s.width}
          aspect={aspect}
          background={look.ground}
          overlay={() => (
            <View style={[StyleSheet.absoluteFill, { justifyContent: s.template === 'grid' ? 'center' : s.template === 'strip' ? 'flex-start' : 'flex-end', padding: 12 * u, paddingVertical: (story ? 40 : 12) * u }]}>
              <View style={{ backgroundColor: b.bg, borderRadius: 14 * u, padding: 12 * u, gap: 8 * u, alignSelf: s.template === 'grid' ? 'center' : 'stretch' }}>
                <Header model={model} logo={s.logo} c={bInk} u={u} />
                <Body model={model} s={s} c={bInk} u={u} align={s.template === 'grid' ? 'center' : 'left'} compact />
              </View>
            </View>
          )}
        />
      );
    }
    case 'photo-panel':
    case 'duo':
      return (
        <PhotoCollage
          layout={s.template === 'duo' ? 'duo' : 'split'}
          photos={photos}
          width={s.width}
          aspect={aspect}
          background={look.ground}
          overlay={({ panel }) => (panel ? <PanelBody panel={panel} look={look} model={model} s={s} u={u} /> : null)}
        />
      );
    case 'polaroid':
      return (
        <Ground look={look} s={s}>
          <View style={[cs.fill, { padding: 18 * u, paddingVertical: (story ? 44 : 18) * u, gap: 12 * u }]}>
            <Header model={model} logo={s.logo} c={lookInk} u={u} />
            <View style={[cs.fill, cs.center]}>
              <View style={[cs.polaroid, { padding: 10 * u, paddingBottom: 14 * u, borderRadius: 4 * u, transform: [{ rotate: '-3deg' }], width: s.width * 0.78 }]}>
                {photos[0] ? (
                  <Image source={{ uri: photos[0] }} style={{ width: '100%', aspectRatio: 1, backgroundColor: '#ddd' }} resizeMode="cover" />
                ) : (
                  <View style={{ width: '100%', aspectRatio: 1, backgroundColor: '#e8e8e8' }} />
                )}
                <View style={{ paddingTop: 10 * u, gap: 2 * u }}>
                  <Text style={[cs.huge, { color: '#1d2b22', fontSize: 26 * u }]} numberOfLines={1} adjustsFontSizeToFit>{model.hero.big}</Text>
                  <Text style={[cs.sub, { color: 'rgba(29,43,34,0.7)', fontSize: 11 * u }]} numberOfLines={2}>{model.title}</Text>
                </View>
              </View>
              {photos.length > 1 ? (
                <View style={[cs.row, { gap: 6 * u, marginTop: 14 * u }]}>
                  {photos.slice(1, 4).map((p) => (
                    <Image key={p} source={{ uri: p }} style={{ width: 44 * u, height: 44 * u, borderRadius: 6 * u, borderWidth: 2 * u, borderColor: '#fff' }} />
                  ))}
                </View>
              ) : null}
            </View>
            <Chips model={model} s={s} c={lookInk} u={u} center />
            <Rows model={model} s={s} c={lookInk} u={u} max={story ? 3 : 1} />
            <Footer c={lookInk} u={u} />
          </View>
        </Ground>
      );
    case 'poster':
    default:
      return (
        <Ground look={look} s={s}>
          <View style={[cs.fill, { padding: 18 * u, paddingVertical: (story ? 44 : 18) * u, gap: 12 * u }]}>
            <Header model={model} logo={s.logo} c={lookInk} u={u} />
            <View style={[cs.fill, { justifyContent: 'center' }]}>
              <Body model={model} s={s} c={lookInk} u={u} align="center" />
            </View>
            <Footer c={lookInk} u={u} />
          </View>
        </Ground>
      );
  }
}

// ── Pieces ──────────────────────────────────────────────────────────────

function Ground({ look, s, children }: { look: ShareLookDef; s: { width: number; height: number }; children: React.ReactNode }) {
  return (
    <View style={[cs.fill, { backgroundColor: look.ground }]}>
      <CourtPattern look={look} width={s.width} height={s.height} />
      {children}
    </View>
  );
}

/** The look's texture: court lines, scattered balls, or a net. */
export function CourtPattern({ look, width, height }: { look: ShareLookDef; width: number; height: number }) {
  const ink = look.patternInk;
  const u = width / 300;
  if (look.pattern === 'lines') {
    // A court seen from above: the outline, the net, both kitchens, the centre lines.
    const m = 22 * u;
    const w = width - 2 * m;
    const h = height - 2 * m;
    const mid = m + h / 2;
    const kitchen = h * (7 / 44);
    return (
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={m} y={m} width={w} height={h} stroke={ink} strokeWidth={3 * u} fill="none" />
        <Line x1={m} y1={mid} x2={m + w} y2={mid} stroke={ink} strokeWidth={5 * u} />
        <Line x1={m} y1={mid - kitchen} x2={m + w} y2={mid - kitchen} stroke={ink} strokeWidth={3 * u} />
        <Line x1={m} y1={mid + kitchen} x2={m + w} y2={mid + kitchen} stroke={ink} strokeWidth={3 * u} />
        <Line x1={width / 2} y1={m} x2={width / 2} y2={mid - kitchen} stroke={ink} strokeWidth={3 * u} />
        <Line x1={width / 2} y1={mid + kitchen} x2={width / 2} y2={m + h} stroke={ink} strokeWidth={3 * u} />
      </Svg>
    );
  }
  if (look.pattern === 'net') {
    const step = 18 * u;
    const lines: React.ReactNode[] = [];
    for (let x = -height; x < width; x += step) {
      lines.push(<Line key={`a${x}`} x1={x} y1={0} x2={x + height} y2={height} stroke={ink} strokeWidth={1.2 * u} />);
      lines.push(<Line key={`b${x}`} x1={x + height} y1={0} x2={x} y2={height} stroke={ink} strokeWidth={1.2 * u} />);
    }
    return (
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
        {lines}
      </Svg>
    );
  }
  // Balls: a fixed scatter (the same every render, so the capture matches the preview).
  const balls: React.ReactNode[] = [];
  const cols = 5;
  const rows = Math.ceil((height / width) * cols) + 1;
  const cell = width / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r * 7 + c * 3) % 4 === 0) continue;
      const cx = c * cell + cell / 2 + ((r % 2) ? cell / 3 : -cell / 5);
      const cy = r * cell + cell / 2;
      const rad = cell * (0.16 + ((r + c) % 3) * 0.04);
      balls.push(
        <React.Fragment key={`${r}-${c}`}>
          <Circle cx={cx} cy={cy} r={rad} stroke={ink} strokeWidth={2 * u} fill="none" />
          <Circle cx={cx - rad * 0.35} cy={cy - rad * 0.2} r={rad * 0.12} fill={ink} />
          <Circle cx={cx + rad * 0.3} cy={cy + rad * 0.3} r={rad * 0.12} fill={ink} />
          <Circle cx={cx + rad * 0.25} cy={cy - rad * 0.4} r={rad * 0.12} fill={ink} />
        </React.Fragment>,
      );
    }
  }
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      {balls}
    </Svg>
  );
}

function Header({ model, logo, c, u }: { model: ShareCardModel; logo: string; c: Ink; u: number }) {
  return (
    <View style={[cs.row, { gap: 8 * u }]}>
      <Text style={[cs.brand, { color: c.ink, fontSize: (logo === 'small' ? 18 : 13) * u }]} numberOfLines={1}>
        {logo === 'small' ? '🥒' : '🥒 Pickleague'}
      </Text>
      <Text style={[cs.kind, { color: c.muted, fontSize: 9 * u, letterSpacing: 1.5 * u, flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>
        {model.eyebrow}
      </Text>
    </View>
  );
}

function Footer({ c, u }: { c: Ink; u: number }) {
  return <Text style={[cs.sub, { color: c.muted, fontSize: 9 * u, textAlign: 'center' }]}>pickleague.club</Text>;
}

function Medal({ rank, size }: { rank: number; size: number }) {
  const bg = MEDAL[rank];
  if (!bg) return null;
  return (
    <View style={[cs.medal, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={[cs.medalText, { fontSize: size * 0.45 }]}>{rank}</Text>
    </View>
  );
}

function Chips({ model, s, c, u, center }: { model: ShareCardModel; s: ShareStudioState; c: Ink; u: number; center?: boolean }) {
  const on = model.stats.filter((x) => s.details[x.id] === true);
  if (!on.length) return null;
  return (
    <View style={[cs.wrap, { gap: 6 * u, justifyContent: center ? 'center' : 'flex-start' }]}>
      {on.map((x) => (
        <View key={x.id} style={{ backgroundColor: c.chip, borderRadius: 10 * u, paddingVertical: 5 * u, paddingHorizontal: 10 * u, maxWidth: '100%' }}>
          <Text style={[cs.chipText, { color: c.ink, fontSize: 12 * u }]} numberOfLines={1}>{x.value}</Text>
        </View>
      ))}
    </View>
  );
}

function RowLead({ lead, u }: { lead: ShareRowItem['lead']; u: number }) {
  if (!lead) return null;
  if ('medal' in lead) return <Medal rank={lead.medal} size={18 * u} />;
  if (lead.won == null) return <View style={{ width: 18 * u }} />;
  return (
    <View style={[cs.medal, { width: 18 * u, height: 18 * u, borderRadius: 4 * u, backgroundColor: lead.won ? WIN : LOSS }]}>
      <Text style={[cs.medalText, { color: '#fff', fontSize: 10 * u }]}>{lead.won ? 'W' : 'L'}</Text>
    </View>
  );
}

function Rows({ model, s, c, u, max }: { model: ShareCardModel; s: ShareStudioState; c: Ink; u: number; max?: number }) {
  const on = model.rows.filter((r) => r.items.length > 0 && s.details[r.id] === true);
  if (!on.length) return null;
  return (
    <View style={{ gap: 8 * u }}>
      {on.map((r) => (
        <View key={r.id} style={{ gap: 5 * u }}>
          {r.heading ? <Text style={[cs.kind, { color: c.muted, fontSize: 9 * u, letterSpacing: 1.2 * u }]}>{r.heading.toUpperCase()}</Text> : null}
          {r.items.slice(0, max ?? 6).map((it, i) => (
            <View key={i} style={[cs.row, { gap: 8 * u, justifyContent: 'flex-start' }]}>
              <RowLead lead={it.lead} u={u} />
              <View style={[cs.row, { gap: 6 * u, justifyContent: 'flex-start', flex: 1, minWidth: 0 }]}>
                {(it.people ?? []).slice(0, 2).map((p, j) => (
                  <View key={j} style={[cs.row, { gap: 4 * u, justifyContent: 'flex-start', flexShrink: 1 }]}>
                    <View style={[cs.initials, { width: 20 * u, height: 20 * u, borderRadius: 10 * u, backgroundColor: c.chip }]}>
                      <Text style={[cs.chipText, { color: c.ink, fontSize: 8 * u }]}>{p.initials}</Text>
                    </View>
                    <Text style={[cs.sub, { color: c.ink, fontSize: 11 * u, flexShrink: 1 }]} numberOfLines={1}>{p.name}</Text>
                  </View>
                ))}
                {it.text ? <Text style={[cs.sub, { color: c.ink, fontSize: 11 * u, flexShrink: 1 }]} numberOfLines={1}>{it.text}</Text> : null}
              </View>
              {it.trailing ? <Text style={[cs.title, { color: it.trailing.includes('★') ? c.accent : c.ink, fontSize: 12 * u }]} numberOfLines={1}>{it.trailing}</Text> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** The bar chart toggle: minutes per week, oldest first, this week last and brightest. */
function Bars({ model, s, c, u, big }: { model: ShareCardModel; s: ShareStudioState; c: Ink; u: number; big?: boolean }) {
  const b = model.bars;
  if (!b || s.details[b.id] !== true || !b.values.some((v) => v > 0)) return null;
  const max = Math.max(...b.values, 1);
  const h = (big ? 54 : 36) * u;
  return (
    <View style={{ gap: 4 * u }}>
      <Text style={[cs.kind, { color: c.muted, fontSize: 9 * u, letterSpacing: 1.2 * u }]}>{b.heading.toUpperCase()}</Text>
      <View style={[cs.row, { alignItems: 'flex-end', height: h, gap: 4 * u }]}>
        {b.values.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: v > 0 ? Math.max(4 * u, (v / max) * h) : 3 * u,
              borderRadius: 3 * u,
              backgroundColor: v > 0 ? c.accent : c.chip,
              opacity: v > 0 && i < b.values.length - 1 ? 0.75 : 1,
            }}
          />
        ))}
      </View>
      {b.caption ? <Text style={[cs.sub, { color: c.ink, fontSize: 11 * u }]} numberOfLines={1}>{b.caption}</Text> : null}
    </View>
  );
}

/** The quote toggle (my drill notes). */
function Quote({ model, s, c, u }: { model: ShareCardModel; s: ShareStudioState; c: Ink; u: number }) {
  const q = model.quote;
  if (!q || s.details[q.id] !== true || !q.text.trim()) return null;
  return (
    <View style={{ borderLeftWidth: 3 * u, borderLeftColor: c.accent, paddingLeft: 8 * u }}>
      <Text style={[cs.sub, { color: c.ink, fontSize: 12 * u, fontStyle: 'italic' }]} numberOfLines={4}>
        {'\u201C'}{q.text}{'\u201D'}
      </Text>
    </View>
  );
}

/** Title, hero, chips and rows. `compact`: smaller hero, fewer rows (over photos). */
function Body({ model, s, c, u, align, compact }: { model: ShareCardModel; s: ShareStudioState; c: Ink; u: number; align: 'center' | 'left'; compact?: boolean }) {
  const center = align === 'center';
  const heroSize = (compact ? 30 : model.hero.big.length > 9 ? 36 : 48) * u;
  return (
    <View style={{ gap: (compact ? 8 : 12) * u }}>
      <View style={{ gap: 2 * u, alignItems: center ? 'center' : 'flex-start' }}>
        {model.over ? <Text style={[cs.sub, { color: c.muted, fontSize: 11 * u }]} numberOfLines={1}>{model.over}</Text> : null}
        <Text style={[cs.title, { color: c.ink, fontSize: (compact ? 15 : 18) * u, textAlign: center ? 'center' : 'left' }]} numberOfLines={2}>
          {model.title}
        </Text>
      </View>
      <View style={[center ? cs.center : cs.row, { gap: 8 * u, justifyContent: 'flex-start' }]}>
        {model.hero.medal ? <Medal rank={model.hero.medal} size={(compact ? 30 : 44) * u} /> : null}
        {/* Centered, the hero line takes the full width to shrink into. */}
        <View style={{ alignItems: center ? 'center' : 'flex-start', flexShrink: 1, alignSelf: center ? 'stretch' : 'auto' }}>
          <Text style={[cs.huge, { color: c.accent, fontSize: heroSize, textAlign: center ? 'center' : 'left', maxWidth: '100%' }]} numberOfLines={1} adjustsFontSizeToFit>
            {model.hero.big}
          </Text>
          {model.hero.small ? <Text style={[cs.sub, { color: c.muted, fontSize: 12 * u }]} numberOfLines={1}>{model.hero.small}</Text> : null}
        </View>
      </View>
      <Chips model={model} s={s} c={c} u={u} center={center} />
      {compact ? null : <Bars model={model} s={s} c={c} u={u} />}
      <Rows model={model} s={s} c={c} u={u} max={compact ? 3 : 6} />
      {compact ? null : <Quote model={model} s={s} c={c} u={u} />}
    </View>
  );
}

/** The panel a photo + stats layout leaves, in the look's colors. */
function PanelBody({ panel, look, model, s, u }: { panel: CollageRect; look: ShareLookDef; model: ShareCardModel; s: ShareStudioState; u: number }) {
  const c: Ink = { ink: look.ink, muted: look.muted, accent: look.accent, chip: look.chip };
  return (
    <View style={{ position: 'absolute', left: panel.x, top: panel.y, width: panel.width, height: panel.height, backgroundColor: look.ground, overflow: 'hidden' }}>
      <CourtPattern look={look} width={panel.width} height={panel.height} />
      <View style={[cs.fill, { padding: 14 * u, gap: 8 * u, justifyContent: 'space-between' }]}>
        <Header model={model} logo={s.logo} c={c} u={u} />
        <View style={{ flexShrink: 1, minHeight: 0, overflow: 'hidden' }}>
          <Body model={model} s={s} c={c} u={u} align="left" compact />
        </View>
        <Footer c={c} u={u} />
      </View>
    </View>
  );
}

const cs = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  center: { alignItems: 'center' },
  stretch: { alignSelf: 'stretch' },
  brand: { fontWeight: '800' },
  kind: { fontWeight: '700' },
  title: { fontWeight: '800' },
  sub: { fontWeight: '500' },
  huge: { fontWeight: '900' },
  chipText: { fontWeight: '700' },
  initials: { alignItems: 'center', justifyContent: 'center' },
  medal: { alignItems: 'center', justifyContent: 'center' },
  medalText: { color: '#1b1b1b', fontWeight: '900' },
  polaroid: { backgroundColor: '#ffffff', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
});
