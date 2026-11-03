// Draws the Harvest Market (November 2026) decor SVGs into ./svg/
// (art/seasonal-market/2026-11/svg). The SVG files are the source the build
// reads; this script is how they were drawn. Edit here and re-run it, or edit
// an SVG by hand and stop using this.
//
//   node art/seasonal-market/2026-11/draw.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C, LEAVES, r1, shade, ball, maple, leaf, pumpkin, wheat, apple, svg, writeAll } from '../shapes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = {};

// ── sm2611_wall_falling_leaves (wallpaper, aspect 1) ────────────────────────
// A seamless tile: nothing crosses an edge, so the tiles meet cleanly.
{
  const base = '#f6ecd9';
  files.sm2611_wall_falling_leaves = svg(100,
    `<rect width="100" height="100" fill="${base}"/>` +
    `<g fill="${shade(base, -0.07)}"><circle cx="46" cy="16" r="1.2"/><circle cx="12" cy="46" r="1"/><circle cx="90" cy="40" r="1.2"/><circle cx="60" cy="78" r="1"/><circle cx="88" cy="90" r="1.1"/><circle cx="8" cy="92" r="1"/></g>` +
    `<path d="M14 14q4 3 9 2M66 58q4 3 9 2M70 8q3 2 7 1M20 64q3 2 7 1" stroke="${shade(base, -0.1)}" stroke-width="0.8" fill="none" stroke-linecap="round"/>` +
    maple(22, 24, 6.5, -20, C.leafRed) +
    leaf(74, 18, 5.5, 40, C.harvest) +
    maple(78, 68, 6, 25, C.pumpkin) +
    leaf(28, 76, 5.5, -55, C.rust) +
    leaf(52, 50, 3.4, 100, C.harvest) +
    ball(48, 88, 3),
  );
}

// ── sm2611_art_market_board (wall_art, aspect 0.8) ──────────────────────────
{
  const slate = '#33433d', chalk = '#f3efe4';
  const pickle = (x, y) =>
    `<g transform="translate(${x} ${y}) rotate(30)">` +
    `<ellipse rx="2" ry="3.6" fill="#7cb342"/><path d="M0 -3.6A2 3.6 0 0 0 0 3.6A1.2 3.6 0 0 1 0 -3.6Z" fill="${shade('#7cb342', 0.18)}"/>` +
    `<g fill="${shade('#7cb342', -0.3)}"><circle cx="0.7" cy="-1.6" r="0.35"/><circle cx="0.9" cy="0.6" r="0.35"/><circle cx="0.2" cy="2.2" r="0.35"/></g></g>`;
  const price = (y, n) => Array.from({ length: n }, (_, i) => pickle(80 - i * 6, y)).join('');
  const leader = (y) => `<path d="M35 ${y}H${80 - 6 * 3 - 1}" stroke="${chalk}" stroke-width="0.8" stroke-dasharray="0.6 2" stroke-linecap="round" opacity="0.7"/>`;
  files.sm2611_art_market_board = svg(125,
    `<path d="M50 3L16 18M50 3L84 18" stroke="#a07850" stroke-width="1.1" fill="none"/>` +
    `<rect x="6" y="14" width="88" height="98" rx="3" fill="${C.wood}"/>` +
    `<rect x="6" y="14" width="88" height="2.4" rx="1.2" fill="${shade(C.wood, 0.14)}"/>` +
    `<rect x="6" y="14" width="2.6" height="98" rx="1.3" fill="${shade(C.wood, 0.12)}"/>` +
    `<rect x="12" y="20" width="76" height="86" rx="1.5" fill="${slate}"/>` +
    `<path d="M14 24l10 -2M16 98l14 -3M70 26l12 -1M66 101l16 -2" stroke="${chalk}" stroke-width="2.4" opacity="0.06" stroke-linecap="round"/>` +
    `<text x="50" y="33.5" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="7.4" letter-spacing="1.2" fill="${chalk}">MARKET</text>` +
    `<path d="M27 37.5q5.5 -1.6 11 0t11 0t11 0t11 0" stroke="${C.wheat}" stroke-width="0.9" fill="none" stroke-linecap="round" opacity="0.85"/>` +
    `<g opacity="0.55">${maple(19.5, 29, 3.2, -20, C.wheat, { veins: false })}${maple(80.5, 29, 3.2, 20, C.wheat, { veins: false })}</g>` +
    pumpkin(25, 51, 7.4, 5.4, C.pumpkin, { vine: false }) + leader(51) + price(51, 3) +
    apple(25, 69, 5.4) + leader(69) + price(69, 2) +
    ball(25, 87, 5.8) + leader(87) + price(87, 1) +
    `<rect x="4" y="106" width="92" height="6" rx="2" fill="${C.darkWood}"/>` +
    `<rect x="5" y="106.4" width="90" height="1.6" rx="0.8" fill="${shade(C.darkWood, 0.14)}"/>` +
    `<rect x="22" y="103" width="11" height="3" rx="1.5" fill="${chalk}"/><rect x="37" y="103.4" width="6.5" height="2.6" rx="1.3" fill="${C.wheat}"/>` +
    `<circle cx="50" cy="3" r="2.8" fill="${C.bark}"/><circle cx="49.2" cy="2.2" r="0.9" fill="${shade(C.bark, 0.3)}"/>` +
    maple(10.5, 17, 6, -25, C.leafRed) + leaf(17, 14.5, 4.6, 35, C.harvest),
  );
}

// ── sm2611_ceiling_lanterns (ceiling, aspect 4) ─────────────────────────────
{
  const wireY = (x) => 1.5 + Math.sin(((x % 50) / 50) * Math.PI) * 2.7;
  const cols = [C.rust, C.harvest, C.pumpkin, 'BALL', C.pumpkin, C.harvest, C.rust];
  const xs = [9, 22, 35.5, 50, 64.5, 78, 91];
  let cords = '', lanterns = '', leaves = '';
  xs.forEach((x, i) => {
    const y0 = wireY(x) + 0.3;
    const drop = i % 2 ? 4.5 : 1.8;
    const capY = y0 + drop;
    const rx = 5, ry = 5.2, cy = capY + 1.2 + ry;
    cords += `M${r1(x)} ${r1(y0)}V${r1(capY)}`;
    const cap = (y) => `<rect x="${r1(x - 1.8)}" y="${r1(y)}" width="3.6" height="1.3" rx="0.5" fill="${C.bark}"/>`;
    let body;
    if (cols[i] === 'BALL') {
      body = ball(x, cy, rx + 0.2);
    } else {
      const col = cols[i];
      let ribs = '';
      for (const dy of [-3.4, -1.15, 1.15, 3.4]) {
        const hw = rx * Math.sqrt(1 - (dy / ry) ** 2);
        ribs += `M${r1(x - hw)} ${r1(cy + dy)}Q${r1(x)} ${r1(cy + dy + 0.7)} ${r1(x + hw)} ${r1(cy + dy)}`;
      }
      body = `<ellipse cx="${r1(x)}" cy="${r1(cy)}" rx="${rx}" ry="${ry}" fill="${col}"/>` +
        `<path d="M${r1(x)} ${r1(cy - ry)}A${rx} ${ry} 0 0 0 ${r1(x)} ${r1(cy + ry)}A${rx * 0.6} ${ry} 0 0 1 ${r1(x)} ${r1(cy - ry)}Z" fill="${shade(col, 0.14)}"/>` +
        `<path d="${ribs}" stroke="${shade(col, -0.2)}" stroke-width="0.45" fill="none"/>` +
        `<ellipse cx="${r1(x - 2.6)}" cy="${r1(cy - 1.4)}" rx="0.7" ry="2.2" fill="${shade(col, 0.4)}" opacity="0.8"/>`;
    }
    lanterns += cap(capY) + body + cap(cy + ry - 0.3) +
      `<path d="M${r1(x)} ${r1(cy + ry + 1)}v1.6" stroke="${C.rust}" stroke-width="0.9" stroke-linecap="round"/>`;
  });
  [[15.5, 0], [29, 1], [43, 2], [57, 3], [71, 1], [84.5, 0]].forEach(([x, c], i) => {
    leaves += (i % 2 ? leaf : maple)(x, wireY(x) + 1.4, 2.4, (i % 2 ? 1 : -1) * 35, LEAVES[c], { veins: false });
  });
  files.sm2611_ceiling_lanterns = svg(25,
    `<path d="M0 1.5Q25 7.1 50 1.5Q75 7.1 100 1.5" fill="none" stroke="#a07850" stroke-width="0.9"/>` +
    `<path d="${cords}" stroke="#a07850" stroke-width="0.5"/>` + leaves + lanterns +
    `<g fill="${C.bark}"><rect x="0.5" y="0" width="3" height="2.6" rx="1"/><rect x="48.5" y="0" width="3" height="2.6" rx="1"/><rect x="96.5" y="0" width="3" height="2.6" rx="1"/></g>`,
  );
}

// ── sm2611_item_lattice_pie (shelf_item, aspect 1) ──────────────────────────
{
  const crust = '#e3ad5e', filling = '#b8562a', dish = C.green;
  const cx = 50, base = 64, RX = 33, RY = 25;
  const topAt = (x) => base - RY * Math.sqrt(Math.max(0, 1 - ((x - cx) / RX) ** 2));
  const halfAt = (y) => RX * Math.sqrt(Math.max(0, 1 - ((base - y) / RY) ** 2));
  let strips = '';
  for (const c of [26, 38, 50, 62, 74]) {
    const w = 5.4, x = c - w / 2, t = Math.max(topAt(x), topAt(x + w)) + 0.6;
    strips += `<rect x="${x}" y="${r1(t)}" width="${w}" height="${r1(base - t)}" rx="1.6" fill="${crust}"/>` +
      `<rect x="${x}" y="${r1(t)}" width="1.4" height="${r1(base - t)}" rx="0.7" fill="${shade(crust, 0.18)}"/>`;
  }
  for (const y of [47, 57]) {
    const h = 4.6, hw = halfAt(y) - 1.2;
    strips += `<rect x="${r1(cx - hw)}" y="${y}" width="${r1(hw * 2)}" height="${h}" rx="2" fill="${crust}"/>` +
      `<rect x="${r1(cx - hw + 1)}" y="${y}" width="${r1(hw * 2 - 2)}" height="1.2" rx="0.6" fill="${shade(crust, 0.18)}"/>`;
  }
  let crimp = '';
  for (let i = 0; i < 12; i++) crimp += `<circle cx="${r1(17.5 + i * 5.9)}" cy="64.2" r="3.1" fill="${i % 2 ? crust : shade(crust, 0.08)}"/>`;
  files.sm2611_item_lattice_pie = svg(100,
    // the cake stand
    `<path d="M34 100L38 92H62L66 100Z" fill="${C.cream}" stroke="${C.creamEdge}" stroke-width="1" stroke-linejoin="round"/>` +
    `<rect x="45" y="78" width="10" height="15" rx="2" fill="${C.cream}" stroke="${C.creamEdge}" stroke-width="1"/>` +
    `<rect x="8" y="74" width="84" height="5.6" rx="2.8" fill="${C.cream}" stroke="${C.creamEdge}" stroke-width="1"/>` +
    `<rect x="10" y="74.6" width="80" height="1.4" rx="0.7" fill="${C.white}"/>` +
    // the dish, the filling dome, the lattice, the crimped rim
    `<path d="M15 64H85L80 74H20Z" fill="${dish}"/><path d="M15 64H24L27 74H20Z" fill="${shade(dish, 0.14)}"/>` +
    `<path d="M17.4 69H82.6" stroke="${C.cream}" stroke-width="1.4"/>` +
    `<path d="M${cx - RX} ${base}A${RX} ${RY} 0 0 1 ${cx + RX} ${base}Z" fill="${filling}"/>` +
    
    strips + crimp +
    // a maple-leaf cut-out of crust on top
    maple(50, 40.5, 6.4, 0, shade(crust, -0.06)) +
    // a pickleball resting on the stand, a leaf fallen beside it
    ball(83.5, 66.5, 6.8) +
    leaf(15, 70.5, 3.6, -70, C.leafRed),
  );
}

// ── sm2611_accent_cider_barrel (accent, aspect 0.75) ────────────────────────
{
  const H = 133.3, wood = '#b07a48', iron = '#5b4b40';
  const top = 56, bot = 126;
  const hwAt = (y) => { const t = (y - top) / (bot - top); return 30 + 24 * t * (1 - t); };
  let staves = '';
  for (const k of [-3, -2, -1, 1, 2, 3]) {
    const xt = 50 + k * 8.6, xm = 50 + k * 11.4;
    staves += `M${r1(xt)} ${top}Q${r1(xm)} ${(top + bot) / 2} ${r1(xt)} ${bot}`;
  }
  const hoop = (y) => {
    const hw = hwAt(y + 1.7) + 0.6;
    return `<rect x="${r1(50 - hw)}" y="${y}" width="${r1(hw * 2)}" height="3.4" rx="1.2" fill="${iron}"/>` +
      `<rect x="${r1(50 - hw + 1.5)}" y="${y}" width="${r1(hw * 2 - 3)}" height="0.9" rx="0.45" fill="${shade(iron, 0.25)}"/>` +
      `<circle cx="${r1(50 - hw + 3.5)}" cy="${y + 1.9}" r="0.6" fill="${shade(iron, 0.35)}"/><circle cx="${r1(50 + hw - 3.5)}" cy="${y + 1.9}" r="0.6" fill="${shade(iron, 0.35)}"/>`;
  };
  const mug = (x, y, w, h, col) =>
    `<path d="M${x + w - 1} ${y + 3}h3a3 3 0 0 1 3 3v${h - 9}a3 3 0 0 1 -3 3h-3" fill="none" stroke="${shade(col, -0.12)}" stroke-width="2.2"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.4" fill="${col}"/>` +
    `<rect x="${x}" y="${y}" width="2.6" height="${h}" rx="1.3" fill="${shade(col, 0.4)}" opacity="0.7"/>` +
    `<rect x="${x + 1}" y="${y + 3.4}" width="${w - 2}" height="2" fill="${C.rust}" opacity="0.85"/>` +
    `<rect x="${x + 0.8}" y="${y - 1}" width="${w - 1.6}" height="2.4" rx="1.2" fill="#f4dfb8"/>`;
  files.sm2611_accent_cider_barrel = svg(H,
    // wheat bundle behind, tied with twine
    wheat(34, 54, 22, 12, C.harvest, 1.25) + wheat(36, 54, 34, 6, shade(C.harvest, 0.1), 1.25) + wheat(38, 54, 46, 13, C.harvest, 1.2) +
    `<rect x="31" y="44" width="9" height="2.6" rx="1.2" fill="${C.rust}"/>` +
    // the cradle
    `<rect x="8" y="${r1(H - 8)}" width="84" height="8" rx="2.5" fill="${C.darkWood}"/>` +
    `<rect x="9" y="${r1(H - 7.6)}" width="82" height="1.6" rx="0.8" fill="${shade(C.darkWood, 0.14)}"/>` +
    // the barrel
    `<path d="M20 ${top}Q8 ${(top + bot) / 2} 20 ${bot}H80Q92 ${(top + bot) / 2} 80 ${top}Z" fill="${wood}"/>` +
    `<path d="M20 ${top}Q8 ${(top + bot) / 2} 20 ${bot}H28.6Q18.6 ${(top + bot) / 2} 28.6 ${top}Z" fill="${shade(wood, 0.14)}"/>` +
    `<path d="M80 ${top}Q92 ${(top + bot) / 2} 80 ${bot}H74Q83 ${(top + bot) / 2} 74 ${top}Z" fill="${shade(wood, -0.12)}"/>` +
    `<path d="${staves}" stroke="${shade(wood, -0.2)}" stroke-width="0.8" fill="none"/>` +
    `<rect x="18.5" y="${top - 2.4}" width="63" height="4.2" rx="1.6" fill="${shade(wood, -0.18)}"/>` +
    hoop(60) + hoop(73) + hoop(107) + hoop(119) +
    // the label and the tap
    `<rect x="33" y="80" width="34" height="11" rx="1.5" fill="${C.cream}" stroke="${C.creamEdge}" stroke-width="0.8"/>` +
    `<text x="50" y="88" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="6.2" letter-spacing="1" fill="${C.rust}">CIDER</text>` +
    `<rect x="45" y="94.5" width="10" height="5" rx="1.5" fill="${C.gold}"/><rect x="45" y="94.5" width="10" height="1.4" rx="0.7" fill="${shade(C.gold, 0.25)}"/>` +
    `<rect x="48.6" y="99" width="2.8" height="4.4" rx="1" fill="${shade(C.gold, -0.15)}"/>` +
    `<rect x="47.4" y="91.8" width="5.2" height="2.2" rx="1" fill="${shade(C.gold, -0.15)}"/>` +
    // on top: a mug of cider with a cinnamon stick, a pickleball and an apple
    `<rect x="52" y="30" width="2" height="12" rx="1" fill="${C.bark}" transform="rotate(12 53 36)"/>` +
    mug(44, 38.5, 14, 15.6, C.cream) +
    ball(72, 47, 6.8) +
    apple(86.5, 49, 4.8) +
    maple(23, 51.5, 4.2, -30, C.leafRed),
  );
}

// ── sm2611_couch_quilt (couch, aspect 2) ────────────────────────────────────
// couch_velvet_green's geometry (seat cushions' top at y = 27.5, the pillow
// surface), in caramel, with a patchwork quilt thrown over the back.
{
  const sofa = '#b8743f', dark = shade(sofa, -0.22), light = shade(sofa, 0.14);
  const patches = [C.pumpkin, C.cream, C.harvest, C.green, C.rust, C.wheat, C.leafRed, C.cream];
  const qx = 36, qy = 3, pw = 6.25, ph = 6.6, cols = 8, rows = 3;
  let quilt = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = patches[(c + r * 3) % patches.length];
      const x = qx + c * pw, y = qy + r * ph;
      quilt += `<rect x="${r1(x)}" y="${r1(y)}" width="${pw}" height="${ph}" fill="${col}"/>`;
      if ((c + r) % 3 === 0 && col !== C.cream) quilt += `<path d="M${r1(x + 1)} ${r1(y + ph - 1)}L${r1(x + pw - 1)} ${r1(y + 1)}" stroke="${shade(col, 0.22)}" stroke-width="0.7"/>`;
    }
  }
  const qw = cols * pw, qh = rows * ph;
  // the corner fold hanging over the front of the back cushion
  const fold = `<path d="M${qx + qw - 14} ${qy + qh}H${qx + qw}L${qx + qw - 2} ${qy + qh + 10}Z" fill="${C.pumpkin}"/>` +
    `<path d="M${qx + qw - 14} ${qy + qh}L${qx + qw - 2} ${qy + qh + 10}" stroke="${C.cream}" stroke-width="0.7" stroke-dasharray="1.2 1"/>` +
    `<path d="M${qx + qw - 14} ${qy + qh}H${qx + qw}L${qx + qw - 2} ${qy + qh + 10}Z" fill="none" stroke="${C.rust}" stroke-width="1.2" stroke-linejoin="round"/>`;
  let seams = '';
  for (let c = 1; c < cols; c++) seams += `M${r1(qx + c * pw)} ${qy}V${r1(qy + qh)}`;
  for (let r = 1; r < rows; r++) seams += `M${qx} ${r1(qy + r * ph)}H${r1(qx + qw)}`;
  files.sm2611_couch_quilt = svg(50,
    `<rect x="6" y="1" width="88" height="28" rx="12" fill="${sofa}"/>` +
    `<rect x="16" y="2.5" width="68" height="4" rx="2" fill="${light}"/>` +
    `<g fill="${dark}"><circle cx="22" cy="12" r="1"/><circle cx="30" cy="12" r="1"/><circle cx="22" cy="20" r="1"/><circle cx="30" cy="20" r="1"/></g>` +
    // the quilt over the back
    quilt +
    `<path d="${seams}" stroke="${C.white}" stroke-width="0.5" stroke-dasharray="1 0.9" opacity="0.75"/>` +
    `<rect x="${qx}" y="${qy}" width="${r1(qw)}" height="${r1(qh)}" fill="none" stroke="${C.rust}" stroke-width="1.2"/>` +
    ball(qx + 4 * pw + pw / 2, qy + ph + ph / 2, 2.5) +
    fold +
    // seat cushions (top at 27.5)
    `<rect x="12" y="27.5" width="76" height="12.5" rx="4" fill="${shade(sofa, 0.06)}"/>` +
    `<rect x="15" y="28.3" width="70" height="2.2" rx="1.1" fill="${shade(sofa, 0.2)}"/>` +
    `<path d="M50 28.5V39.5" stroke="${dark}" stroke-width="0.9"/>` +
    `<path d="M13 39H87" stroke="${C.harvest}" stroke-width="1"/>` +
    `<rect x="4" y="40" width="92" height="5" rx="2" fill="${dark}"/>` +
    `<g fill="${C.bark}"><path d="M9 45H13.5L12 50H9.5Z"/><path d="M91 45H86.5L88 50H90.5Z"/></g>` +
    // rolled arms
    `<rect x="0" y="12" width="13" height="31" rx="6.5" fill="${shade(sofa, -0.1)}"/>` +
    `<rect x="87" y="12" width="13" height="31" rx="6.5" fill="${shade(sofa, -0.1)}"/>` +
    `<circle cx="6.5" cy="18.5" r="4.6" fill="${light}"/><circle cx="93.5" cy="18.5" r="4.6" fill="${light}"/>` +
    `<circle cx="6.5" cy="18.5" r="1.6" fill="${shade(sofa, -0.1)}"/><circle cx="93.5" cy="18.5" r="1.6" fill="${shade(sofa, -0.1)}"/>`,
  );
}

writeAll(HERE, files);
