// Draws the Winter Market (December 2026) decor SVGs into ./svg/
// (art/seasonal-market/2026-12/svg). The SVG files are the source the build
// reads; this script is how they were drawn. Edit here and re-run it, or edit
// an SVG by hand and stop using this.
//
//   node art/seasonal-market/2026-12/draw.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C, r1, shade, ball, paddle, flake, pineSprig, svg, writeAll } from '../shapes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = {};
const berry = '#c62f2f';
const holly = '#c94a3a';

// ── sm2612_wall_fair_isle (wallpaper, aspect 1) ─────────────────────────────
// A knitted band across the middle; it runs edge to edge, and anything cut by
// a side edge is drawn on both sides, so the tiles meet cleanly. Kept soft
// (ice blue, not red) so it stays behind the room's decor.
{
  const base = '#eef3f8', band = shade(C.deep, 0.5), stitch = shade(C.deep, -0.05);
  let stitches = '';
  for (let x = 2.5; x < 100; x += 5) stitches += `M${x - 1.4} 37.6l1.4 1.7l1.4 -1.7M${x - 1.4} 60.7l1.4 1.7l1.4 -1.7`;
  const star = (x, y) => `M${x} ${y - 2}V${y + 2}M${x - 2} ${y}H${x + 2}`;
  const diamond = (x) => `<path d="M${x} 46.4L${x + 3} 50L${x} 53.6L${x - 3} 50Z" fill="${C.snow}"/>`;
  files.sm2612_wall_fair_isle = svg(100,
    `<rect width="100" height="100" fill="${base}"/>` +
    `<path d="${star(25, 14)}${star(75, 14)}${star(0, 86)}${star(50, 86)}${star(100, 86)}" stroke="${shade(C.ice, 0.45)}" stroke-width="1" stroke-linecap="round"/>` +
    `<rect x="0" y="41" width="100" height="18" fill="${band}"/>` +
    `<rect x="0" y="41" width="100" height="1.4" fill="${shade(band, 0.2)}"/>` +
    `<path d="M0 40.4H100M0 59.6H100" stroke="${stitch}" stroke-width="1.2"/>` +
    `<path d="${stitches}" stroke="${stitch}" stroke-width="0.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    flake(25, 50, 5.4, C.snow, 1.1) + flake(75, 50, 5.4, C.snow, 1.1) +
    diamond(0) + diamond(100) +
    `<circle cx="50" cy="50" r="4.6" fill="${C.snow}"/>` + ball(50, 50, 3.6),
  );
}

// ── sm2612_rug_braided (rug, aspect 3) ──────────────────────────────────────
{
  const rings = [holly, C.cream, C.pine, C.cream, holly, C.deep, C.cream, holly];
  const cy = 16.65;
  let g = '';
  rings.forEach((col, i) => {
    const rx = 49 - i * 5.1, ry = 16 - i * 1.66;
    g += `<ellipse cx="50" cy="${cy}" rx="${r1(rx)}" ry="${r1(ry)}" fill="${col}"/>`;
    g += `<ellipse cx="50" cy="${cy}" rx="${r1(rx - 2.5)}" ry="${r1(ry - 0.82)}" fill="none" stroke="${col === C.cream ? shade(col, -0.12) : shade(col, 0.22)}" stroke-width="1.5" stroke-dasharray="2.2 1.5" opacity="0.8"/>`;
  });
  const inner = 49 - rings.length * 5.1, innerY = 16 - rings.length * 1.66;
  files.sm2612_rug_braided = svg(33.3,
    g +
    `<ellipse cx="50" cy="${cy}" rx="${r1(inner)}" ry="${r1(innerY)}" fill="${C.snow}"/>` +
    `<g transform="translate(50 ${cy}) scale(1 0.62) translate(-50 -${cy})">${ball(50, cy, 5.2)}</g>` ,
  );
}

// ── sm2612_ceiling_mittens (ceiling, aspect 4) ──────────────────────────────
{
  const wireY = (x) => { const t = x / 100; return 2 + 12 * t * (1 - t); };
  const pin = (x) => { const y = wireY(x); return `<rect x="${r1(x - 0.9)}" y="${r1(y - 1.6)}" width="1.8" height="4.4" rx="0.6" fill="${C.wood}"/><rect x="${r1(x - 0.9)}" y="${r1(y + 0.4)}" width="1.8" height="0.6" fill="${shade(C.wood, -0.25)}"/>`; };
  const mitten = (x, col, thumbRight) => {
    const y = wireY(x) + 1.2;
    const tx = thumbRight ? x + 4.2 : x - 4.2;
    return `<ellipse cx="${r1(tx)}" cy="${r1(y + 9)}" rx="1.9" ry="3.2" fill="${shade(col, -0.1)}" transform="rotate(${thumbRight ? -20 : 20} ${r1(tx)} ${r1(y + 9)})"/>` +
      `<rect x="${r1(x - 4.3)}" y="${r1(y + 2.5)}" width="8.6" height="13" rx="4.3" fill="${col}"/>` +
      `<rect x="${r1(x - 4.3)}" y="${r1(y + 3)}" width="1.8" height="10" rx="0.9" fill="${shade(col, 0.15)}"/>` +
      `<rect x="${r1(x - 4.6)}" y="${r1(y)}" width="9.2" height="4" rx="1" fill="${C.snow}"/>` +
      `<path d="M${r1(x - 4.6)} ${r1(y + 2)}h9.2" stroke="${col}" stroke-width="0.8" stroke-dasharray="1 1"/>` +
      flake(x, y + 9.5, 2.2, C.snow, 0.6, false);
  };
  const hat = (x, col) => {
    const y = wireY(x) + 1;
    return `<circle cx="${r1(x)}" cy="${r1(y + 2.2)}" r="2.4" fill="${C.snow}"/>` +
      `<path d="M${r1(x - 5)} ${r1(y + 13)}Q${r1(x - 5)} ${r1(y + 3.6)} ${r1(x)} ${r1(y + 3.6)}Q${r1(x + 5)} ${r1(y + 3.6)} ${r1(x + 5)} ${r1(y + 13)}Z" fill="${col}"/>` +
      `<path d="M${r1(x - 4.6)} ${r1(y + 9)}H${r1(x + 4.6)}" stroke="${C.snow}" stroke-width="1.1"/>` +
      `<rect x="${r1(x - 5.6)}" y="${r1(y + 12)}" width="11.2" height="4" rx="1.4" fill="${shade(col, 0.15)}"/>` +
      `<path d="M${r1(x - 3.6)} ${r1(y + 12.6)}v2.8M${r1(x - 1.2)} ${r1(y + 12.6)}v2.8M${r1(x + 1.2)} ${r1(y + 12.6)}v2.8M${r1(x + 3.6)} ${r1(y + 12.6)}v2.8" stroke="${col}" stroke-width="0.6"/>`;
  };
  const scarf = (x) => {
    const y = wireY(x) - 0.4;
    let s = '';
    for (const [ox, len] of [[-5, 17], [0.6, 13.5]]) {
      s += `<rect x="${r1(x + ox)}" y="${r1(y)}" width="4.4" height="${len}" rx="1" fill="${holly}"/>`;
      for (let k = 2.5; k < len - 1; k += 3.2) s += `<rect x="${r1(x + ox)}" y="${r1(y + k)}" width="4.4" height="1.2" fill="${C.snow}"/>`;
      s += `<path d="M${r1(x + ox + 0.6)} ${r1(y + len)}v1.6M${r1(x + ox + 2.2)} ${r1(y + len)}v1.6M${r1(x + ox + 3.8)} ${r1(y + len)}v1.6" stroke="${holly}" stroke-width="0.6" stroke-linecap="round"/>`;
    }
    return s;
  };
  const bag = (x) => {
    const y = wireY(x) + 1.4;
    return `<path d="M${r1(x)} ${r1(y)}L${r1(x - 2.6)} ${r1(y + 4)}M${r1(x)} ${r1(y)}L${r1(x + 2.6)} ${r1(y + 4)}" stroke="${C.cream}" stroke-width="0.6"/>` +
      ball(x, y + 8.4, 4.6) +
      `<path d="M${r1(x - 4.2)} ${r1(y + 6.6)}L${r1(x + 1)} ${r1(y + 12.9)}M${r1(x - 2)} ${r1(y + 4.4)}L${r1(x + 4.2)} ${r1(y + 10)}M${r1(x + 4.2)} ${r1(y + 6.6)}L${r1(x - 1)} ${r1(y + 12.9)}M${r1(x + 2)} ${r1(y + 4.4)}L${r1(x - 4.2)} ${r1(y + 10)}" stroke="${C.cream}" stroke-width="0.55" opacity="0.9"/>` +
      `<rect x="${r1(x - 2.8)}" y="${r1(y + 3.4)}" width="5.6" height="1.3" rx="0.6" fill="${C.deep}"/>`;
  };
  const sock = (x) => {
    const y = wireY(x) + 1.2;
    return `<path d="M${r1(x - 3.4)} ${r1(y + 3)}V${r1(y + 12)}Q${r1(x - 3.4)} ${r1(y + 16)} ${r1(x + 1)} ${r1(y + 16)}H${r1(x + 4.6)}Q${r1(x + 7)} ${r1(y + 16)} ${r1(x + 7)} ${r1(y + 13.6)}Q${r1(x + 7)} ${r1(y + 11.4)} ${r1(x + 3.4)} ${r1(y + 11)}V${r1(y + 3)}Z" fill="${C.pine}"/>` +
      `<path d="M${r1(x - 3.4)} ${r1(y + 7.4)}H${r1(x + 3.4)}M${r1(x - 3.4)} ${r1(y + 9.6)}H${r1(x + 3.4)}" stroke="${C.snow}" stroke-width="0.9"/>` +
      `<path d="M${r1(x + 4.6)} ${r1(y + 16)}Q${r1(x + 7)} ${r1(y + 16)} ${r1(x + 7)} ${r1(y + 13.6)}Q${r1(x + 7)} ${r1(y + 12)} ${r1(x + 5.4)} ${r1(y + 11.4)}Z" fill="${holly}"/>` +
      `<rect x="${r1(x - 3.8)}" y="${r1(y)}" width="7.6" height="3.6" rx="1" fill="${C.snow}"/>`;
  };
  const items = [
    [8.5, () => mitten(8.5, holly, true)],
    [18, () => mitten(18, holly, false)],
    [30, () => hat(30, C.pine)],
    [43.5, () => scarf(43.5)],
    [56, () => bag(56)],
    [67.5, () => mitten(67.5, C.deep, true)],
    [77, () => mitten(77, C.deep, false)],
    [88.5, () => sock(88.5)],
  ];
  files.sm2612_ceiling_mittens = svg(25,
    `<path d="M0 2Q50 14 100 2" fill="none" stroke="#a07850" stroke-width="0.9"/>` +
    items.map(([, f]) => f()).join('') +
    items.map(([x]) => pin(x)).join('') +
    `<g fill="${C.bark}"><rect x="0" y="0" width="3" height="3.4" rx="1"/><rect x="97" y="0" width="3" height="3.4" rx="1"/></g>`,
  );
}

// ── sm2612_item_gingerbread (shelf_item, aspect 1) ──────────────────────────
{
  const ginger = '#c47a3c', gDark = shade(ginger, -0.2), icing = C.snow;
  const gum = (x, y, col) => `<path d="M${r1(x - 2.6)} ${y}a2.6 3 0 0 1 5.2 0Z" fill="${col}"/><circle cx="${r1(x - 0.9)}" cy="${r1(y - 1.6)}" r="0.6" fill="${shade(col, 0.4)}"/>`;
  let shingles = '';
  const rows = [[44, 26], [37, 19.5], [30, 13]];
  rows.forEach(([y, hw], ri) => {
    const n = Math.round((hw * 2) / 6.4);
    for (let i = 0; i < n; i++) {
      const x = 50 - hw + 3.2 + i * ((hw * 2 - 6.4) / Math.max(1, n - 1));
      const col = [holly, C.ice, C.pine][(i + ri) % 3];
      shingles += `<circle cx="${r1(x)}" cy="${y}" r="2.3" fill="${col}"/><circle cx="${r1(x - 0.7)}" cy="${y - 0.7}" r="0.6" fill="${shade(col, 0.45)}"/>`;
    }
  });
  let drips = '';
  for (const [x, y, h] of [[18, 50.4, 3], [26, 42.5, 2.4], [74, 42.5, 2.6], [82, 50.4, 3.2], [36, 32.4, 2], [64, 32.4, 2.2]]) {
    drips += `<rect x="${x - 1}" y="${y}" width="2" height="${h}" rx="1" fill="${icing}"/>`;
  }
  const win = (x) => `<rect x="${x}" y="59" width="11" height="11" rx="1.6" fill="${C.ball}"/>` +
    `<path d="M${x + 5.5} 59v11M${x} 64.5h11" stroke="${icing}" stroke-width="1.3"/>` +
    `<rect x="${x}" y="59" width="11" height="11" rx="1.6" fill="none" stroke="${icing}" stroke-width="1.4"/>`;
  files.sm2612_item_gingerbread = svg(100,
    `<rect x="4" y="93" width="92" height="7" rx="3" fill="${C.deep}"/>` +
    `<rect x="5" y="93.4" width="90" height="1.6" rx="0.8" fill="${shade(C.deep, 0.2)}"/>` +
    // chimney behind the roof
    `<rect x="64" y="20" width="9" height="16" rx="1" fill="${gDark}"/><rect x="62.6" y="17.6" width="11.8" height="4" rx="2" fill="${icing}"/>` +
    // walls
    `<rect x="20" y="48" width="60" height="45" rx="2" fill="${ginger}"/>` +
    `<rect x="20" y="48" width="3.4" height="45" rx="1.7" fill="${shade(ginger, 0.14)}"/>` +
    win(26) + win(63) +
    `<path d="M43 93V80a7 7 0 0 1 14 0V93Z" fill="${gDark}"/>` +
    `<path d="M43 93V80a7 7 0 0 1 14 0V93" fill="none" stroke="${icing}" stroke-width="1.4"/>` +
    `<circle cx="54" cy="86" r="1" fill="${C.gold}"/>` +
    `<path d="M21 88q2.5 -2 5 0t5 0t5 0t5 0M59 88q2.5 -2 5 0t5 0t5 0t5 0" stroke="${icing}" stroke-width="1" fill="none" stroke-linecap="round"/>` +
    // roof, its candy shingles and the icing snow on its edges
    `<polygon points="50,16 13,51 87,51" fill="${gDark}" stroke="${gDark}" stroke-width="2" stroke-linejoin="round"/>` +
    shingles +
    `<path d="M11.5 51.5L50 15L88.5 51.5" fill="none" stroke="${icing}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
    drips +
    // the gumdrop pickleball on the peak, gumdrops along the base, a candy paddle by the door
    ball(50, 11.5, 5.8) +
    gum(25, 93, holly) + gum(33, 93, C.pine) + gum(67, 93, C.ice) + gum(75, 93, holly) +
    `<g transform="translate(88 82) rotate(10)">${paddle(7.4, holly)}</g>` +
    `<ellipse cx="12" cy="92.6" rx="7" ry="2.4" fill="${icing}"/>`,
  );
}

// ── sm2612_accent_sled (accent, aspect 0.75) ────────────────────────────────
// A wooden sled stood on its tail: lengthwise slats, a steering bar at the
// front, red runners whose front ends scroll over at the top.
{
  const H = 133.3, runner = holly, wood = C.wood;
  let slats = '';
  for (const x of [31, 40.5, 50, 59.5]) {
    slats += `<rect x="${x}" y="34" width="8.5" height="90" rx="3" fill="${wood}"/>` +
      `<rect x="${x}" y="34" width="2" height="90" rx="1" fill="${shade(wood, 0.16)}"/>` +
      `<g fill="${shade(wood, -0.3)}"><circle cx="${x + 4.25}" cy="47" r="0.8"/><circle cx="${x + 4.25}" cy="111" r="0.8"/></g>`;
  }
  const skate = (x, y, rot) =>
    `<g transform="translate(${x} ${y}) rotate(${rot})">` +
    `<path d="M-4.4 -11H3.4V3.5H9Q11.4 3.5 11.4 6.2V8.4H-4.4Z" fill="${C.snow}" stroke="${C.frameEdge}" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<path d="M-2.4 -7.6h3.4M-2.4 -4.4h3.4M-2.4 -1.2h3.4" stroke="${holly}" stroke-width="0.9" stroke-linecap="round"/>` +
    `<path d="M-3 8.4V11M8.6 8.4V11" stroke="${C.frameEdge}" stroke-width="1.1"/>` +
    `<path d="M-6.4 11.4H11Q13.2 11.4 13.2 9.6" stroke="#9aa3ad" stroke-width="1.5" fill="none" stroke-linecap="round"/>` +
    `</g>`;
  let scarf = `<rect x="18.5" y="44" width="8" height="40" rx="2" fill="${C.pine}"/>`;
  for (let y = 50; y < 82; y += 6) scarf += `<rect x="18.5" y="${y}" width="8" height="2" fill="${C.snow}"/>`;
  scarf += `<path d="M19.5 84v3M22.5 84v3M25.5 84v3" stroke="${C.pine}" stroke-width="1" stroke-linecap="round"/>`;
  files.sm2612_accent_sled = svg(H,
    // a paddle leaning behind, on the right
    `<g transform="translate(86 108) rotate(10)">${paddle(15, C.deep)}</g>` +
    // runners (behind the slats' edges), slats, cross bars
    `<path d="M29 126V26a7 7 0 0 0 -14 0a4.4 4.4 0 0 0 7.4 3.2" fill="none" stroke="${runner}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M71 126V26a7 7 0 0 1 14 0a4.4 4.4 0 0 1 -7.4 3.2" fill="none" stroke="${runner}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M28 120V30M70 120V30" stroke="${shade(runner, 0.3)}" stroke-width="1" stroke-linecap="round"/>` +
    slats +
    `<rect x="18" y="38" width="64" height="5.4" rx="2.7" fill="${C.darkWood}"/><rect x="19" y="38.4" width="62" height="1.4" rx="0.7" fill="${shade(C.darkWood, 0.2)}"/>` +
    `<rect x="27" y="108" width="46" height="4.4" rx="2" fill="${C.darkWood}"/>` +
    // a striped scarf knotted on the steering bar's left end
    `<rect x="16" y="36" width="12" height="9" rx="4" fill="${C.pine}"/><rect x="16" y="39.4" width="12" height="2" fill="${C.snow}"/>` + scarf +
    // skates hung from its right end by their laces
    `<path d="M78 41L76 53M78 41L86 57" stroke="${C.cream}" stroke-width="0.9"/>` +
    skate(76, 63, -5) + skate(86, 67, 5) +
    // a snowdrift at the foot, with a pickleball and a pine sprig in it
    `<path d="M2 ${H}V124Q12 115 26 120Q40 113 54 119Q70 112 84 118Q94 116 98 122V${H}Z" fill="${C.snow}"/>` +
    `<path d="M2 ${H}V124Q12 115 26 120Q40 113 54 119Q70 112 84 118Q94 116 98 122V${H}Z" fill="none" stroke="${shade(C.snow, -0.08)}" stroke-width="1"/>` +
    `<path d="M2 ${H - 4}H98" stroke="${shade(C.snow, -0.05)}" stroke-width="5"/>` +
    ball(63, 122, 6.4) +
    pineSprig(6, 126, 20, 116, C.pine, 1) + `<g fill="${berry}"><circle cx="13" cy="120.5" r="1.3"/><circle cx="15.2" cy="121.5" r="1.3"/></g>`,
  );
}

// ── sm2612_shelf_hutch (shelf, aspect 0.9) ──────────────────────────────────
// shelf_oak's frame: the top plank is the top 6 units of the 111.1 box (the
// shelf_item surface, 0.05), feet on the bottom edge.
{
  const paint = '#f1ebe0', edge = '#d9cfbd', back = holly;
  const plate = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.snow}" stroke="${edge}" stroke-width="0.8"/>` +
    `<circle cx="${x}" cy="${y}" r="${r1(r * 0.72)}" fill="none" stroke="${C.deep}" stroke-width="1"/>` +
    flake(x, y, r * 0.45, C.deep, 0.9, r > 8);
  const mug = (x, y, col) => `<path d="M${x + 6} ${y + 2.5}h2a2.4 2.4 0 0 1 0 6h-2" fill="none" stroke="${shade(col, -0.15)}" stroke-width="1.6"/>` +
    `<rect x="${x}" y="${y}" width="7.4" height="10" rx="1.6" fill="${col}"/><rect x="${x}" y="${y + 3.2}" width="7.4" height="1.6" fill="${col === C.snow ? holly : C.snow}"/>`;
  const present = (x, y, w, h, col, rib) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${col}"/>` +
    `<rect x="${x}" y="${y}" width="1.6" height="${h}" fill="${shade(col, 0.16)}"/>` +
    `<path d="M${x + w / 2} ${y}v${h}" stroke="${rib}" stroke-width="1.6"/>` +
    `<path d="M${x + w / 2} ${y}q-3 -3.2 -4 -0.4q1.6 1.4 4 0.4q3 -3.2 4 -0.4q-1.6 1.4 -4 0.4" fill="${rib}" stroke="${rib}" stroke-width="0.8" stroke-linejoin="round"/>`;
  let garland = pineSprig(6, 8.2, 28, 13.6, C.pine, 1.05) + pineSprig(50, 8.2, 28, 13.6, C.pine, 1.05) +
    pineSprig(50, 8.2, 72, 13.6, C.pine, 1.05) + pineSprig(94, 8.2, 72, 13.6, C.pine, 1.05);
  garland += `<g fill="${berry}">${[[17, 12], [28, 14.4], [39, 12], [61, 12], [72, 14.4], [83, 12]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4"/><circle cx="${x + 2}" cy="${y + 0.8}" r="1.2"/>`).join('')}</g>`;
  files.sm2612_shelf_hutch = svg(111.1,
    `<rect x="8" y="103" width="8" height="8.1" rx="1" fill="${C.darkWood}"/>` +
    `<rect x="84" y="103" width="8" height="8.1" rx="1" fill="${C.darkWood}"/>` +
    `<rect x="4" y="6" width="92" height="99" rx="3" fill="${paint}" stroke="${edge}" stroke-width="1.2"/>` +
    `<rect x="5" y="7" width="3" height="97" rx="1.5" fill="${shade(paint, 0.5)}"/>` +
    // open shelves: red backs, plates on a rail, mugs, presents
    `<rect x="10" y="12" width="80" height="25" rx="1.5" fill="${back}"/>` +
    `<rect x="10" y="43" width="80" height="24" rx="1.5" fill="${back}"/>` +
    `<rect x="10" y="12" width="80" height="2" fill="${shade(back, -0.2)}"/><rect x="10" y="43" width="80" height="2" fill="${shade(back, -0.2)}"/>` +
    `<rect x="10" y="37" width="80" height="6" fill="${shade(paint, -0.05)}"/><rect x="10" y="41.4" width="80" height="1.6" fill="${edge}"/>` +
    plate(23, 26.4, 8.6) + plate(45, 25.6, 9.6) +
    `<path d="M11 31.6H58" stroke="${C.darkWood}" stroke-width="1.2"/>` +
    mug(62, 27, C.snow) + mug(76, 27, C.pine) +
    present(14, 54, 13, 13, C.pine, C.snow) + present(31, 58, 10, 9, C.ice, holly) + present(45, 51, 15, 16, C.gold, holly) +
    ball(70, 61.6, 5.4) + present(78, 57, 9, 10, C.snow, C.pine) +
    // lower cupboard doors
    `<rect x="10" y="71" width="80" height="28" rx="1.5" fill="${shade(paint, -0.06)}"/>` +
    `<rect x="12" y="73" width="37" height="24" rx="1.5" fill="${paint}"/><rect x="51" y="73" width="37" height="24" rx="1.5" fill="${paint}"/>` +
    `<rect x="16" y="77" width="29" height="16" rx="1" fill="none" stroke="${edge}" stroke-width="1"/><rect x="55" y="77" width="29" height="16" rx="1" fill="none" stroke="${edge}" stroke-width="1"/>` +
    flake(30.5, 85, 5, C.deep, 1.1) + flake(69.5, 85, 5, C.deep, 1.1) +
    `<circle cx="46" cy="85" r="1.3" fill="${C.wood}"/><circle cx="54" cy="85" r="1.3" fill="${C.wood}"/>` +
    // the top plank (the shelf-item surface), then the garland under its edge
    `<rect x="0" y="0" width="100" height="6" rx="2" fill="${shade(paint, -0.08)}"/>` +
    `<rect x="1" y="0.5" width="98" height="1.5" rx="0.75" fill="${shade(paint, 0.4)}"/>` +
    garland,
  );
}

writeAll(HERE, files);
