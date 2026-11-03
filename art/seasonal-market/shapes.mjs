// Shared drawing helpers for the seasonal market art (art/seasonal-market/<drop>/draw.mjs).
// The same shapes and stroke style as the Court Pass draw scripts
// (art/court-pass/2026-11/draw.mjs, 2026-12/draw.mjs), so a market item and a
// Court Pass item of the same month look like one set: pickleballs, paddles,
// maple and oak leaves, pumpkins, wheat, apples and snowflakes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const r1 = (n) => Math.round(n * 10) / 10;
export const r2 = (n) => Math.round(n * 100) / 100;

/** A hex colour lightened (pct > 0) or darkened (pct < 0), as Doggle's shade(). */
export function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(pct < 0 ? c * (1 + pct) : c + (255 - c) * pct)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export const C = {
  // harvest (Court Pass November's palette_added)
  pumpkin: '#e8772e', rust: '#b5451b', harvest: '#e8a33d', wheat: '#f2d58a', leafRed: '#c8432b', bark: '#6d4c33',
  // winter (Court Pass December's palette_added)
  ice: '#7cc7ff', deep: '#2f7fc1', snow: '#f7fbff', red: '#e0533f',
  // My Place
  green: '#2e7d32', pine: '#1b5e20', ball: '#f2dd4b', hole: '#c9b52e', wood: '#b88a5a', darkWood: '#8a6f55',
  cream: '#f5f1e6', creamEdge: '#e2dccf', gold: '#d4a017', white: '#ffffff', ink: '#3a3a3a',
  glass: '#bfe3f5', glassEdge: '#9cc8e0', frame: '#eef0f3', frameEdge: '#c4cad2',
  apple: '#d2452f', vine: '#558b2f',
};
export const LEAVES = [C.leafRed, C.harvest, C.pumpkin, C.rust];

/** A pickleball: a disc with holes (centre + four on the diagonals, or a ring of six when big). */
export function ball(cx, cy, r, fill = C.ball, holeFill = C.hole) {
  const hr = r1(Math.max(0.35, r * 0.1));
  const pts = r >= 7
    ? [[0, 0], ...[0, 60, 120, 180, 240, 300].map((a) => [Math.cos((a * Math.PI) / 180) * r * 0.55, Math.sin((a * Math.PI) / 180) * r * 0.55])]
    : [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]].map(([x, y]) => [x * r, y * r]);
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"/>` +
    `<g fill="${holeFill}">${pts.map(([x, y]) => `<circle cx="${r1(cx + x)}" cy="${r1(cy + y)}" r="${hr}"/>`).join('')}</g>`;
}

/** A pickleball paddle centred on (0,0) of face width W (face 1.35 W tall), handle below. */
export function paddle(W, face, { mark = '', handle = C.pine } = {}) {
  const H = W * 1.35, hw = W * 0.24, hh = H / 3;
  const top = -H / 2;
  return `<rect x="${r1(-hw / 2)}" y="${r1(H / 2 - 1)}" width="${r1(hw)}" height="${r1(hh)}" rx="${r1(hw * 0.35)}" fill="${handle}"/>` +
    `<path d="M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.35)}h${r1(hw)}M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.65)}h${r1(hw)}" stroke="${C.white}" stroke-width="${r1(Math.max(0.6, W * 0.04))}"/>` +
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
const place = (cx, cy, s, rot, sy = 1) => `translate(${r2(cx)} ${r2(cy)})${sy === 1 ? '' : ` scale(1 ${sy})`} rotate(${rot}) scale(${s})`;

/** A maple leaf of radius s, tip up before rotation; the left half is the lit face. */
export function maple(cx, cy, s, rot = 0, color = C.leafRed, { veins = s >= 3, sy = 1 } = {}) {
  const dark = shade(color, -0.25);
  return `<g transform="${place(cx, cy, s, rot, sy)}">` +
    `<path d="M0 0.45L0.06 0.95" stroke="${dark}" stroke-width="0.12" stroke-linecap="round"/>` +
    `<polygon points="${MAPLE}" fill="${color}" stroke="${color}" stroke-width="0.08" stroke-linejoin="round"/>` +
    `<polygon points="${MAPLE_LIT}" fill="${shade(color, 0.12)}"/>` +
    (veins ? `<path d="M0 0.45V-0.7M0 0.2L0.6 -0.3M0 0.2L-0.6 -0.3" stroke="${dark}" stroke-width="0.07" stroke-linecap="round" fill="none"/>` : '') +
    `</g>`;
}

/** An almond leaf (oak / beech) of half-length s, tip up before rotation. */
export function leaf(cx, cy, s, rot = 0, color = C.harvest, { sy = 1 } = {}) {
  const dark = shade(color, -0.25);
  return `<g transform="${place(cx, cy, s, rot, sy)}">` +
    `<path d="M0 0.8L0 1.15" stroke="${dark}" stroke-width="0.12" stroke-linecap="round"/>` +
    `<path d="M0 -1C0.6 -0.6 0.6 0.5 0 1C-0.6 0.5 -0.6 -0.6 0 -1Z" fill="${color}"/>` +
    `<path d="M0 -1C-0.6 -0.6 -0.6 0.5 0 1Z" fill="${shade(color, 0.12)}"/>` +
    (s >= 3 ? `<path d="M0 0.9V-0.7M0 0.1L0.3 -0.25M0 0.45L-0.3 0.1" stroke="${dark}" stroke-width="0.08" stroke-linecap="round" fill="none"/>` : '') +
    `</g>`;
}

/** A ribbed pumpkin centred on (cx, cy): side lobes, a lit centre lobe, grooves, a stem and a vine curl. */
export function pumpkin(cx, cy, rx, ry, color = C.pumpkin, { vine = true, stem = '#7a5a32' } = {}) {
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
export function wheat(x0, y0, x1, y1, color = C.harvest, k = 1) {
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
export function apple(cx, cy, r, color = C.apple) {
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${color}"/>` +
    `<path d="M${r1(cx)} ${r1(cy - r)}A${r1(r)} ${r1(r)} 0 0 0 ${r1(cx)} ${r1(cy + r)}A${r1(r * 0.75)} ${r1(r)} 0 0 1 ${r1(cx)} ${r1(cy - r)}Z" fill="${shade(color, 0.12)}"/>` +
    `<ellipse cx="${r1(cx - r * 0.45)}" cy="${r1(cy - r * 0.35)}" rx="${r1(r * 0.16)}" ry="${r1(r * 0.28)}" fill="${shade(color, 0.4)}"/>` +
    `<path d="M${r1(cx)} ${r1(cy - r * 0.8)}L${r1(cx + r * 0.15)} ${r1(cy - r * 1.35)}" stroke="${C.bark}" stroke-width="${r1(Math.max(0.6, r * 0.14))}" stroke-linecap="round"/>` +
    leaf(cx + r * 0.45, cy - r * 1.15, r * 0.38, 60, C.vine);
}

// ── winter shapes ───────────────────────────────────────────────────────────

/** A six-armed snowflake (stroked lines, round caps). */
export function flake(cx, cy, r, color = C.white, w = 1.2, branches = true) {
  let d = '';
  for (let k = 0; k < 6; k++) {
    const a = ((90 + 60 * k) * Math.PI) / 180;
    const ex = cx + Math.cos(a) * r, ey = cy - Math.sin(a) * r;
    d += `M${r1(cx)} ${r1(cy)}L${r1(ex)} ${r1(ey)}`;
    if (branches) {
      const bx = cx + Math.cos(a) * r * 0.58, by = cy - Math.sin(a) * r * 0.58;
      for (const s of [-1, 1]) {
        const b = a + s * (Math.PI / 4);
        d += `M${r1(bx)} ${r1(by)}L${r1(bx + Math.cos(b) * r * 0.32)} ${r1(by - Math.sin(b) * r * 0.32)}`;
      }
    }
  }
  return `<path d="${d}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
}

/** A sprig of pine: a stem with needle strokes either side, from (x0,y0) to (x1,y1). */
export function pineSprig(x0, y0, x1, y1, color = C.pine, k = 1) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
  let d = `M${r1(x0)} ${r1(y0)}L${r1(x1)} ${r1(y1)}`;
  const n = Math.max(3, Math.round(len / (1.6 * k)));
  for (let i = 1; i < n; i++) {
    const t = i / n, bx = x0 + ux * len * t, by = y0 + uy * len * t, l = 2.6 * k * (1 - t * 0.4);
    for (const s of [-1, 1]) d += `M${r1(bx)} ${r1(by)}l${r1((px * s + ux * 0.6) * l)} ${r1((py * s + uy * 0.6) * l)}`;
  }
  return `<path d="${d}" stroke="${color}" stroke-width="${r1(0.9 * k)}" stroke-linecap="round" fill="none"/>`;
}

// ── output ──────────────────────────────────────────────────────────────────

export const svg = (h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${h}">${body}</svg>\n`;

/** Writes { id: svgString } into <dir>/svg/<id>.svg and prints each size. */
export function writeAll(dir, files) {
  const out = join(dir, 'svg');
  mkdirSync(out, { recursive: true });
  for (const [id, s] of Object.entries(files)) {
    writeFileSync(join(out, `${id}.svg`), s);
    console.log(id, s.length);
  }
}
