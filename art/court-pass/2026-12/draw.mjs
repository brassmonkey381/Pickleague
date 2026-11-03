// Draws the December 2026 Court Pass decor SVGs into ./svg/ (art/court-pass/2026-12/svg).
// The SVG files are the source the build reads; this script is how they were
// drawn. Edit here and re-run it, or edit an SVG by hand and stop using this.
//
//   node art/court-pass/2026-12/draw.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'svg');
mkdirSync(OUT, { recursive: true });

const r1 = (n) => Math.round(n * 10) / 10;
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(pct < 0 ? c * (1 + pct) : c + (255 - c) * pct)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
const C = {
  ice: '#7cc7ff', deep: '#2f7fc1', snow: '#f7fbff', red: '#e0533f', pine: '#1b5e20',
  green: '#2e7d32', ball: '#f2dd4b', hole: '#c9b52e', wood: '#b88a5a', darkWood: '#8a6f55',
  glass: '#bfe3f5', glassEdge: '#9cc8e0', cream: '#f5f1e6', creamEdge: '#e2dccf', gold: '#d4a017',
  white: '#ffffff', ink: '#3a3a3a', frame: '#eef0f3', frameEdge: '#c4cad2',
};

/** A pickleball: a disc with holes (centre + four on the diagonals, or a ring of six when big). */
function ball(cx, cy, r, fill = C.ball, holeFill = C.hole) {
  const hr = r1(Math.max(0.35, r * 0.1));
  const pts = r >= 7
    ? [[0, 0], ...[0, 60, 120, 180, 240, 300].map((a) => [Math.cos((a * Math.PI) / 180) * r * 0.55, Math.sin((a * Math.PI) / 180) * r * 0.55])]
    : [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]].map(([x, y]) => [x * r, y * r]);
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"/>` +
    `<g fill="${holeFill}">${pts.map(([x, y]) => `<circle cx="${r1(cx + x)}" cy="${r1(cy + y)}" r="${hr}"/>`).join('')}</g>`;
}

/** A six-armed snowflake (stroked lines, round caps). */
function flake(cx, cy, r, color = C.white, w = 1.2, branches = true) {
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

/** A pickleball paddle centred on (0,0) of face width W (face 1.35 W tall), handle below. */
function paddle(W, face, { mark = '' } = {}) {
  const H = W * 1.35, hw = W * 0.24, hh = H / 3;
  const top = -H / 2;
  return `<rect x="${r1(-hw / 2)}" y="${r1(H / 2 - 1)}" width="${r1(hw)}" height="${r1(hh)}" rx="${r1(hw * 0.35)}" fill="${C.pine}"/>` +
    `<path d="M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.35)}h${r1(hw)}M${r1(-hw / 2)} ${r1(H / 2 + hh * 0.65)}h${r1(hw)}" stroke="${C.white}" stroke-width="${r1(Math.max(0.6, W * 0.04))}"/>` +
    `<rect x="${r1(-W / 2)}" y="${r1(top)}" width="${r1(W)}" height="${r1(H)}" rx="${r1(W * 0.3)}" fill="${face}" stroke="${shade(face, -0.25)}" stroke-width="${r1(Math.max(1.2, W * 0.07))}"/>` +
    `<rect x="${r1(-W * 0.37)}" y="${r1(top + H * 0.14)}" width="${r1(W * 0.13)}" height="${r1(H * 0.72)}" rx="${r1(W * 0.065)}" fill="${shade(face, 0.12)}"/>` +
    `<rect x="${r1(-W * 0.46)}" y="${r1(top + H * 0.16)}" width="${r1(W * 0.92)}" height="${r1(W * 0.12)}" fill="${C.white}"/>` +
    mark;
}

const svg = (h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${h}">${body}</svg>\n`;
const files = {};

// ── cp2612_snow_globe (shelf_item, aspect 1) ────────────────────────────────
{
  const cx = 50, cy = 44, R = 42;
  const at = (y) => Math.sqrt(R * R - (y - cy) * (y - cy));
  const y1 = 62, y2 = 80;
  const mound = `M${r1(cx - at(y1))} ${y1}Q50 50 ${r1(cx + at(y1))} ${y1}A${R} ${R} 0 0 1 ${r1(cx + at(y2))} ${y2}L${r1(cx - at(y2))} ${y2}A${R} ${R} 0 0 1 ${r1(cx - at(y1))} ${y1}Z`;
  const pine = (x, base, h) =>
    `<polygon points="${x},${base - h} ${x + h * 0.42},${base} ${x - h * 0.42},${base}" fill="${C.pine}" stroke="${C.pine}" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<polygon points="${x},${base - h} ${x - h * 0.42},${base} ${x},${base}" fill="${C.green}"/>` +
    `<polygon points="${x},${r1(base - h - 0.6)} ${r1(x + h * 0.16)},${r1(base - h * 0.62)} ${r1(x - h * 0.16)},${r1(base - h * 0.62)}" fill="${C.snow}" stroke="${C.snow}" stroke-width="1" stroke-linejoin="round"/>`;
  const dots = [[24, 26, 1.6], [36, 14, 1.2], [62, 12, 1.5], [76, 24, 1.3], [30, 40, 1.1], [70, 40, 1.6], [56, 30, 1.1], [44, 26, 1.4], [18, 46, 1.2], [84, 48, 1.1], [50, 18, 1]];
  files.cp2612_snow_globe = svg(100,
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.glass}" fill-opacity="0.55"/>` +
    `<path d="${mound}" fill="${C.snow}"/>` +
    pine(22, 62, 13) + pine(78, 62, 11) +
    `<polygon points="32,58.5 68,58.5 72,67 28,67" fill="${C.green}"/>` +
    `<polygon points="33.2,59.4 66.8,59.4 70.3,66.1 29.7,66.1" fill="none" stroke="${C.white}" stroke-width="0.9" stroke-linejoin="round"/>` +
    `<path d="M41 59.4L39.7 66.1M59 59.4L60.3 66.1M31.4 62.7H40.4M59.6 62.7H68.6" stroke="${C.white}" stroke-width="0.8"/>` +
    `<path d="M50 58.5V67" stroke="${C.white}" stroke-width="1" stroke-dasharray="1.6 1"/>` +
    `<ellipse cx="38" cy="66.6" rx="6" ry="1.6" fill="${C.snow}"/><ellipse cx="66" cy="59" rx="4" ry="1.2" fill="${C.snow}"/>` +
    ball(57, 63.6, 2.6) +
    dots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.white}"/>`).join('') +
    flake(30, 30, 4, C.white, 1) + flake(68, 22, 3.4, C.white, 0.9) +
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${C.glassEdge}" stroke-width="1.5"/>` +
    `<path d="M18.5 32A34 34 0 0 1 34 14.5" fill="none" stroke="${C.white}" stroke-width="3.2" stroke-linecap="round" opacity="0.7"/>` +
    `<circle cx="16.5" cy="40" r="1.6" fill="${C.white}" opacity="0.7"/>` +
    `<rect x="14" y="78" width="72" height="16" rx="4" fill="${C.wood}"/>` +
    `<rect x="16" y="78.8" width="68" height="2.4" rx="1.2" fill="${shade(C.wood, 0.12)}"/>` +
    `<rect x="14" y="84" width="72" height="4" fill="${C.red}"/>` +
    `<rect x="44" y="83" width="12" height="6" rx="1.5" fill="${C.gold}"/>` +
    `<rect x="2" y="93" width="96" height="7" rx="3" fill="${C.darkWood}"/>` +
    `<rect x="4" y="93.6" width="92" height="1.8" rx="0.9" fill="${shade(C.darkWood, 0.12)}"/>`,
  );
}

// ── cp2612_ornament_tree (accent, aspect 0.75) ──────────────────────────────
{
  const H = 133.3;
  const tier = (apexY, baseY, half) => {
    const pts = `50,${apexY} ${50 + half},${baseY} ${50 - half},${baseY}`;
    const snowBumps = [];
    const n = Math.round(half / 6);
    for (let i = 0; i <= n * 2; i++) {
      const x = 50 - half + 4 + ((2 * half - 8) * i) / (n * 2);
      snowBumps.push(`<circle cx="${r1(x)}" cy="${baseY}" r="2.3"/>`);
    }
    return `<polygon points="${pts}" fill="${C.pine}" stroke="${C.pine}" stroke-width="4" stroke-linejoin="round"/>` +
      `<polygon points="50,${apexY} ${50 - half},${baseY} 50,${baseY}" fill="${C.green}"/>` +
      `<g fill="${C.snow}"><rect x="${50 - half + 1}" y="${baseY - 1.8}" width="${2 * half - 2}" height="3.6" rx="1.8"/>${snowBumps.join('')}</g>`;
  };
  const garland = (y0, y1, half) =>
    `<path d="M${50 - half} ${y0}Q50 ${y1} ${50 + half} ${y0 - 6}" fill="none" stroke="${C.ice}" stroke-width="1.6" stroke-linecap="round"/>`;
  const orn = (x, y, r, fill, hole) => `<rect x="${r1(x - 1.4)}" y="${r1(y - r - 1.6)}" width="2.8" height="2.2" rx="0.6" fill="${C.gold}"/>` + ball(x, y, r, fill, hole);
  const iceHole = shade(C.ice, -0.25);
  files.cp2612_ornament_tree = svg(H,
    `<rect x="45.5" y="96" width="9" height="14" fill="${shade(C.darkWood, -0.2)}"/>` +
    tier(50, 98, 46) + garland(80, 96, 34) +
    tier(32, 74, 36) + garland(58, 72, 25) +
    tier(16, 50, 26) +
    orn(44, 42, 4, C.ball, C.hole) + orn(58, 45.5, 3.6, C.ice, iceHole) +
    orn(31, 65, 4.6, C.ice, iceHole) + orn(52, 60, 4.2, C.ball, C.hole) + orn(70, 66, 4.6, C.red, shade(C.red, -0.2)) +
    orn(20, 91, 5, C.ball, C.hole) + orn(40, 85, 4.6, C.red, shade(C.red, -0.2)) + orn(62, 88, 5, C.ice, iceHole) + orn(82, 90, 5, C.ball, C.hole) +
    `<g transform="translate(50 11.5)">${paddle(12, C.gold, { mark: flake(0, 0.6, 3.4, C.white, 1) })}</g>` +
    `<rect x="27" y="104" width="46" height="8" rx="2.5" fill="${shade(C.red, -0.15)}"/>` +
    `<rect x="30" y="110" width="40" height="${r1(H - 110)}" rx="4" fill="${C.red}"/>` +
    `<rect x="33" y="112.5" width="3" height="${r1(H - 117)}" rx="1.5" fill="${shade(C.red, 0.12)}"/>` +
    `<rect x="30" y="118" width="40" height="4" fill="${C.snow}"/>` +
    `<rect x="28" y="104.6" width="44" height="2" rx="1" fill="${shade(C.red, 0.05)}"/>`,
  );
}

// ── cp2612_window_snow (window, aspect 0.9) ─────────────────────────────────
{
  const dots = [[20, 20, 1.2], [30, 32, 1], [40, 18, 1.4], [62, 20, 1.1], [80, 34, 1.3], [70, 42, 1], [24, 44, 1.2], [58, 38, 1.4], [84, 18, 1], [36, 60, 1.1], [64, 60, 1.2], [18, 64, 1], [78, 58, 1.1], [44, 46, 1]];
  const tree = (x, base, h) =>
    `<polygon points="${x},${base - h} ${r1(x + h * 0.38)},${base} ${r1(x - h * 0.38)},${base}" fill="${shade(C.pine, -0.1)}"/>` +
    `<polygon points="${x},${base - h} ${r1(x + h * 0.2)},${r1(base - h * 0.48)} ${r1(x - h * 0.2)},${r1(base - h * 0.48)}" fill="${C.snow}"/>`;
  files.cp2612_window_snow = svg(111.1,
    `<rect x="4" y="4" width="92" height="96" rx="4" fill="${C.frame}" stroke="${C.frameEdge}" stroke-width="1.5"/>` +
    `<rect x="12" y="12" width="76" height="80" rx="2" fill="${C.deep}"/>` +
    `<circle cx="72" cy="27" r="6.5" fill="${C.snow}" opacity="0.9"/>` +
    tree(20, 76, 22) + tree(30, 74, 16) + tree(80, 76, 20) +
    `<path d="M12 72Q32 64 52 70T88 68V90a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2Z" fill="${shade(C.snow, -0.05)}"/>` +
    `<polygon points="30,76 70,76 77,90 23,90" fill="${C.green}"/>` +
    `<polygon points="31.6,77.2 68.4,77.2 74.8,89 25.2,89" fill="none" stroke="${C.white}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="M50 82.3V89" stroke="${C.white}" stroke-width="0.9"/>` +
    `<rect x="26" y="80.8" width="48" height="2" fill="${C.ink}" opacity="0.6"/>` +
    `<rect x="25.4" y="79" width="1.2" height="4" fill="${C.ink}"/><rect x="73.4" y="79" width="1.2" height="4" fill="${C.ink}"/>` +
    `<ellipse cx="36" cy="87" rx="8" ry="2" fill="${C.snow}"/><ellipse cx="64" cy="78.6" rx="6" ry="1.4" fill="${C.snow}"/><ellipse cx="60" cy="88.4" rx="5" ry="1.4" fill="${C.snow}"/>` +
    `<g fill="${C.white}">${dots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>` +
    flake(26, 26, 3.6, C.white, 0.9) + flake(60, 32, 3, C.white, 0.8) +
    `<g fill="${C.white}" opacity="0.6"><path d="M12 22V14a2 2 0 0 1 2-2h8Q14 14 12 22Z"/><path d="M88 22V14a2 2 0 0 0-2-2h-8Q86 14 88 22Z"/><path d="M12 82v8a2 2 0 0 0 2 2h8Q14 90 12 82Z"/><path d="M88 82v8a2 2 0 0 1-2 2h-8Q86 90 88 82Z"/></g>` +
    `<rect x="15" y="15" width="3" height="30" rx="1.5" fill="${C.white}" opacity="0.3"/>` +
    `<rect x="48" y="12" width="4" height="80" fill="${C.frame}"/>` +
    `<rect x="12" y="50" width="76" height="4" fill="${C.frame}"/>` +
    `<path d="M12 50Q30 47 48 50ZM52 50Q70 47 88 50Z" fill="${C.snow}"/>` +
    `<path d="M13 92Q14 87 22 88Q28 86 34 90Q40 88 47 91L47 92ZM53 92Q58 88 66 89Q74 86 80 90Q86 88 87 92Z" fill="${C.snow}"/>` +
    `<circle cx="50" cy="52" r="9" fill="none" stroke="${C.pine}" stroke-width="4"/>` +
    `<circle cx="50" cy="52" r="9" fill="none" stroke="${C.green}" stroke-width="1.4" stroke-dasharray="2.5 2.5"/>` +
    `<g fill="${C.red}"><circle cx="43.4" cy="47.5" r="1.3"/><circle cx="57.8" cy="49" r="1.3"/><circle cx="56" cy="58.6" r="1.3"/><circle cx="42.6" cy="56.8" r="1.3"/></g>` +
    `<path d="M50 59.5l-4.6 -2.6v5.2zM50 59.5l4.6 -2.6v5.2z" fill="${C.red}" stroke="${C.red}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="M49 60.5l-2.6 6M51 60.5l2.6 6" stroke="${shade(C.red, -0.15)}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="50" cy="59.5" r="1.6" fill="${shade(C.red, -0.15)}"/>` +
    `<rect x="0.75" y="100" width="98.5" height="8" rx="2" fill="#e2e5ea" stroke="${C.frameEdge}" stroke-width="1.5"/>` +
    `<rect x="2" y="100.8" width="96" height="2" rx="1" fill="#f6f7f9"/>` +
    `<path d="M2 101Q5 96.5 12 97Q18 95 26 97.5Q34 95.6 42 97.2Q50 95 58 97.4Q66 95.6 74 97Q82 95.2 90 97.4Q96 96.4 98 101Z" fill="${C.snow}" stroke="${C.frameEdge}" stroke-width="0.6"/>`,
  );
}

// ── cp2612_poster_first_frost (wall_art, aspect 0.8) ────────────────────────
{
  files.cp2612_poster_first_frost = svg(125,
    `<rect x="6" y="6" width="88" height="114" rx="1" fill="${C.snow}" stroke="${C.creamEdge}" stroke-width="1.5"/>` +
    `<rect x="14" y="14" width="72" height="66" rx="1" fill="${C.deep}"/>` +
    `<g fill="${C.white}" opacity="0.8"><circle cx="22" cy="22" r="1"/><circle cx="78" cy="26" r="1.2"/><circle cx="24" cy="60" r="1"/><circle cx="76" cy="56" r="1"/><circle cx="66" cy="18" r="0.9"/><circle cx="34" cy="20" r="0.8"/></g>` +
    flake(50, 42, 26, shade(C.ice, 0.2), 3) +
    flake(50, 42, 26, C.white, 1.2, false) +
    ball(50, 42, 10) +
    `<path d="M41.6 37.2A10 10 0 0 1 58.4 37.2Q56 39 54 37.6Q52 39.4 50 37.4Q48 39.4 46 37.6Q44 39 41.6 37.2Z" fill="${C.white}"/>` +
    `<path d="M14 72Q26 66 38 70T62 69T86 70V79a1 1 0 0 1-1 1H15a1 1 0 0 1-1-1Z" fill="${C.ice}"/>` +
    `<path d="M14 76Q30 72 46 75T86 74V79a1 1 0 0 1-1 1H15a1 1 0 0 1-1-1Z" fill="${shade(C.ice, 0.35)}"/>` +
    `<rect x="14" y="86" width="72" height="22" fill="${C.red}"/>` +
    `<text x="50" y="97.5" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="8" letter-spacing="1.5" fill="${C.white}">FROST</text>` +
    `<path d="M30 101.5h40M36 105h28" stroke="${C.white}" stroke-width="1"/>` +
    `<rect x="-9" y="-3" width="18" height="6" fill="${C.ice}" opacity="0.8" transform="translate(11 9) rotate(-35)"/>` +
    `<rect x="-9" y="-3" width="18" height="6" fill="${C.ice}" opacity="0.8" transform="translate(89 9) rotate(35)"/>`,
  );
}

// ── cp2612_icicle_lights (ceiling, aspect 4) ────────────────────────────────
{
  const wireY = (x) => (x <= 50 ? 1.5 + Math.sin((x / 50) * Math.PI) * 2.6 : 1.5 + Math.sin(((x - 50) / 50) * Math.PI) * 2.6);
  const lens = [10, 16, 21, 13, 18, 11, 20, 14, 9, 17, 21, 12, 19, 15, 10, 18];
  let halos = '', bodies = '', clips = '';
  lens.forEach((L, i) => {
    const x = 3.2 + i * 6.24;
    const y = wireY(x) + 0.6;
    const tip = Math.min(24.2, y + L);
    halos += `<ellipse cx="${r1(x)}" cy="${r1(tip - 2.5)}" rx="2.8" ry="4" fill="${C.ice}"/>`;
    bodies += `<path d="M${r1(x - 1.9)} ${r1(y)}H${r1(x + 1.9)}L${r1(x + 0.3)} ${r1(tip)}Q${r1(x)} ${r1(tip + 0.6)} ${r1(x - 0.3)} ${r1(tip)}Z" fill="${C.glass}" stroke="${C.glassEdge}" stroke-width="0.5" stroke-linejoin="round"/>` +
      `<path d="M${r1(x - 0.9)} ${r1(y + 1)}L${r1(x - 0.2)} ${r1(tip - 3)}" stroke="${C.white}" stroke-width="0.7" stroke-linecap="round"/>` +
      `<circle cx="${r1(x)}" cy="${r1(tip - 1.6)}" r="0.9" fill="${C.white}"/>`;
    clips += `<rect x="${r1(x - 1)}" y="${r1(y - 1.1)}" width="2" height="1.4" rx="0.4" fill="${C.frameEdge}"/>`;
  });
  files.cp2612_icicle_lights = svg(25,
    `<path d="M0 1.5Q25 6.6 50 1.5Q75 6.6 100 1.5" fill="none" stroke="${C.glassEdge}" stroke-width="0.9"/>` +
    `<g opacity="0.25">${halos}</g>` + bodies + clips +
    `<g fill="${C.deep}"><rect x="0.5" y="0" width="3" height="2.6" rx="1"/><rect x="48.5" y="0" width="3" height="2.6" rx="1"/><rect x="96.5" y="0" width="3" height="2.6" rx="1"/></g>`,
  );
}

// ── cp2612_pillow_knit (couch_pillow, aspect 1.2) ───────────────────────────
{
  const H = 83.3;
  const dark = shade(C.red, -0.14);
  const vRow = (y, x0, x1) => {
    let d = '';
    for (let x = x0; x <= x1 - 4; x += 5) d += `M${r1(x)} ${y}l2 2.6l2 -2.6`;
    return d;
  };
  let zig = '';
  for (const y of [27, 56.3]) {
    zig += `M5 ${y}`;
    for (let x = 5; x < 95; x += 5) zig += `L${x + 2.5} ${y + (y < 40 ? -2.5 : 2.5)}L${x + 5} ${y}`;
  }
  files.cp2612_pillow_knit = svg(H,
    `<rect x="2" y="2" width="96" height="${r1(H - 4)}" rx="32" fill="${C.red}"/>` +
    `<ellipse cx="26" cy="14" rx="12" ry="4.5" fill="${shade(C.red, 0.14)}" transform="rotate(-18 26 14)"/>` +
    `<path d="${vRow(9, 26, 76)}${vRow(15, 14, 88)}${vRow(64, 12, 90)}${vRow(70, 22, 80)}" fill="none" stroke="${dark}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="2" y="31.5" width="96" height="20.3" fill="${C.snow}"/>` +
    `<path d="${zig}" fill="none" stroke="${C.snow}" stroke-width="1.6" stroke-linejoin="round"/>` +
    flake(18, 41.6, 6, C.pine, 1.4) + flake(82, 41.6, 6, C.pine, 1.4) +
    `<g fill="${C.red}"><rect x="31.5" y="38.6" width="6" height="6" rx="1" transform="rotate(45 34.5 41.6)"/><rect x="62.5" y="38.6" width="6" height="6" rx="1" transform="rotate(45 65.5 41.6)"/></g>` +
    ball(50, 41.6, 8.2) +
    `<rect x="5" y="5" width="90" height="${r1(H - 10)}" rx="29" fill="none" stroke="${dark}" stroke-width="1.4" stroke-dasharray="3 2.4"/>`,
  );
}

// ── cp2612_rug_snowflake (rug, aspect 3) ────────────────────────────────────
{
  const kitchen = shade(C.ice, -0.1);
  files.cp2612_rug_snowflake = svg(33.3,
    `<polygon points="9.1,2.2 90.9,2.2 97.5,31.1 2.5,31.1" fill="${C.deep}" stroke="${C.deep}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<polygon points="11.1,4 88.9,4 94.4,29.3 5.6,29.3" fill="${C.ice}"/>` +
    `<polygon points="37.9,4 62.1,4 63.8,29.3 36.2,29.3" fill="${kitchen}"/>` +
    `<path d="M37.8 5L36.3 28.3M62.2 5L63.7 28.3M9.3 16.7L37.1 16.7M63 16.7L90.7 16.7" stroke="${C.white}" stroke-width="1.5" fill="none"/>` +
    `<polygon points="11.8,5 88.2,5 93.2,28.3 6.8,28.3" fill="none" stroke="${C.white}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<g transform="translate(50 16.7) scale(1 0.62)"><circle r="12.5" fill="${kitchen}"/>${flake(0, 0, 11.5, C.white, 1.8)}</g>` +
    `<g transform="translate(23.5 10.8) scale(1 0.62)">${flake(0, 0, 3.2, C.snow, 0.9, false)}</g>` +
    `<g transform="translate(76.5 10.8) scale(1 0.62)">${flake(0, 0, 3.2, C.snow, 0.9, false)}</g>` +
    `<g transform="translate(22 22.6) scale(1 0.62)">${flake(0, 0, 3.6, C.snow, 0.9, false)}</g>` +
    `<g transform="translate(78 22.6) scale(1 0.62)">${flake(0, 0, 3.6, C.snow, 0.9, false)}</g>` +
    `<g fill="${C.snow}"><circle cx="9.1" cy="2.2" r="1.4"/><circle cx="90.9" cy="2.2" r="1.4"/><circle cx="2.5" cy="31.1" r="1.4"/><circle cx="97.5" cy="31.1" r="1.4"/></g>`,
  );
}

// ── cp2612_rack_ice_palace (paddle_rack, aspect 1.25) ───────────────────────
{
  const wall = C.deep, inner = shade(C.deep, -0.22), hi = shade(C.deep, 0.12);
  const roof = (x, w, top, base) =>
    `<polygon points="${x + w / 2},${top} ${x + w + 1},${base} ${x - 1},${base}" fill="${C.ice}" stroke="${C.ice}" stroke-width="1" stroke-linejoin="round"/>` +
    `<polygon points="${x + w / 2},${top} ${x - 1},${base} ${x + w / 2},${base}" fill="${shade(C.ice, 0.25)}"/>` +
    `<rect x="${x - 1.4}" y="${base - 1}" width="${w + 2.8}" height="2" rx="1" fill="${C.snow}"/>`;
  const tower = (x, w, top) => `<rect x="${x}" y="${top}" width="${w}" height="${78 - top}" rx="2" fill="${wall}"/><rect x="${x + 1}" y="${top + 0.8}" width="${w - 2}" height="2" rx="1" fill="${hi}"/>`;
  const arch = (cx, y, w, h) => `<path d="M${r1(cx - w / 2)} ${r1(y + h)}V${r1(y + w / 2)}A${r1(w / 2)} ${r1(w / 2)} 0 0 1 ${r1(cx + w / 2)} ${r1(y + w / 2)}V${r1(y + h)}Z" fill="${C.glass}"/>`;
  let crenel = '';
  for (const x of [22, 28, 34, 62, 68, 74]) crenel += `<rect x="${x}" y="17" width="4" height="6" rx="0.8" fill="${wall}"/>`;
  let icicles = '';
  for (let i = 0; i < 12; i++) {
    const x = 12 + i * 6.9, L = [4, 6, 3.4, 5, 6.4, 3.6, 5.4, 4.2, 6, 3.4, 5.2, 4.4][i];
    icicles += `<path d="M${r1(x - 1.3)} 26H${r1(x + 1.3)}L${r1(x)} ${r1(26 + L)}Z" fill="${C.glass}"/>`;
  }
  const fan = (rot, len, W, face) => `<g transform="translate(50 77) rotate(${rot}) translate(0 -${len})">${paddle(W, face)}</g>`;
  files.cp2612_rack_ice_palace = svg(80,
    `<rect x="2" y="22" width="96" height="56" rx="4" fill="${wall}"/>` + crenel +
    tower(3, 16, 12) + tower(81, 16, 12) + tower(40, 20, 9) +
    roof(3, 16, 2, 12) + roof(81, 16, 2, 12) + roof(40, 20, 0, 9) +
    arch(11, 14, 4, 6) + arch(89, 14, 4, 6) + arch(50, 11.5, 5, 7) +
    `<rect x="4" y="22.8" width="92" height="2.4" rx="1.2" fill="${hi}"/>` +
    `<rect x="7" y="26" width="86" height="48" rx="3" fill="${inner}"/>` + icicles +
    `<g opacity="0.5">${flake(14, 62, 3, C.ice, 0.8, false)}${flake(86, 62, 3, C.ice, 0.8, false)}${flake(18, 40, 2.4, C.ice, 0.7, false)}${flake(82, 40, 2.4, C.ice, 0.7, false)}</g>` +
    fan(-50, 40, 14, C.ice) + fan(50, 40, 14, C.ice) +
    fan(-25, 43, 15.5, C.snow) + fan(25, 43, 15.5, C.snow) +
    `<g transform="translate(50 31)">${paddle(19, C.gold, { mark: flake(0, 1.6, 5, C.white, 1.3) })}</g>` +
    `<rect x="40" y="65" width="20" height="6" rx="1.5" fill="${C.gold}"/>` +
    `<path d="M44 68h12" stroke="${shade(C.gold, -0.24)}" stroke-width="0.8"/>`,
  );
}

for (const [id, s] of Object.entries(files)) {
  writeFileSync(join(OUT, `${id}.svg`), s);
  console.log(id, s.length);
}
