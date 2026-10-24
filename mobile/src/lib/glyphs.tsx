// Pickleague's own glyphs (glyphs-ui-plan.md section 2.1): the art the
// foundation can't carry because it names pickleball. Registered at startup
// through the foundation's registerGlyphs(), so every Icon / iconName /
// EmojiGlyph in the app (and in foundation components) can use them by name:
//
//   pickle      🥒        the pickles currency
//   pickleball  🥎 🎾     a league; the Play slot
//   paddle      🏓        a drill
//   shot-lob    ⛅ ☁      drill focus: lobs
//   shot-drop   🪂        drill focus: third-shot drops
//   shot-serve  🏐        drill focus: serves
//
// Imported once for its side effect from lib/ThemeContext.tsx (the same place
// the palette is configured), so the glyphs exist before the first render.
// Drawing rules match the foundation set: 24x24, filled, one colour, evenodd
// cut-outs, stroke 2 for the line-natured shot arcs.
import React from 'react';
import Svg, { G, Path } from 'react-native-svg';
import {
  configureIcons,
  circlePath,
  lineGlyphProps,
  registerGlyphs,
  roundRectPath,
  type GlyphProps,
} from '@just-messin-around/expo-foundation/icons';

declare module '@just-messin-around/expo-foundation/icons' {
  interface AppGlyphs {
    pickle: true;
    pickleball: true;
    paddle: true;
    'shot-lob': true;
    'shot-drop': true;
    'shot-serve': true;
  }
}

const svg = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24' });

// A dill pickle: a gently curved bean, warts cut out, tilted 45 degrees.
const PICKLE_D =
  'M2 12.7C2 9.1 5.6 7.6 8.9 8.4C11.1 8.9 13.1 8.9 15.4 7.8C18.9 6.2 22.3 8 22 11.6C21.8 15.8 17.6 17.9 12.2 17.7C6.3 17.5 2 16.6 2 12.7z' +
  circlePath(6, 12.8, 1) +
  circlePath(9.8, 13.6, 1) +
  circlePath(13.6, 13.4, 1) +
  circlePath(17.5, 12.3, 1);
export const PickleGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <G rotation={-40} origin="12, 12.8">
      <Path d={PICKLE_D} fill={color} fillRule="evenodd" />
    </G>
  </Svg>
);

// A pickleball: a disc with seven holes (a centre and a ring of six).
const PICKLEBALL_D = (() => {
  let d = circlePath(12, 12, 9) + circlePath(12, 12, 1.6);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    d += circlePath(Math.round((12 + 5 * Math.cos(a)) * 100) / 100, Math.round((12 + 5 * Math.sin(a)) * 100) / 100, 1.6);
  }
  return d;
})();
export const PickleballGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <Path d={PICKLEBALL_D} fill={color} fillRule="evenodd" />
  </Svg>
);

// A pickleball paddle (rounded-rectangle face, not a round ping-pong face),
// tilted, with a ball at the top right.
const PADDLE_D = roundRectPath(7, 2.5, 10, 12, 4.5) + roundRectPath(10.6, 14, 2.8, 6, 1) + roundRectPath(10.1, 19.5, 3.8, 1.8, 0.9);
export const PaddleGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <G rotation={-35} origin="12, 12">
      <Path d={PADDLE_D} fill={color} />
    </G>
    <Path d={circlePath(19, 5.2, 2.2)} fill={color} />
  </Svg>
);

// Shot templates: a ground line, a net post at x 12, a dashed arc ending in a ball.
const COURT_D = 'M2.5 20.5h19M12 20.5v-6';
const DASH = '2 2.4';
export const ShotLobGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <Path d={COURT_D} {...lineGlyphProps(color)} />
    <Path d="M4 18Q10 -8 17.6 15.4" {...lineGlyphProps(color)} strokeDasharray={DASH} />
    <Path d={circlePath(19.4, 17.2, 2.3)} fill={color} />
  </Svg>
);
export const ShotDropGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <Path d={COURT_D} {...lineGlyphProps(color)} />
    <Path d="M3.5 17.5C7 9 12.5 8 15.4 15.3" {...lineGlyphProps(color)} strokeDasharray={DASH} />
    <Path d={circlePath(16.4, 17.6, 2.3)} fill={color} />
  </Svg>
);
export const ShotServeGlyph = ({ size, color }: GlyphProps) => (
  <Svg {...svg(size)}>
    <Path d={COURT_D} {...lineGlyphProps(color)} />
    <Path d={roundRectPath(2, 10.5, 3.6, 5, 1.6) + roundRectPath(3.1, 15.3, 1.4, 3, 0.7)} fill={color} />
    <Path d="M6.2 12.5Q12 3 17.8 15.3" {...lineGlyphProps(color)} strokeDasharray={DASH} />
    <Path d={circlePath(19.4, 17.3, 2.3)} fill={color} />
  </Svg>
);

registerGlyphs({
  pickle: { glyph: PickleGlyph, emoji: '🥒' },
  // 🎾 is the foundation's tennis `ball`; in Pickleague it is a pickleball.
  pickleball: { glyph: PickleballGlyph, emoji: '🥎', aliases: ['🎾'] },
  paddle: { glyph: PaddleGlyph, emoji: '🏓' },
  'shot-lob': { glyph: ShotLobGlyph, emoji: '⛅', aliases: ['☁'] },
  'shot-drop': { glyph: ShotDropGlyph, emoji: '🪂' },
  'shot-serve': { glyph: ShotServeGlyph, emoji: '🏐' },
});

// Emoji `icon` props on foundation components (Chip, Badge, EmptyState,
// SegmentedToggle, ...) draw as glyphs app-wide.
configureIcons({ glyphifyEmojiProps: true });
