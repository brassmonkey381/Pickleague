// Draws the November 2026 Court Pass decor SVGs into ./svg/ (art/court-pass/2026-11/svg).
// The SVG files are the source the build reads; this script is how they were
// drawn. Edit here and re-run it, or edit an SVG by hand and stop using this.
// Same helpers and stroke style as 2026-12/draw.mjs, with harvest shapes added
// (maple and oak leaves, acorns, pumpkins, wheat).
//
//   node art/court-pass/2026-11/draw.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'svg');
mkdirSync(OUT, { recursive: true });

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(pct < 0 ? c * (1 + pct) : c + (255 - c) * pct)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
const C = {
  // harvest palette (catalog.json style.palette_added)
  pumpkin: '#e8772e', rust: '#b5451b', harvest: '#e8a33d', wheat: '#f2d58a', leafRed: '#c8432b', bark: '#6d4c33',
  // kept from My Place / December
  green: '#2e7d32', pine: '#1b5e20', ball: '#f2dd4b', hole: '#c9b52e', wood: '#b88a5a', darkWood: '#8a6f55',
  cream: '#fbf3e4', creamEdge: '#e2d6bf', gold: '#d4a017', white: '#ffffff', ink: '#3a3a3a',
  frame: '#eef0f3', frameEdge: '#c4cad2',
  // item colours
  wicker: '#c8955a', apple: '#d2452f', vine: '#558b2f', sky: '#f4b860', sun: '#fff3d6', hill: '#d9894a',
  meadow: '#c99a4a', straw: '#e6c36a', barn: '#a8402a', acornNut: '#c68a4a',
};
const LEAVES = [C.leafRed, C.harvest, C.pumpkin, C.rust];

/** A pickleball: a disc with holes (centre + four on the diagonals, or a ring of six when big). */
function ball(cx, cy, r, fill = C.ball, holeFill = C.hole) {
  const hr = r1(Math.max(0.35, r * 0.1));
  const pts = r >= 7
    ? [[0, 0], ...[0, 60, 120, 180, 240, 300].map((a) => [Math.cos((a * Math.PI) / 180) * r * 0.55, Math.sin((a * Math.PI) / 180) * r * 0.55])]
    : [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]].map(([x, y]) => [x * r, y * r]);
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"/>` +
    `<g fill="${holeFill}">${pts.map(([x, y]) => `<circle cx="${r1(cx + x)}" cy="${r1(cy + y)}" r="${hr}"/>`).join('')}</g>`;
}

/** A pickleball paddle centred on (0,0) of face width W (face 1.35 W tall), handle below. */
function paddle(W, face, { mark = '', handle = C.bark } = {}) {
  const H = W * 1.35, hw = W * 0.24, hh = H / 3;
  const top = -H / 2;
  return `<rect x="${r1(-hw / 2)}" y="${r1(H / 2 - 1)}" width="${r1(hw)}" height="${r1(hh)}" rx="${r1(hw * 0.35)}" fill="${handle}"/>` +
    `<path d="M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.35)}h${r1(hw)}M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.65)}h${r1(hw)}" stroke="${C.cream}" stroke-width="${r1(Math.max(0.6, W * 0.04))}"/>` +
    `<rect x="${r1(-W / 2)}" y="${r1(top)}" width="${r1(W)}" height="${r1(H)}" rx="${r1(W * 0.3)}" fill="${face}" stroke="${shade(face, -0.25)}" stroke-width="${r1(Math.max(1.2, W * 0.07))}"/>` +
    `<rect x="${r1(-W * 0.37)}" y="${r1(top + H * 0.14)}" width="${r1(W * 0.13)}" height="${r1(H * 0.72)}" rx="${r1(W * 0.065)}" fill="${shade(face, 0.12)}"/>` +
    `<rect x="${r1(-W * 0.46)}" y="${r1(top + H * 0.16)}" width="${r1(W * 0.92)}" height="${r1(W * 0.12)}" fill="${C.white}"/>` +
    mark;
}

// ── harvest shapes (unit shapes, placed with translate / rotate / scale) ────
const MAPLE_R = [[0.16, -0.6], [0.42, -0.74], [0.36, -0.36], [0.84, -0.44], [0.68, -0.16], [0.9, 0.02], [0.46, 0.16], [0.52, 0.4], [0.14, 0.3], [0.06, 0.52]];
const MAPLE_L = MAPLE_R.map(([x, y]) => [-x, y]);
const pts = (a) => a.map(([x, y]) => `${x},${y}`).join(' ');
const MAPLE = pts([[0, -1], ...MAPLE_R, ...[...MAPLE_L].reverse()]);
const MAPLE_LIT = pts([[0, -1], ...MAPLE_L, [0, 0.5]]);
// sy < 1 squashes the shape in the drawing's frame (after rotation), e.g. to lay it flat on a rug.
const place = (cx, cy, s, rot, sy = 1) => `translate(${r2(cx)} ${r2(cy)})${sy === 1 ? '' : ` scale(1 ${sy})`} rotate(${rot}) scale(${s})`;

/** A maple leaf of radius s, tip up before rotation; the left half is the lit face. */
function maple(cx, cy, s, rot = 0, color = C.leafRed, { veins = s >= 3, sy = 1 } = {}) {
  const dark = shade(color, -0.25);
  return `<g transform="${place(cx, cy, s, rot, sy)}">` +
    `<path d="M0 0.45L0.06 0.95" stroke="${dark}" stroke-width="0.12" stroke-linecap="round"/>` +
    `<polygon points="${MAPLE}" fill="${color}" stroke="${color}" stroke-width="0.08" stroke-linejoin="round"/>` +
    `<polygon points="${MAPLE_LIT}" fill="${shade(color, 0.12)}"/>` +
    (veins ? `<path d="M0 0.45V-0.7M0 0.2L0.6 -0.3M0 0.2L-0.6 -0.3" stroke="${dark}" stroke-width="0.07" stroke-linecap="round" fill="none"/>` : '') +
    `</g>`;
}

/** An almond leaf (oak / beech) of half-length s, tip up before rotation. */
function leaf(cx, cy, s, rot = 0, color = C.harvest, { sy = 1 } = {}) {
  const dark = shade(color, -0.25);
  return `<g transform="${place(cx, cy, s, rot, sy)}">` +
    `<path d="M0 0.8L0 1.15" stroke="${dark}" stroke-width="0.12" stroke-linecap="round"/>` +
    `<path d="M0 -1C0.6 -0.6 0.6 0.5 0 1C-0.6 0.5 -0.6 -0.6 0 -1Z" fill="${color}"/>` +
    `<path d="M0 -1C-0.6 -0.6 -0.6 0.5 0 1Z" fill="${shade(color, 0.12)}"/>` +
    (s >= 3 ? `<path d="M0 0.9V-0.7M0 0.1L0.3 -0.25M0 0.45L-0.3 0.1" stroke="${dark}" stroke-width="0.08" stroke-linecap="round" fill="none"/>` : '') +
    `</g>`;
}

/** An acorn about 2 s tall, centred on (cx, cy). */
function acorn(cx, cy, s, rot = 0) {
  return `<g transform="${place(cx, cy, s, rot)}">` +
    `<rect x="-0.07" y="-1" width="0.14" height="0.35" rx="0.07" fill="${C.bark}"/>` +
    `<ellipse cx="0" cy="0.3" rx="0.42" ry="0.6" fill="${C.acornNut}"/>` +
    `<ellipse cx="-0.17" cy="0.25" rx="0.1" ry="0.3" fill="${shade(C.acornNut, 0.22)}"/>` +
    `<path d="M-0.56 -0.12A0.56 0.56 0 0 1 0.56 -0.12Q0 0.06 -0.56 -0.12Z" fill="${C.bark}" stroke="${C.bark}" stroke-width="0.1" stroke-linejoin="round"/>` +
    `<g fill="${shade(C.bark, 0.2)}"><circle cx="-0.25" cy="-0.28" r="0.07"/><circle cx="0" cy="-0.36" r="0.07"/><circle cx="0.25" cy="-0.28" r="0.07"/><circle cx="-0.12" cy="-0.13" r="0.07"/><circle cx="0.13" cy="-0.13" r="0.07"/></g>` +
    `</g>`;
}

/** A ribbed pumpkin centred on (cx, cy): side lobes, a lit centre lobe, grooves, a stem and a vine curl. */
function pumpkin(cx, cy, rx, ry, color = C.pumpkin, { vine = true, stem = '#7a5a32' } = {}) {
  const sw = Math.max(1.4, rx * 0.16), sh = ry * 0.5;
  return `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="${shade(color, -0.16)}"/>` +
    `<ellipse cx="${r1(cx - rx * 0.4)}" cy="${r1(cy)}" rx="${r1(rx * 0.6)}" ry="${r1(ry)}" fill="${shade(color, 0.04)}"/>` +
    `<ellipse cx="${r1(cx + rx * 0.4)}" cy="${r1(cy)}" rx="${r1(rx * 0.6)}" ry="${r1(ry)}" fill="${shade(color, -0.06)}"/>` +
    `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx * 0.4)}" ry="${r1(ry)}" fill="${color}"/>` +
    `<path d="M${r1(cx - rx * 0.4)} ${r1(cy - ry * 0.9)}Q${r1(cx - rx * 0.5)} ${r1(cy)} ${r1(cx - rx * 0.4)} ${r1(cy + ry * 0.9)}M${r1(cx + rx * 0.4)} ${r1(cy - ry * 0.9)}Q${r1(cx + rx * 0.5)} ${r1(cy)} ${r1(cx + rx * 0.4)} ${r1(cy + ry * 0.9)}" stroke="${shade(color, -0.22)}" stroke-width="${r1(Math.max(0.5, rx * 0.04))}" fill="none" stroke-linecap="round"/>` +
    `<ellipse cx="${r1(cx - rx * 0.62)}" cy="${r1(cy - ry * 0.35)}" rx="${r1(rx * 0.1)}" ry="${r1(ry * 0.3)}" fill="${shade(color, 0.28)}"/>` +
    `<path d="M${r1(cx - sw / 2)} ${r1(cy - ry * 0.75)}V${r1(cy - ry - sh * 0.55)}Q${r1(cx)} ${r1(cy - ry - sh * 1.1)} ${r1(cx + sw * 0.9)} ${r1(cy - ry - sh)}L${r1(cx + sw / 2)} ${r1(cy - ry * 0.75)}Z" fill="${stem}"/>` +
    (vine
      ? `<path d="M${r1(cx + sw * 0.4)} ${r1(cy - ry * 0.95)}q${r1(rx * 0.25)} ${r1(-ry * 0.25)} ${r1(rx * 0.32)} ${r1(ry * 0.02)}q${r1(rx * 0.04)} ${r1(ry * 0.18)} ${r1(-rx * 0.1)} ${r1(ry * 0.12)}" stroke="${C.vine}" stroke-width="${r1(Math.max(0.6, rx * 0.05))}" fill="none" stroke-linecap="round"/>`
      : '');
}

/** A wheat stalk from (x0,y0) (the cut end) to (x1,y1) (the ear's tip). */
function wheat(x0, y0, x1, y1, color = C.harvest, k = 1) {
  const a = Math.atan2(y1 - y0, x1 - x0), deg = (a * 180) / Math.PI;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
  let g = `<path d="M${r1(x0)} ${r1(y0)}L${r1(x1)} ${r1(y1)}" stroke="${shade(color, -0.15)}" stroke-width="${r1(0.9 * k)}" stroke-linecap="round"/>`;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = 0.58 + (0.36 * i) / (n - 1);
    const bx = x0 + ux * len * t, by = y0 + uy * len * t;
    for (const s of [-1, 1]) {
      const ex = bx + px * 1.1 * k * s, ey = by + py * 1.1 * k * s;
      g += `<ellipse cx="${r1(ex)}" cy="${r1(ey)}" rx="${r1(1.9 * k)}" ry="${r1(0.95 * k)}" fill="${s < 0 ? shade(color, 0.12) : color}" transform="rotate(${r1(deg - s * 28)} ${r1(ex)} ${r1(ey)})"/>`;
    }
  }
  g += `<ellipse cx="${r1(x1 - ux * 0.6 * k)}" cy="${r1(y1 - uy * 0.6 * k)}" rx="${r1(1.8 * k)}" ry="${r1(0.9 * k)}" fill="${color}" transform="rotate(${r1(deg)} ${r1(x1 - ux * 0.6 * k)} ${r1(y1 - uy * 0.6 * k)})"/>`;
  return g;
}

/** An apple: a red disc, a lit spot, a stem and a leaf. */
function apple(cx, cy, r) {
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${C.apple}"/>` +
    `<path d="M${r1(cx)} ${r1(cy - r)}A${r1(r)} ${r1(r)} 0 0 0 ${r1(cx)} ${r1(cy + r)}A${r1(r * 0.75)} ${r1(r)} 0 0 1 ${r1(cx)} ${r1(cy - r)}Z" fill="${shade(C.apple, 0.12)}"/>` +
    `<ellipse cx="${r1(cx - r * 0.45)}" cy="${r1(cy - r * 0.35)}" rx="${r1(r * 0.16)}" ry="${r1(r * 0.28)}" fill="${shade(C.apple, 0.4)}"/>` +
    `<path d="M${r1(cx)} ${r1(cy - r * 0.8)}L${r1(cx + r * 0.15)} ${r1(cy - r * 1.35)}" stroke="${C.bark}" stroke-width="${r1(Math.max(0.6, r * 0.14))}" stroke-linecap="round"/>` +
    leaf(cx + r * 0.45, cy - r * 1.15, r * 0.38, 60, C.vine);
}

const svg = (h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${h}">${body}</svg>\n`;
const files = {};

// ── cp2611_cornucopia (shelf_item, aspect 1) ────────────────────────────────
{
  const bez = (p, t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t * t * t * p[3][k]);
  };
  const TOP = [[66, 30], [40, 32], [22, 50], [14, 24]];
  const BOT = [[68, 88], [36, 82], [22, 42], [20, 19]];
  const horn = `M66 30C40 32 22 50 14 24Q12.5 17 20 19C22 42 36 82 68 88Z`;
  let bands = '', mids = [];
  for (const t of [0.12, 0.26, 0.4, 0.54, 0.68, 0.8]) {
    const [ax, ay] = bez(TOP, t), [bx, by] = bez(BOT, t);
    const mx = (ax + bx) / 2 + 4 * (1 - t), my = (ay + by) / 2;
    mids.push([mx - 2 * (1 - t), my]);
    bands += `M${r1(ax)} ${r1(ay + 0.8)}Q${r1(mx)} ${r1(my)} ${r1(bx)} ${r1(by - 0.8)}`;
  }
  let hi = '';
  for (let i = 0; i <= 10; i++) {
    const [x, y] = bez(TOP, 0.08 + i * 0.06);
    hi += `${i ? 'L' : 'M'}${r1(x)} ${r1(y + 2.6 - i * 0.12)}`;
  }
  const wick = C.wicker;
  files.cp2611_cornucopia = svg(100,
    `<rect x="2" y="93" width="96" height="7" rx="3" fill="${C.darkWood}"/>` +
    `<rect x="4" y="93.6" width="92" height="1.8" rx="0.9" fill="${shade(C.darkWood, 0.12)}"/>` +
    leaf(12, 89, 5.5, -70, C.harvest) +
    `<path d="${horn}" fill="${wick}" stroke="${wick}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="${bands}" stroke="${shade(wick, -0.22)}" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
    `<path d="M${mids.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}" stroke="${shade(wick, 0.2)}" stroke-width="1.2" fill="none" stroke-dasharray="2.4 2" stroke-linecap="round"/>` +
    `<path d="${hi}" stroke="${shade(wick, 0.25)}" stroke-width="1.8" fill="none" stroke-linecap="round"/>` +
    `<ellipse cx="68" cy="59" rx="8" ry="29" fill="#5a3b24"/>` +
    wheat(68, 52, 86, 14, C.harvest, 1.1) + wheat(68, 56, 95, 30, shade(C.harvest, 0.1), 1) +
    maple(77, 40, 9, 22, C.leafRed) +
    leaf(60, 42, 6, -30, C.harvest) +
    `<ellipse cx="68" cy="59" rx="8" ry="29" fill="none" stroke="${shade(wick, -0.1)}" stroke-width="3"/>` +
    apple(76, 60, 7) +
    ball(66, 73, 8.5) +
    pumpkin(84, 80, 14, 11, C.pumpkin) +
    ball(56, 86, 6) +
    acorn(94, 88, 5, 15),
  );
}

// ── cp2611_pumpkin_stack (accent, aspect 0.75) ──────────────────────────────
{
  const H = 133.3;
  let straw = '';
  for (const [x, y, l, a] of [[10, 113, 6, -8], [32, 121, 7, 6], [46, 112, 5, -4], [60, 126, 6, 8], [86, 114, 6, -6], [14, 126, 5, 4], [40, 128, 6, -6], [92, 125, 4, 6]]) {
    const rad = (a * Math.PI) / 180;
    straw += `M${x} ${y}l${r1(Math.cos(rad) * l)} ${r1(Math.sin(rad) * l)}`;
  }
  files.cp2611_pumpkin_stack = svg(H,
    `<rect x="2" y="105" width="96" height="${r1(H - 105)}" rx="4" fill="${C.straw}"/>` +
    `<rect x="4" y="106" width="92" height="3" rx="1.5" fill="${shade(C.straw, 0.25)}"/>` +
    `<rect x="2" y="${r1(H - 5)}" width="96" height="5" rx="2.5" fill="${shade(C.straw, -0.14)}"/>` +
    `<path d="${straw}" stroke="${shade(C.straw, -0.2)}" stroke-width="1" stroke-linecap="round"/>` +
    `<g fill="${C.bark}"><rect x="21" y="105" width="3.4" height="${r1(H - 105)}"/><rect x="75" y="105" width="3.4" height="${r1(H - 105)}"/></g>` +
    pumpkin(50, 87, 40, 19, C.pumpkin, { vine: false }) +
    pumpkin(47, 57, 27, 14, '#f1e6cf', { vine: false }) +
    pumpkin(51, 35, 17, 11, C.harvest) +
    `<g transform="translate(86 91) rotate(16)">${paddle(17, C.green)}</g>` +
    ball(13, 99.5, 6.5) +
    maple(32, 115, 5, -20, C.leafRed) + leaf(64, 119, 4.5, 65, C.rust) + maple(88, 123, 4, 25, C.harvest),
  );
}

// ── cp2611_window_autumn (window, aspect 0.9) ───────────────────────────────
{
  const tree = (x, base, r, color) =>
    `<rect x="${r1(x - r * 0.12)}" y="${r1(base - r * 1.2)}" width="${r1(r * 0.24)}" height="${r1(r * 1.2)}" fill="${C.bark}"/>` +
    `<circle cx="${r1(x)}" cy="${r1(base - r * 1.7)}" r="${r1(r)}" fill="${color}"/>` +
    `<circle cx="${r1(x - r * 0.55)}" cy="${r1(base - r * 1.25)}" r="${r1(r * 0.7)}" fill="${shade(color, 0.1)}"/>` +
    `<circle cx="${r1(x + r * 0.55)}" cy="${r1(base - r * 1.25)}" r="${r1(r * 0.7)}" fill="${shade(color, -0.1)}"/>`;
  const falling = [[22, 22, 2.4, 20, 0], [38, 34, 2, -30, 1], [60, 20, 2.2, 45, 2], [84, 22, 2, -15, 3], [28, 46, 1.8, 60, 1], [64, 44, 2, -50, 0], [80, 48, 1.8, 30, 2], [44, 18, 1.6, 10, 3]];
  let sill = '';
  for (let i = 0; i < 21; i++) {
    const x = 4.5 + i * 4.55, y = 99 - (i % 2) * 1.2;
    sill += leaf(x, y, 2.8, i % 2 ? 70 : -70, LEAVES[i % 4]);
  }
  let wreath = '';
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 * Math.PI) / 180;
    wreath += leaf(50 + Math.cos(a) * 9, 52 + Math.sin(a) * 9, 3, i * 30 + 90 + 25, LEAVES[i % 4]);
  }
  files.cp2611_window_autumn = svg(111.1,
    `<rect x="4" y="4" width="92" height="96" rx="4" fill="${C.frame}" stroke="${C.frameEdge}" stroke-width="1.5"/>` +
    `<rect x="12" y="12" width="76" height="80" rx="2" fill="${C.sky}"/>` +
    `<circle cx="70" cy="34" r="11" fill="${C.sun}" opacity="0.3"/>` +
    `<circle cx="70" cy="34" r="7" fill="${C.sun}"/>` +
    `<path d="M12 64Q28 54 46 60T88 56V92H12Z" fill="${C.hill}"/>` +
    tree(20, 74, 8, C.leafRed) + tree(32, 71, 6, C.harvest) + tree(80, 74, 8, C.pumpkin) + tree(68, 69, 5, C.rust) +
    `<path d="M12 72Q32 66 52 71T88 69V90a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2Z" fill="${C.meadow}"/>` +
    `<polygon points="30,76 70,76 77,90 23,90" fill="${C.green}"/>` +
    `<polygon points="31.6,77.2 68.4,77.2 74.8,89 25.2,89" fill="none" stroke="${C.white}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="M50 82.3V89" stroke="${C.white}" stroke-width="0.9"/>` +
    `<rect x="26" y="80.8" width="48" height="2" fill="${C.ink}" opacity="0.6"/>` +
    `<rect x="25.4" y="79" width="1.2" height="4" fill="${C.ink}"/><rect x="73.4" y="79" width="1.2" height="4" fill="${C.ink}"/>` +
    maple(36, 86.5, 1.8, 30, C.leafRed, { veins: false }) + leaf(62, 78.5, 1.6, -60, C.harvest) + maple(66, 87, 1.6, -20, C.pumpkin, { veins: false }) +
    ball(43, 86.4, 1.6) +
    falling.map(([x, y, s, rot, c]) => (c % 2 ? leaf(x, y, s, rot, LEAVES[c]) : maple(x, y, s, rot, LEAVES[c], { veins: false }))).join('') +
    `<rect x="15" y="15" width="3" height="30" rx="1.5" fill="${C.white}" opacity="0.3"/>` +
    `<rect x="48" y="12" width="4" height="80" fill="${C.frame}"/>` +
    `<rect x="12" y="50" width="76" height="4" fill="${C.frame}"/>` +
    `<circle cx="50" cy="52" r="9" fill="none" stroke="${C.bark}" stroke-width="2.4"/>` + wreath +
    `<path d="M50 61.5l-4.6 -2.6v5.2zM50 61.5l4.6 -2.6v5.2z" fill="${C.rust}" stroke="${C.rust}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="M49 62.5l-2.6 6M51 62.5l2.6 6" stroke="${shade(C.rust, -0.15)}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="50" cy="61.5" r="1.6" fill="${shade(C.rust, -0.15)}"/>` +
    `<rect x="0.75" y="100" width="98.5" height="8" rx="2" fill="#e2e5ea" stroke="${C.frameEdge}" stroke-width="1.5"/>` +
    `<rect x="2" y="100.8" width="96" height="2" rx="1" fill="#f6f7f9"/>` +
    sill + pumpkin(14, 97.2, 5, 3.6, C.pumpkin, { vine: false }) + pumpkin(87, 97.6, 4, 3, C.harvest, { vine: false }),
  );
}

// ── cp2611_poster_gratitude (wall_art, aspect 0.8) ──────────────────────────
{
  files.cp2611_poster_gratitude = svg(125,
    `<rect x="6" y="6" width="88" height="114" rx="1" fill="${C.cream}" stroke="${C.creamEdge}" stroke-width="1.5"/>` +
    `<rect x="14" y="14" width="72" height="66" rx="1" fill="${C.rust}"/>` +
    `<g fill="${C.wheat}" opacity="0.7"><circle cx="22" cy="22" r="1"/><circle cx="78" cy="24" r="1.2"/><circle cx="21" cy="52" r="0.9"/><circle cx="79" cy="50" r="1"/><circle cx="66" cy="18" r="0.8"/><circle cx="33" cy="19" r="0.8"/></g>` +
    leaf(24, 34, 3.2, -35, C.pumpkin) + maple(77, 36, 3.4, 25, C.leafRed) +
    maple(50, 43, 25, 0, C.harvest) +
    ball(50, 41, 9) +
    `<path d="M14 70Q26 63 38 67T62 66T86 67V79a1 1 0 0 1-1 1H15a1 1 0 0 1-1-1Z" fill="${C.pumpkin}"/>` +
    `<path d="M14 75Q30 71 46 74T86 73V79a1 1 0 0 1-1 1H15a1 1 0 0 1-1-1Z" fill="${C.wheat}"/>` +
    `<rect x="14" y="86" width="72" height="24" fill="${C.green}"/>` +
    `<text x="50" y="97.6" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="7.4" letter-spacing="1" fill="${C.white}">GRATITUDE</text>` +
    `<text x="50" y="105.6" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="4.4" letter-spacing="2" fill="${C.wheat}">COURT</text>` +
    `<path d="M26 104h12M62 104h12" stroke="${C.white}" stroke-width="1"/>` +
    `<rect x="-9" y="-3" width="18" height="6" fill="${C.wheat}" opacity="0.85" transform="translate(11 9) rotate(-35)"/>` +
    `<rect x="-9" y="-3" width="18" height="6" fill="${C.wheat}" opacity="0.85" transform="translate(89 9) rotate(35)"/>`,
  );
}

// ── cp2611_leaf_garland (ceiling, aspect 4) ─────────────────────────────────
{
  const wireY = (x) => (x <= 50 ? 1.5 + Math.sin((x / 50) * Math.PI) * 2.6 : 1.5 + Math.sin(((x - 50) / 50) * Math.PI) * 2.6);
  const kinds = ['maple', 'leaf', 'acorn', 'maple', 'ball', 'leaf', 'maple', 'acorn', 'maple', 'leaf', 'ball', 'maple', 'acorn', 'leaf', 'maple'];
  let strings = '', items = '';
  kinds.forEach((k, i) => {
    const x = 4 + i * 6.6;
    const y = wireY(x) + 0.4;
    const drop = i % 2 ? 6.5 : 2;
    const tilt = (i % 3 - 1) * 14;
    const cy = y + drop + 5;
    strings += `M${r1(x)} ${r1(y)}V${r1(cy - 3.5)}`;
    if (k === 'maple') items += maple(x, cy, 5.2, tilt, LEAVES[i % 4]);
    else if (k === 'leaf') items += leaf(x, cy, 4.8, tilt, LEAVES[(i + 1) % 4]);
    else if (k === 'acorn') items += acorn(x, cy - 0.5, 3.6, tilt);
    else items += ball(x, cy - 1, 3);
  });
  files.cp2611_leaf_garland = svg(25,
    `<path d="M0 1.5Q25 6.6 50 1.5Q75 6.6 100 1.5" fill="none" stroke="#a07850" stroke-width="0.9"/>` +
    `<path d="${strings}" stroke="#a07850" stroke-width="0.5"/>` + items +
    `<g fill="${C.bark}"><rect x="0.5" y="0" width="3" height="2.6" rx="1"/><rect x="48.5" y="0" width="3" height="2.6" rx="1"/><rect x="96.5" y="0" width="3" height="2.6" rx="1"/></g>`,
  );
}

// ── cp2611_pillow_plaid (couch_pillow, aspect 1.2) ──────────────────────────
{
  const H = 83.3;
  const L = 2, R = 98, T = 2, B = H - 2, RAD = 32;
  // The pillow's outline is a rounded rect; stripes are cut to it by sampling its edge (no clipPath).
  const xAt = (y) => {
    const dy = y < T + RAD ? T + RAD - y : y > B - RAD ? y - (B - RAD) : 0;
    const dx = RAD - Math.sqrt(Math.max(0, RAD * RAD - dy * dy));
    return [L + dx, R - dx];
  };
  const yAt = (x) => {
    const dx = x < L + RAD ? L + RAD - x : x > R - RAD ? x - (R - RAD) : 0;
    const dy = RAD - Math.sqrt(Math.max(0, RAD * RAD - dx * dx));
    return [T + dy, B - dy];
  };
  const steps = (a, b) => {
    const out = [];
    for (let v = a; v < b; v += 1) out.push(v);
    out.push(b);
    return out;
  };
  const hBand = (y0, y1) => {
    const ys = steps(y0, y1);
    return `M${ys.map((y) => `${r1(xAt(y)[0])} ${r1(y)}`).join('L')}L${[...ys].reverse().map((y) => `${r1(xAt(y)[1])} ${r1(y)}`).join('L')}Z`;
  };
  const vBand = (x0, x1) => {
    const xs = steps(x0, x1);
    return `M${xs.map((x) => `${r1(x)} ${r1(yAt(x)[0])}`).join('L')}L${[...xs].reverse().map((x) => `${r1(x)} ${r1(yAt(x)[1])}`).join('L')}Z`;
  };
  const wide = [[9, 19], [36.6, 46.6], [64, 74]].map(([a, b]) => hBand(a, b)).join('') +
    [[12, 24], [44, 56], [76, 88]].map(([a, b]) => vBand(a, b)).join('');
  const thinCream = [[25, 25.9], [57, 57.9]].map(([a, b]) => hBand(a, b)).join('') + [[32, 32.9], [67, 67.9]].map(([a, b]) => vBand(a, b)).join('');
  const thinDark = [[13.6, 14.4], [41.2, 42], [68.6, 69.4]].map(([a, b]) => hBand(a, b)).join('') + [[17.6, 18.4], [49.6, 50.4], [81.6, 82.4]].map(([a, b]) => vBand(a, b)).join('');
  const dark = shade(C.pumpkin, -0.3);
  files.cp2611_pillow_plaid = svg(H,
    `<rect x="2" y="2" width="96" height="${r1(H - 4)}" rx="32" fill="${C.pumpkin}"/>` +
    `<path d="${wide}" fill="${C.rust}" opacity="0.45"/>` +
    `<path d="${thinCream}" fill="${C.cream}" opacity="0.6"/>` +
    `<path d="${thinDark}" fill="${C.bark}" opacity="0.5"/>` +
    `<ellipse cx="26" cy="13" rx="12" ry="4.5" fill="${shade(C.pumpkin, 0.25)}" opacity="0.7" transform="rotate(-18 26 13)"/>` +
    `<ellipse cx="50" cy="41.6" rx="18" ry="15.5" fill="${C.cream}"/>` +
    `<ellipse cx="50" cy="41.6" rx="15.4" ry="13" fill="none" stroke="${C.rust}" stroke-width="1" stroke-dasharray="2.2 1.8"/>` +
    maple(50, 41, 11, 0, C.harvest) +
    ball(50, 40, 5.5) +
    `<rect x="5" y="5" width="90" height="${r1(H - 10)}" rx="29" fill="none" stroke="${dark}" stroke-width="1.4" stroke-dasharray="3 2.4"/>`,
  );
}

// ── cp2611_rug_harvest (rug, aspect 3) ──────────────────────────────────────
{
  const court = '#eccb83', kitchen = shade(court, -0.1), line = '#fff8ea';
  files.cp2611_rug_harvest = svg(33.3,
    `<polygon points="9.1,2.2 90.9,2.2 97.5,31.1 2.5,31.1" fill="${C.rust}" stroke="${C.rust}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<polygon points="9.6,2.6 90.4,2.6 96.6,30.6 3.4,30.6" fill="none" stroke="${C.wheat}" stroke-width="0.7" stroke-dasharray="1.4 1.4"/>` +
    `<polygon points="11.1,4 88.9,4 94.4,29.3 5.6,29.3" fill="${court}"/>` +
    `<polygon points="37.9,4 62.1,4 63.8,29.3 36.2,29.3" fill="${kitchen}"/>` +
    `<path d="M37.8 5L36.3 28.3M62.2 5L63.7 28.3M9.3 16.7L37.1 16.7M63 16.7L90.7 16.7" stroke="${line}" stroke-width="1.5" fill="none"/>` +
    `<polygon points="11.8,5 88.2,5 93.2,28.3 6.8,28.3" fill="none" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<g transform="translate(50 16.7) scale(1 0.62)"><circle r="12.5" fill="${shade(court, -0.2)}"/></g>` +
    maple(50, 16.2, 10.5, 0, C.pumpkin, { sy: 0.62 }) +
    ball(50, 16, 3.2) +
    maple(23.5, 10.6, 3.4, -20, C.leafRed, { veins: false, sy: 0.62 }) +
    leaf(76.5, 10.6, 3.2, 70, C.harvest, { sy: 0.62 }) +
    leaf(22, 22.6, 3.6, -60, C.rust, { sy: 0.62 }) +
    maple(78, 22.6, 3.6, 20, C.harvest, { veins: false, sy: 0.62 }) +
    `<g fill="${C.wheat}"><circle cx="9.1" cy="2.2" r="1.4"/><circle cx="90.9" cy="2.2" r="1.4"/><circle cx="2.5" cy="31.1" r="1.4"/><circle cx="97.5" cy="31.1" r="1.4"/></g>`,
  );
}

// ── cp2611_rack_harvest_hall (paddle_rack, aspect 1.25) ─────────────────────
{
  const wall = C.barn, inner = shade(C.barn, -0.24), hi = shade(C.barn, 0.12);
  let boards = '';
  for (let x = 15; x < 93; x += 8) boards += `M${x} 27.5V73.5`;
  let eave = '';
  for (let i = 0; i < 12; i++) eave += maple(7 + i * 7.8, 27.6, 2.6, (i % 3 - 1) * 20, LEAVES[i % 4], { veins: false });
  const fan = (rot, len, W, face) => `<g transform="translate(50 77) rotate(${rot}) translate(0 -${len})">${paddle(W, face)}</g>`;
  files.cp2611_rack_harvest_hall = svg(80,
    `<rect x="2" y="22" width="96" height="56" rx="4" fill="${wall}"/>` +
    `<polygon points="1,25 11,12 89,12 99,25" fill="${C.bark}" stroke="${C.bark}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<rect x="11" y="12.2" width="78" height="2" rx="1" fill="${shade(C.bark, 0.18)}"/>` +
    `<polygon points="33,22 50,1.2 67,22" fill="${wall}" stroke="${C.cream}" stroke-width="1.8" stroke-linejoin="round"/>` +
    `<path d="M36.5 20.6L50 4.1" stroke="${hi}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="50" cy="14" r="4.4" fill="${C.gold}"/>` +
    `<path d="M50 9.6V18.4M45.6 14H54.4" stroke="${C.bark}" stroke-width="1"/>` +
    `<rect x="1" y="24" width="98" height="2.2" rx="1.1" fill="${C.cream}"/>` +
    `<rect x="7" y="27" width="86" height="47" rx="3" fill="${inner}"/>` +
    `<path d="${boards}" stroke="${shade(inner, -0.2)}" stroke-width="0.6" opacity="0.6"/>` +
    `<path d="M9 29L91 72M91 29L9 72" stroke="${C.cream}" stroke-width="2.4" opacity="0.1"/>` +
    eave +
    `<g opacity="0.45">${leaf(14, 62, 3, -30, C.harvest)}${leaf(86, 62, 3, 30, C.harvest)}${maple(16, 42, 2.6, -15, C.harvest, { veins: false })}${maple(84, 42, 2.6, 15, C.harvest, { veins: false })}</g>` +
    fan(-50, 40, 14, C.pumpkin) + fan(50, 40, 14, C.pumpkin) +
    fan(-25, 43, 15.5, C.wheat) + fan(25, 43, 15.5, C.wheat) +
    `<g transform="translate(50 31)">${paddle(19, C.gold, { mark: maple(0, 1.4, 5.6, 0, C.rust) })}</g>` +
    pumpkin(11, 71.5, 7.5, 5.5, C.pumpkin, { vine: false }) + pumpkin(89, 71.5, 7.5, 5.5, C.harvest, { vine: false }) +
    `<rect x="40" y="65" width="20" height="6" rx="1.5" fill="${C.gold}"/>` +
    `<path d="M44 68h12" stroke="${shade(C.gold, -0.24)}" stroke-width="0.8"/>`,
  );
}

for (const [id, s] of Object.entries(files)) {
  writeFileSync(join(OUT, `${id}.svg`), s);
  console.log(id, s.length);
}
